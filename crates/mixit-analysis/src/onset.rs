//! Onset strength: log-filtered spectral flux with vibrato suppression (SuperFlux,
//! Böck & Widmer 2013), plus a separate low-band flux that follows the kick drum.

use crate::stft::{Spectrogram, stft};

pub const ONSET_WINDOW: usize = 1_024;
pub const ONSET_HOP: usize = 256;

/// Onset envelopes at the spectrogram frame rate.
pub struct Onsets {
    /// Full-band onset strength (normalised, ≥ 0).
    pub full: Vec<f32>,
    /// 30–150 Hz flux (kick drums).
    pub low: Vec<f32>,
    /// 300 Hz–3 kHz flux (snares, claps, chords): finds the backbeat.
    pub mid: Vec<f32>,
    /// 2–11 kHz flux (hats, snares).
    pub high: Vec<f32>,
    /// Frames per second.
    pub rate: f64,
    /// Frame `i` is centred on sample `i * hop`.
    pub hop: usize,
}

/// Triangular filterbank with `per_octave` bands between `fmin` and `fmax`.
pub struct Filterbank {
    /// For each band: (first bin, weights).
    bands: Vec<(usize, Vec<f32>)>,
    pub centres: Vec<f32>,
}

impl Filterbank {
    pub fn log(bins: usize, size: usize, sr: f32, fmin: f32, fmax: f32, per_octave: f32) -> Filterbank {
        let hz = |k: f32| k * sr / size as f32;
        let mut edges = Vec::new();
        let mut f = fmin;
        while f < fmax.min(sr * 0.5) {
            edges.push(f);
            f *= 2f32.powf(1.0 / per_octave);
        }
        let mut bands = Vec::new();
        let mut centres = Vec::new();
        for w in edges.windows(3) {
            let (lo, c, hi) = (w[0], w[1], w[2]);
            let mut first = usize::MAX;
            let mut weights = Vec::new();
            for k in 0..bins {
                let f = hz(k as f32);
                if f <= lo || f >= hi {
                    continue;
                }
                let wgt = if f <= c { (f - lo) / (c - lo) } else { (hi - f) / (hi - c) };
                if first == usize::MAX {
                    first = k;
                }
                weights.resize(k - first, 0.0);
                weights.push(wgt);
            }
            if first == usize::MAX {
                // Band narrower than a bin: use the nearest bin.
                let k = (c * size as f32 / sr).round() as usize;
                if k < bins {
                    bands.push((k, vec![1.0]));
                    centres.push(c);
                }
                continue;
            }
            let s: f32 = weights.iter().sum::<f32>().max(1e-9);
            weights.iter_mut().for_each(|w| *w /= s);
            bands.push((first, weights));
            centres.push(c);
        }
        Filterbank { bands, centres }
    }

    pub fn len(&self) -> usize {
        self.bands.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bands.is_empty()
    }

    pub fn apply(&self, spectrum: &[f32], out: &mut [f32]) {
        for (o, (first, w)) in out.iter_mut().zip(&self.bands) {
            let mut acc = 0.0;
            for (j, &wt) in w.iter().enumerate() {
                acc += spectrum[first + j] * wt;
            }
            *o = acc;
        }
    }
}

/// Removes a moving average and half-wave rectifies, then scales to unit peak.
fn adaptive_normalise(x: &mut [f32], radius: usize) {
    let n = x.len();
    if n == 0 {
        return;
    }
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + x[i] as f64;
    }
    let src = x.to_vec();
    for i in 0..n {
        let a = i.saturating_sub(radius);
        let b = (i + radius + 1).min(n);
        let mean = (prefix[b] - prefix[a]) / (b - a) as f64;
        x[i] = (src[i] as f64 - mean).max(0.0) as f32;
    }
    let mut sorted: Vec<f32> = x.iter().copied().filter(|v| *v > 0.0).collect();
    if sorted.is_empty() {
        return;
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // Scale by a high percentile rather than the maximum (robust to single spikes).
    let idx = ((sorted.len() - 1) as f32 * 0.99) as usize;
    let p = sorted[idx].max(1e-9);
    x.iter_mut().for_each(|v| *v = (*v / p).min(4.0));
}

fn flux(spec: &Spectrogram, fb: &Filterbank, lag: usize, max_radius: usize) -> Vec<f32> {
    let nb = fb.len();
    let mut logspec = vec![0.0f32; spec.frames * nb];
    let mut tmp = vec![0.0f32; nb];
    for f in 0..spec.frames {
        fb.apply(spec.frame(f), &mut tmp);
        for (o, v) in logspec[f * nb..(f + 1) * nb].iter_mut().zip(&tmp) {
            *o = (1.0 + 1_000.0 * v).ln();
        }
    }
    let mut out = vec![0.0f32; spec.frames];
    let mut maxf = vec![0.0f32; nb];
    for f in lag..spec.frames {
        let prev = &logspec[(f - lag) * nb..(f - lag + 1) * nb];
        // Maximum filter over neighbouring bands suppresses vibrato and glides.
        for b in 0..nb {
            let lo = b.saturating_sub(max_radius);
            let hi = (b + max_radius + 1).min(nb);
            maxf[b] = prev[lo..hi].iter().copied().fold(f32::MIN, f32::max);
        }
        let cur = &logspec[f * nb..(f + 1) * nb];
        out[f] = cur.iter().zip(&maxf).map(|(c, p)| (c - p).max(0.0)).sum();
    }
    out
}

pub fn onsets(x: &[f32], sr: f32) -> Onsets {
    let spec = stft(x, sr, ONSET_WINDOW, ONSET_HOP);
    onsets_from(&spec)
}

pub fn onsets_from(spec: &Spectrogram) -> Onsets {
    let sr = spec.sample_rate;
    let full_fb = Filterbank::log(spec.bins, spec.size, sr, 30.0, 11_000.0, 12.0);
    let low_fb = Filterbank::log(spec.bins, spec.size, sr, 25.0, 160.0, 6.0);
    let mid_fb = Filterbank::log(spec.bins, spec.size, sr, 300.0, 3_000.0, 6.0);
    let high_fb = Filterbank::log(spec.bins, spec.size, sr, 2_000.0, 11_000.0, 6.0);
    let radius = (spec.frame_rate() * 0.5) as usize; // half-second running mean
    let mut full = flux(spec, &full_fb, 2, 1);
    let mut low = flux(spec, &low_fb, 1, 0);
    let mut mid = flux(spec, &mid_fb, 1, 0);
    let mut high = flux(spec, &high_fb, 1, 0);
    for x in [&mut full, &mut low, &mut mid, &mut high] {
        adaptive_normalise(x, radius);
    }
    Onsets { full, low, mid, high, rate: spec.frame_rate(), hop: spec.hop }
}
