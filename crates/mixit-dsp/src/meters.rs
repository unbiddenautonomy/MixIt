//! Meters: peak, true peak, loudness (ITU-R BS.1770-4 / EBU R128), correlation and
//! band energy.
//!
//! The loudness meter keeps 100 ms sub-blocks and fixed histograms, so it runs on the
//! audio thread with no allocation and measures integrated loudness and loudness range
//! over any duration.

use crate::biquad::{Biquad, Coeffs};
use crate::crossover::ThreeBandSplitter;
use crate::oversample::TruePeakDetector;
use crate::util::one_pole_coeff;

/// K-weighting filters for a sample rate (pre-filter shelf and RLB high-pass), using the
/// sample-rate-independent design from libebur128.
pub fn k_weighting(sr: f64) -> (Coeffs, Coeffs) {
    let f0 = 1_681.974_450_955_533;
    let g = 3.999_843_853_973_347;
    let q = 0.707_175_236_955_419_6;
    let k = (std::f64::consts::PI * f0 / sr).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Coeffs {
        b0: (vh + vb * k / q + k * k) / a0,
        b1: 2.0 * (k * k - vh) / a0,
        b2: (vh - vb * k / q + k * k) / a0,
        a1: 2.0 * (k * k - 1.0) / a0,
        a2: (1.0 - k / q + k * k) / a0,
    };
    let f0 = 38.135_470_876_024_44;
    let q = 0.500_327_037_323_877_3;
    let k = (std::f64::consts::PI * f0 / sr).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Coeffs { b0: 1.0, b1: -2.0, b2: 1.0, a1: 2.0 * (k * k - 1.0) / a0, a2: (1.0 - k / q + k * k) / a0 };
    (shelf, hp)
}

const HIST_MIN: f64 = -70.0;
const HIST_MAX: f64 = 10.0;
const HIST_STEP: f64 = 0.05;
const HIST_BINS: usize = ((HIST_MAX - HIST_MIN) / HIST_STEP) as usize;

#[derive(Clone, Debug)]
struct Histogram {
    count: Vec<u64>,
    energy: Vec<f64>,
}

impl Histogram {
    fn new() -> Histogram {
        Histogram { count: vec![0; HIST_BINS], energy: vec![0.0; HIST_BINS] }
    }

    fn clear(&mut self) {
        self.count.fill(0);
        self.energy.fill(0.0);
    }

    fn add(&mut self, loudness: f64, energy: f64) {
        if loudness < HIST_MIN {
            return;
        }
        let b = (((loudness - HIST_MIN) / HIST_STEP) as usize).min(HIST_BINS - 1);
        self.count[b] += 1;
        self.energy[b] += energy;
    }

    fn bin_loudness(b: usize) -> f64 {
        HIST_MIN + (b as f64 + 0.5) * HIST_STEP
    }

    fn bin_of(loudness: f64) -> usize {
        if loudness <= HIST_MIN { 0 } else { (((loudness - HIST_MIN) / HIST_STEP) as usize).min(HIST_BINS) }
    }

    /// Mean energy and count of blocks at or above `min_loudness`.
    fn mean_above(&self, min_loudness: f64) -> (f64, u64) {
        let start = Self::bin_of(min_loudness);
        let mut e = 0.0;
        let mut c = 0;
        for b in start..HIST_BINS {
            e += self.energy[b];
            c += self.count[b];
        }
        if c == 0 { (0.0, 0) } else { (e / c as f64, c) }
    }

    /// Loudness value at a percentile (0..1) of blocks at or above `min_loudness`.
    fn percentile_above(&self, min_loudness: f64, p: f64) -> Option<f64> {
        let start = Self::bin_of(min_loudness);
        let total: u64 = self.count[start..].iter().sum();
        if total == 0 {
            return None;
        }
        let target = (p * (total - 1) as f64).round() as u64;
        let mut acc = 0;
        for b in start..HIST_BINS {
            acc += self.count[b];
            if acc > target {
                return Some(Self::bin_loudness(b));
            }
        }
        None
    }
}

#[inline]
fn energy_to_lufs(e: f64) -> f64 {
    if e <= 0.0 { -f64::INFINITY } else { -0.691 + 10.0 * e.log10() }
}

/// Stereo loudness meter (momentary 400 ms, short-term 3 s, integrated, loudness range).
#[derive(Clone, Debug)]
pub struct LoudnessMeter {
    kw: [[Biquad; 2]; 2],
    sub_len: usize,
    sub_pos: usize,
    sub_acc: f64,
    ring: [f64; 30],
    ring_pos: usize,
    ring_fill: usize,
    integrated: Histogram,
    short_term: Histogram,
    blocks_seen: u64,
}

impl LoudnessMeter {
    pub fn new(sr: f32) -> LoudnessMeter {
        let (shelf, hp) = k_weighting(sr as f64);
        LoudnessMeter {
            kw: [[Biquad::new(shelf), Biquad::new(hp)], [Biquad::new(shelf), Biquad::new(hp)]],
            sub_len: (sr as f64 * 0.1).round() as usize,
            sub_pos: 0,
            sub_acc: 0.0,
            ring: [0.0; 30],
            ring_pos: 0,
            ring_fill: 0,
            integrated: Histogram::new(),
            short_term: Histogram::new(),
            blocks_seen: 0,
        }
    }

    pub fn reset(&mut self) {
        for ch in &mut self.kw {
            for b in ch {
                b.reset();
            }
        }
        self.sub_pos = 0;
        self.sub_acc = 0.0;
        self.ring = [0.0; 30];
        self.ring_pos = 0;
        self.ring_fill = 0;
        self.integrated.clear();
        self.short_term.clear();
        self.blocks_seen = 0;
    }

    /// Resets only the integrated and range measurements (keeps momentary running).
    pub fn reset_integrated(&mut self) {
        self.integrated.clear();
        self.short_term.clear();
        self.blocks_seen = 0;
    }

    pub fn process(&mut self, l: &[f32], r: &[f32]) {
        let n = l.len().min(r.len());
        for i in 0..n {
            let a = self.kw[0][0].process64(l[i] as f64);
            let a = self.kw[0][1].process64(a);
            let b = self.kw[1][0].process64(r[i] as f64);
            let b = self.kw[1][1].process64(b);
            self.sub_acc += a * a + b * b;
            self.sub_pos += 1;
            if self.sub_pos == self.sub_len {
                self.finish_sub_block();
            }
        }
    }

    fn finish_sub_block(&mut self) {
        let mean = self.sub_acc / self.sub_len as f64;
        self.sub_acc = 0.0;
        self.sub_pos = 0;
        self.ring[self.ring_pos] = mean;
        self.ring_pos = (self.ring_pos + 1) % 30;
        self.ring_fill = (self.ring_fill + 1).min(30);
        if self.ring_fill >= 4 {
            let e = self.window_energy(4);
            self.integrated.add(energy_to_lufs(e), e);
            self.blocks_seen += 1;
        }
        if self.ring_fill >= 30 {
            let e = self.window_energy(30);
            self.short_term.add(energy_to_lufs(e), e);
        }
    }

    fn window_energy(&self, subs: usize) -> f64 {
        let mut e = 0.0;
        for k in 0..subs {
            e += self.ring[(self.ring_pos + 30 - 1 - k) % 30];
        }
        e / subs as f64
    }

    /// Momentary loudness (LUFS) over the last 400 ms.
    pub fn momentary(&self) -> f64 {
        if self.ring_fill < 4 { -f64::INFINITY } else { energy_to_lufs(self.window_energy(4)) }
    }

    /// Short-term loudness (LUFS) over the last 3 s (or what has been measured so far).
    pub fn short_term(&self) -> f64 {
        if self.ring_fill == 0 { -f64::INFINITY } else { energy_to_lufs(self.window_energy(self.ring_fill.min(30))) }
    }

    /// Gated integrated loudness (LUFS).
    pub fn integrated(&self) -> f64 {
        let (e, c) = self.integrated.mean_above(-70.0);
        if c == 0 {
            return -f64::INFINITY;
        }
        let rel = energy_to_lufs(e) - 10.0;
        let (e2, c2) = self.integrated.mean_above(rel);
        if c2 == 0 { -f64::INFINITY } else { energy_to_lufs(e2) }
    }

    /// Loudness range (LU), EBU Tech 3342.
    pub fn loudness_range(&self) -> f64 {
        let (e, c) = self.short_term.mean_above(-70.0);
        if c == 0 {
            return 0.0;
        }
        let rel = energy_to_lufs(e) - 20.0;
        match (self.short_term.percentile_above(rel, 0.10), self.short_term.percentile_above(rel, 0.95)) {
            (Some(lo), Some(hi)) => (hi - lo).max(0.0),
            _ => 0.0,
        }
    }

    /// Seconds of audio measured (gating blocks × 100 ms).
    pub fn measured_seconds(&self) -> f64 {
        self.blocks_seen as f64 * 0.1
    }
}

/// Stereo true-peak meter holding the maximum since the last reset.
#[derive(Clone, Debug, Default)]
pub struct TruePeakMeter {
    det: [TruePeakDetector; 2],
    pub max: [f32; 2],
}

impl TruePeakMeter {
    pub fn new() -> TruePeakMeter {
        TruePeakMeter::default()
    }

    pub fn process(&mut self, l: &[f32], r: &[f32]) {
        for (&a, &b) in l.iter().zip(r) {
            self.max[0] = self.max[0].max(self.det[0].process(a));
            self.max[1] = self.max[1].max(self.det[1].process(b));
        }
    }

    pub fn max_dbtp(&self) -> f32 {
        crate::util::gain_to_db(self.max[0].max(self.max[1]))
    }

    pub fn reset(&mut self) {
        self.max = [0.0; 2];
        for d in &mut self.det {
            d.reset();
        }
    }
}

/// Phase correlation (+1 mono, 0 unrelated, −1 out of phase), averaged over ~300 ms.
#[derive(Clone, Debug)]
pub struct CorrelationMeter {
    lr: f64,
    ll: f64,
    rr: f64,
    a: f64,
}

impl CorrelationMeter {
    pub fn new(sr: f32) -> CorrelationMeter {
        CorrelationMeter { lr: 0.0, ll: 0.0, rr: 0.0, a: one_pole_coeff(0.3, sr) as f64 }
    }

    pub fn process(&mut self, l: &[f32], r: &[f32]) {
        for (&a, &b) in l.iter().zip(r) {
            let (a, b) = (a as f64, b as f64);
            self.lr = a * b + self.a * (self.lr - a * b);
            self.ll = a * a + self.a * (self.ll - a * a);
            self.rr = b * b + self.a * (self.rr - b * b);
        }
    }

    pub fn value(&self) -> f32 {
        let d = (self.ll * self.rr).sqrt();
        if d < 1e-12 { 0.0 } else { (self.lr / d).clamp(-1.0, 1.0) as f32 }
    }
}

/// Energy below, between and above two crossover points, smoothed (for the coach and
/// three-band waveform colouring).
#[derive(Clone, Debug)]
pub struct BandEnergy {
    split: ThreeBandSplitter,
    env: [f64; 3],
    a: f64,
}

impl BandEnergy {
    pub fn new(sr: f32, low_hz: f32, high_hz: f32, time_s: f32) -> BandEnergy {
        BandEnergy {
            split: ThreeBandSplitter::new(low_hz as f64, high_hz as f64, sr as f64),
            env: [0.0; 3],
            a: one_pole_coeff(time_s, sr) as f64,
        }
    }

    /// Feeds a mono signal.
    pub fn process(&mut self, x: &[f32]) {
        for &v in x {
            // Linkwitz–Riley bands: phase-coherent, so a tone lands in one band only.
            let (lo, mid, hi) = self.split.split(v);
            for (e, s) in self.env.iter_mut().zip([lo as f64, mid as f64, hi as f64]) {
                *e = s * s + self.a * (*e - s * s);
            }
        }
    }

    /// RMS level of each band in dBFS.
    pub fn db(&self) -> [f32; 3] {
        self.env.map(|e| if e <= 1e-14 { -140.0 } else { (10.0 * e.log10()) as f32 + 3.01 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(f: f32, amp: f32, secs: f32, sr: f32) -> Vec<f32> {
        (0..(secs * sr) as usize).map(|i| amp * (std::f32::consts::TAU * f * i as f32 / sr).sin()).collect()
    }

    #[test]
    fn ebu_tech_3341_case_1() {
        // Stereo 1 kHz sine at −23 dBFS for 20 s reads −23.0 LUFS momentary, short-term and integrated.
        let sr = 48_000.0;
        let x = sine(1_000.0, db(-23.0), 20.0, sr);
        let mut m = LoudnessMeter::new(sr);
        m.process(&x, &x);
        assert!((m.momentary() + 23.0).abs() < 0.1, "{}", m.momentary());
        assert!((m.short_term() + 23.0).abs() < 0.1);
        assert!((m.integrated() + 23.0).abs() < 0.1, "{}", m.integrated());
    }

    fn db(d: f32) -> f32 {
        10f32.powf(d / 20.0)
    }

    #[test]
    fn integrated_gating_matches_ebur128_crate() {
        let sr = 48_000u32;
        // Loud, quiet and silent sections: the gates must ignore the silence.
        let mut x = sine(440.0, 0.5, 5.0, sr as f32);
        x.extend(sine(440.0, 0.02, 5.0, sr as f32));
        x.extend(vec![0.0; sr as usize * 5]);
        x.extend(sine(2_000.0, 0.25, 5.0, sr as f32));
        let mut m = LoudnessMeter::new(sr as f32);
        m.process(&x, &x);
        let mut r = ebur128::EbuR128::new(2, sr, ebur128::Mode::I | ebur128::Mode::LRA).unwrap();
        let inter: Vec<f32> = x.iter().flat_map(|&v| [v, v]).collect();
        r.add_frames_f32(&inter).unwrap();
        let reference = r.loudness_global().unwrap();
        assert!((m.integrated() - reference).abs() < 0.1, "ours {} reference {}", m.integrated(), reference);
    }

    #[test]
    fn loudness_range_matches_ebur128_crate() {
        // Long, steady sections (LRA depends on the short-term hop, which may legitimately
        // differ: we hop every 100 ms, libebur128 every second; both meet EBU Tech 3342).
        let sr = 48_000u32;
        let mut x = sine(440.0, 0.5, 30.0, sr as f32);
        x.extend(sine(440.0, 0.25, 30.0, sr as f32));
        x.extend(sine(440.0, 0.35, 30.0, sr as f32));
        let mut m = LoudnessMeter::new(sr as f32);
        m.process(&x, &x);
        let mut r = ebur128::EbuR128::new(2, sr, ebur128::Mode::LRA).unwrap();
        let inter: Vec<f32> = x.iter().flat_map(|&v| [v, v]).collect();
        r.add_frames_f32(&inter).unwrap();
        let lra_ref = r.loudness_range().unwrap();
        assert!((m.loudness_range() - lra_ref).abs() < 0.5, "lra ours {} reference {}", m.loudness_range(), lra_ref);
    }

    #[test]
    fn correlation() {
        let sr = 48_000.0;
        let x = sine(300.0, 0.5, 1.0, sr);
        let neg: Vec<f32> = x.iter().map(|v| -v).collect();
        let mut c = CorrelationMeter::new(sr);
        c.process(&x, &x);
        assert!(c.value() > 0.99);
        let mut c = CorrelationMeter::new(sr);
        c.process(&x, &neg);
        assert!(c.value() < -0.99);
    }

    #[test]
    fn band_energy_separates() {
        let sr = 48_000.0;
        let mut b = BandEnergy::new(sr, 200.0, 4_000.0, 0.1);
        b.process(&sine(60.0, 0.5, 1.0, sr));
        let d = b.db();
        assert!(d[0] > d[1] + 10.0 && d[0] > d[2] + 20.0, "{d:?}");
        assert!((d[0] - (-6.02)).abs() < 1.0, "{d:?}");
    }
}
