//! The DJ channel filter: one knob, low-pass to the left, high-pass to the right.
//!
//! * Centre (inside a small dead zone) is a bit-exact bypass.
//! * Both filter paths always run, and the output crossfades between dry, low-pass
//!   and high-pass, so sweeping through the centre or jumping across it is click-free.
//! * 24 dB/octave: two cascaded state-variable sections; resonance raises the Q of the
//!   second section, capped so the peak cannot run away.

use crate::smooth::Smoothed;
use crate::svf::{Svf, SvfCoeffs, SvfMode, prewarp};

pub const DEAD_ZONE: f32 = 0.03;
const LP_TOP_HZ: f32 = 20_000.0;
const LP_BOTTOM_HZ: f32 = 45.0;
const HP_BOTTOM_HZ: f32 = 18.0;
const HP_TOP_HZ: f32 = 9_000.0;

pub struct DjFilter {
    sr: f32,
    value: Smoothed,
    resonance: Smoothed,
    lp_mix: Smoothed,
    hp_mix: Smoothed,
    lp: [[Svf; 2]; 2],
    hp: [[Svf; 2]; 2],
    target: f32,
}

/// Low-pass cutoff for knob travel u in 0..1 (0 = fully open).
#[inline]
pub fn lp_cutoff(u: f32) -> f32 {
    LP_TOP_HZ * (LP_BOTTOM_HZ / LP_TOP_HZ).powf(u.clamp(0.0, 1.0))
}

/// High-pass cutoff for knob travel u in 0..1 (0 = fully open).
#[inline]
pub fn hp_cutoff(u: f32) -> f32 {
    HP_BOTTOM_HZ * (HP_TOP_HZ / HP_BOTTOM_HZ).powf(u.clamp(0.0, 1.0))
}

impl DjFilter {
    pub fn new(sample_rate: f32) -> DjFilter {
        DjFilter {
            sr: sample_rate,
            value: Smoothed::new(0.0, 15.0, sample_rate),
            resonance: Smoothed::new(0.3, 15.0, sample_rate),
            lp_mix: Smoothed::new(0.0, 12.0, sample_rate),
            hp_mix: Smoothed::new(0.0, 12.0, sample_rate),
            lp: [[Svf::default(); 2]; 2],
            hp: [[Svf::default(); 2]; 2],
            target: 0.0,
        }
    }

    /// Knob position −1 (full low-pass) … 0 (off) … +1 (full high-pass).
    pub fn set_value(&mut self, v: f32) {
        let v = if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 };
        self.target = v;
        self.value.set(v);
        self.lp_mix.set(if v < -DEAD_ZONE { 1.0 } else { 0.0 });
        self.hp_mix.set(if v > DEAD_ZONE { 1.0 } else { 0.0 });
    }

    pub fn value(&self) -> f32 {
        self.target
    }

    /// Resonance 0..1.
    pub fn set_resonance(&mut self, r: f32) {
        self.resonance.set(r.clamp(0.0, 1.0));
    }

    pub fn is_bypassed(&self) -> bool {
        self.lp_mix.is_steady() && self.hp_mix.is_steady() && self.lp_mix.value() == 0.0 && self.hp_mix.value() == 0.0
    }

    pub fn reset(&mut self) {
        for ch in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            for s in ch {
                s.reset();
            }
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if self.is_bypassed() {
            // Keep the knob smoother moving so re-entry starts from the right place.
            self.value.advance(l.len() as u32);
            self.resonance.advance(l.len() as u32);
            return;
        }
        let n = l.len().min(r.len());
        for i in 0..n {
            let v = self.value.next();
            let res = self.resonance.next();
            let mlp = self.lp_mix.next();
            let mhp = self.hp_mix.next();
            let u_lp = ((-v - DEAD_ZONE) / (1.0 - DEAD_ZONE)).max(0.0);
            let u_hp = ((v - DEAD_ZONE) / (1.0 - DEAD_ZONE)).max(0.0);
            // Butterworth 4th order (Q 0.5412 and 1.3066) at zero resonance.
            let q1 = 0.5412;
            let q2 = 1.3066 * (1.0 + res * 3.0);
            let tl = prewarp(lp_cutoff(u_lp), self.sr);
            let th = prewarp(hp_cutoff(u_hp), self.sr);
            let lp1 = SvfCoeffs::new(SvfMode::Lowpass, tl, q1, 0.0);
            let lp2 = SvfCoeffs::new(SvfMode::Lowpass, tl, q2, 0.0);
            let hp1 = SvfCoeffs::new(SvfMode::Highpass, th, q1, 0.0);
            let hp2 = SvfCoeffs::new(SvfMode::Highpass, th, q2, 0.0);
            // Resonance gain compensation keeps the passband level steady as Q rises.
            let comp = 1.0 / (1.0 + res * 0.8);
            let x = [l[i], r[i]];
            let mut out = [0.0f32; 2];
            for ch in 0..2 {
                let a = self.lp[ch][0].process(&lp1, x[ch]);
                let a = self.lp[ch][1].process(&lp2, a) * comp;
                let b = self.hp[ch][0].process(&hp1, x[ch]);
                let b = self.hp[ch][1].process(&hp2, b) * comp;
                let dry = 1.0 - mlp - mhp;
                out[ch] = x[ch] * dry.max(0.0) + a * mlp + b * mhp;
            }
            l[i] = out[0];
            r[i] = out[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(f: &mut DjFilter, freq: f32, n: usize) -> (Vec<f32>, f32) {
        let sr = 48_000.0;
        let mut l: Vec<f32> = (0..n).map(|i| (std::f32::consts::TAU * freq * i as f32 / sr).sin() * 0.5).collect();
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        let peak = l[n / 2..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        (l, 20.0 * (peak / 0.5).log10())
    }

    #[test]
    fn centre_is_bit_exact() {
        let mut f = DjFilter::new(48_000.0);
        let x: Vec<f32> = (0..512).map(|i| (i as f32 * 0.37).sin()).collect();
        let mut l = x.clone();
        let mut r = x.clone();
        f.process(&mut l, &mut r);
        assert_eq!(l, x);
    }

    #[test]
    fn lowpass_and_highpass_cut() {
        let mut f = DjFilter::new(48_000.0);
        f.set_value(-1.0);
        let (_, db) = run(&mut f, 5_000.0, 48_000);
        assert!(db < -60.0, "{db}");
        let mut f = DjFilter::new(48_000.0);
        f.set_value(1.0);
        let (_, db) = run(&mut f, 100.0, 48_000);
        assert!(db < -60.0, "{db}");
    }

    #[test]
    fn sweep_through_centre_is_bounded_and_continuous() {
        let mut f = DjFilter::new(48_000.0);
        f.set_resonance(1.0);
        let sr = 48_000.0;
        let mut max_step = 0.0f32;
        let mut prev = 0.0f32;
        let mut peak = 0.0f32;
        for block in 0..400 {
            f.set_value(((block as f32) * 0.05).sin());
            let mut l: Vec<f32> =
                (0..128).map(|i| (std::f32::consts::TAU * 220.0 * (block * 128 + i) as f32 / sr).sin() * 0.5).collect();
            let mut r = l.clone();
            f.process(&mut l, &mut r);
            for &y in &l {
                max_step = max_step.max((y - prev).abs());
                prev = y;
                peak = peak.max(y.abs());
            }
        }
        assert!(peak < 2.0, "peak {peak}");
        assert!(max_step < 0.2, "step {max_step}");
    }
}
