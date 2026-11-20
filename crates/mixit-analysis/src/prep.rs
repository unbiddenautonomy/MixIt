//! Preparing audio for analysis: mono downmix at a reduced rate.

use mixit_dsp::svf::{Svf, SvfCoeffs, SvfMode};

/// Sample rate the main analysis runs at (approximately; integer decimation).
pub const ANALYSIS_RATE: u32 = 22_050;

/// Mono at about 22 kHz (or the source rate if already low). Returns (samples, rate).
pub fn analysis_mono(interleaved: &[f32], sample_rate: u32) -> (Vec<f32>, f32) {
    let mono: Vec<f32> = interleaved.chunks_exact(2).map(|c| 0.5 * (c[0] + c[1])).collect();
    let factor = (sample_rate / ANALYSIS_RATE).max(1) as usize;
    let sr = sample_rate as f32;
    if factor == 1 {
        return (mono, sr);
    }
    (decimate(&mono, sr, factor, 0.45 * sr / factor as f32), sr / factor as f32)
}

/// 8th-order Butterworth low-pass at `cutoff`, then keeps every `factor`-th sample.
pub fn decimate(x: &[f32], sample_rate: f32, factor: usize, cutoff: f32) -> Vec<f32> {
    if factor <= 1 {
        return x.to_vec();
    }
    let qs = [0.5098, 0.6013, 0.9000, 2.5629];
    let cs: Vec<SvfCoeffs> =
        qs.iter().map(|&q| SvfCoeffs::design(SvfMode::Lowpass, cutoff, q, 0.0, sample_rate)).collect();
    let mut st = [Svf::default(); 4];
    let mut out = Vec::with_capacity(x.len() / factor + 1);
    for (i, &v) in x.iter().enumerate() {
        let mut y = v;
        for (s, c) in st.iter_mut().zip(&cs) {
            y = s.process(c, y);
        }
        if i % factor == 0 {
            out.push(y);
        }
    }
    out
}
