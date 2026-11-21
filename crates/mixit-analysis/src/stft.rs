//! Short-time Fourier transform helpers.

use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex};

/// Magnitude spectrogram: `frames × bins`, row-major.
pub struct Spectrogram {
    pub bins: usize,
    pub frames: usize,
    pub hop: usize,
    pub size: usize,
    pub sample_rate: f32,
    pub mag: Vec<f32>,
}

impl Spectrogram {
    #[inline]
    pub fn frame(&self, i: usize) -> &[f32] {
        &self.mag[i * self.bins..(i + 1) * self.bins]
    }

    /// Centre frequency of bin `k` (Hz).
    #[inline]
    pub fn bin_hz(&self, k: usize) -> f32 {
        k as f32 * self.sample_rate / self.size as f32
    }

    /// Time of frame `i` (seconds), at the window centre.
    pub fn frame_time(&self, i: usize) -> f64 {
        (i * self.hop) as f64 / self.sample_rate as f64
    }

    pub fn frame_rate(&self) -> f64 {
        self.sample_rate as f64 / self.hop as f64
    }
}

pub fn hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect()
}

/// Computes |STFT| with a Hann window. Frame `i` is centred on sample `i * hop`.
pub fn stft(x: &[f32], sample_rate: f32, size: usize, hop: usize) -> Spectrogram {
    let mut planner = RealFftPlanner::<f32>::new();
    let fft: Arc<dyn RealToComplex<f32>> = planner.plan_fft_forward(size);
    let win = hann(size);
    let bins = size / 2 + 1;
    let frames = x.len() / hop + 1;
    let mut mag = vec![0.0f32; frames * bins];
    let mut input = fft.make_input_vec();
    let mut output = fft.make_output_vec();
    let mut scratch = fft.make_scratch_vec();
    let half = (size / 2) as i64;
    let norm = 2.0 / win.iter().sum::<f32>();
    for f in 0..frames {
        let start = (f * hop) as i64 - half;
        for (k, v) in input.iter_mut().enumerate() {
            let idx = start + k as i64;
            *v = if idx >= 0 && (idx as usize) < x.len() { x[idx as usize] * win[k] } else { 0.0 };
        }
        let _ = fft.process_with_scratch(&mut input, &mut output, &mut scratch);
        let row = &mut mag[f * bins..(f + 1) * bins];
        for (m, c) in row.iter_mut().zip(output.iter()) {
            *m = c.norm() * norm;
        }
    }
    Spectrogram { bins, frames, hop, size, sample_rate, mag }
}

/// Autocorrelation via FFT (unbiased by overlap length is not applied).
pub fn autocorrelation(x: &[f32], max_lag: usize) -> Vec<f32> {
    let n = (x.len() * 2).next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(n);
    let inv = planner.plan_fft_inverse(n);
    let mut a = fwd.make_input_vec();
    a[..x.len()].copy_from_slice(x);
    let mut spec = fwd.make_output_vec();
    let _ = fwd.process(&mut a, &mut spec);
    for c in spec.iter_mut() {
        *c = realfft::num_complex::Complex::new(c.norm_sqr(), 0.0);
    }
    let mut out = inv.make_output_vec();
    let _ = inv.process(&mut spec, &mut out);
    out.truncate(max_lag.min(x.len()));
    let z = out.first().copied().unwrap_or(1.0).max(1e-12);
    out.iter().map(|v| v / z).collect()
}
