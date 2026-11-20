//! Biquad filters (RBJ Audio EQ Cookbook designs), run in transposed direct form II
//! with f64 state so low-frequency filters stay accurate. Use these for fixed or
//! slowly changing filters; use [`crate::svf`] for anything modulated quickly.

use crate::util::flush64;
use std::f64::consts::PI;

/// Normalised biquad coefficients (a0 = 1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterType {
    Lowpass,
    Highpass,
    Bandpass,
    Notch,
    Allpass,
    Peaking,
    LowShelf,
    HighShelf,
}

struct Pre {
    cos: f64,
    alpha: f64,
    a: f64,
}

fn pre(freq: f64, q: f64, gain_db: f64, sr: f64) -> Pre {
    let f = freq.clamp(1.0, sr * 0.499);
    let w0 = 2.0 * PI * f / sr;
    Pre { cos: w0.cos(), alpha: w0.sin() / (2.0 * q.max(1e-4)), a: 10f64.powf(gain_db / 40.0) }
}

impl Coeffs {
    pub const IDENTITY: Coeffs = Coeffs { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0 };

    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coeffs {
        Coeffs { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }

    pub fn design(kind: FilterType, freq: f64, q: f64, gain_db: f64, sr: f64) -> Coeffs {
        let p = pre(freq, q, gain_db, sr);
        let (c, al, a) = (p.cos, p.alpha, p.a);
        match kind {
            FilterType::Lowpass => Self::norm((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al),
            FilterType::Highpass => {
                Self::norm((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al)
            }
            FilterType::Bandpass => Self::norm(al, 0.0, -al, 1.0 + al, -2.0 * c, 1.0 - al),
            FilterType::Notch => Self::norm(1.0, -2.0 * c, 1.0, 1.0 + al, -2.0 * c, 1.0 - al),
            FilterType::Allpass => Self::norm(1.0 - al, -2.0 * c, 1.0 + al, 1.0 + al, -2.0 * c, 1.0 - al),
            FilterType::Peaking => {
                Self::norm(1.0 + al * a, -2.0 * c, 1.0 - al * a, 1.0 + al / a, -2.0 * c, 1.0 - al / a)
            }
            FilterType::LowShelf => {
                let s = 2.0 * a.sqrt() * al;
                Self::norm(
                    a * ((a + 1.0) - (a - 1.0) * c + s),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * c),
                    a * ((a + 1.0) - (a - 1.0) * c - s),
                    (a + 1.0) + (a - 1.0) * c + s,
                    -2.0 * ((a - 1.0) + (a + 1.0) * c),
                    (a + 1.0) + (a - 1.0) * c - s,
                )
            }
            FilterType::HighShelf => {
                let s = 2.0 * a.sqrt() * al;
                Self::norm(
                    a * ((a + 1.0) + (a - 1.0) * c + s),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
                    a * ((a + 1.0) + (a - 1.0) * c - s),
                    (a + 1.0) - (a - 1.0) * c + s,
                    2.0 * ((a - 1.0) - (a + 1.0) * c),
                    (a + 1.0) - (a - 1.0) * c - s,
                )
            }
        }
    }

    pub fn lowpass(f: f64, q: f64, sr: f64) -> Coeffs {
        Self::design(FilterType::Lowpass, f, q, 0.0, sr)
    }
    pub fn highpass(f: f64, q: f64, sr: f64) -> Coeffs {
        Self::design(FilterType::Highpass, f, q, 0.0, sr)
    }
    pub fn allpass(f: f64, q: f64, sr: f64) -> Coeffs {
        Self::design(FilterType::Allpass, f, q, 0.0, sr)
    }

    /// Complex response at frequency `f`: returns (re, im).
    pub fn response(&self, f: f64, sr: f64) -> (f64, f64) {
        let w = 2.0 * PI * f / sr;
        let (c1, s1) = (w.cos(), -w.sin());
        let (c2, s2) = ((2.0 * w).cos(), -(2.0 * w).sin());
        let nr = self.b0 + self.b1 * c1 + self.b2 * c2;
        let ni = self.b1 * s1 + self.b2 * s2;
        let dr = 1.0 + self.a1 * c1 + self.a2 * c2;
        let di = self.a1 * s1 + self.a2 * s2;
        let den = dr * dr + di * di;
        ((nr * dr + ni * di) / den, (ni * dr - nr * di) / den)
    }

    /// Magnitude at `f` (linear).
    pub fn magnitude(&self, f: f64, sr: f64) -> f64 {
        let (r, i) = self.response(f, sr);
        (r * r + i * i).sqrt()
    }

    pub fn magnitude_db(&self, f: f64, sr: f64) -> f64 {
        20.0 * self.magnitude(f, sr).max(1e-12).log10()
    }
}

/// One channel of a biquad.
#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    pub c: Coeffs,
    z1: f64,
    z2: f64,
}

impl Default for Biquad {
    fn default() -> Self {
        Biquad { c: Coeffs::IDENTITY, z1: 0.0, z2: 0.0 }
    }
}

impl Biquad {
    pub fn new(c: Coeffs) -> Biquad {
        Biquad { c, z1: 0.0, z2: 0.0 }
    }

    pub fn set(&mut self, c: Coeffs) {
        self.c = c;
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let y = self.c.b0 * x + self.z1;
        self.z1 = flush64(self.c.b1 * x - self.c.a1 * y + self.z2);
        self.z2 = flush64(self.c.b2 * x - self.c.a2 * y);
        if !y.is_finite() {
            self.reset();
            return 0.0;
        }
        y as f32
    }

    #[inline(always)]
    pub fn process64(&mut self, x: f64) -> f64 {
        let y = self.c.b0 * x + self.z1;
        self.z1 = flush64(self.c.b1 * x - self.c.a1 * y + self.z2);
        self.z2 = flush64(self.c.b2 * x - self.c.a2 * y);
        if !y.is_finite() {
            self.reset();
            return 0.0;
        }
        y
    }

    pub fn process_block(&mut self, buf: &mut [f32]) {
        for x in buf {
            *x = self.process(*x);
        }
    }
}

/// A stereo pair sharing coefficients.
#[derive(Clone, Copy, Debug, Default)]
pub struct StereoBiquad {
    pub l: Biquad,
    pub r: Biquad,
}

impl StereoBiquad {
    pub fn new(c: Coeffs) -> StereoBiquad {
        StereoBiquad { l: Biquad::new(c), r: Biquad::new(c) }
    }

    pub fn set(&mut self, c: Coeffs) {
        self.l.set(c);
        self.r.set(c);
    }

    pub fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }

    #[inline(always)]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        (self.l.process(l), self.r.process(r))
    }

    pub fn process_block(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            *a = self.l.process(*a);
            *b = self.r.process(*b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SR: f64 = 48_000.0;

    #[test]
    fn lowpass_shape() {
        let c = Coeffs::lowpass(1_000.0, std::f64::consts::FRAC_1_SQRT_2, SR);
        assert!((c.magnitude_db(10.0, SR)).abs() < 0.01);
        assert!((c.magnitude_db(1_000.0, SR) + 3.0103).abs() < 0.01);
        assert!(c.magnitude_db(10_000.0, SR) < -38.0);
    }

    #[test]
    fn peaking_hits_gain_at_centre() {
        let c = Coeffs::design(FilterType::Peaking, 2_000.0, 1.0, 6.0, SR);
        assert!((c.magnitude_db(2_000.0, SR) - 6.0).abs() < 0.01);
        assert!(c.magnitude_db(20.0, SR).abs() < 0.05);
    }

    #[test]
    fn shelves_reach_their_gain() {
        let ls = Coeffs::design(FilterType::LowShelf, 200.0, 0.707, -12.0, SR);
        assert!((ls.magnitude_db(10.0, SR) + 12.0).abs() < 0.05);
        assert!(ls.magnitude_db(15_000.0, SR).abs() < 0.05);
        let hs = Coeffs::design(FilterType::HighShelf, 5_000.0, 0.707, 9.0, SR);
        assert!((hs.magnitude_db(22_000.0, SR) - 9.0).abs() < 0.2);
        assert!(hs.magnitude_db(50.0, SR).abs() < 0.05);
    }

    #[test]
    fn allpass_is_flat() {
        let c = Coeffs::allpass(800.0, 0.707, SR);
        for f in [20.0, 200.0, 800.0, 5_000.0, 20_000.0] {
            assert!(c.magnitude_db(f, SR).abs() < 1e-9);
        }
    }

    #[test]
    fn time_domain_matches_response() {
        let c = Coeffs::design(FilterType::Peaking, 1_000.0, 2.0, -9.0, SR);
        let mut bq = Biquad::new(c);
        let f = 1_000.0;
        let n = 48_000;
        let mut peak = 0.0f32;
        for i in 0..n {
            let x = (2.0 * PI * f * i as f64 / SR).sin() as f32;
            let y = bq.process(x);
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        let db = 20.0 * (peak as f64).log10();
        assert!((db + 9.0).abs() < 0.05, "{db}");
    }

    #[test]
    fn recovers_from_nan() {
        let mut bq = Biquad::new(Coeffs::lowpass(100.0, 0.7, SR));
        bq.process(f32::NAN);
        let y = bq.process(0.5);
        assert!(y.is_finite());
    }
}
