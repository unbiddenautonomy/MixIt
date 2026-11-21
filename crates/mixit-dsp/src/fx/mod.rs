//! Effects shared by the deck FX racks, colour FX, the Mix workspace and Arrange.
//!
//! Every effect implements [`Effect`]: it processes a block in place and returns the
//! fully wet signal. An [`FxSlot`] adds what every slot needs: dry/wet mixing, smooth
//! on/off, and echo-out tails (send-type effects keep ringing after they are switched
//! off, until the tail falls below −100 dB).
//!
//! An effect with latency (oversampled distortion) has its dry path delayed by the slot
//! for as long as it is loaded, on or off, so the slot's latency stays constant and
//! switching never jumps.
//!
//! Effects allocate their buffers in their constructor, which runs on a control
//! thread; the engine receives them ready-made (see `mixit-engine`).

pub mod color;
pub mod delay_fx;
pub mod modulation;
pub mod reverb;
pub mod rhythm;

use crate::delay::StereoDelay;
use crate::smooth::Smoothed;

/// Largest effect latency the slot compensates (frames).
pub const MAX_FX_LATENCY: usize = 64;

/// Musical timing for beat-synced effects, valid at the first sample of a block.
#[derive(Clone, Copy, Debug)]
pub struct FxContext {
    pub sample_rate: f32,
    pub bpm: f32,
    /// Beat position at the first sample of the block.
    pub beat: f64,
    /// Beats advanced per frame (bpm / 60 / sample_rate, times playback direction).
    pub beats_per_frame: f64,
}

impl FxContext {
    pub fn free(sample_rate: f32, bpm: f32) -> FxContext {
        FxContext { sample_rate, bpm, beat: 0.0, beats_per_frame: bpm as f64 / 60.0 / sample_rate as f64 }
    }

    /// Frames per beat at the current tempo.
    pub fn frames_per_beat(&self) -> f32 {
        60.0 * self.sample_rate / self.bpm.max(1.0)
    }

    /// Beat position at frame `i` of the block.
    #[inline]
    pub fn beat_at(&self, i: usize) -> f64 {
        self.beat + i as f64 * self.beats_per_frame
    }
}

/// How the slot mixes the effect with the dry signal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MixMode {
    /// Crossfade dry to wet (filters, modulation, crushers).
    Insert,
    /// Dry stays at unity and the wet signal is added on top (echoes, reverbs).
    Send,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FxKind {
    None,
    Echo,
    PingPong,
    Reverb,
    FilterLfo,
    Flanger,
    Phaser,
    Chorus,
    Gater,
    Slicer,
    BeatRepeat,
    Bitcrusher,
    Distortion,
    TapeStop,
    PitchDelay,
    RingMod,
    NoiseRiser,
    DubEcho,
}

impl FxKind {
    pub const ALL: [FxKind; 18] = [
        FxKind::None,
        FxKind::Echo,
        FxKind::PingPong,
        FxKind::Reverb,
        FxKind::FilterLfo,
        FxKind::Flanger,
        FxKind::Phaser,
        FxKind::Chorus,
        FxKind::Gater,
        FxKind::Slicer,
        FxKind::BeatRepeat,
        FxKind::Bitcrusher,
        FxKind::Distortion,
        FxKind::TapeStop,
        FxKind::PitchDelay,
        FxKind::RingMod,
        FxKind::NoiseRiser,
        FxKind::DubEcho,
    ];

    pub fn from_index(i: usize) -> FxKind {
        *Self::ALL.get(i).unwrap_or(&FxKind::None)
    }

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|k| *k == self).unwrap_or(0)
    }

    pub fn name(self) -> &'static str {
        match self {
            FxKind::None => "None",
            FxKind::Echo => "Echo",
            FxKind::PingPong => "Ping-pong delay",
            FxKind::Reverb => "Reverb",
            FxKind::FilterLfo => "Filter LFO",
            FxKind::Flanger => "Flanger",
            FxKind::Phaser => "Phaser",
            FxKind::Chorus => "Chorus",
            FxKind::Gater => "Gater",
            FxKind::Slicer => "Slicer",
            FxKind::BeatRepeat => "Beat repeat",
            FxKind::Bitcrusher => "Bitcrusher",
            FxKind::Distortion => "Distortion",
            FxKind::TapeStop => "Tape stop",
            FxKind::PitchDelay => "Pitch delay",
            FxKind::RingMod => "Ring modulator",
            FxKind::NoiseRiser => "Noise riser",
            FxKind::DubEcho => "Dub echo",
        }
    }
}

/// An audio effect. See the module docs for the contract.
pub trait Effect: Send {
    fn kind(&self) -> FxKind;
    fn mix_mode(&self) -> MixMode;
    /// Clears buffers and state.
    fn reset(&mut self);
    /// Normalised parameter `index` (0 = main, 1 = second) in 0..1.
    fn set_param(&mut self, index: usize, value: f32);
    /// Timing in beats (delay time, LFO period, gate step).
    fn set_beats(&mut self, beats: f32);
    /// Processes in place, replacing the input with the wet signal.
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext);
    /// Called when the slot switches on (beat repeat captures, risers restart).
    fn on_enable(&mut self, _ctx: &FxContext) {}
    /// Added latency in frames (reported to latency compensation).
    fn latency(&self) -> usize {
        0
    }
}

/// Creates an effect. Allocates: call from a control thread, never the audio thread.
pub fn create(kind: FxKind, sample_rate: f32) -> Option<Box<dyn Effect>> {
    use delay_fx::*;
    let sr = sample_rate;
    Some(match kind {
        FxKind::None => return None,
        FxKind::Echo => Box::new(Echo::new(sr, EchoStyle::Classic)),
        FxKind::PingPong => Box::new(Echo::new(sr, EchoStyle::PingPong)),
        FxKind::DubEcho => Box::new(Echo::new(sr, EchoStyle::Dub)),
        FxKind::PitchDelay => Box::new(PitchDelay::new(sr)),
        FxKind::Reverb => Box::new(reverb::Reverb::new(sr)),
        FxKind::FilterLfo => Box::new(modulation::FilterLfo::new(sr)),
        FxKind::Flanger => Box::new(modulation::Flanger::new(sr)),
        FxKind::Phaser => Box::new(modulation::Phaser::new(sr)),
        FxKind::Chorus => Box::new(modulation::Chorus::new(sr)),
        FxKind::RingMod => Box::new(modulation::RingMod::new(sr)),
        FxKind::Gater => Box::new(rhythm::Gater::new(sr)),
        FxKind::Slicer => Box::new(rhythm::Slicer::new(sr)),
        FxKind::BeatRepeat => Box::new(rhythm::BeatRepeat::new(sr)),
        FxKind::TapeStop => Box::new(rhythm::TapeStop::new(sr)),
        FxKind::Bitcrusher => Box::new(color::Bitcrusher::new(sr)),
        FxKind::Distortion => Box::new(color::Distortion::new(sr)),
        FxKind::NoiseRiser => Box::new(color::NoiseRiser::new(sr)),
    })
}

/// Beat choices offered by the FX timing selector.
pub const BEAT_CHOICES: [f32; 10] = [1.0 / 16.0, 1.0 / 8.0, 0.25, 0.5, 0.75, 1.0, 2.0, 4.0, 8.0, 16.0];

/// One slot in an FX rack: an optional effect plus on/off, amount and tail handling.
pub struct FxSlot {
    effect: Option<Box<dyn Effect>>,
    on: bool,
    mix: Smoothed,
    gate: Smoothed,
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    dry_delay: StereoDelay,
    silent_frames: u32,
    tail_done: bool,
    beats: f32,
    params: [f32; 2],
    sr: f32,
}

impl FxSlot {
    pub fn new(sample_rate: f32, max_block: usize) -> FxSlot {
        FxSlot {
            effect: None,
            on: false,
            mix: Smoothed::new(0.5, 15.0, sample_rate),
            gate: Smoothed::new(0.0, 10.0, sample_rate),
            dry_l: vec![0.0; max_block],
            dry_r: vec![0.0; max_block],
            dry_delay: StereoDelay::new(MAX_FX_LATENCY + 4),
            silent_frames: 0,
            tail_done: true,
            beats: 0.5,
            params: [0.5, 0.5],
            sr: sample_rate,
        }
    }

    /// Installs an effect and returns the previous one (drop it off the audio thread).
    pub fn set_effect(&mut self, mut fx: Option<Box<dyn Effect>>) -> Option<Box<dyn Effect>> {
        if let Some(f) = fx.as_mut() {
            f.set_beats(self.beats);
            f.set_param(0, self.params[0]);
            f.set_param(1, self.params[1]);
        }
        self.tail_done = !self.on;
        std::mem::replace(&mut self.effect, fx)
    }

    pub fn kind(&self) -> FxKind {
        self.effect.as_ref().map(|e| e.kind()).unwrap_or(FxKind::None)
    }

    pub fn set_on(&mut self, on: bool, ctx: &FxContext) {
        if on && !self.on {
            if let Some(e) = self.effect.as_mut() {
                if self.tail_done {
                    e.reset();
                }
                e.on_enable(ctx);
            }
            self.tail_done = false;
            self.silent_frames = 0;
        }
        self.on = on;
        self.gate.set(if on { 1.0 } else { 0.0 });
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    pub fn set_mix(&mut self, m: f32) {
        self.mix.set(m.clamp(0.0, 1.0));
    }

    pub fn set_beats(&mut self, beats: f32) {
        self.beats = beats;
        if let Some(e) = self.effect.as_mut() {
            e.set_beats(beats);
        }
    }

    pub fn set_param(&mut self, index: usize, v: f32) {
        if index < 2 {
            self.params[index] = v;
        }
        if let Some(e) = self.effect.as_mut() {
            e.set_param(index, v);
        }
    }

    pub fn latency(&self) -> usize {
        self.effect.as_ref().map(|e| e.latency().min(MAX_FX_LATENCY)).unwrap_or(0)
    }

    /// True while the effect is producing sound (on, or ringing out).
    pub fn is_active(&self) -> bool {
        self.effect.is_some() && (self.on || !self.tail_done || !self.gate.is_steady())
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let n = l.len().min(r.len()).min(self.dry_l.len());
        let lat = self.latency();
        if !self.is_active() {
            self.mix.advance(n as u32);
            if lat > 0 {
                for i in 0..n {
                    self.dry_delay.l.push(l[i]);
                    self.dry_delay.r.push(r[i]);
                    l[i] = self.dry_delay.l.tap(lat + 1);
                    r[i] = self.dry_delay.r.tap(lat + 1);
                }
            }
            return;
        }
        let Some(e) = self.effect.as_mut() else {
            return;
        };
        if lat > 0 {
            for i in 0..n {
                self.dry_delay.l.push(l[i]);
                self.dry_delay.r.push(r[i]);
                self.dry_l[i] = self.dry_delay.l.tap(lat + 1);
                self.dry_r[i] = self.dry_delay.r.tap(lat + 1);
            }
        } else {
            self.dry_l[..n].copy_from_slice(&l[..n]);
            self.dry_r[..n].copy_from_slice(&r[..n]);
        }
        match e.mix_mode() {
            MixMode::Send => {
                // Input to the effect is gated, so tails continue after switching off.
                for i in 0..n {
                    let g = self.gate.next();
                    l[i] *= g;
                    r[i] *= g;
                }
                e.process(&mut l[..n], &mut r[..n], ctx);
                let mut energy = 0.0f32;
                for i in 0..n {
                    let m = self.mix.next();
                    energy = energy.max(l[i].abs()).max(r[i].abs());
                    l[i] = self.dry_l[i] + l[i] * m;
                    r[i] = self.dry_r[i] + r[i] * m;
                }
                if !self.on {
                    if energy < 1e-5 {
                        self.silent_frames += n as u32;
                        if self.silent_frames > (self.sr * 0.25) as u32 {
                            self.tail_done = true;
                        }
                    } else {
                        self.silent_frames = 0;
                    }
                }
            }
            MixMode::Insert => {
                e.process(&mut l[..n], &mut r[..n], ctx);
                for i in 0..n {
                    let w = self.mix.next() * self.gate.next();
                    l[i] = self.dry_l[i] + (l[i] - self.dry_l[i]) * w;
                    r[i] = self.dry_r[i] + (r[i] - self.dry_r[i]) * w;
                }
                if !self.on && self.gate.is_steady() {
                    self.tail_done = true;
                }
            }
        }
    }
}

/// A deck or master FX rack: three slots in series.
pub struct FxRack {
    pub slots: [FxSlot; 3],
}

impl FxRack {
    pub fn new(sample_rate: f32, max_block: usize) -> FxRack {
        FxRack {
            slots: [
                FxSlot::new(sample_rate, max_block),
                FxSlot::new(sample_rate, max_block),
                FxSlot::new(sample_rate, max_block),
            ],
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        for s in &mut self.slots {
            s.process(l, r, ctx);
        }
    }

    pub fn is_active(&self) -> bool {
        self.slots.iter().any(|s| s.is_active())
    }

    /// Total latency of the loaded effects (constant while the same effects are loaded).
    pub fn latency(&self) -> usize {
        self.slots.iter().map(|s| s.latency()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit;

    #[test]
    fn every_effect_is_stable_and_finite() {
        let sr = 48_000.0;
        for kind in FxKind::ALL {
            let Some(mut e) = create(kind, sr) else {
                continue;
            };
            for p in [0.0, 0.5, 1.0] {
                e.set_param(0, p);
                e.set_param(1, 1.0 - p);
                for beats in [0.125f32, 1.0, 4.0] {
                    e.set_beats(beats);
                    let mut ctx = FxContext::free(sr, 128.0);
                    e.on_enable(&ctx);
                    let mut peak = 0.0f32;
                    for block in 0..200 {
                        let mut l = testkit::noise(256, block as u64 + 1, 0.5);
                        let mut r = testkit::noise(256, block as u64 + 99, 0.5);
                        e.process(&mut l, &mut r, &ctx);
                        ctx.beat += 256.0 * ctx.beats_per_frame;
                        for v in l.iter().chain(r.iter()) {
                            assert!(v.is_finite(), "{kind:?} produced a non-finite sample");
                            peak = peak.max(v.abs());
                        }
                    }
                    assert!(peak < 8.0, "{kind:?} p={p} beats={beats} peak {peak}");
                }
            }
        }
    }

    #[test]
    fn echo_tail_continues_after_switch_off() {
        let sr = 48_000.0;
        let mut slot = FxSlot::new(sr, 512);
        slot.set_effect(create(FxKind::Echo, sr));
        slot.set_beats(0.25);
        slot.set_param(0, 0.6);
        slot.set_mix(1.0);
        let ctx = FxContext::free(sr, 120.0);
        slot.set_on(true, &ctx);
        let mut l = testkit::sine(512, 440.0, sr, 0.5);
        let mut r = l.clone();
        slot.process(&mut l, &mut r, &ctx);
        slot.set_on(false, &ctx);
        // Feed silence: the echo of the burst must still come out.
        let mut heard = 0.0f32;
        for _ in 0..40 {
            let mut l = vec![0.0f32; 512];
            let mut r = vec![0.0f32; 512];
            slot.process(&mut l, &mut r, &ctx);
            heard = heard.max(crate::util::peak(&l));
        }
        assert!(heard > 0.05, "no tail: {heard}");
        // Eventually the tail ends and the slot goes idle.
        for _ in 0..2_000 {
            let mut l = vec![0.0f32; 512];
            let mut r = vec![0.0f32; 512];
            slot.process(&mut l, &mut r, &ctx);
        }
        assert!(!slot.is_active());
    }

    #[test]
    fn insert_slot_off_is_transparent() {
        let sr = 48_000.0;
        let mut slot = FxSlot::new(sr, 256);
        slot.set_effect(create(FxKind::Bitcrusher, sr));
        let ctx = FxContext::free(sr, 120.0);
        let x = testkit::sine(256, 300.0, sr, 0.5);
        let mut l = x.clone();
        let mut r = x.clone();
        slot.process(&mut l, &mut r, &ctx);
        assert_eq!(l, x);
    }
}
