//! Test signals and measurements shared by the DSP, engine and analysis tests.
//!
//! Enabled for this crate's tests, and for other crates with the `testkit` feature.

use crate::rng::Rng;

/// A sine of `n` frames at `freq` Hz with peak `amp`.
pub fn sine(n: usize, freq: f32, sr: f32, amp: f32) -> Vec<f32> {
    let w = std::f64::consts::TAU * freq as f64 / sr as f64;
    (0..n).map(|i| (amp as f64 * (w * i as f64).sin()) as f32).collect()
}

/// Uniform white noise in ±`amp`, deterministic for a given seed.
pub fn noise(n: usize, seed: u64, amp: f32) -> Vec<f32> {
    let mut rng = Rng::new(seed);
    (0..n).map(|_| rng.bipolar() * amp).collect()
}

/// A logarithmic sine sweep from `f0` to `f1` Hz.
pub fn sweep(n: usize, f0: f32, f1: f32, sr: f32, amp: f32) -> Vec<f32> {
    let t_total = n as f64 / sr as f64;
    let k = (f1 as f64 / f0 as f64).ln();
    (0..n)
        .map(|i| {
            let t = i as f64 / sr as f64;
            let phase = std::f64::consts::TAU * f0 as f64 * t_total / k * ((t / t_total * k).exp() - 1.0);
            (amp as f64 * phase.sin()) as f32
        })
        .collect()
}

/// A unit impulse at frame 0.
pub fn impulse(n: usize) -> Vec<f32> {
    let mut v = vec![0.0; n];
    if n > 0 {
        v[0] = 1.0;
    }
    v
}

/// RMS level.
pub fn rms(x: &[f32]) -> f32 {
    crate::util::rms(x)
}

/// Amplitude of the component at `freq` (single-bin DFT, Hann-windowed, peak-scaled).
pub fn tone_level(x: &[f32], freq: f32, sr: f32) -> f32 {
    let n = x.len();
    if n == 0 {
        return 0.0;
    }
    let w = std::f64::consts::TAU * freq as f64 / sr as f64;
    let (mut re, mut im, mut wsum) = (0.0f64, 0.0f64, 0.0f64);
    for (i, &v) in x.iter().enumerate() {
        let win = 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos();
        re += v as f64 * win * (w * i as f64).cos();
        im += v as f64 * win * (w * i as f64).sin();
        wsum += win;
    }
    (2.0 * (re * re + im * im).sqrt() / wsum) as f32
}

/// Level of `a − b` relative to `a`, in dB (−∞ when identical). Lengths must match.
pub fn null_test_db(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    let diff: Vec<f32> = a.iter().zip(b).map(|(x, y)| x - y).collect();
    let d = rms(&diff);
    let r = rms(a).max(1e-12);
    if d == 0.0 { f32::NEG_INFINITY } else { 20.0 * (d / r).log10() }
}

/// Finds discontinuities: frames whose second difference exceeds a threshold.
///
/// Smooth programme (tones up to a few kHz, fades longer than about a millisecond) stays
/// far below the default threshold; a hard step, dropout or splice shows up at once.
#[derive(Clone, Copy, Debug)]
pub struct ClickDetector {
    pub threshold: f32,
}

impl Default for ClickDetector {
    fn default() -> Self {
        ClickDetector { threshold: 0.05 }
    }
}

impl ClickDetector {
    /// Frames where a click was detected (adjacent detections are merged).
    pub fn clicks(&self, x: &[f32]) -> Vec<usize> {
        let mut out: Vec<usize> = Vec::new();
        for i in 2..x.len() {
            let d2 = x[i] - 2.0 * x[i - 1] + x[i - 2];
            if d2.abs() > self.threshold && out.last().is_none_or(|&p| i > p + 4) {
                out.push(i);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_detector_finds_steps_not_tones() {
        let x = sine(4_800, 1_000.0, 48_000.0, 0.9);
        assert!(ClickDetector::default().clicks(&x).is_empty());
        let mut y = x.clone();
        for v in &mut y[2_000..] {
            *v = 0.0;
        }
        assert!(!ClickDetector::default().clicks(&y).is_empty() || x[2_000].abs() < 0.05);
    }

    #[test]
    fn tone_level_measures_amplitude() {
        let x = sine(48_000, 1_000.0, 48_000.0, 0.5);
        assert!((tone_level(&x, 1_000.0, 48_000.0) - 0.5).abs() < 0.01);
        assert!(tone_level(&x, 3_000.0, 48_000.0) < 0.001);
    }
}
