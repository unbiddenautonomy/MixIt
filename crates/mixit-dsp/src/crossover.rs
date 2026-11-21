//! Linkwitz-Riley crossovers for isolator EQs and multiband processing.
//!
//! An LR4 crossover is two cascaded Butterworth sections per side. Its low and high
//! outputs sum to a second-order allpass, so the bands add back to a flat magnitude.
//! For three bands we split at f1, then split the upper part at f2, and pass the low
//! band through the f2 allpass so all three bands share the same phase response.

use crate::biquad::{Biquad, Coeffs};
use std::f64::consts::FRAC_1_SQRT_2;

#[derive(Clone, Debug)]
struct Lr4 {
    lp: [Biquad; 2],
    hp: [Biquad; 2],
}

impl Lr4 {
    fn new(freq: f64, sr: f64) -> Lr4 {
        let lp = Coeffs::lowpass(freq, FRAC_1_SQRT_2, sr);
        let hp = Coeffs::highpass(freq, FRAC_1_SQRT_2, sr);
        Lr4 { lp: [Biquad::new(lp); 2], hp: [Biquad::new(hp); 2] }
    }

    #[inline(always)]
    fn split(&mut self, x: f64) -> (f64, f64) {
        let lo = self.lp[0].process64(x);
        let lo = self.lp[1].process64(lo);
        let hi = self.hp[0].process64(x);
        let hi = self.hp[1].process64(hi);
        (lo, hi)
    }

    fn reset(&mut self) {
        for b in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            b.reset();
        }
    }
}

/// Splits one channel into low, mid and high bands that sum to an allpass response.
#[derive(Clone, Debug)]
pub struct ThreeBandSplitter {
    x1: Lr4,
    x2: Lr4,
    low_ap: Biquad,
}

impl ThreeBandSplitter {
    pub fn new(f1: f64, f2: f64, sr: f64) -> ThreeBandSplitter {
        assert!(f1 < f2);
        ThreeBandSplitter {
            x1: Lr4::new(f1, sr),
            x2: Lr4::new(f2, sr),
            low_ap: Biquad::new(Coeffs::allpass(f2, FRAC_1_SQRT_2, sr)),
        }
    }

    #[inline(always)]
    pub fn split(&mut self, x: f32) -> (f32, f32, f32) {
        let (lo, rest) = self.x1.split(x as f64);
        let lo = self.low_ap.process64(lo);
        let (mid, hi) = self.x2.split(rest);
        (lo as f32, mid as f32, hi as f32)
    }

    pub fn reset(&mut self) {
        self.x1.reset();
        self.x2.reset();
        self.low_ap.reset();
    }
}

/// Splits one channel into two LR4 bands.
#[derive(Clone, Debug)]
pub struct TwoBandSplitter {
    x: Lr4,
}

impl TwoBandSplitter {
    pub fn new(freq: f64, sr: f64) -> TwoBandSplitter {
        TwoBandSplitter { x: Lr4::new(freq, sr) }
    }

    #[inline(always)]
    pub fn split(&mut self, x: f32) -> (f32, f32) {
        let (a, b) = self.x.split(x as f64);
        (a as f32, b as f32)
    }

    pub fn reset(&mut self) {
        self.x.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn band_gain_db(f: f32, which: usize) -> f32 {
        let sr = 48_000.0;
        let mut s = ThreeBandSplitter::new(250.0, 2_500.0, sr as f64);
        let n = 96_000;
        let x = crate::testkit::sine(n, f, sr, 1.0);
        let mut out = vec![0.0f32; n];
        for (i, &v) in x.iter().enumerate() {
            let (l, m, h) = s.split(v);
            out[i] = match which {
                0 => l,
                1 => m,
                2 => h,
                _ => l + m + h,
            };
        }
        20.0 * crate::testkit::tone_level(&out[n / 2..], f, sr).max(1e-12).log10()
    }

    #[test]
    fn bands_sum_flat() {
        for f in [30.0, 100.0, 250.0, 700.0, 2_500.0, 6_000.0, 15_000.0] {
            let db = band_gain_db(f, 3);
            assert!(db.abs() < 0.05, "sum at {f} Hz = {db} dB");
        }
    }

    #[test]
    fn bands_separate() {
        assert!(band_gain_db(40.0, 0) > -0.1);
        assert!(band_gain_db(40.0, 2) < -60.0);
        assert!(band_gain_db(10_000.0, 0) < -60.0);
        assert!((band_gain_db(250.0, 0) + 6.02).abs() < 0.1);
        assert!(band_gain_db(800.0, 1) > -1.5);
    }
}
