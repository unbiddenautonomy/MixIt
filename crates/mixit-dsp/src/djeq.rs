//! The DJ mixer's 3-band EQ, in two modes:
//!
//! * **Classic:** a low shelf, a wide mid bell and a high shelf, +6 to −26 dB. Gentle
//!   and musical. At 0 dB on all bands the output is bit-identical to the input.
//! * **Isolator:** Linkwitz-Riley crossovers (default 250 Hz and 2.5 kHz) with a gain
//!   per band, so a band can be removed completely ("killed"). Used to swap basslines
//!   between two tracks without any low-end bleed.
//!
//! Switching mode crossfades the two paths over 20 ms, so it is click-free.

use crate::crossover::ThreeBandSplitter;
use crate::smooth::Smoothed;
use crate::svf::{Svf, SvfCoeffs, SvfMode, prewarp};
use crate::util::db_to_gain;
use std::f32::consts::FRAC_1_SQRT_2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EqMode {
    Classic,
    Isolator,
}

pub const EQ_MIN_DB: f32 = -26.0;
pub const EQ_MAX_DB: f32 = 6.0;
pub const BAND_LOW: usize = 0;
pub const BAND_MID: usize = 1;
pub const BAND_HIGH: usize = 2;

/// Frequencies of the classic EQ (low shelf, mid bell, high shelf) and the isolator crossovers.
#[derive(Clone, Copy, Debug)]
pub struct EqVoicing {
    pub low_shelf_hz: f32,
    pub mid_hz: f32,
    pub mid_q: f32,
    pub high_shelf_hz: f32,
    pub iso_low_hz: f32,
    pub iso_high_hz: f32,
}

impl Default for EqVoicing {
    fn default() -> Self {
        EqVoicing {
            low_shelf_hz: 100.0,
            mid_hz: 1_000.0,
            mid_q: 0.7,
            high_shelf_hz: 10_000.0,
            iso_low_hz: 250.0,
            iso_high_hz: 2_500.0,
        }
    }
}

pub struct DjEq {
    sr: f32,
    voicing: EqVoicing,
    tan: [f32; 3],
    db: [f32; 3],
    kill: [bool; 3],
    classic_db: [Smoothed; 3],
    classic_state: [[Svf; 3]; 2],
    classic_c: [SvfCoeffs; 3],
    iso_gain: [Smoothed; 3],
    iso: [ThreeBandSplitter; 2],
    mode: EqMode,
    /// 0 = classic, 1 = isolator; ramps during a mode switch.
    blend: Smoothed,
}

impl DjEq {
    pub fn new(sample_rate: f32, voicing: EqVoicing) -> DjEq {
        let sr = sample_rate;
        let tan = [prewarp(voicing.low_shelf_hz, sr), prewarp(voicing.mid_hz, sr), prewarp(voicing.high_shelf_hz, sr)];
        let mk = |ms| Smoothed::new(0.0, ms, sr);
        let mut eq = DjEq {
            sr,
            voicing,
            tan,
            db: [0.0; 3],
            kill: [false; 3],
            classic_db: [mk(15.0), mk(15.0), mk(15.0)],
            classic_state: [[Svf::default(); 3]; 2],
            classic_c: [SvfCoeffs::new(SvfMode::Bell, tan[1], 0.7, 0.0); 3],
            iso_gain: [Smoothed::new(1.0, 10.0, sr), Smoothed::new(1.0, 10.0, sr), Smoothed::new(1.0, 10.0, sr)],
            iso: [
                ThreeBandSplitter::new(voicing.iso_low_hz as f64, voicing.iso_high_hz as f64, sr as f64),
                ThreeBandSplitter::new(voicing.iso_low_hz as f64, voicing.iso_high_hz as f64, sr as f64),
            ],
            mode: EqMode::Isolator,
            blend: Smoothed::new(1.0, 20.0, sr),
        };
        eq.update_classic_coeffs();
        eq
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn voicing(&self) -> EqVoicing {
        self.voicing
    }

    pub fn mode(&self) -> EqMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: EqMode) {
        self.mode = mode;
        self.blend.set(if mode == EqMode::Isolator { 1.0 } else { 0.0 });
    }

    /// Band gain in dB, clamped to −26..+6.
    pub fn set_gain_db(&mut self, band: usize, db: f32) {
        self.db[band] = db.clamp(EQ_MIN_DB, EQ_MAX_DB);
        self.apply(band);
    }

    pub fn gain_db(&self, band: usize) -> f32 {
        self.db[band]
    }

    pub fn set_kill(&mut self, band: usize, kill: bool) {
        self.kill[band] = kill;
        self.apply(band);
    }

    pub fn kill(&self, band: usize) -> bool {
        self.kill[band]
    }

    fn apply(&mut self, band: usize) {
        let classic = if self.kill[band] { EQ_MIN_DB } else { self.db[band] };
        self.classic_db[band].set(classic);
        // In isolator mode the bottom of the knob is a full kill.
        let iso = if self.kill[band] || self.db[band] <= EQ_MIN_DB + 0.05 { 0.0 } else { db_to_gain(self.db[band]) };
        self.iso_gain[band].set(iso);
    }

    fn update_classic_coeffs(&mut self) {
        let v = self.voicing;
        self.classic_c[BAND_LOW] =
            SvfCoeffs::new(SvfMode::LowShelf, self.tan[0], FRAC_1_SQRT_2, self.classic_db[0].value());
        self.classic_c[BAND_MID] = SvfCoeffs::new(SvfMode::Bell, self.tan[1], v.mid_q, self.classic_db[1].value());
        self.classic_c[BAND_HIGH] =
            SvfCoeffs::new(SvfMode::HighShelf, self.tan[2], FRAC_1_SQRT_2, self.classic_db[2].value());
    }

    pub fn reset(&mut self) {
        for ch in &mut self.classic_state {
            for s in ch {
                s.reset();
            }
        }
        for s in &mut self.iso {
            s.reset();
        }
    }

    /// True when the EQ would pass audio unchanged (classic mode, all bands at 0 dB).
    pub fn is_transparent(&self) -> bool {
        self.mode == EqMode::Classic
            && self.blend.is_steady()
            && self.classic_db.iter().all(|s| s.is_steady() && s.value() == 0.0)
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.is_transparent() {
            return;
        }
        let n = l.len().min(r.len());
        for i in 0..n {
            let blend = self.blend.next();
            let classic_steady = self.classic_db.iter().all(|s| s.is_steady());
            if !classic_steady {
                for s in &mut self.classic_db {
                    s.next();
                }
                self.update_classic_coeffs();
            }
            let gl = self.iso_gain[0].next();
            let gm = self.iso_gain[1].next();
            let gh = self.iso_gain[2].next();

            let (xl, xr) = (l[i], r[i]);
            let mut cl = xl;
            let mut cr = xr;
            if blend < 1.0 {
                for b in 0..3 {
                    cl = self.classic_state[0][b].process(&self.classic_c[b], cl);
                    cr = self.classic_state[1][b].process(&self.classic_c[b], cr);
                }
            }
            let (mut il, mut ir) = (0.0, 0.0);
            if blend > 0.0 {
                let (a, b, c) = self.iso[0].split(xl);
                il = a * gl + b * gm + c * gh;
                let (a, b, c) = self.iso[1].split(xr);
                ir = a * gl + b * gm + c * gh;
            }
            if blend <= 0.0 {
                l[i] = cl;
                r[i] = cr;
            } else if blend >= 1.0 {
                l[i] = il;
                r[i] = ir;
            } else {
                let (go, gi) = crate::util::equal_power(blend);
                l[i] = cl * go + il * gi;
                r[i] = cr * go + ir * gi;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone_db(eq: &mut DjEq, f: f32) -> f32 {
        let sr = eq.sample_rate();
        let n = 48_000;
        let mut l: Vec<f32> = (0..n).map(|i| (std::f32::consts::TAU * f * i as f32 / sr).sin()).collect();
        let mut r = l.clone();
        eq.process(&mut l, &mut r);
        20.0 * crate::testkit::tone_level(&l[n / 2..], f, sr).max(1e-12).log10()
    }

    #[test]
    fn classic_unity_is_bit_exact() {
        let mut eq = DjEq::new(48_000.0, EqVoicing::default());
        eq.set_mode(EqMode::Classic);
        // Let the mode switch finish.
        let mut a = vec![0.0f32; 2_000];
        let mut b = vec![0.0f32; 2_000];
        eq.process(&mut a, &mut b);
        let x: Vec<f32> = (0..1000).map(|i| ((i * 37) % 101) as f32 / 101.0 - 0.5).collect();
        let mut l = x.clone();
        let mut r = x.clone();
        eq.process(&mut l, &mut r);
        assert_eq!(l, x);
    }

    #[test]
    fn isolator_unity_is_flat_and_kills_are_deep() {
        let mut eq = DjEq::new(48_000.0, EqVoicing::default());
        for f in [40.0, 400.0, 4_000.0, 12_000.0] {
            let db = tone_db(&mut eq, f);
            assert!(db.abs() < 0.1, "{f} Hz: {db}");
        }
        eq.set_kill(BAND_LOW, true);
        assert!(tone_db(&mut eq, 40.0) < -60.0);
        eq.set_kill(BAND_LOW, false);
        eq.set_gain_db(BAND_HIGH, EQ_MIN_DB);
        assert!(tone_db(&mut eq, 12_000.0) < -60.0);
    }

    #[test]
    fn classic_cut_depth() {
        let mut eq = DjEq::new(48_000.0, EqVoicing::default());
        eq.set_mode(EqMode::Classic);
        eq.set_gain_db(BAND_LOW, -26.0);
        let db = tone_db(&mut eq, 30.0);
        assert!(db < -23.0, "{db}");
        eq.set_gain_db(BAND_LOW, 0.0);
        eq.set_gain_db(BAND_MID, 6.0);
        let db = tone_db(&mut eq, 1_000.0);
        assert!((db - 6.0).abs() < 0.1, "{db}");
    }
}
