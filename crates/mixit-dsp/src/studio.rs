//! Studio channel processing: the insert chain a mixing console gives every channel.
//!
//! ```text
//! in → gate → parametric EQ → compressor → saturation → stereo width → output gain → out
//! ```
//!
//! Every stage can be switched on and off mid-song without a click (each switch is a
//! short crossfade between the processed and the unprocessed signal), every knob is
//! smoothed, and a strip with everything off costs nothing.
//!
//! Also here: [`Ducker`], which turns one channel down while another plays (sidechain
//! ducking), and the "one knob" mappings behind the Easy view ([`CompressorSettings::punch`],
//! [`CompressorSettings::glue`]).

use crate::dynamics::{Compressor, CompressorSettings, Gate, GateSettings};
use crate::peq::{BandSettings, MAX_BANDS, ParametricEq};
use crate::smooth::Smoothed;
use crate::util::{db_to_gain, flush, one_pole_coeff};

/// Crossfade time when a stage is switched on or off.
const SWITCH_MS: f32 = 20.0;

impl CompressorSettings {
    /// "Punch" for one channel, 0 (off) … 1 (squashed): slow enough attack to let the
    /// drums' attack through, then holds the body of the sound up.
    pub fn punch(amount: f32) -> CompressorSettings {
        let a = amount.clamp(0.0, 1.0);
        CompressorSettings {
            threshold_db: -6.0 - 24.0 * a,
            ratio: 1.5 + 4.5 * a,
            knee_db: 6.0,
            attack_ms: 15.0,
            release_ms: 120.0,
            makeup_db: 0.0,
            auto_makeup: true,
            sidechain_hpf_hz: 60.0,
            mix: 1.0,
        }
    }

    /// "Glue" for the master bus, 0 … 1: a gentle 2:1 bus compressor that makes the
    /// tracks sound like one mix. The detector ignores sub-bass so kicks do not pump it.
    pub fn glue(amount: f32) -> CompressorSettings {
        let a = amount.clamp(0.0, 1.0);
        CompressorSettings {
            threshold_db: -4.0 - 16.0 * a,
            ratio: 2.0,
            knee_db: 6.0,
            attack_ms: 30.0,
            release_ms: 200.0,
            makeup_db: 0.0,
            auto_makeup: true,
            sidechain_hpf_hz: 90.0,
            mix: 1.0,
        }
    }
}

/// `ln(cosh(x))`, the antiderivative of `tanh`, without overflow for large `x`.
#[inline]
fn log_cosh(x: f32) -> f32 {
    let a = x.abs();
    if a < 12.0 { a.cosh().ln() } else { a - std::f32::consts::LN_2 }
}

/// Tape-style saturation: a soft `tanh` curve with a touch of asymmetry (even
/// harmonics, the "warm" part), using first-order antiderivative anti-aliasing so
/// heavy drive does not fold harsh aliases back into the audible range.
///
/// The output is divided by the drive, so quiet passages stay at the same level and
/// only the peaks are rounded off: turning the knob makes the sound denser and warmer,
/// not simply louder.
#[derive(Clone, Debug)]
pub struct Saturator {
    drive: Smoothed,
    x1: [f32; 2],
    f1: [f32; 2],
    /// DC blocker state (the asymmetry adds a little DC).
    dc_x: [f32; 2],
    dc_y: [f32; 2],
    dc_r: f32,
}

/// Bias that makes the curve asymmetric.
const BIAS: f32 = 0.12;

impl Saturator {
    pub fn new(sr: f32) -> Saturator {
        Saturator {
            drive: Smoothed::new(1.0, 30.0, sr),
            x1: [0.0; 2],
            f1: [log_cosh(BIAS); 2],
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
            dc_r: 1.0 - 2.0 * std::f32::consts::PI * 8.0 / sr,
        }
    }

    /// Drive in dB (0 … 24).
    pub fn set_drive_db(&mut self, db: f32) {
        self.drive.set(db_to_gain(db.clamp(0.0, 30.0)));
    }

    pub fn reset(&mut self) {
        self.x1 = [0.0; 2];
        self.f1 = [log_cosh(BIAS); 2];
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
    }

    #[inline]
    fn shape(&mut self, ch: usize, x: f32) -> f32 {
        // tanh(x + b) − tanh(b), anti-aliased: (F(x) − F(x₁)) / (x − x₁).
        let u = x + BIAS;
        let f = log_cosh(u);
        let d = u - (self.x1[ch] + BIAS);
        let y = if d.abs() > 1e-4 { (f - self.f1[ch]) / d } else { (0.5 * (u + self.x1[ch] + BIAS)).tanh() };
        self.x1[ch] = x;
        self.f1[ch] = f;
        let y = y - BIAS.tanh();
        // DC blocker.
        let out = y - self.dc_x[ch] + self.dc_r * self.dc_y[ch];
        self.dc_x[ch] = y;
        self.dc_y[ch] = flush(out);
        out
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len().min(r.len()) {
            let g = self.drive.next();
            // Compensate the small-signal slope of tanh at the bias point too.
            let comp = 1.0 / (g * (1.0 - BIAS.tanh().powi(2)));
            l[i] = self.shape(0, l[i] * g) * comp;
            r[i] = self.shape(1, r[i] * g) * comp;
        }
    }
}

/// Turns a signal down while a sidechain signal is loud (a "ducker"): the bass of one
/// deck makes room for the kick of another, or the music dips under a voice.
#[derive(Clone, Debug)]
pub struct Ducker {
    sr: f32,
    /// How far down it goes (positive dB).
    depth_db: f32,
    threshold_db: f32,
    gr_db: f32,
    att: f32,
    rel: f32,
    det: f32,
    det_att: f32,
    det_rel: f32,
    /// Largest reduction in the last block (positive dB), for meters.
    pub meter_db: f32,
}

impl Ducker {
    pub fn new(sr: f32) -> Ducker {
        let mut d = Ducker {
            sr,
            depth_db: 0.0,
            threshold_db: -30.0,
            gr_db: 0.0,
            att: 0.0,
            rel: 0.0,
            det: 0.0,
            det_att: one_pole_coeff(0.002, sr),
            det_rel: one_pole_coeff(0.06, sr),
            meter_db: 0.0,
        };
        d.set_times(10.0, 250.0);
        d
    }

    pub fn set_depth_db(&mut self, db: f32) {
        self.depth_db = db.abs().min(40.0);
    }

    pub fn depth_db(&self) -> f32 {
        self.depth_db
    }

    pub fn set_threshold_db(&mut self, db: f32) {
        self.threshold_db = db.clamp(-60.0, 0.0);
    }

    pub fn set_times(&mut self, attack_ms: f32, release_ms: f32) {
        self.att = one_pole_coeff(attack_ms.max(0.1) * 0.001, self.sr);
        self.rel = one_pole_coeff(release_ms.max(1.0) * 0.001, self.sr);
    }

    /// Whether it is doing anything (depth set, or still recovering).
    pub fn is_active(&self) -> bool {
        self.depth_db > 0.0 || self.gr_db > 0.001
    }

    /// Ducks `l`/`r` by the level of the sidechain `sl`/`sr` (same length).
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sl: &[f32], sr: &[f32]) {
        let n = l.len().min(r.len()).min(sl.len()).min(sr.len());
        let mut max_gr = 0.0f32;
        for i in 0..n {
            let x = sl[i].abs().max(sr[i].abs());
            let a = if x > self.det { self.det_att } else { self.det_rel };
            self.det = flush(x + a * (self.det - x));
            let lvl_db = if self.det > 1e-6 { 20.0 * self.det.log10() } else { -120.0 };
            // Full depth 12 dB above the threshold, with a soft start.
            let t = ((lvl_db - self.threshold_db) / 12.0).clamp(0.0, 1.0);
            let target = self.depth_db * t * t * (3.0 - 2.0 * t);
            let c = if target > self.gr_db { self.att } else { self.rel };
            self.gr_db = flush(target + c * (self.gr_db - target));
            max_gr = max_gr.max(self.gr_db);
            let g = db_to_gain(-self.gr_db);
            l[i] *= g;
            r[i] *= g;
        }
        self.meter_db = max_gr;
    }

    /// Lets the reduction recover with no sidechain (the source went silent or away).
    pub fn release(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mut max_gr = 0.0f32;
        for i in 0..l.len().min(r.len()) {
            if self.gr_db <= 1e-4 {
                self.gr_db = 0.0;
                break;
            }
            self.gr_db = flush(self.rel * self.gr_db);
            max_gr = max_gr.max(self.gr_db);
            let g = db_to_gain(-self.gr_db);
            l[i] *= g;
            r[i] *= g;
        }
        self.det = 0.0;
        self.meter_db = max_gr;
    }
}

/// Everything a studio strip can be set to. Plain data, so it can be saved with a
/// project, copied between channels and sent to the audio thread as one message.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StudioSettings {
    pub gate_on: bool,
    pub gate: GateSettings,
    pub eq_on: bool,
    pub bands: [BandSettings; MAX_BANDS],
    pub comp_on: bool,
    pub comp: CompressorSettings,
    pub sat_on: bool,
    /// Saturation drive (dB, 0 … 24).
    pub drive_db: f32,
    /// Stereo width: 0 = mono, 1 = as recorded, 2 = extra wide.
    pub width: f32,
    /// Output gain (dB).
    pub output_db: f32,
}

impl Default for StudioSettings {
    fn default() -> Self {
        StudioSettings {
            gate_on: false,
            gate: GateSettings::default(),
            eq_on: true,
            bands: [BandSettings::default(); MAX_BANDS],
            comp_on: false,
            comp: CompressorSettings::punch(0.5),
            sat_on: false,
            drive_db: 6.0,
            width: 1.0,
            output_db: 0.0,
        }
    }
}

impl PartialEq for GateSettings {
    fn eq(&self, o: &Self) -> bool {
        self.threshold_db == o.threshold_db
            && self.hysteresis_db == o.hysteresis_db
            && self.attack_ms == o.attack_ms
            && self.hold_ms == o.hold_ms
            && self.release_ms == o.release_ms
            && self.range_db == o.range_db
    }
}

impl PartialEq for CompressorSettings {
    fn eq(&self, o: &Self) -> bool {
        self.threshold_db == o.threshold_db
            && self.ratio == o.ratio
            && self.knee_db == o.knee_db
            && self.attack_ms == o.attack_ms
            && self.release_ms == o.release_ms
            && self.makeup_db == o.makeup_db
            && self.auto_makeup == o.auto_makeup
            && self.sidechain_hpf_hz == o.sidechain_hpf_hz
            && self.mix == o.mix
    }
}

/// One channel's insert chain. See the module docs.
pub struct StudioStrip {
    s: StudioSettings,
    gate: Gate,
    gate_mix: Smoothed,
    eq: ParametricEq,
    comp: Compressor,
    comp_mix: Smoothed,
    makeup: Smoothed,
    sat: Saturator,
    sat_mix: Smoothed,
    width: Smoothed,
    out: Smoothed,
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    /// Largest compressor gain reduction in the last block (positive dB).
    pub meter_gr_db: f32,
}

impl StudioStrip {
    /// Allocates scratch space for blocks of up to `max_block` frames.
    pub fn new(sr: f32, max_block: usize) -> StudioStrip {
        let s = StudioSettings::default();
        let mut st = StudioStrip {
            s,
            gate: Gate::new(sr, s.gate),
            gate_mix: Smoothed::new(0.0, SWITCH_MS, sr),
            eq: ParametricEq::new(sr),
            comp: Compressor::new(sr, s.comp),
            comp_mix: Smoothed::new(0.0, SWITCH_MS, sr),
            makeup: Smoothed::new(1.0, 30.0, sr),
            sat: Saturator::new(sr),
            sat_mix: Smoothed::new(0.0, SWITCH_MS, sr),
            width: Smoothed::new(1.0, 30.0, sr),
            out: Smoothed::new(1.0, 20.0, sr),
            dry_l: vec![0.0; max_block],
            dry_r: vec![0.0; max_block],
            meter_gr_db: 0.0,
        };
        st.set(s);
        st
    }

    pub fn settings(&self) -> &StudioSettings {
        &self.s
    }

    /// Applies new settings; every change is smoothed.
    pub fn set(&mut self, s: StudioSettings) {
        self.gate.set(s.gate);
        self.gate_mix.set(if s.gate_on { 1.0 } else { 0.0 });
        for (i, b) in s.bands.iter().enumerate() {
            self.eq.set_band(i, BandSettings { enabled: b.enabled && s.eq_on, ..*b });
        }
        // Makeup is applied here (smoothed) rather than inside the compressor, so changing
        // the amount never jumps the level.
        let makeup_db = s.comp.makeup_db
            + if s.comp.auto_makeup {
                -crate::dynamics::gain_computer(0.0, s.comp.threshold_db, s.comp.ratio, s.comp.knee_db) * 0.5
            } else {
                0.0
            };
        self.comp.set(CompressorSettings { makeup_db: 0.0, auto_makeup: false, ..s.comp });
        self.makeup.set(if s.comp_on { db_to_gain(makeup_db) } else { 1.0 });
        self.comp_mix.set(if s.comp_on { 1.0 } else { 0.0 });
        self.sat.set_drive_db(s.drive_db);
        self.sat_mix.set(if s.sat_on { 1.0 } else { 0.0 });
        self.width.set(s.width.clamp(0.0, 2.0));
        self.out.set(db_to_gain(s.output_db.clamp(-24.0, 24.0)));
        self.s = s;
    }

    pub fn eq(&self) -> &ParametricEq {
        &self.eq
    }

    pub fn gate_open(&self) -> bool {
        self.s.gate_on && self.gate.is_open()
    }

    /// True when nothing is on and nothing is fading: `process` would not change the sound.
    pub fn is_transparent(&self) -> bool {
        let off = |m: &Smoothed| m.is_steady() && m.value() == 0.0;
        off(&self.gate_mix)
            && off(&self.comp_mix)
            && off(&self.sat_mix)
            && self.makeup.is_steady()
            && self.makeup.value() == 1.0
            && self.width.is_steady()
            && self.width.value() == 1.0
            && self.out.is_steady()
            && self.out.value() == 1.0
            && self.eq.is_idle()
    }

    /// Runs `stage` with a crossfade by `mix` against the unprocessed signal.
    fn blended(
        dry_l: &mut [f32],
        dry_r: &mut [f32],
        mix: &mut Smoothed,
        l: &mut [f32],
        r: &mut [f32],
        stage: impl FnOnce(&mut [f32], &mut [f32]),
    ) {
        if mix.is_steady() && mix.value() == 0.0 {
            return;
        }
        if mix.is_steady() && mix.value() == 1.0 {
            stage(l, r);
            return;
        }
        let n = l.len();
        dry_l[..n].copy_from_slice(l);
        dry_r[..n].copy_from_slice(r);
        stage(l, r);
        for i in 0..n {
            let m = mix.next();
            l[i] = dry_l[i] + (l[i] - dry_l[i]) * m;
            r[i] = dry_r[i] + (r[i] - dry_r[i]) * m;
        }
    }

    /// Processes a block in place (at most `max_block` frames).
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len()).min(self.dry_l.len());
        let (l, r) = (&mut l[..n], &mut r[..n]);
        let gate = &mut self.gate;
        Self::blended(&mut self.dry_l, &mut self.dry_r, &mut self.gate_mix, l, r, |l, r| gate.process(l, r));
        self.eq.process(l, r);
        let comp = &mut self.comp;
        let makeup = &mut self.makeup;
        let comp_active = !(self.comp_mix.is_steady() && self.comp_mix.value() == 0.0);
        Self::blended(&mut self.dry_l, &mut self.dry_r, &mut self.comp_mix, l, r, |l, r| {
            comp.process(l, r, None);
            for i in 0..l.len() {
                let g = makeup.next();
                l[i] *= g;
                r[i] *= g;
            }
        });
        if !comp_active {
            self.makeup.advance(n as u32);
            self.comp.meter_gr_db = 0.0;
        }
        self.meter_gr_db = if self.s.comp_on { self.comp.meter_gr_db } else { 0.0 };
        let sat = &mut self.sat;
        Self::blended(&mut self.dry_l, &mut self.dry_r, &mut self.sat_mix, l, r, |l, r| sat.process(l, r));
        if !(self.width.is_steady() && self.width.value() == 1.0) {
            for i in 0..n {
                let w = self.width.next();
                let m = 0.5 * (l[i] + r[i]);
                let s = 0.5 * (l[i] - r[i]) * w;
                l[i] = m + s;
                r[i] = m - s;
            }
        }
        if !(self.out.is_steady() && self.out.value() == 1.0) {
            for i in 0..n {
                let g = self.out.next();
                l[i] *= g;
                r[i] *= g;
            }
        }
    }

    pub fn reset(&mut self) {
        self.comp.reset();
        self.sat.reset();
        self.eq.reset();
    }
}

// ------------------------------------------------------------------ spectrum

/// In-place iterative radix-2 complex FFT (forward). `re` and `im` have the same
/// power-of-two length. Allocation-free; twiddles come from `tw` (see [`fft_twiddles`]).
pub fn fft(re: &mut [f32], im: &mut [f32], tw: &[(f32, f32)]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n && tw.len() >= n / 2);
    // Bit reversal.
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let step = n / len;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (wr, wi) = tw[k * step];
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * wr - im[b] * wi;
                let ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// Twiddle factors `e^{-2πik/n}` for k in 0..n/2.
pub fn fft_twiddles(n: usize) -> Vec<(f32, f32)> {
    (0..n / 2)
        .map(|k| {
            let a = -2.0 * std::f64::consts::PI * k as f64 / n as f64;
            (a.cos() as f32, a.sin() as f32)
        })
        .collect()
}

/// A spectrum analyser for drawing behind the EQ: log-spaced bands from 20 Hz to
/// 20 kHz in dB, tilted +4.5 dB per octave so typical music looks roughly flat (the
/// way studio analysers show it). Runs on a control thread, never the audio thread.
pub struct Spectrum {
    sr: f32,
    size: usize,
    ring: Vec<f32>,
    at: usize,
    filled: usize,
    window: Vec<f32>,
    tw: Vec<(f32, f32)>,
    re: Vec<f32>,
    im: Vec<f32>,
    edges: Vec<f32>,
}

/// Number of bands [`Spectrum::bands`] returns.
pub const SPECTRUM_BANDS: usize = 96;
/// Lowest and highest band edges (Hz).
pub const SPECTRUM_RANGE: (f32, f32) = (20.0, 20_000.0);

impl Spectrum {
    pub fn new(sr: f32) -> Spectrum {
        let size = if sr > 60_000.0 { 8192 } else { 4096 };
        let window =
            (0..size).map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / size as f32).cos()).collect();
        let (lo, hi) = SPECTRUM_RANGE;
        let edges = (0..=SPECTRUM_BANDS).map(|k| lo * (hi / lo).powf(k as f32 / SPECTRUM_BANDS as f32)).collect();
        Spectrum {
            sr,
            size,
            ring: vec![0.0; size],
            at: 0,
            filled: 0,
            window,
            tw: fft_twiddles(size),
            re: vec![0.0; size],
            im: vec![0.0; size],
            edges,
        }
    }

    /// Centre frequency of band `k`.
    pub fn band_hz(k: usize) -> f32 {
        let (lo, hi) = SPECTRUM_RANGE;
        lo * (hi / lo).powf((k as f32 + 0.5) / SPECTRUM_BANDS as f32)
    }

    /// Adds mono samples.
    pub fn push(&mut self, x: &[f32]) {
        for &v in x {
            self.ring[self.at] = if v.is_finite() { v } else { 0.0 };
            self.at = (self.at + 1) % self.size;
        }
        self.filled = (self.filled + x.len()).min(self.size);
    }

    /// Adds interleaved stereo samples (mixed to mono).
    pub fn push_interleaved(&mut self, x: &[f32]) {
        for f in x.chunks_exact(2) {
            let v = 0.5 * (f[0] + f[1]);
            self.ring[self.at] = if v.is_finite() { v } else { 0.0 };
            self.at = (self.at + 1) % self.size;
        }
        self.filled = (self.filled + x.len() / 2).min(self.size);
    }

    pub fn clear(&mut self) {
        self.ring.fill(0.0);
        self.filled = 0;
    }

    /// Band levels in dB (about −100 … 0; a full-scale sine reads near 0 before tilt).
    pub fn bands(&mut self, out: &mut [f32; SPECTRUM_BANDS]) {
        let n = self.size;
        for i in 0..n {
            self.re[i] = self.ring[(self.at + i) % n] * self.window[i];
            self.im[i] = 0.0;
        }
        fft(&mut self.re, &mut self.im, &self.tw);
        let bin_hz = self.sr / n as f32;
        // Hann window coherent gain 0.5; one-sided spectrum doubles.
        let scale = 2.0 / (0.5 * n as f32);
        let mag2 = |k: usize, re: &[f32], im: &[f32]| (re[k] * re[k] + im[k] * im[k]) * scale * scale;
        for (b, o) in out.iter_mut().enumerate() {
            let (f0, f1) = (self.edges[b], self.edges[b + 1]);
            let (k0, k1) = ((f0 / bin_hz).floor() as usize, (f1 / bin_hz).ceil() as usize);
            let k1 = k1.min(n / 2);
            let p = if k1 <= k0 + 1 {
                // Narrower than a bin: interpolate the power at the centre.
                let fc = (f0 * f1).sqrt() / bin_hz;
                let k = (fc.floor() as usize).min(n / 2 - 1);
                let t = fc - k as f32;
                mag2(k, &self.re, &self.im) * (1.0 - t) + mag2(k + 1, &self.re, &self.im) * t
            } else {
                // Peak bin in the band (reads a sine's level whatever the band width).
                (k0..k1).map(|k| mag2(k, &self.re, &self.im)).fold(0.0f32, f32::max)
            };
            let fc = Self::band_hz(b);
            let tilt = 4.5 * (fc / 1000.0).log2();
            *o = (10.0 * p.max(1e-12).log10() + tilt).max(-120.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peq::BandShape;
    use crate::testkit::{self, ClickDetector};

    const SR: f32 = 48_000.0;

    fn run(st: &mut StudioStrip, x: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let (mut l, mut r) = (x.to_vec(), x.to_vec());
        for (a, b) in l.chunks_mut(256).zip(r.chunks_mut(256)) {
            st.process(a, b);
        }
        (l, r)
    }

    #[test]
    fn a_default_strip_is_bit_transparent() {
        let mut st = StudioStrip::new(SR, 256);
        assert!(st.is_transparent());
        let x = testkit::noise(48_000, 3, 0.5);
        let (l, _) = run(&mut st, &x);
        assert_eq!(l, x);
    }

    #[test]
    fn switching_every_stage_on_and_off_mid_signal_does_not_click() {
        let mut st = StudioStrip::new(SR, 256);
        let x = testkit::sine(SR as usize * 2, 220.0, SR, 0.5);
        let (mut l, mut r) = (x.clone(), x.clone());
        let on = StudioSettings {
            gate_on: true,
            comp_on: true,
            sat_on: true,
            drive_db: 18.0,
            width: 0.0,
            output_db: -6.0,
            ..StudioSettings::default()
        };
        for (k, (a, b)) in l.chunks_mut(256).zip(r.chunks_mut(256)).enumerate() {
            if k == 60 {
                st.set(on);
            }
            if k == 250 {
                st.set(StudioSettings::default());
            }
            st.process(a, b);
        }
        assert!(l.iter().all(|v| v.is_finite()));
        let clicks = ClickDetector::default().clicks(&l);
        assert!(clicks.is_empty(), "clicks at {clicks:?}");
        // Back to unity once everything has faded out.
        assert!((l[l.len() - 100] - x[x.len() - 100]).abs() < 1e-3);
    }

    #[test]
    fn eq_band_boosts_its_frequency() {
        let mut st = StudioStrip::new(SR, 256);
        let mut s = StudioSettings::default();
        s.bands[0] =
            BandSettings { enabled: true, shape: BandShape::Bell, freq: 1000.0, q: 1.0, gain_db: 6.0, slope_db: 12 };
        st.set(s);
        let x = testkit::sine(SR as usize, 1000.0, SR, 0.1);
        let (l, _) = run(&mut st, &x);
        let tail = &l[24_000..];
        let db = 20.0 * (testkit::rms(tail) / testkit::rms(&x[24_000..])).log10();
        assert!((db - 6.0).abs() < 0.3, "{db}");
    }

    #[test]
    fn compressor_evens_out_loud_and_quiet_passages() {
        let mut st = StudioStrip::new(SR, 256);
        st.set(StudioSettings { comp_on: true, comp: CompressorSettings::punch(1.0), ..StudioSettings::default() });
        let loud = testkit::sine(24_000, 200.0, SR, 0.9);
        let quiet = testkit::sine(24_000, 200.0, SR, 0.09);
        let x: Vec<f32> = loud.iter().chain(quiet.iter()).chain(loud.iter()).copied().collect();
        let (l, _) = run(&mut st, &x);
        let a = testkit::rms(&l[48_000 + 12_000..72_000]);
        let b = testkit::rms(&l[12_000..24_000]);
        // 20 dB in, much less out.
        let out_db = 20.0 * (b / a).log10();
        assert!(out_db < 10.0, "{out_db}");
        assert!(st.meter_gr_db > 3.0);
    }

    #[test]
    fn saturation_keeps_quiet_level_and_adds_harmonics() {
        let mut s = Saturator::new(SR);
        s.set_drive_db(18.0);
        let quiet = testkit::sine(48_000, 100.0, SR, 0.01);
        let (mut l, mut r) = (quiet.clone(), quiet.clone());
        s.process(&mut l, &mut r);
        let db = 20.0 * (testkit::rms(&l[10_000..]) / testkit::rms(&quiet[10_000..])).log10();
        assert!(db.abs() < 1.0, "{db}");
        s.reset();
        let loud = testkit::sine(48_000, 100.0, SR, 0.8);
        let (mut l, mut r) = (loud.clone(), loud.clone());
        s.process(&mut l, &mut r);
        assert!(l.iter().all(|v| v.abs() < 1.2));
        // Second (warmth) and third harmonics appear.
        let h2 = testkit::tone_level(&l[10_000..], 200.0, SR);
        let h3 = testkit::tone_level(&l[10_000..], 300.0, SR);
        assert!(h2 > 0.001 && h3 > 0.001, "{h2} {h3}");
        // No DC left.
        let dc: f32 = l[10_000..].iter().sum::<f32>() / 38_000.0;
        assert!(dc.abs() < 1e-3, "{dc}");
    }

    #[test]
    fn width_zero_makes_mono() {
        let mut st = StudioStrip::new(SR, 256);
        st.set(StudioSettings { width: 0.0, ..StudioSettings::default() });
        let mut l = testkit::noise(9600, 1, 0.3);
        let mut r = testkit::noise(9600, 2, 0.3);
        for (a, b) in l.chunks_mut(256).zip(r.chunks_mut(256)) {
            st.process(a, b);
        }
        for i in 4800..9600 {
            assert!((l[i] - r[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn ducker_dips_under_the_sidechain_and_recovers() {
        let mut d = Ducker::new(SR);
        d.set_depth_db(12.0);
        let n = 96_000;
        let x = vec![0.5; n];
        let kick: Vec<f32> = (0..n).map(|i| if i < 24_000 { 0.8 } else { 0.0 }).collect();
        let (mut l, mut r) = (x.clone(), x.clone());
        for k in (0..n).step_by(256) {
            let e = (k + 256).min(n);
            d.process(&mut l[k..e], &mut r[k..e], &kick[k..e], &kick[k..e]);
        }
        let mid = 20.0 * (l[20_000] / 0.5).log10();
        assert!((mid + 12.0).abs() < 0.5, "{mid}");
        let end = 20.0 * (l[n - 1] / 0.5).log10();
        assert!(end > -0.5, "{end}");
        assert!(ClickDetector::default().clicks(&l).is_empty());
    }

    #[test]
    fn fft_matches_a_direct_dft() {
        let n = 64;
        let x: Vec<f32> = (0..n).map(|i| ((i * 7 % 13) as f32 - 6.0) / 6.0).collect();
        let (mut re, mut im) = (x.clone(), vec![0.0; n]);
        fft(&mut re, &mut im, &fft_twiddles(n));
        for k in 0..n {
            let (mut a, mut b) = (0.0f64, 0.0f64);
            for (i, v) in x.iter().enumerate() {
                let w = -2.0 * std::f64::consts::PI * (k * i) as f64 / n as f64;
                a += *v as f64 * w.cos();
                b += *v as f64 * w.sin();
            }
            assert!((re[k] as f64 - a).abs() < 1e-3 && (im[k] as f64 - b).abs() < 1e-3);
        }
    }

    #[test]
    fn spectrum_shows_a_sine_in_its_band() {
        let mut sp = Spectrum::new(SR);
        sp.push(&testkit::sine(8192, 1000.0, SR, 0.5));
        let mut out = [0.0; SPECTRUM_BANDS];
        sp.bands(&mut out);
        let (k, v) = out.iter().enumerate().fold((0, -999.0f32), |m, (i, v)| if *v > m.1 { (i, *v) } else { m });
        let fc = Spectrum::band_hz(k);
        assert!((fc / 1000.0).log2().abs() < 0.15, "peak at {fc} Hz");
        // 0.5 amplitude is −6 dBFS; the tilt is 0 at 1 kHz.
        assert!((v + 6.0).abs() < 1.5, "{v}");
        // Far bands are much lower.
        assert!(out[10] < v - 40.0);
    }
}
