//! Modulation effects: filter LFO, flanger, phaser, chorus and ring modulator.
//!
//! Beat-synced LFOs take their phase from the beat position in [`FxContext`], so a sweep
//! started on any deck lands on the same beats as the music and stays there through
//! tempo changes, loops and jumps.

use super::{Effect, FxContext, FxKind, MixMode};
use crate::delay::DelayLine;
use crate::svf::{Svf, SvfCoeffs, SvfMode, prewarp};
use crate::util::{TAU, flush};
use std::f32::consts::FRAC_1_SQRT_2;

/// Unipolar raised-cosine LFO value (0 at the start of the period, 1 halfway).
#[inline]
fn lfo_at(beat: f64, period_beats: f32, offset: f32) -> f32 {
    let p = (beat / period_beats.max(1.0 / 64.0) as f64 + offset as f64).rem_euclid(1.0) as f32;
    0.5 - 0.5 * (TAU * p).cos()
}

/// How often modulated filter coefficients are recomputed (frames).
const COEFF_INTERVAL: usize = 8;

// ---------------------------------------------------------------------------------------
// Filter LFO
// ---------------------------------------------------------------------------------------

/// A resonant low-pass whose cutoff sweeps with the beat.
///
/// * p1: depth (0 = no sweep, 1 = from 16 kHz down to about 90 Hz).
/// * p2: resonance.
/// * beats: LFO period.
pub struct FilterLfo {
    sr: f32,
    depth: f32,
    q: f32,
    beats: f32,
    st: [Svf; 2],
    c: SvfCoeffs,
}

impl FilterLfo {
    pub fn new(sr: f32) -> FilterLfo {
        FilterLfo {
            sr,
            depth: 0.5,
            q: 0.9,
            beats: 1.0,
            st: [Svf::default(); 2],
            c: SvfCoeffs::design(SvfMode::Lowpass, 16_000.0, FRAC_1_SQRT_2, 0.0, sr),
        }
    }
}

impl Effect for FilterLfo {
    fn kind(&self) -> FxKind {
        FxKind::FilterLfo
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.st = [Svf::default(); 2];
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.depth = v,
            1 => self.q = FRAC_1_SQRT_2 + v * v * 9.0,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 16.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let top = 16_000.0f32.min(self.sr * 0.45);
        let span = (2f32.powf(self.depth * 7.5)).ln();
        // Resonance compensation keeps the level steady as Q rises.
        let comp = 1.0 / (1.0 + (self.q - FRAC_1_SQRT_2) * 0.12);
        for i in 0..l.len() {
            if i % COEFF_INTERVAL == 0 {
                let lfo = lfo_at(ctx.beat_at(i), self.beats, 0.0);
                let f = top * (-span * lfo).exp();
                self.c = SvfCoeffs::new(SvfMode::Lowpass, prewarp(f, self.sr), self.q, 0.0);
            }
            l[i] = self.st[0].process(&self.c, l[i]) * comp;
            r[i] = self.st[1].process(&self.c, r[i]) * comp;
        }
    }
}

// ---------------------------------------------------------------------------------------
// Flanger
// ---------------------------------------------------------------------------------------

/// A through-zero-style flanger: a short delay (0.3–6 ms) swept by a beat LFO.
///
/// * p1: feedback (0 … 0.9).
/// * p2: depth (sweep width).
/// * beats: sweep period. The right channel runs a quarter period behind for width.
pub struct Flanger {
    sr: f32,
    lines: [DelayLine; 2],
    feedback: f32,
    depth: f32,
    beats: f32,
    fb_state: [f32; 2],
}

impl Flanger {
    pub fn new(sr: f32) -> Flanger {
        let cap = (0.008 * sr) as usize + 8;
        Flanger {
            sr,
            lines: [DelayLine::new(cap), DelayLine::new(cap)],
            feedback: 0.5,
            depth: 0.5,
            beats: 4.0,
            fb_state: [0.0; 2],
        }
    }
}

impl Effect for Flanger {
    fn kind(&self) -> FxKind {
        FxKind::Flanger
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        for d in &mut self.lines {
            d.clear();
        }
        self.fb_state = [0.0; 2];
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.feedback = v * 0.9,
            1 => self.depth = v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 16.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let ms = self.sr / 1000.0;
        let min_d = 0.3 * ms;
        let range = (0.2 + 5.5 * self.depth) * ms;
        for i in 0..l.len() {
            let beat = ctx.beat_at(i);
            for (ch, x) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let lfo = lfo_at(beat, self.beats, ch as f32 * 0.25);
                let d = 1.0 + min_d + range * lfo;
                let w = self.lines[ch].read(d);
                self.fb_state[ch] = w;
                self.lines[ch].push(flush((*x + self.feedback * w).clamp(-4.0, 4.0)));
                *x = 0.5 * (*x + w);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Phaser
// ---------------------------------------------------------------------------------------

const PHASER_STAGES: usize = 6;

/// A six-stage phaser with allpass notches sweeping 200 Hz … 4 kHz.
///
/// * p1: feedback (resonance of the notches).
/// * p2: depth (how far up the sweep travels).
/// * beats: sweep period.
pub struct Phaser {
    sr: f32,
    s: [[f32; PHASER_STAGES]; 2],
    g: [f32; 2],
    last: [f32; 2],
    feedback: f32,
    depth: f32,
    beats: f32,
}

impl Phaser {
    pub fn new(sr: f32) -> Phaser {
        Phaser { sr, s: [[0.0; PHASER_STAGES]; 2], g: [0.0; 2], last: [0.0; 2], feedback: 0.4, depth: 0.7, beats: 4.0 }
    }
}

impl Effect for Phaser {
    fn kind(&self) -> FxKind {
        FxKind::Phaser
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.s = [[0.0; PHASER_STAGES]; 2];
        self.last = [0.0; 2];
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.feedback = v * 0.85,
            1 => self.depth = v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 16.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let span = (20.0f32).ln() * (0.15 + 0.85 * self.depth);
        for i in 0..l.len() {
            if i % COEFF_INTERVAL == 0 {
                let beat = ctx.beat_at(i);
                for ch in 0..2 {
                    let lfo = lfo_at(beat, self.beats, ch as f32 * 0.2);
                    let f = 200.0 * (span * lfo).exp();
                    let t = prewarp(f, self.sr);
                    self.g[ch] = t / (1.0 + t);
                }
            }
            for (ch, x) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let g = self.g[ch];
                let mut v = *x + self.feedback * self.last[ch];
                for st in self.s[ch].iter_mut() {
                    // First-order TPT allpass.
                    let u = (v - *st) * g;
                    let lp = u + *st;
                    *st = flush(lp + u);
                    v = 2.0 * lp - v;
                }
                self.last[ch] = v.clamp(-4.0, 4.0);
                *x = 0.5 * (*x + v);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Chorus
// ---------------------------------------------------------------------------------------

const CHORUS_VOICES: usize = 3;
const CHORUS_BASE_MS: [f32; CHORUS_VOICES] = [12.0, 18.0, 24.0];
const CHORUS_RATE_HZ: [f32; CHORUS_VOICES] = [0.31, 0.47, 0.71];

/// A three-voice stereo chorus with free-running, mutually prime LFO rates.
///
/// * p1: stereo width (0 = mono chorus, 1 = voices spread wide).
/// * p2: depth (0.3 … 4 ms of modulation).
pub struct Chorus {
    sr: f32,
    lines: [DelayLine; 2],
    phase: [f32; CHORUS_VOICES],
    width: f32,
    depth: f32,
}

impl Chorus {
    pub fn new(sr: f32) -> Chorus {
        let cap = (0.035 * sr) as usize + 8;
        Chorus {
            sr,
            lines: [DelayLine::new(cap), DelayLine::new(cap)],
            phase: [0.0, 0.33, 0.66],
            width: 0.7,
            depth: 0.5,
        }
    }
}

impl Effect for Chorus {
    fn kind(&self) -> FxKind {
        FxKind::Chorus
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        for d in &mut self.lines {
            d.clear();
        }
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.width = v,
            1 => self.depth = v,
            _ => {}
        }
    }
    fn set_beats(&mut self, _beats: f32) {}
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _ctx: &FxContext) {
        let ms = self.sr / 1000.0;
        let mod_frames = (0.3 + 3.7 * self.depth) * ms;
        let inc = CHORUS_RATE_HZ.map(|hz| hz / self.sr);
        // Voice pans: centre, left, right (scaled by width).
        let pans = [0.0f32, -self.width, self.width];
        for i in 0..l.len() {
            self.lines[0].push(flush(l[i]));
            self.lines[1].push(flush(r[i]));
            let (mut wl, mut wr) = (0.0f32, 0.0f32);
            for v in 0..CHORUS_VOICES {
                self.phase[v] = (self.phase[v] + inc[v]) % 1.0;
                let m = (TAU * self.phase[v]).sin();
                let d = CHORUS_BASE_MS[v] * ms + m * mod_frames;
                // The centre voice reads both lines; the side voices read one each.
                let a = self.lines[0].read(d);
                let b = self.lines[1].read(d);
                let p = pans[v];
                let gl = (0.5 * (1.0 - p)).sqrt();
                let gr = (0.5 * (1.0 + p)).sqrt();
                let s = if v == 0 {
                    0.5 * (a + b)
                } else if v == 1 {
                    a
                } else {
                    b
                };
                wl += s * gl;
                wr += s * gr;
            }
            l[i] = 0.7 * l[i] + 0.45 * wl;
            r[i] = 0.7 * r[i] + 0.45 * wr;
        }
    }
}

// ---------------------------------------------------------------------------------------
// Ring modulator
// ---------------------------------------------------------------------------------------

/// Multiplies the signal by a sine carrier (30 Hz … 2 kHz).
///
/// * p1: carrier frequency (exponential).
/// * p2: wobble: the carrier is swept up to two octaves by a beat LFO.
/// * beats: wobble period.
pub struct RingMod {
    sr: f32,
    freq: f32,
    wobble: f32,
    beats: f32,
    phase: f32,
}

impl RingMod {
    pub fn new(sr: f32) -> RingMod {
        RingMod { sr, freq: 30.0 * (2_000.0f32 / 30.0).powf(0.5), wobble: 0.0, beats: 1.0, phase: 0.0 }
    }
}

impl Effect for RingMod {
    fn kind(&self) -> FxKind {
        FxKind::RingMod
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.phase = 0.0;
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.freq = 30.0 * (2_000.0f32 / 30.0).powf(v),
            1 => self.wobble = v * 2.0,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 16.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let mut inc = self.freq / self.sr;
        for i in 0..l.len() {
            if i % COEFF_INTERVAL == 0 {
                let lfo = lfo_at(ctx.beat_at(i), self.beats, 0.0);
                inc = self.freq * (self.wobble * lfo * std::f32::consts::LN_2).exp() / self.sr;
            }
            self.phase = (self.phase + inc) % 1.0;
            let c = (TAU * self.phase).sin();
            l[i] *= c;
            r[i] *= c;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit;

    #[test]
    fn filter_lfo_sweep_follows_the_beat() {
        let sr = 48_000.0;
        let mut f = FilterLfo::new(sr);
        f.set_param(0, 1.0);
        f.set_param(1, 0.0);
        f.set_beats(1.0);
        // At 120 BPM a beat is 24,000 frames. Bright at the start of the beat, dark halfway.
        let ctx = FxContext::free(sr, 120.0);
        let mut l = testkit::sine(24_000, 3_000.0, sr, 0.5);
        let mut r = l.clone();
        f.process(&mut l, &mut r, &ctx);
        let start = crate::util::rms(&l[200..1_200]);
        let middle = crate::util::rms(&l[11_500..12_500]);
        assert!(start > 0.3, "start {start}");
        assert!(middle < 0.05, "middle {middle}");
    }

    #[test]
    fn ring_mod_moves_energy_to_sidebands() {
        let sr = 48_000.0;
        let mut m = RingMod::new(sr);
        m.set_param(0, 0.0); // 30 Hz carrier
        let ctx = FxContext::free(sr, 120.0);
        let mut l = testkit::sine(48_000, 1_000.0, sr, 0.5);
        let mut r = l.clone();
        m.process(&mut l, &mut r, &ctx);
        // RMS halves in power (sin·sin), so the level is about 0.25 instead of 0.35.
        let level = crate::util::rms(&l);
        assert!((level - 0.25).abs() < 0.02, "{level}");
    }

    #[test]
    fn phaser_sweeps_a_notch_through_a_tone() {
        let sr = 48_000.0;
        let mut p = Phaser::new(sr);
        p.set_param(0, 0.0);
        p.set_param(1, 0.7);
        p.set_beats(4.0);
        let ctx = FxContext::free(sr, 120.0); // one sweep = 4 beats = 96,000 frames
        let mut l = testkit::sine(96_000, 1_000.0, sr, 0.5);
        let mut r = l.clone();
        p.process(&mut l, &mut r, &ctx);
        // Without feedback the dry + allpass sum never exceeds the input…
        assert!(crate::util::peak(&l) < 0.51);
        // …and the notch passes through 1 kHz somewhere in the sweep.
        let quietest = l.chunks(480).skip(4).map(crate::util::rms).fold(1.0f32, f32::min);
        assert!(quietest < 0.05, "{quietest}");
    }
}
