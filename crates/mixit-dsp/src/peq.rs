//! Studio parametric EQ (up to 8 bands) built on modulation-safe SVF sections, so every
//! band can be automated or dragged on screen without zipper noise.

use crate::biquad::{Coeffs, FilterType};
use crate::smooth::Smoothed;
use crate::svf::{Svf, SvfCoeffs, SvfMode, prewarp};
use std::f32::consts::FRAC_1_SQRT_2;

pub const MAX_BANDS: usize = 8;
/// Cut filters can cascade up to this many 12 dB/octave sections (48 dB/octave).
const MAX_SECTIONS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BandShape {
    Bell,
    LowShelf,
    HighShelf,
    LowCut,
    HighCut,
    Notch,
    BandPass,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BandSettings {
    pub enabled: bool,
    pub shape: BandShape,
    pub freq: f32,
    pub q: f32,
    pub gain_db: f32,
    /// For cuts: 12, 24, 36 or 48 dB/octave.
    pub slope_db: u8,
}

impl Default for BandSettings {
    fn default() -> Self {
        BandSettings {
            enabled: false,
            shape: BandShape::Bell,
            freq: 1_000.0,
            q: FRAC_1_SQRT_2,
            gain_db: 0.0,
            slope_db: 12,
        }
    }
}

struct BandState {
    s: BandSettings,
    freq: Smoothed,
    q: Smoothed,
    gain: Smoothed,
    mix: Smoothed,
    st: [[Svf; MAX_SECTIONS]; 2],
    c: SvfCoeffs,
}

pub struct ParametricEq {
    sr: f32,
    bands: Vec<BandState>,
    output_gain: Smoothed,
}

fn svf_mode(shape: BandShape) -> SvfMode {
    match shape {
        BandShape::Bell => SvfMode::Bell,
        BandShape::LowShelf => SvfMode::LowShelf,
        BandShape::HighShelf => SvfMode::HighShelf,
        BandShape::LowCut => SvfMode::Highpass,
        BandShape::HighCut => SvfMode::Lowpass,
        BandShape::Notch => SvfMode::Notch,
        BandShape::BandPass => SvfMode::Bandpass,
    }
}

impl ParametricEq {
    pub fn new(sr: f32) -> ParametricEq {
        let bands = (0..MAX_BANDS)
            .map(|_| {
                let s = BandSettings::default();
                BandState {
                    s,
                    freq: Smoothed::new(s.freq.ln(), 30.0, sr),
                    q: Smoothed::new(s.q, 30.0, sr),
                    gain: Smoothed::new(0.0, 30.0, sr),
                    mix: Smoothed::new(0.0, 20.0, sr),
                    st: [[Svf::default(); MAX_SECTIONS]; 2],
                    c: SvfCoeffs::design(SvfMode::Bell, s.freq, s.q, 0.0, sr),
                }
            })
            .collect();
        ParametricEq { sr, bands, output_gain: Smoothed::new(1.0, 20.0, sr) }
    }

    pub fn set_band(&mut self, i: usize, s: BandSettings) {
        let b = &mut self.bands[i];
        if b.s.shape != s.shape {
            for ch in &mut b.st {
                for x in ch {
                    x.reset();
                }
            }
        }
        b.s = s;
        b.freq.set(s.freq.clamp(10.0, self.sr * 0.49).ln());
        b.q.set(s.q.clamp(0.1, 30.0));
        b.gain.set(s.gain_db.clamp(-30.0, 30.0));
        b.mix.set(if s.enabled { 1.0 } else { 0.0 });
    }

    pub fn band(&self, i: usize) -> BandSettings {
        self.bands[i].s
    }

    pub fn set_output_db(&mut self, db: f32) {
        self.output_gain.set(crate::util::db_to_gain(db));
    }

    fn sections(s: &BandSettings) -> usize {
        match s.shape {
            BandShape::LowCut | BandShape::HighCut => ((s.slope_db / 12).clamp(1, 4)) as usize,
            _ => 1,
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        for b in &mut self.bands {
            if b.mix.is_steady() && b.mix.value() == 0.0 {
                continue;
            }
            let mode = svf_mode(b.s.shape);
            let secs = Self::sections(&b.s);
            let mut steady = b.freq.is_steady() && b.q.is_steady() && b.gain.is_steady();
            if steady {
                b.c = SvfCoeffs::new(mode, prewarp(b.freq.value().exp(), self.sr), b.q.value(), b.gain.value());
            }
            for i in 0..n {
                if !steady {
                    let f = b.freq.next().exp();
                    let q = b.q.next();
                    let g = b.gain.next();
                    b.c = SvfCoeffs::new(mode, prewarp(f, self.sr), q, g);
                    steady = b.freq.is_steady() && b.q.is_steady() && b.gain.is_steady();
                }
                let m = b.mix.next();
                let x = [l[i], r[i]];
                let mut y = x;
                for ch in 0..2 {
                    for s in 0..secs {
                        y[ch] = b.st[ch][s].process(&b.c, y[ch]);
                    }
                }
                l[i] = x[0] + (y[0] - x[0]) * m;
                r[i] = x[1] + (y[1] - x[1]) * m;
            }
        }
        if !(self.output_gain.is_steady() && self.output_gain.value() == 1.0) {
            for i in 0..n {
                let g = self.output_gain.next();
                l[i] *= g;
                r[i] *= g;
            }
        }
    }

    /// True when no band is on or fading and the output gain is unity: `process` would
    /// leave the signal untouched.
    pub fn is_idle(&self) -> bool {
        self.bands.iter().all(|b| b.mix.is_steady() && b.mix.value() == 0.0)
            && self.output_gain.is_steady()
            && self.output_gain.value() == 1.0
    }

    /// Magnitude response of the whole EQ at `f` (dB), for drawing the curve.
    pub fn response_db(&self, f: f32) -> f32 {
        let mut db = 0.0f64;
        for b in &self.bands {
            if !b.s.enabled {
                continue;
            }
            let kind = match b.s.shape {
                BandShape::Bell => FilterType::Peaking,
                BandShape::LowShelf => FilterType::LowShelf,
                BandShape::HighShelf => FilterType::HighShelf,
                BandShape::LowCut => FilterType::Highpass,
                BandShape::HighCut => FilterType::Lowpass,
                BandShape::Notch => FilterType::Notch,
                BandShape::BandPass => FilterType::Bandpass,
            };
            let c = Coeffs::design(kind, b.s.freq as f64, b.s.q as f64, b.s.gain_db as f64, self.sr as f64);
            db += c.magnitude_db(f as f64, self.sr as f64) * Self::sections(&b.s) as f64;
        }
        db as f32
    }

    pub fn reset(&mut self) {
        for b in &mut self.bands {
            for ch in &mut b.st {
                for x in ch {
                    x.reset();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bell_band_matches_its_curve() {
        let sr = 48_000.0;
        let mut eq = ParametricEq::new(sr);
        eq.set_band(
            0,
            BandSettings { enabled: true, shape: BandShape::Bell, freq: 2_000.0, q: 1.5, gain_db: -8.0, slope_db: 12 },
        );
        let n = 48_000;
        for f in [200.0f32, 2_000.0, 8_000.0] {
            let mut l: Vec<f32> = (0..n).map(|i| (std::f32::consts::TAU * f * i as f32 / sr).sin()).collect();
            let mut r = l.clone();
            eq.reset();
            eq.process(&mut l, &mut r);
            let measured = 20.0 * crate::testkit::tone_level(&l[n / 2..], f, sr).log10();
            assert!((measured - eq.response_db(f)).abs() < 0.2, "{f}: {measured} vs {}", eq.response_db(f));
        }
    }

    #[test]
    fn disabled_eq_is_transparent() {
        let mut eq = ParametricEq::new(48_000.0);
        let x: Vec<f32> = (0..256).map(|i| (i as f32 * 0.1).sin()).collect();
        let mut l = x.clone();
        let mut r = x.clone();
        eq.process(&mut l, &mut r);
        assert_eq!(l, x);
    }
}
