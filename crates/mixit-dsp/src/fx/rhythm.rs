//! Rhythmic effects: gater, pattern slicer, beat repeat (roll) and tape stop.
//!
//! Gater and slicer read the beat position from [`FxContext`] each frame, so their steps
//! line up with the beatgrid whatever the tempo. Beat repeat and tape stop start from the
//! moment the slot is switched on; the engine quantises that moment when quantise is on.

use super::{Effect, FxContext, FxKind, MixMode};
use crate::delay::DelayLine;
use crate::svf::{Svf, SvfCoeffs, SvfMode, prewarp};
use crate::util::{one_pole_coeff, raised_cosine};
use std::f32::consts::FRAC_1_SQRT_2;

/// Edge smoothing for gate steps: short enough to stay punchy, long enough not to click.
const EDGE_MS: f32 = 1.5;

/// Longest capture or stop the rhythm effects support.
pub const MAX_RHYTHM_SECONDS: f32 = 8.0;

// ---------------------------------------------------------------------------------------
// Gater
// ---------------------------------------------------------------------------------------

/// A tempo-synced volume gate (trance gate).
///
/// * p1: duty (how much of each step is open, 10 … 90 %).
/// * p2: depth (how far the closed part drops; 1 = silence).
/// * beats: step length.
pub struct Gater {
    duty: f32,
    depth: f32,
    beats: f32,
    gain: f32,
    coeff: f32,
}

impl Gater {
    pub fn new(sr: f32) -> Gater {
        Gater { duty: 0.5, depth: 1.0, beats: 0.25, gain: 1.0, coeff: one_pole_coeff(EDGE_MS / 1000.0, sr) }
    }
}

impl Effect for Gater {
    fn kind(&self) -> FxKind {
        FxKind::Gater
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.gain = 1.0;
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.duty = 0.1 + 0.8 * v,
            1 => self.depth = v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 32.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let closed = 1.0 - self.depth;
        for i in 0..l.len() {
            let phase = (ctx.beat_at(i) / self.beats as f64).rem_euclid(1.0) as f32;
            let target = if phase < self.duty { 1.0 } else { closed };
            self.gain = target + self.coeff * (self.gain - target);
            l[i] *= self.gain;
            r[i] *= self.gain;
        }
    }
}

// ---------------------------------------------------------------------------------------
// Slicer
// ---------------------------------------------------------------------------------------

/// Sixteen-step on/off patterns; the most significant bit is the first step.
pub const SLICER_PATTERNS: [u16; 8] = [
    0b1010_1010_1010_1010, // straight eighths
    0b1000_1000_1000_1000, // quarters
    0b1110_1110_1110_1110, // long-short
    0b1001_0010_0100_1001, // 3-3-3-3-2-2 (tresillo feel)
    0b1011_0101_1011_0101, // syncopated
    0b1111_0000_1111_0000, // half-bar chop
    0b1101_1011_0110_1101, // rolling
    0b1000_1010_0010_1010, // broken
];

/// Chops the audio with a sixteen-step pattern.
///
/// * p1: pattern (eight presets, see [`SLICER_PATTERNS`]).
/// * p2: depth.
/// * beats: the whole pattern spans four times this many beats (1 beat → 16th steps).
pub struct Slicer {
    pattern: u16,
    depth: f32,
    beats: f32,
    gain: f32,
    coeff: f32,
}

impl Slicer {
    pub fn new(sr: f32) -> Slicer {
        Slicer {
            pattern: SLICER_PATTERNS[0],
            depth: 1.0,
            beats: 1.0,
            gain: 1.0,
            coeff: one_pole_coeff(EDGE_MS / 1000.0, sr),
        }
    }

    /// True when `step` (0–15) of the current pattern is open.
    pub fn step_open(&self, step: usize) -> bool {
        self.pattern & (0x8000 >> (step & 15)) != 0
    }
}

impl Effect for Slicer {
    fn kind(&self) -> FxKind {
        FxKind::Slicer
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.gain = 1.0;
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => {
                self.pattern =
                    SLICER_PATTERNS[((v * SLICER_PATTERNS.len() as f32) as usize).min(SLICER_PATTERNS.len() - 1)]
            }
            1 => self.depth = v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 16.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let step_beats = self.beats as f64 / 4.0;
        let closed = 1.0 - self.depth;
        for i in 0..l.len() {
            let pos = ctx.beat_at(i) / step_beats;
            let step = pos.floor().rem_euclid(16.0) as usize;
            let frac = pos.rem_euclid(1.0) as f32;
            // Open steps also close briefly at their end so repeated steps are audible.
            let open = self.step_open(step) && frac < 0.92;
            let target = if open { 1.0 } else { closed };
            self.gain = target + self.coeff * (self.gain - target);
            l[i] *= self.gain;
            r[i] *= self.gain;
        }
    }
}

// ---------------------------------------------------------------------------------------
// Beat repeat
// ---------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RepeatState {
    Idle,
    Recording,
    Looping,
}

/// Captures `beats` of audio when switched on, then repeats it (a "roll").
///
/// * p1: decay per repeat (0 = none).
/// * p2: subdivision of the captured slice (1, 1/2, 1/4, 1/8) for stutters.
/// * beats: capture length.
pub struct BeatRepeat {
    buf: [Vec<f32>; 2],
    beats: f32,
    decay: f32,
    divisions: usize,
    state: RepeatState,
    len: usize,
    pos: usize,
    gain: f32,
    fade: usize,
}

impl BeatRepeat {
    pub fn new(sr: f32) -> BeatRepeat {
        let cap = (MAX_RHYTHM_SECONDS * sr) as usize;
        BeatRepeat {
            buf: [vec![0.0; cap], vec![0.0; cap]],
            beats: 0.5,
            decay: 0.0,
            divisions: 1,
            state: RepeatState::Idle,
            len: 0,
            pos: 0,
            gain: 1.0,
            fade: (0.002 * sr) as usize,
        }
    }

    fn segment(&self) -> usize {
        (self.len / self.divisions).max(2 * self.fade + 1)
    }
}

impl Effect for BeatRepeat {
    fn kind(&self) -> FxKind {
        FxKind::BeatRepeat
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.state = RepeatState::Idle;
        self.pos = 0;
        self.gain = 1.0;
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.decay = v,
            1 => self.divisions = 1 << ((v * 3.0).round() as usize),
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 32.0);
    }
    fn on_enable(&mut self, ctx: &FxContext) {
        let cap = self.buf[0].len();
        self.len = ((self.beats * ctx.frames_per_beat()) as usize).clamp(2 * self.fade + 2, cap);
        self.pos = 0;
        self.gain = 1.0;
        self.state = RepeatState::Recording;
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _ctx: &FxContext) {
        let per_repeat = 1.0 - 0.6 * self.decay;
        for i in 0..l.len() {
            match self.state {
                RepeatState::Idle => {}
                RepeatState::Recording => {
                    self.buf[0][self.pos] = l[i];
                    self.buf[1][self.pos] = r[i];
                    self.pos += 1;
                    if self.pos >= self.len {
                        self.state = RepeatState::Looping;
                        self.pos = 0;
                    }
                }
                RepeatState::Looping => {
                    let seg = self.segment();
                    // Short raised-cosine fades at both ends of each repeat hide the seam.
                    let edge = self.pos.min(seg - 1 - self.pos);
                    let w = if edge < self.fade { raised_cosine(edge as f32 / self.fade as f32) } else { 1.0 };
                    let g = self.gain * w;
                    l[i] = self.buf[0][self.pos] * g;
                    r[i] = self.buf[1][self.pos] * g;
                    self.pos += 1;
                    if self.pos >= seg {
                        self.pos = 0;
                        self.gain *= per_repeat;
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Tape stop
// ---------------------------------------------------------------------------------------

/// Slows the audio to a halt over `beats`, like a turntable losing power.
///
/// * p1: curve (0 = linear slowdown, 1 = holds speed then drops fast).
/// * p2: darkening as the tape slows.
pub struct TapeStop {
    sr: f32,
    lines: [DelayLine; 2],
    lp: [Svf; 2],
    lpc: SvfCoeffs,
    beats: f32,
    curve: f32,
    dark: f32,
    t: f32,
    duration: f32,
    lag: f32,
}

impl TapeStop {
    pub fn new(sr: f32) -> TapeStop {
        let cap = (MAX_RHYTHM_SECONDS * sr) as usize + 16;
        TapeStop {
            sr,
            lines: [DelayLine::new(cap), DelayLine::new(cap)],
            lp: [Svf::default(); 2],
            lpc: SvfCoeffs::design(SvfMode::Lowpass, 18_000.0, FRAC_1_SQRT_2, 0.0, sr),
            beats: 2.0,
            curve: 0.5,
            dark: 0.5,
            t: 0.0,
            duration: sr,
            lag: 2.0,
        }
    }

    /// Playback speed at progress `p` (0 … 1).
    fn rate(&self, p: f32) -> f32 {
        let p = p.clamp(0.0, 1.0);
        let e = 1.0 + 3.0 * self.curve;
        1.0 - p.powf(e)
    }
}

impl Effect for TapeStop {
    fn kind(&self) -> FxKind {
        FxKind::TapeStop
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        for d in &mut self.lines {
            d.clear();
        }
        self.lp = [Svf::default(); 2];
        self.t = 0.0;
        self.lag = 2.0;
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.curve = v,
            1 => self.dark = v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 16.0);
    }
    fn on_enable(&mut self, ctx: &FxContext) {
        self.duration =
            (self.beats * ctx.frames_per_beat()).clamp(0.05 * self.sr, (MAX_RHYTHM_SECONDS - 0.1) * self.sr);
        self.t = 0.0;
        self.lag = 2.0;
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _ctx: &FxContext) {
        for i in 0..l.len() {
            self.lines[0].push(l[i]);
            self.lines[1].push(r[i]);
            let p = self.t / self.duration;
            let rate = self.rate(p);
            if i % 8 == 0 {
                let f = (18_000.0 * rate.max(0.0).powf(0.5 + 1.5 * self.dark)).max(150.0);
                self.lpc = SvfCoeffs::new(SvfMode::Lowpass, prewarp(f, self.sr), FRAC_1_SQRT_2, 0.0);
            }
            if p >= 1.0 {
                l[i] = 0.0;
                r[i] = 0.0;
                continue;
            }
            self.lag += 1.0 - rate;
            self.t += 1.0;
            // Fade the last few percent so the stop never ends on a click.
            let tail = ((1.0 - p) / 0.04).min(1.0);
            l[i] = self.lp[0].process(&self.lpc, self.lines[0].read(self.lag)) * tail;
            r[i] = self.lp[1].process(&self.lpc, self.lines[1].read(self.lag)) * tail;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit;

    #[test]
    fn gater_opens_on_the_beat() {
        let sr = 48_000.0;
        let mut g = Gater::new(sr);
        g.set_beats(1.0);
        g.set_param(0, 0.5); // 50 % duty
        g.set_param(1, 1.0);
        let ctx = FxContext::free(sr, 120.0); // 24,000 frames per beat
        let mut l = vec![1.0f32; 48_000];
        let mut r = l.clone();
        g.process(&mut l, &mut r, &ctx);
        assert!(l[6_000] > 0.99);
        assert!(l[18_000] < 0.01);
        assert!(l[30_000] > 0.99);
        assert!(testkit::ClickDetector::default().clicks(&l).len() <= 4);
    }

    #[test]
    fn beat_repeat_repeats_the_capture() {
        let sr = 48_000.0;
        let mut b = BeatRepeat::new(sr);
        b.set_beats(0.5);
        b.set_param(0, 0.0);
        b.set_param(1, 0.0);
        let ctx = FxContext::free(sr, 120.0); // half a beat = 12,000 frames
        b.on_enable(&ctx);
        let input = testkit::noise(36_000, 7, 0.5);
        let mut l = input.clone();
        let mut r = input.clone();
        b.process(&mut l, &mut r, &ctx);
        // The second and third slices are copies of the first (away from the fades).
        for k in 1_000..11_000 {
            assert_eq!(l[12_000 + k], input[k]);
            assert_eq!(l[24_000 + k], input[k]);
        }
    }

    #[test]
    fn tape_stop_ends_in_silence() {
        let sr = 48_000.0;
        let mut t = TapeStop::new(sr);
        t.set_beats(1.0);
        let ctx = FxContext::free(sr, 120.0);
        t.on_enable(&ctx);
        let mut l = testkit::sine(36_000, 220.0, sr, 0.5);
        let mut r = l.clone();
        t.process(&mut l, &mut r, &ctx);
        assert!(crate::util::peak(&l[..2_000]) > 0.4);
        assert_eq!(crate::util::peak(&l[24_100..]), 0.0);
    }
}
