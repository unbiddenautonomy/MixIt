//! Polyphase FIR oversampling, for true-peak detection and non-linear effects.
//!
//! The upsampler inserts N−1 zeros between samples and low-passes at the original
//! Nyquist frequency, computed efficiently as N sub-filters (phases). The downsampler
//! low-passes and keeps every Nth sample.

use crate::interp::kaiser;

fn design_lowpass(factor: usize, taps_per_phase: usize, cutoff: f64, beta: f64) -> Vec<f64> {
    let len = factor * taps_per_phase;
    let centre = (len - 1) as f64 / 2.0;
    let fc = cutoff / factor as f64; // cycles per (oversampled) sample × 2
    let mut h: Vec<f64> = (0..len)
        .map(|i| {
            let x = i as f64 - centre;
            let s = if x.abs() < 1e-12 {
                1.0
            } else {
                (std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * fc * x)
            };
            fc * s * kaiser(x / (centre + 1.0), beta)
        })
        .collect();
    let sum: f64 = h.iter().sum();
    for v in &mut h {
        *v /= sum;
    }
    h
}

/// Upsamples one channel by an integer factor.
#[derive(Clone, Debug)]
pub struct Upsampler {
    factor: usize,
    taps: usize,
    /// phases[p][k]: coefficient for history sample k of output phase p.
    phases: Vec<Vec<f32>>,
    hist: Vec<f32>,
    pos: usize,
}

impl Upsampler {
    /// `taps_per_phase` 12–16 is plenty for metering; 24+ for transparent effects.
    pub fn new(factor: usize, taps_per_phase: usize) -> Upsampler {
        let h = design_lowpass(factor, taps_per_phase, 0.92, 8.0);
        let mut phases = vec![vec![0.0f32; taps_per_phase]; factor];
        for (i, &c) in h.iter().enumerate() {
            phases[i % factor][i / factor] = (c * factor as f64) as f32;
        }
        Upsampler { factor, taps: taps_per_phase, phases, hist: vec![0.0; taps_per_phase * 2], pos: 0 }
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    /// Group delay in input samples.
    pub fn latency(&self) -> f64 {
        (self.taps as f64 * self.factor as f64 - 1.0) / 2.0 / self.factor as f64
    }

    pub fn reset(&mut self) {
        self.hist.fill(0.0);
        self.pos = 0;
    }

    /// Pushes one input sample and writes `factor` output samples.
    #[inline]
    pub fn process(&mut self, x: f32, out: &mut [f32]) {
        // Double-buffered history so the newest `taps` samples are contiguous.
        self.pos = if self.pos == 0 { self.taps - 1 } else { self.pos - 1 };
        self.hist[self.pos] = x;
        self.hist[self.pos + self.taps] = x;
        let window = &self.hist[self.pos..self.pos + self.taps];
        for (p, o) in out.iter_mut().enumerate().take(self.factor) {
            let c = &self.phases[p];
            let mut acc = 0.0f32;
            for k in 0..self.taps {
                acc += c[k] * window[k];
            }
            *o = acc;
        }
    }
}

/// Downsamples one channel by an integer factor.
#[derive(Clone, Debug)]
pub struct Downsampler {
    factor: usize,
    h: Vec<f32>,
    hist: Vec<f32>,
    pos: usize,
}

impl Downsampler {
    pub fn new(factor: usize, taps_per_phase: usize) -> Downsampler {
        let h = design_lowpass(factor, taps_per_phase, 0.92, 8.0).into_iter().map(|v| v as f32).collect::<Vec<_>>();
        let n = h.len();
        Downsampler { factor, h, hist: vec![0.0; n * 2], pos: 0 }
    }

    pub fn reset(&mut self) {
        self.hist.fill(0.0);
        self.pos = 0;
    }

    /// Consumes `factor` oversampled inputs and returns one output sample.
    #[inline]
    pub fn process(&mut self, input: &[f32]) -> f32 {
        let n = self.h.len();
        for &x in input.iter().take(self.factor) {
            self.pos = if self.pos == 0 { n - 1 } else { self.pos - 1 };
            self.hist[self.pos] = x;
            self.hist[self.pos + n] = x;
        }
        let window = &self.hist[self.pos..self.pos + n];
        let mut acc = 0.0f32;
        for k in 0..n {
            acc += self.h[k] * window[k];
        }
        acc
    }
}

/// 4x oversampled true-peak detector (ITU-R BS.1770 style) for one channel.
#[derive(Clone, Debug)]
pub struct TruePeakDetector {
    up: Upsampler,
    buf: [f32; 4],
}

impl TruePeakDetector {
    pub fn new() -> TruePeakDetector {
        TruePeakDetector { up: Upsampler::new(4, 16), buf: [0.0; 4] }
    }

    pub fn reset(&mut self) {
        self.up.reset();
    }

    /// Returns the largest absolute inter-sample value around this sample.
    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        self.up.process(x, &mut self.buf);
        self.buf.iter().fold(x.abs(), |m, v| m.max(v.abs()))
    }

    /// Delay of the oversampled signal in input samples.
    pub fn latency(&self) -> f64 {
        self.up.latency()
    }
}

impl Default for TruePeakDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsampled_sine_is_smooth() {
        let mut up = Upsampler::new(4, 16);
        let mut out = [0.0f32; 4];
        let mut ys = Vec::new();
        for i in 0..2_000 {
            let x = (i as f32 * 0.1).sin();
            up.process(x, &mut out);
            ys.extend_from_slice(&out);
        }
        // Compare against the analytic sine at the oversampled positions, delayed by the latency.
        let lat = up.latency();
        let mut max_err = 0.0f32;
        for (j, y) in ys.iter().enumerate().skip(400) {
            let t = j as f64 / 4.0 - lat;
            max_err = max_err.max((y - (t * 0.1).sin() as f32).abs());
        }
        assert!(max_err < 5e-3, "{max_err}");
    }

    #[test]
    fn true_peak_finds_intersample_peak() {
        // A sine at fs/4 with a 45 degree phase: samples hit ±0.707, the waveform hits ±1.
        let mut tp = TruePeakDetector::new();
        let mut m = 0.0f32;
        for i in 0..4_000 {
            let x = (std::f32::consts::FRAC_PI_2 * i as f32 + std::f32::consts::FRAC_PI_4).sin();
            let p = tp.process(x);
            if i > 100 {
                m = m.max(p);
            }
        }
        let db = 20.0 * m.log10();
        assert!(db.abs() < 0.2, "true peak {db} dB");
    }

    #[test]
    fn downsampler_round_trip() {
        let mut up = Upsampler::new(2, 24);
        let mut down = Downsampler::new(2, 24);
        let mut buf = [0.0f32; 2];
        let mut max = 0.0f32;
        for i in 0..4_000 {
            let x = (i as f32 * 0.05).sin() * 0.5;
            up.process(x, &mut buf);
            let y = down.process(&buf);
            if i > 200 {
                max = max.max(y.abs());
            }
        }
        assert!((max - 0.5).abs() < 0.01, "{max}");
    }
}
