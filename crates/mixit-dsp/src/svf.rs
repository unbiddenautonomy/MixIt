//! Topology-preserving-transform state-variable filter (Andrew Simper's linear trapezoidal
//! SVF). Stable and click-free under fast modulation of cutoff, Q and gain, which makes
//! it the right filter for DJ filters, sweeps and any automated EQ.

use crate::util::flush;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SvfMode {
    Lowpass,
    Highpass,
    Bandpass,
    Notch,
    Allpass,
    Peak,
    Bell,
    LowShelf,
    HighShelf,
}

/// Coefficients: g = tan(π·fc/fs), k = 1/Q, and output mix m0·v0 + m1·v1 + m2·v2.
#[derive(Clone, Copy, Debug)]
pub struct SvfCoeffs {
    a1: f32,
    a2: f32,
    a3: f32,
    m0: f32,
    m1: f32,
    m2: f32,
}

impl SvfCoeffs {
    /// Designs coefficients. `tan_wc` may be passed precomputed (tan(π·fc/fs)) to make
    /// per-sample gain modulation cheap; use [`prewarp`] to compute it.
    pub fn new(mode: SvfMode, tan_wc: f32, q: f32, gain_db: f32) -> SvfCoeffs {
        let q = q.max(0.025);
        let a = 10f32.powf(gain_db / 40.0);
        let (g, k, m0, m1, m2) = match mode {
            SvfMode::Lowpass => (tan_wc, 1.0 / q, 0.0, 0.0, 1.0),
            SvfMode::Highpass => (tan_wc, 1.0 / q, 1.0, -1.0 / q, -1.0),
            SvfMode::Bandpass => (tan_wc, 1.0 / q, 0.0, 1.0, 0.0),
            SvfMode::Notch => (tan_wc, 1.0 / q, 1.0, -1.0 / q, 0.0),
            SvfMode::Allpass => (tan_wc, 1.0 / q, 1.0, -2.0 / q, 0.0),
            SvfMode::Peak => (tan_wc, 1.0 / q, 1.0, -1.0 / q, -2.0),
            SvfMode::Bell => {
                let k = 1.0 / (q * a);
                (tan_wc, k, 1.0, k * (a * a - 1.0), 0.0)
            }
            SvfMode::LowShelf => {
                let k = 1.0 / q;
                (tan_wc / a.sqrt(), k, 1.0, k * (a - 1.0), a * a - 1.0)
            }
            SvfMode::HighShelf => {
                let k = 1.0 / q;
                (tan_wc * a.sqrt(), k, a * a, k * (1.0 - a) * a, 1.0 - a * a)
            }
        };
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        SvfCoeffs { a1, a2, a3, m0, m1, m2 }
    }

    pub fn design(mode: SvfMode, freq: f32, q: f32, gain_db: f32, sample_rate: f32) -> SvfCoeffs {
        Self::new(mode, prewarp(freq, sample_rate), q, gain_db)
    }
}

/// tan(π·f/fs), with f clamped below Nyquist.
#[inline]
pub fn prewarp(freq: f32, sample_rate: f32) -> f32 {
    let f = freq.clamp(1.0, sample_rate * 0.49);
    (std::f32::consts::PI * f / sample_rate).tan()
}

/// One channel of filter state.
#[derive(Clone, Copy, Debug, Default)]
pub struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    #[inline(always)]
    pub fn process(&mut self, c: &SvfCoeffs, v0: f32) -> f32 {
        let v3 = v0 - self.ic2;
        let v1 = c.a1 * self.ic1 + c.a2 * v3;
        let v2 = self.ic2 + c.a2 * self.ic1 + c.a3 * v3;
        self.ic1 = flush(2.0 * v1 - self.ic1);
        self.ic2 = flush(2.0 * v2 - self.ic2);
        if !(self.ic1.is_finite() && self.ic2.is_finite()) {
            self.reset();
            return 0.0;
        }
        c.m0 * v0 + c.m1 * v1 + c.m2 * v2
    }

    /// Returns (lowpass, bandpass, highpass) at once for crossovers and multimode use.
    #[inline(always)]
    pub fn process_multi(&mut self, c: &SvfCoeffs, k: f32, v0: f32) -> (f32, f32, f32) {
        let v3 = v0 - self.ic2;
        let v1 = c.a1 * self.ic1 + c.a2 * v3;
        let v2 = self.ic2 + c.a2 * self.ic1 + c.a3 * v3;
        self.ic1 = flush(2.0 * v1 - self.ic1);
        self.ic2 = flush(2.0 * v2 - self.ic2);
        if !(self.ic1.is_finite() && self.ic2.is_finite()) {
            self.reset();
            return (0.0, 0.0, 0.0);
        }
        (v2, v1, v0 - k * v1 - v2)
    }
}

/// A stereo SVF with its coefficients.
#[derive(Clone, Copy, Debug)]
pub struct StereoSvf {
    pub c: SvfCoeffs,
    l: Svf,
    r: Svf,
}

impl StereoSvf {
    pub fn new(c: SvfCoeffs) -> StereoSvf {
        StereoSvf { c, l: Svf::default(), r: Svf::default() }
    }

    pub fn set(&mut self, c: SvfCoeffs) {
        self.c = c;
    }

    pub fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }

    #[inline(always)]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        (self.l.process(&self.c, l), self.r.process(&self.c, r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_1_SQRT_2;

    fn measure(mode: SvfMode, fc: f32, q: f32, gain: f32, f: f32) -> f32 {
        let sr = 48_000.0;
        let c = SvfCoeffs::design(mode, fc, q, gain, sr);
        let mut s = Svf::default();
        let n = 48_000;
        let x = crate::testkit::sine(n, f, sr, 1.0);
        let y: Vec<f32> = x.iter().map(|&v| s.process(&c, v)).collect();
        20.0 * crate::testkit::tone_level(&y[n / 2..], f, sr).max(1e-12).log10()
    }

    #[test]
    fn lowpass_and_highpass() {
        assert!(measure(SvfMode::Lowpass, 1_000.0, FRAC_1_SQRT_2, 0.0, 100.0).abs() < 0.05);
        assert!((measure(SvfMode::Lowpass, 1_000.0, FRAC_1_SQRT_2, 0.0, 1_000.0) + 3.01).abs() < 0.05);
        assert!(measure(SvfMode::Highpass, 1_000.0, FRAC_1_SQRT_2, 0.0, 100.0) < -38.0);
        assert!(measure(SvfMode::Highpass, 1_000.0, FRAC_1_SQRT_2, 0.0, 10_000.0).abs() < 0.05);
    }

    #[test]
    fn bell_and_shelves() {
        assert!((measure(SvfMode::Bell, 1_000.0, 1.0, 6.0, 1_000.0) - 6.0).abs() < 0.05);
        assert!((measure(SvfMode::LowShelf, 200.0, FRAC_1_SQRT_2, -12.0, 20.0) + 12.0).abs() < 0.1);
        assert!(measure(SvfMode::LowShelf, 200.0, FRAC_1_SQRT_2, -12.0, 10_000.0).abs() < 0.05);
        assert!((measure(SvfMode::HighShelf, 4_000.0, FRAC_1_SQRT_2, 6.0, 18_000.0) - 6.0).abs() < 0.2);
    }

    #[test]
    fn fast_modulation_stays_bounded() {
        let sr = 48_000.0;
        let mut s = Svf::default();
        let mut max = 0.0f32;
        for i in 0..96_000 {
            let fc = 50.0 + 15_000.0 * (0.5 + 0.5 * (i as f32 * 0.01).sin());
            let c = SvfCoeffs::design(SvfMode::Lowpass, fc, 4.0, 0.0, sr);
            let x = if i % 200 < 100 { 0.5 } else { -0.5 };
            max = max.max(s.process(&c, x).abs());
        }
        assert!(max < 10.0 && max.is_finite());
    }
}
