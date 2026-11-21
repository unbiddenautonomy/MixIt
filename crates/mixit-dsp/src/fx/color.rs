//! Colour effects: bitcrusher, oversampled distortion and the noise riser.

use super::{Effect, FxContext, FxKind, MixMode};
use crate::oversample::{Downsampler, Upsampler};
use crate::rng::Rng;
use crate::svf::{Svf, SvfCoeffs, SvfMode, prewarp};
use crate::util::{db_to_gain, flush};
use std::f32::consts::FRAC_1_SQRT_2;

// ---------------------------------------------------------------------------------------
// Bitcrusher
// ---------------------------------------------------------------------------------------

/// Bit-depth and sample-rate reduction.
///
/// * p1: crush (16 bits … 2 bits, continuous).
/// * p2: downsample (hold each sample for 1 … 40 frames).
pub struct Bitcrusher {
    levels: f32,
    step: f32,
    phase: f32,
    held: [f32; 2],
}

impl Bitcrusher {
    pub fn new(_sr: f32) -> Bitcrusher {
        let mut b = Bitcrusher { levels: 0.0, step: 1.0, phase: 1.0, held: [0.0; 2] };
        b.set_param(0, 0.5);
        b.set_param(1, 0.3);
        b
    }
}

impl Effect for Bitcrusher {
    fn kind(&self) -> FxKind {
        FxKind::Bitcrusher
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.phase = 1.0;
        self.held = [0.0; 2];
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => {
                let bits = 16.0 - 14.0 * v;
                self.levels = 2f32.powf(bits - 1.0);
            }
            1 => {
                let hold = 1.0 + 39.0 * v * v;
                self.step = 1.0 / hold;
            }
            _ => {}
        }
    }
    fn set_beats(&mut self, _beats: f32) {}
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _ctx: &FxContext) {
        let q = self.levels;
        for i in 0..l.len() {
            self.phase += self.step;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
                self.held = [(l[i] * q).round() / q, (r[i] * q).round() / q];
            }
            l[i] = self.held[0];
            r[i] = self.held[1];
        }
    }
}

// ---------------------------------------------------------------------------------------
// Distortion
// ---------------------------------------------------------------------------------------

const OVERSAMPLE: usize = 4;
const OS_TAPS: usize = 16;

/// Warm saturation to hard drive, processed at 4× the sample rate to keep aliasing down.
///
/// * p1: drive (0 … 36 dB), with automatic level compensation.
/// * p2: tone (dark … bright low-pass after the shaper).
pub struct Distortion {
    sr: f32,
    up: [Upsampler; 2],
    down: [Downsampler; 2],
    drive: f32,
    comp: f32,
    tone: [Svf; 2],
    tone_c: SvfCoeffs,
    dc_x: [f32; 2],
    dc_y: [f32; 2],
    latency: usize,
}

/// Asymmetric soft clipper: a small bias adds even harmonics (tube-like warmth).
#[inline]
fn shape(x: f32) -> f32 {
    const BIAS: f32 = 0.15;
    // tanh(BIAS) precomputed.
    const TANH_BIAS: f32 = 0.148_885_2;
    (x + BIAS).tanh() - TANH_BIAS
}

impl Distortion {
    pub fn new(sr: f32) -> Distortion {
        let up = Upsampler::new(OVERSAMPLE, OS_TAPS);
        // The down-sampler uses the same prototype filter, so its delay matches.
        let latency = (2.0 * up.latency()).round() as usize;
        let mut d = Distortion {
            sr,
            up: [up.clone(), up],
            down: [Downsampler::new(OVERSAMPLE, OS_TAPS), Downsampler::new(OVERSAMPLE, OS_TAPS)],
            drive: 1.0,
            comp: 1.0,
            tone: [Svf::default(); 2],
            tone_c: SvfCoeffs::design(SvfMode::Lowpass, 12_000.0, FRAC_1_SQRT_2, 0.0, sr),
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
            latency,
        };
        d.set_param(0, 0.5);
        d.set_param(1, 0.6);
        d
    }
}

impl Effect for Distortion {
    fn kind(&self) -> FxKind {
        FxKind::Distortion
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Insert
    }
    fn reset(&mut self) {
        for u in &mut self.up {
            u.reset();
        }
        for d in &mut self.down {
            d.reset();
        }
        self.tone = [Svf::default(); 2];
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => {
                let g = db_to_gain(36.0 * v);
                self.drive = g;
                // Small signals come out g times louder; saturated ones level off near 1.
                // This divisor tracks both, keeping perceived loudness roughly constant.
                self.comp = (1.0 + (g - 1.0) / 3.0) / g;
            }
            1 => {
                let f = 800.0 * (22.5f32).powf(v);
                self.tone_c =
                    SvfCoeffs::new(SvfMode::Lowpass, prewarp(f.min(self.sr * 0.45), self.sr), FRAC_1_SQRT_2, 0.0);
            }
            _ => {}
        }
    }
    fn set_beats(&mut self, _beats: f32) {}
    fn latency(&self) -> usize {
        self.latency
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], _ctx: &FxContext) {
        let mut os = [0.0f32; OVERSAMPLE];
        for i in 0..l.len() {
            for (ch, x) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                self.up[ch].process(*x * self.drive, &mut os);
                for v in os.iter_mut() {
                    *v = shape(*v);
                }
                let y = self.down[ch].process(&os);
                // DC blocker (the bias adds a small offset on loud passages).
                let dc = y - self.dc_x[ch] + 0.9995 * self.dc_y[ch];
                self.dc_x[ch] = y;
                self.dc_y[ch] = flush(dc);
                *x = self.tone[ch].process(&self.tone_c, dc) * self.comp;
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Noise riser
// ---------------------------------------------------------------------------------------

/// A white-noise sweep that builds tension into a drop.
///
/// The noise is added on top of the music; switching the slot off fades it away. The
/// sweep restarts each time the slot is switched on and reaches the top after `beats`,
/// then holds there.
///
/// * p1: level.
/// * p2: resonance (wide hiss … narrow whistle).
/// * beats: sweep length.
pub struct NoiseRiser {
    sr: f32,
    rng: Rng,
    bp: [Svf; 2],
    c: SvfCoeffs,
    level: f32,
    q: f32,
    beats: f32,
    progress: f64,
}

impl NoiseRiser {
    pub fn new(sr: f32) -> NoiseRiser {
        NoiseRiser {
            sr,
            rng: Rng::new(0x5EED_F00D),
            bp: [Svf::default(); 2],
            c: SvfCoeffs::design(SvfMode::Bandpass, 200.0, 1.0, 0.0, sr),
            level: 0.5,
            q: 1.5,
            beats: 8.0,
            progress: 0.0,
        }
    }

    /// Sweep position (0 … 1).
    pub fn progress(&self) -> f32 {
        self.progress as f32
    }
}

impl Effect for NoiseRiser {
    fn kind(&self) -> FxKind {
        FxKind::NoiseRiser
    }
    fn mix_mode(&self) -> MixMode {
        // Insert, with the noise added to the input, so switching off removes the noise.
        MixMode::Insert
    }
    fn reset(&mut self) {
        self.bp = [Svf::default(); 2];
        self.progress = 0.0;
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => self.level = v,
            1 => self.q = 0.7 + 7.0 * v * v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(0.25);
    }
    fn on_enable(&mut self, _ctx: &FxContext) {
        self.progress = 0.0;
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let inc = ctx.beats_per_frame.abs() / self.beats as f64;
        let k = 1.0 / self.q;
        // Unity-peak band-pass, partly compensated so narrow settings are not too quiet.
        let norm = k * self.q.sqrt();
        let top = 12_000.0f32.min(self.sr * 0.45);
        for i in 0..l.len() {
            if i % 8 == 0 {
                let p = self.progress as f32;
                let f = 150.0 * (top / 150.0).powf(p * p);
                self.c = SvfCoeffs::new(SvfMode::Bandpass, prewarp(f, self.sr), self.q, 0.0);
            }
            let p = self.progress as f32;
            let amp = self.level * (0.15 + 0.85 * p * p) * norm;
            let nl = self.bp[0].process(&self.c, self.rng.bipolar());
            let nr = self.bp[1].process(&self.c, self.rng.bipolar());
            l[i] += nl * amp;
            r[i] += nr * amp;
            self.progress = (self.progress + inc).min(1.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit;

    #[test]
    fn bitcrusher_quantises() {
        let mut b = Bitcrusher::new(48_000.0);
        b.set_param(0, 1.0); // 2 bits: levels at multiples of 0.5
        b.set_param(1, 0.0);
        let ctx = FxContext::free(48_000.0, 120.0);
        let mut l = testkit::sine(1_000, 100.0, 48_000.0, 0.9);
        let mut r = l.clone();
        b.process(&mut l, &mut r, &ctx);
        for v in &l {
            assert!(((v * 2.0).round() - v * 2.0).abs() < 1e-6, "{v}");
        }
    }

    #[test]
    fn distortion_adds_harmonics_with_little_aliasing() {
        let sr = 48_000.0;
        let mut d = Distortion::new(sr);
        d.set_param(0, 0.8);
        d.set_param(1, 1.0);
        let ctx = FxContext::free(sr, 120.0);
        let mut l = testkit::sine(48_000, 1_000.0, sr, 0.5);
        let mut r = l.clone();
        d.process(&mut l, &mut r, &ctx);
        let level = crate::util::rms(&l[4_800..]);
        assert!(level > 0.05 && level < 1.0, "{level}");
        // The 3rd harmonic should be strong.
        let h3 = testkit::tone_level(&l[4_800..], 3_000.0, sr);
        assert!(h3 > 0.02, "h3 {h3}");
    }

    #[test]
    fn riser_reaches_the_top_after_its_length() {
        let sr = 48_000.0;
        let mut n = NoiseRiser::new(sr);
        n.set_beats(4.0);
        let ctx = FxContext::free(sr, 120.0); // 4 beats = 2 s
        n.on_enable(&ctx);
        let mut l = vec![0.0f32; 96_000];
        let mut r = l.clone();
        n.process(&mut l, &mut r, &ctx);
        assert!(n.progress() > 0.999);
        let early = crate::util::rms(&l[..9_600]);
        let late = crate::util::rms(&l[86_400..]);
        assert!(late > early * 2.0, "{early} {late}");
    }
}
