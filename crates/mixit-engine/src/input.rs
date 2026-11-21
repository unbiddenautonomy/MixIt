//! Live input: a microphone or a line-in (turntable, phone, another mixer) on its own
//! mixer channel.
//!
//! The input device runs on its own clock, often at another rate and with another buffer
//! size than the output. Its callback pushes interleaved stereo frames into a lock-free
//! ring ([`InputFeed`]); the engine reads them through an adaptive resampler that keeps
//! the ring at a small target fill. A PI controller on the fill level trims the resampling
//! ratio by a few hundred parts per million, so the two clocks never drift apart and the
//! latency stays put, without the clicks of dropping or repeating samples.
//!
//! Channel signal flow:
//!
//! ```text
//! input → resampler → (mono) → gain → low cut → noise gate → EQ → [meter, cue, capture]
//!       → level × on air → master bus
//! ```
//!
//! Talk-over listens to the processed mic and turns the music down while you speak.

use mixit_dsp::biquad::{Coeffs, StereoBiquad};
use mixit_dsp::djeq::{DjEq, EqMode, EqVoicing};
use mixit_dsp::dynamics::{EnvelopeFollower, Gate, GateSettings};
use mixit_dsp::interp::SincTable;
use mixit_dsp::smooth::Smoothed;
use mixit_dsp::util::{db_to_gain, gain_to_db, one_pole_coeff};

use crate::deck::BLOCK;
use crate::mixer::Mixer;
use crate::trash::{Trash, TrashBin};

/// Source frames the resampler buffers locally (more than any block can need).
const BUF_FRAMES: usize = 16_384;
/// Largest correction to the resampling ratio (±0.5 %): far more than any real clock
/// drift, small enough to be inaudible as a pitch change.
const MAX_ADJ: f64 = 0.005;
/// Low-cut corner for handling noise, breath pops and rumble.
const LOW_CUT_HZ: f64 = 90.0;
/// Talk-over opens above this level (after gain and gate).
const TALK_THRESHOLD_DB: f32 = -38.0;

/// The ring an input device writes into, with what the engine needs to read it.
/// Built on a control thread (it allocates) and sent in with [`MicCommand::SetFeed`].
pub struct InputFeed {
    ring: rtrb::Consumer<f32>,
    sample_rate: u32,
    target: f64,
    sinc: SincTable,
}

impl InputFeed {
    /// Makes a ring for a device at `input_rate` whose callbacks deliver about
    /// `device_frames` frames at a time. Returns the producer (give it to the device's
    /// callback; it writes interleaved stereo f32) and the feed (send it to the engine).
    pub fn new(input_rate: u32, output_rate: u32, device_frames: u32) -> (rtrb::Producer<f32>, InputFeed) {
        let input_rate = input_rate.max(8_000);
        // Aim to hold two device callbacks plus one engine block: enough to ride out
        // scheduling jitter, little enough to talk over a track without a noticeable delay.
        let target = (2 * device_frames.max(32)) as f64 + BLOCK as f64 * input_rate as f64 / output_rate.max(1) as f64;
        let capacity = ((input_rate as usize / 2).max(target as usize * 8)) * 2;
        let (tx, rx) = rtrb::RingBuffer::new(capacity);
        // Band-limit when the input is faster than the output.
        let ratio = input_rate as f64 / output_rate.max(1) as f64;
        let cutoff = 0.94 / ratio.max(1.0);
        let sinc = SincTable::new(16, 256, cutoff, 9.0);
        (tx, InputFeed { ring: rx, sample_rate: input_rate, target, sinc })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Target buffering in input frames.
    pub fn target_frames(&self) -> f64 {
        self.target
    }
}

/// Writes interleaved stereo frames into an input ring, dropping what does not fit.
/// Returns the frames written. Real-time safe (for the input device's callback).
pub fn push_input(tx: &mut rtrb::Producer<f32>, frames: &[f32]) -> usize {
    let want = frames.len() / 2 * 2;
    let n = want.min(tx.slots() / 2 * 2);
    if n == 0 {
        return 0;
    }
    if let Ok(mut chunk) = tx.write_chunk_uninit(n) {
        let (a, b) = chunk.as_mut_slices();
        for (slot, v) in a.iter_mut().chain(b.iter_mut()).zip(frames) {
            slot.write(*v);
        }
        // SAFETY: both slices together are `n` slots long and all were written.
        unsafe { chunk.commit_all() };
    }
    n / 2
}

/// Reads an [`InputFeed`] at the engine's rate, following the device's clock.
pub struct InputReader {
    feed: Option<Box<InputFeed>>,
    out_rate: f64,
    /// Source frames to keep buffered. Starts from the feed's estimate and grows after
    /// an underrun (a device whose callbacks are bigger or later than it said).
    target: f64,
    buf: Vec<f32>,
    len: usize,
    pos: f64,
    nominal: f64,
    adj: f64,
    adj_avg: f64,
    integral: f64,
    fill: f64,
    primed: bool,
    pub underruns: u32,
    pub overflows: u32,
}

impl InputReader {
    pub fn new(out_rate: f32) -> InputReader {
        InputReader {
            feed: None,
            out_rate: out_rate as f64,
            target: 0.0,
            buf: vec![0.0; BUF_FRAMES * 2],
            len: 0,
            pos: 0.0,
            nominal: 1.0,
            adj: 0.0,
            adj_avg: 0.0,
            integral: 0.0,
            fill: 0.0,
            primed: false,
            underruns: 0,
            overflows: 0,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.feed.is_some()
    }

    /// True while audio is flowing (primed and not starved).
    pub fn is_live(&self) -> bool {
        self.feed.is_some() && self.primed
    }

    /// Installs a feed (the old one goes to the trash).
    pub fn set_feed(&mut self, feed: Option<Box<InputFeed>>, trash: &mut TrashBin) {
        let old = std::mem::replace(&mut self.feed, feed);
        trash.put_opt(old, Trash::Input);
        if let Some(f) = &self.feed {
            self.nominal = f.sample_rate as f64 / self.out_rate;
            self.target = f.target;
        }
        self.adj = 0.0;
        self.adj_avg = 0.0;
        self.integral = 0.0;
        self.underruns = 0;
        self.overflows = 0;
        self.unprime();
    }

    fn half(&self) -> usize {
        self.feed.as_ref().map(|f| f.sinc.taps() / 2).unwrap_or(8)
    }

    fn unprime(&mut self) {
        self.primed = false;
        let h = self.half();
        self.buf[..h * 2].fill(0.0);
        self.len = h;
        self.pos = h as f64;
    }

    /// Source frames waiting: in the ring plus not yet read from the local buffer.
    pub fn backlog(&self) -> f64 {
        let ring = self.feed.as_ref().map(|f| f.ring.slots() / 2).unwrap_or(0);
        ring as f64 + (self.len as f64 - self.pos).max(0.0)
    }

    /// Buffered input in milliseconds.
    pub fn latency_ms(&self) -> f32 {
        let sr = self.feed.as_ref().map(|f| f.sample_rate as f64).unwrap_or(self.out_rate);
        (self.fill / sr * 1000.0) as f32
    }

    /// The clock correction in parts per million (averaged over a few seconds): how much
    /// faster the input's clock runs than the output's.
    pub fn drift_ppm(&self) -> f32 {
        (self.adj_avg * 1e6) as f32
    }

    /// Discards `frames` source frames (from the local buffer first, then the ring).
    fn skip(&mut self, frames: usize) {
        let local = ((self.len as f64 - self.pos).max(0.0) as usize).min(frames);
        self.pos += local as f64;
        let rest = frames - local;
        if rest > 0 {
            if let Some(f) = self.feed.as_mut() {
                let n = (rest * 2).min(f.ring.slots() / 2 * 2);
                if let Ok(c) = f.ring.read_chunk(n) {
                    c.commit_all();
                }
            }
        }
    }

    /// Makes room at the end of the local buffer by dropping frames already read
    /// (keeping the interpolator's history).
    fn compact(&mut self) {
        let h = self.half();
        let keep_from = (self.pos.floor() as usize).saturating_sub(h);
        if keep_from == 0 {
            return;
        }
        self.buf.copy_within(keep_from * 2..self.len * 2, 0);
        self.len -= keep_from;
        self.pos -= keep_from as f64;
    }

    /// Pulls up to `want` frames from the ring into the local buffer.
    fn pull(&mut self, want: usize) {
        let Some(f) = self.feed.as_mut() else { return };
        let room = BUF_FRAMES - self.len;
        let n = want.min(room).min(f.ring.slots() / 2);
        if n == 0 {
            return;
        }
        if let Ok(c) = f.ring.read_chunk(n * 2) {
            let (a, b) = c.as_slices();
            let dst = &mut self.buf[self.len * 2..(self.len + n) * 2];
            dst[..a.len()].copy_from_slice(a);
            dst[a.len()..].copy_from_slice(b);
            c.commit_all();
            self.len += n;
        }
    }

    /// Renders `n` frames at the engine rate into `l` and `r`.
    pub fn read(&mut self, n: usize, l: &mut [f32], r: &mut [f32]) {
        l[..n].fill(0.0);
        r[..n].fill(0.0);
        if self.feed.is_none() {
            return;
        }
        let target = self.target;
        let h = self.half();
        let backlog = self.backlog();
        if !self.primed {
            // Wait for a full target's worth, then start with exactly the target.
            if backlog < target + h as f64 {
                return;
            }
            self.skip((backlog - target) as usize);
            self.primed = true;
            self.fill = target;
            self.integral = 0.0;
        } else if backlog > target * 4.0 + 4_096.0 {
            // A stall on the output side left a pile of input: drop it rather than
            // keep the extra delay.
            self.skip((backlog - target) as usize);
            self.overflows = self.overflows.saturating_add(1);
            self.fill = target;
            self.integral = 0.0;
        }

        // Clock follower: a slow PI controller on the buffered amount.
        let dt = n as f64 / self.out_rate;
        let src_rate = self.nominal * self.out_rate;
        let a = 1.0 - (-dt / 0.5).exp();
        self.fill += (self.backlog() - self.fill) * a;
        let err = (self.fill - target) / src_rate; // seconds of extra buffering
        self.integral = (self.integral + err * dt).clamp(-0.5, 0.5);
        self.adj = (0.4 * err + 0.08 * self.integral).clamp(-MAX_ADJ, MAX_ADJ);
        self.adj_avg += (self.adj - self.adj_avg) * (1.0 - (-dt / 4.0).exp());
        let step = self.nominal * (1.0 + self.adj);

        // Make sure the local buffer holds every frame this block reads.
        let need = (self.pos + n as f64 * step).ceil() as usize + h + 1;
        if need > self.len {
            if need > BUF_FRAMES {
                self.compact();
            }
            let need = (self.pos + n as f64 * step).ceil() as usize + h + 1;
            self.pull(need.saturating_sub(self.len));
        }
        let Some(f) = self.feed.as_ref() else { return };
        let limit = self.len as f64 - h as f64 - 1.0;
        for i in 0..n {
            if self.pos > limit {
                // Starved: the device stopped delivering (or was unplugged).
                self.underruns = self.underruns.saturating_add(1);
                let max = 0.12 * self.nominal * self.out_rate;
                self.target = (self.target * 1.5).min(max.max(self.target));
                self.unprime();
                return;
            }
            let (a, b) = f.sinc.read_stereo(&self.buf, self.len, self.pos);
            l[i] = a;
            r[i] = b;
            self.pos += step;
        }
        if self.pos as usize > BUF_FRAMES / 2 {
            self.compact();
        }
    }
}

/// What to do with the mic channel.
pub enum MicCommand {
    /// Connects an input device (or disconnects with `None`).
    SetFeed(Option<Box<InputFeed>>),
    /// Sends the mic to the master output (the audience hears it).
    SetOnAir(bool),
    /// Sends the mic to the headphones.
    SetCue(bool),
    SetGainDb(f32),
    SetEq(usize, f32),
    /// Channel volume, 0…1.
    SetLevel(f32),
    SetLowCut(bool),
    SetGate(bool),
    SetTalkover(bool),
    /// How far talk-over turns the music down (negative dB).
    SetTalkoverDepth(f32),
    /// Uses one mic signal on both sides (most mics and laptop arrays).
    SetMono(bool),
    /// Records the processed mic (before its volume) into the capture ring.
    Capture(bool),
}

/// The mic channel strip.
pub struct MicChannel {
    sr: f32,
    pub reader: InputReader,
    mono: bool,
    gain: Smoothed,
    low_cut_on: bool,
    low_cut: StereoBiquad,
    gate_on: bool,
    gate: Gate,
    pub eq: DjEq,
    level_pos: f32,
    level: Smoothed,
    on_air: bool,
    air: Smoothed,
    cue: bool,
    talkover: bool,
    depth_db: f32,
    talk_env: EnvelopeFollower,
    talk_hold: u32,
    duck: f32,
    duck_att: f32,
    duck_rel: f32,
    l: Vec<f32>,
    r: Vec<f32>,
    peak: [f32; 2],
    sum_sq: f64,
    count: u64,
    min_duck: f32,
    capture: bool,
    cap_tx: rtrb::Producer<f32>,
    pub captured: u64,
    pub capture_overruns: u32,
}

impl MicChannel {
    pub fn new(sr: f32, cap_tx: rtrb::Producer<f32>) -> MicChannel {
        let mut eq = DjEq::new(sr, EqVoicing::default());
        eq.set_mode_now(EqMode::Classic);
        MicChannel {
            sr,
            reader: InputReader::new(sr),
            mono: true,
            gain: Smoothed::new(1.0, 20.0, sr),
            low_cut_on: true,
            low_cut: StereoBiquad::new(Coeffs::highpass(LOW_CUT_HZ, std::f64::consts::FRAC_1_SQRT_2, sr as f64)),
            gate_on: false,
            gate: Gate::new(
                sr,
                GateSettings {
                    threshold_db: -50.0,
                    hysteresis_db: 6.0,
                    attack_ms: 2.0,
                    hold_ms: 150.0,
                    release_ms: 250.0,
                    range_db: -30.0,
                },
            ),
            eq,
            level_pos: 0.8,
            level: Smoothed::new(0.8, 10.0, sr),
            on_air: false,
            air: Smoothed::new(0.0, 15.0, sr),
            cue: false,
            talkover: true,
            depth_db: -12.0,
            talk_env: EnvelopeFollower::new(0.005, 0.06, sr),
            talk_hold: 0,
            duck: 1.0,
            duck_att: one_pole_coeff(0.04, sr),
            duck_rel: one_pole_coeff(0.6, sr),
            l: vec![0.0; BLOCK],
            r: vec![0.0; BLOCK],
            peak: [0.0; 2],
            sum_sq: 0.0,
            count: 0,
            min_duck: 1.0,
            capture: false,
            cap_tx,
            captured: 0,
            capture_overruns: 0,
        }
    }

    pub fn handle(&mut self, cmd: MicCommand, trash: &mut TrashBin) {
        match cmd {
            MicCommand::SetFeed(f) => self.reader.set_feed(f, trash),
            MicCommand::SetOnAir(on) => {
                self.on_air = on;
                self.air.set(if on { 1.0 } else { 0.0 });
            }
            MicCommand::SetCue(on) => self.cue = on,
            MicCommand::SetGainDb(db) => self.gain.set(db_to_gain(db.clamp(-20.0, 30.0))),
            MicCommand::SetEq(band, db) => self.eq.set_gain_db(band, db),
            MicCommand::SetLevel(v) => {
                self.level_pos = v.clamp(0.0, 1.0);
                self.level.set(mixit_dsp::curves::fader_gain(self.level_pos, mixit_dsp::curves::FaderCurve::Smooth));
            }
            MicCommand::SetLowCut(on) => {
                if on && !self.low_cut_on {
                    self.low_cut.reset();
                }
                self.low_cut_on = on;
            }
            MicCommand::SetGate(on) => self.gate_on = on,
            MicCommand::SetTalkover(on) => self.talkover = on,
            MicCommand::SetTalkoverDepth(db) => self.depth_db = db.clamp(-40.0, 0.0),
            MicCommand::SetMono(on) => self.mono = on,
            MicCommand::Capture(on) => {
                if on && !self.capture {
                    self.captured = 0;
                    self.capture_overruns = 0;
                }
                self.capture = on;
            }
        }
    }

    pub fn on_air(&self) -> bool {
        self.on_air
    }

    pub fn capturing(&self) -> bool {
        self.capture
    }

    pub fn gate_open(&self) -> bool {
        !self.gate_on || self.gate.is_open()
    }

    /// Takes the meters since the last call: (peak, rms, deepest talk-over in dB).
    pub fn take_meters(&mut self) -> ([f32; 2], f32, f32) {
        let rms = if self.count > 0 { (self.sum_sq / self.count as f64).sqrt() as f32 } else { 0.0 };
        let p = self.peak;
        let duck = gain_to_db(self.min_duck.max(1e-6)).min(0.0);
        self.peak = [0.0; 2];
        self.sum_sq = 0.0;
        self.count = 0;
        self.min_duck = self.duck;
        (p, rms, duck)
    }

    /// Reads and processes the input for a chunk, then ducks the music already on the
    /// master bus and adds the mic to the master and cue buses.
    pub fn render(&mut self, n: usize, mixer: &mut Mixer) {
        if !self.reader.is_connected() {
            self.air.advance(n as u32);
            self.release_duck(n, mixer);
            return;
        }
        let (l, r) = (&mut self.l[..n], &mut self.r[..n]);
        self.reader.read(n, l, r);
        if self.mono {
            for i in 0..n {
                let m = 0.5 * (l[i] + r[i]);
                l[i] = m;
                r[i] = m;
            }
        }
        for i in 0..n {
            let g = self.gain.next();
            l[i] *= g;
            r[i] *= g;
        }
        if self.low_cut_on {
            for i in 0..n {
                l[i] = self.low_cut.l.process(l[i]);
                r[i] = self.low_cut.r.process(r[i]);
            }
        }
        if self.gate_on {
            self.gate.process(l, r);
        }
        if !self.eq.is_transparent() {
            self.eq.process(l, r);
        }
        for i in 0..n {
            let (a, b) = (l[i].abs(), r[i].abs());
            self.peak[0] = self.peak[0].max(a);
            self.peak[1] = self.peak[1].max(b);
            self.sum_sq += 0.5 * (l[i] as f64 * l[i] as f64 + r[i] as f64 * r[i] as f64);
        }
        self.count += n as u64;
        if self.capture {
            write_stereo(&mut self.cap_tx, l, r, &mut self.captured, &mut self.capture_overruns);
        }
        if self.cue {
            for i in 0..n {
                mixer.cue_l[i] += l[i];
                mixer.cue_r[i] += r[i];
            }
        }

        // Talk-over: duck the music while the mic is on air and someone is speaking.
        let threshold = db_to_gain(TALK_THRESHOLD_DB);
        let hold = (0.35 * self.sr) as u32;
        let floor = db_to_gain(self.depth_db);
        let active = self.talkover && self.on_air;
        for i in 0..n {
            let e = self.talk_env.process(l[i].abs().max(r[i].abs()));
            if active && e > threshold {
                self.talk_hold = hold;
            } else if self.talk_hold > 0 {
                self.talk_hold -= 1;
            }
            let target = if active && self.talk_hold > 0 { floor } else { 1.0 };
            let c = if target < self.duck { self.duck_att } else { self.duck_rel };
            self.duck = target + c * (self.duck - target);
            self.min_duck = self.min_duck.min(self.duck);
            mixer.master_l[i] *= self.duck;
            mixer.master_r[i] *= self.duck;
        }

        for i in 0..n {
            let g = self.level.next() * self.air.next();
            mixer.master_l[i] += l[i] * g;
            mixer.master_r[i] += r[i] * g;
        }
    }

    /// Lets a duck that was in progress recover when the mic goes away.
    fn release_duck(&mut self, n: usize, mixer: &mut Mixer) {
        if self.duck >= 0.9999 {
            self.duck = 1.0;
            return;
        }
        for i in 0..n {
            self.duck = 1.0 + self.duck_rel * (self.duck - 1.0);
            mixer.master_l[i] *= self.duck;
            mixer.master_r[i] *= self.duck;
        }
    }
}

fn write_stereo(tx: &mut rtrb::Producer<f32>, l: &[f32], r: &[f32], count: &mut u64, overruns: &mut u32) {
    let n = l.len();
    if tx.slots() < n * 2 {
        *overruns = overruns.saturating_add(1);
        return;
    }
    if let Ok(mut chunk) = tx.write_chunk_uninit(n * 2) {
        let (a, b) = chunk.as_mut_slices();
        for (k, slot) in a.iter_mut().chain(b.iter_mut()).enumerate() {
            slot.write(if k % 2 == 0 { l[k / 2] } else { r[k / 2] });
        }
        // SAFETY: every slot of both slices was written above.
        unsafe { chunk.commit_all() };
        *count += n as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bin() -> (TrashBin, rtrb::Consumer<Trash>) {
        let (tx, rx) = rtrb::RingBuffer::new(16);
        (TrashBin::new(tx), rx)
    }

    /// A device whose clock runs `ppm` fast relative to the output, delivering a sine in
    /// callbacks of `frames`.
    fn simulate(in_rate: u32, out_rate: u32, ppm: f64, frames: usize, seconds: f64) -> (InputReader, Vec<f32>) {
        let (mut tx, feed) = InputFeed::new(in_rate, out_rate, frames as u32);
        let (mut trash, _rx) = bin();
        let mut rd = InputReader::new(out_rate as f32);
        rd.set_feed(Some(Box::new(feed)), &mut trash);
        let true_in = in_rate as f64 * (1.0 + ppm * 1e-6);
        let mut t_in = 0u64;
        let mut produced_time = 0.0f64;
        let mut out = Vec::new();
        let (mut l, mut r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
        let blocks = (seconds * out_rate as f64 / BLOCK as f64) as usize;
        let mut chunk = vec![0.0f32; frames * 2];
        for b in 0..blocks {
            let now = (b + 1) as f64 * BLOCK as f64 / out_rate as f64;
            // The input callback fires whenever another `frames` have been captured.
            while produced_time + frames as f64 / true_in <= now {
                for k in 0..frames {
                    let s =
                        (2.0 * std::f64::consts::PI * 440.0 * (t_in + k as u64) as f64 / in_rate as f64).sin() as f32;
                    chunk[2 * k] = s * 0.5;
                    chunk[2 * k + 1] = s * 0.5;
                }
                t_in += frames as u64;
                produced_time += frames as f64 / true_in;
                push_input(&mut tx, &chunk);
            }
            rd.read(BLOCK, &mut l, &mut r);
            out.extend_from_slice(&l);
        }
        (rd, out)
    }

    #[test]
    fn follows_a_drifting_clock_without_dropouts() {
        for ppm in [-300.0, 0.0, 250.0] {
            let (rd, out) = simulate(48_000, 48_000, ppm, 480, 40.0);
            assert_eq!(rd.underruns, 0, "{ppm} ppm: underruns");
            assert_eq!(rd.overflows, 0, "{ppm} ppm: overflows");
            assert!((rd.drift_ppm() as f64 - ppm).abs() < 60.0, "{ppm} ppm: settled at {}", rd.drift_ppm());
            // Latency stays near the target (2 callbacks + a block ≈ 25 ms).
            assert!(rd.latency_ms() < 40.0, "{ppm}: {} ms", rd.latency_ms());
            // The last seconds are a clean sine: no clicks from skipped samples.
            let tail = &out[out.len() - 48_000..];
            let max_step = tail.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
            let ideal = 0.5 * 2.0 * std::f32::consts::PI * 440.0 / 48_000.0;
            assert!(max_step < ideal * 1.1, "{ppm}: step {max_step} vs {ideal}");
            let rms = (tail.iter().map(|x| x * x).sum::<f32>() / tail.len() as f32).sqrt();
            assert!((rms - 0.5 / 2f32.sqrt()).abs() < 0.01, "{ppm}: rms {rms}");
        }
    }

    #[test]
    fn converts_between_sample_rates() {
        let (rd, out) = simulate(44_100, 48_000, 80.0, 441, 20.0);
        assert_eq!(rd.underruns, 0);
        let tail = &out[out.len() - 48_000..];
        // Count zero crossings: a 440 Hz tone at the output rate.
        let crossings = tail.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((crossings as i32 - 440).abs() <= 1, "{crossings}");
    }

    #[test]
    fn recovers_after_the_device_stalls() {
        let (mut tx, feed) = InputFeed::new(48_000, 48_000, 256);
        let (mut trash, _rx) = bin();
        let mut rd = InputReader::new(48_000.0);
        rd.set_feed(Some(Box::new(feed)), &mut trash);
        let (mut l, mut r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
        let chunk = vec![0.25f32; 256 * 2];
        for _ in 0..200 {
            push_input(&mut tx, &chunk);
            rd.read(BLOCK, &mut l, &mut r);
        }
        assert!(rd.is_live());
        // The device stops: the reader starves once, outputs silence, and waits.
        for _ in 0..10 {
            rd.read(BLOCK, &mut l, &mut r);
        }
        assert_eq!(rd.underruns, 1);
        assert!(!rd.is_live());
        assert!(l.iter().all(|x| *x == 0.0));
        // It comes back.
        for _ in 0..50 {
            push_input(&mut tx, &chunk);
            rd.read(BLOCK, &mut l, &mut r);
        }
        assert!(rd.is_live());
        assert!((l[BLOCK / 2] - 0.25).abs() < 1e-3);
    }

    fn mic_with_feed() -> (MicChannel, rtrb::Producer<f32>, Mixer, rtrb::Consumer<f32>) {
        let (cap_tx, cap_rx) = rtrb::RingBuffer::new(48_000 * 4);
        let mut mic = MicChannel::new(48_000.0, cap_tx);
        let (tx, feed) = InputFeed::new(48_000, 48_000, 256);
        let (mut trash, _rx) = bin();
        mic.handle(MicCommand::SetFeed(Some(Box::new(feed))), &mut trash);
        mic.handle(MicCommand::SetLevel(1.0), &mut trash);
        (mic, tx, Mixer::new(48_000.0, 2), cap_rx)
    }

    fn run(
        mic: &mut MicChannel,
        tx: &mut rtrb::Producer<f32>,
        mixer: &mut Mixer,
        voice: f32,
        music: f32,
        blocks: usize,
    ) -> f32 {
        let mut chunk = vec![0.0f32; BLOCK * 2];
        let mut out = 0.0f32;
        for b in 0..blocks {
            for k in 0..BLOCK {
                let t = (b * BLOCK + k) as f32 / 48_000.0;
                let s = voice * (2.0 * std::f32::consts::PI * 300.0 * t).sin();
                chunk[2 * k] = s;
                chunk[2 * k + 1] = s;
            }
            push_input(tx, &chunk);
            mixer.begin(BLOCK);
            mixer.master_l[..BLOCK].fill(music);
            mixer.master_r[..BLOCK].fill(music);
            mic.render(BLOCK, mixer);
            out = mixer.master_l[BLOCK - 1];
        }
        out
    }

    #[test]
    fn talk_over_ducks_the_music_only_while_speaking_on_air() {
        let (mut mic, mut tx, mut mixer, _cap) = mic_with_feed();
        let (mut trash, _rx) = bin();
        // Off air: the music is untouched and the mic is not heard.
        let out = run(&mut mic, &mut tx, &mut mixer, 0.3, 0.5, 200);
        assert!((out - 0.5).abs() < 1e-4, "{out}");
        mic.handle(MicCommand::SetOnAir(true), &mut trash);
        mic.handle(MicCommand::SetLevel(0.0), &mut trash); // hear only the duck
        run(&mut mic, &mut tx, &mut mixer, 0.3, 0.5, 200);
        let (_, _, duck) = mic.take_meters();
        assert!((duck + 12.0).abs() < 0.5, "ducked {duck} dB");
        // Silence: the music comes back after the hold and release.
        let out = run(&mut mic, &mut tx, &mut mixer, 0.0, 0.5, 600);
        assert!((out - 0.5).abs() < 0.01, "{out}");
        // Talk-over off: no ducking.
        mic.handle(MicCommand::SetTalkover(false), &mut trash);
        let out = run(&mut mic, &mut tx, &mut mixer, 0.3, 0.5, 200);
        assert!((out - 0.5).abs() < 1e-3, "{out}");
    }

    #[test]
    fn on_air_mic_reaches_the_master_and_capture() {
        let (mut mic, mut tx, mut mixer, cap) = mic_with_feed();
        let (mut trash, _rx) = bin();
        mic.handle(MicCommand::SetOnAir(true), &mut trash);
        mic.handle(MicCommand::SetTalkover(false), &mut trash);
        mic.handle(MicCommand::Capture(true), &mut trash);
        let mut peak = 0.0f32;
        let mut chunk = vec![0.0f32; BLOCK * 2];
        for b in 0..100 {
            for k in 0..BLOCK {
                let s = 0.3 * (2.0 * std::f32::consts::PI * 1000.0 * (b * BLOCK + k) as f32 / 48_000.0).sin();
                chunk[2 * k] = s;
                chunk[2 * k + 1] = s;
            }
            push_input(&mut tx, &chunk);
            mixer.begin(BLOCK);
            mic.render(BLOCK, &mut mixer);
            if b > 50 {
                peak = peak.max(mixit_dsp::util::peak(&mixer.master_l[..BLOCK]));
            }
        }
        assert!((peak - 0.3).abs() < 0.02, "{peak}");
        assert!(mic.captured > 0);
        assert_eq!(cap.slots() as u64, mic.captured * 2);
        let (p, rms, _) = mic.take_meters();
        assert!(p[0] > 0.25 && rms > 0.15, "{p:?} {rms}");
    }
}
