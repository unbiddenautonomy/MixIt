//! Tempo estimation, beat tracking and beatgrid fitting.
//!
//! 1. **Tempo**: autocorrelation of the onset envelope, read through a harmonic comb
//!    (the true period also correlates at 2×, 3× and 4× its lag) and weighted by a
//!    log-Gaussian tempo prior, inside the user's preferred BPM range.
//! 2. **Beats**: dynamic-programming beat tracking (Ellis 2007), which finds the beat
//!    sequence that best balances onset strength against a steady period.
//! 3. **Grid fit**: a robust linear fit through the tracked beats gives a sub-millisecond
//!    period; a joint search over period and phase then maximises onset alignment, and
//!    near-integer tempos are snapped when that does not hurt the fit. If the beats
//!    drift from any constant grid (live drummers, old records), the grid becomes a
//!    warped one with anchors that follow the tracked beats.

use serde::{Deserialize, Serialize};

use crate::stft::autocorrelation;

/// Linear interpolation into a sequence.
#[inline]
pub fn interp(x: &[f32], pos: f64) -> f32 {
    if pos < 0.0 {
        return 0.0;
    }
    let i = pos.floor() as usize;
    if i + 1 >= x.len() {
        return x.last().copied().unwrap_or(0.0) * (i < x.len()) as u8 as f32;
    }
    let t = (pos - i as f64) as f32;
    x[i] + (x[i + 1] - x[i]) * t
}

/// Gaussian smoothing (sigma in samples).
pub fn smooth(x: &[f32], sigma: f64) -> Vec<f32> {
    if sigma < 0.5 {
        return x.to_vec();
    }
    let r = (sigma * 3.0).ceil() as i64;
    let k: Vec<f32> = (-r..=r).map(|i| (-0.5 * (i as f64 / sigma).powi(2)).exp() as f32).collect();
    let ks: f32 = k.iter().sum();
    let n = x.len() as i64;
    (0..n)
        .map(|i| {
            let mut acc = 0.0;
            for (j, w) in k.iter().enumerate() {
                let idx = i + j as i64 - r;
                if idx >= 0 && idx < n {
                    acc += x[idx as usize] * w;
                }
            }
            acc / ks
        })
        .collect()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TempoEstimate {
    pub bpm: f64,
    /// 0..1: how much the winner stands out from the other candidates.
    pub confidence: f32,
    /// Other plausible tempos (BPM, relative score), best first.
    pub candidates: Vec<(f64, f32)>,
}

/// Estimates the dominant tempo within `range` (BPM).
pub fn estimate_tempo(onset: &[f32], rate: f64, range: (f64, f64)) -> TempoEstimate {
    let max_lag = (60.0 * rate / 30.0) as usize * 4 + 8;
    let acf = autocorrelation(onset, max_lag);
    let comb = |bpm: f64| -> f64 {
        let lag = 60.0 * rate / bpm;
        let a = |m: f64| interp(&acf, lag * m).max(0.0) as f64;
        a(1.0) + 0.5 * a(2.0) + 0.33 * a(3.0) + 0.25 * a(4.0)
    };
    // Log-spaced BPM grid (0.02 % steps).
    let (lo, hi) = (range.0.max(30.0), range.1.min(300.0));
    let mut grid = Vec::new();
    let mut b = lo;
    while b <= hi {
        grid.push(b);
        b *= 1.0002;
    }
    let scores: Vec<f64> = grid
        .iter()
        .map(|&bpm| {
            let prior = (-0.5 * ((bpm / 120.0).log2() / 1.2).powi(2)).exp();
            comb(bpm) * prior
        })
        .collect();
    // Local maxima as candidates.
    let mut peaks: Vec<(f64, f64)> = Vec::new();
    for i in 1..scores.len().saturating_sub(1) {
        if scores[i] >= scores[i - 1] && scores[i] > scores[i + 1] {
            peaks.push((grid[i], scores[i]));
        }
    }
    peaks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    // Keep candidates at least 2 % apart.
    let mut cands: Vec<(f64, f64)> = Vec::new();
    for p in peaks {
        if cands.iter().all(|c| (c.0 / p.0 - 1.0).abs() > 0.02) {
            cands.push(p);
        }
        if cands.len() >= 6 {
            break;
        }
    }
    let Some(&(best, best_s)) = cands.first() else {
        return TempoEstimate { bpm: 120.0, confidence: 0.0, candidates: vec![] };
    };
    let second = cands.get(1).map(|c| c.1).unwrap_or(0.0);
    let confidence = if best_s > 0.0 { ((best_s - second) / best_s).clamp(0.0, 1.0) as f32 } else { 0.0 };
    TempoEstimate { bpm: best, confidence, candidates: cands.iter().map(|c| (c.0, (c.1 / best_s) as f32)).collect() }
}

/// Dynamic-programming beat tracker. Returns beat positions in onset frames.
pub fn track_beats(onset: &[f32], period: f64, tightness: f64) -> Vec<f64> {
    let n = onset.len();
    if n < 4 || period < 2.0 {
        return vec![];
    }
    let local = smooth(onset, period / 32.0);
    let mut score = vec![0.0f64; n];
    let mut back = vec![usize::MAX; n];
    let lo = (period * 0.5).round() as usize;
    let hi = (period * 2.0).round() as usize;
    for t in 0..n {
        let mut best = 0.0f64;
        let mut arg = usize::MAX;
        if t >= lo {
            let start = t.saturating_sub(hi);
            for tau in start..=t - lo {
                let d = (t - tau) as f64 / period;
                let s = score[tau] - tightness * d.ln().powi(2);
                if s > best || arg == usize::MAX {
                    best = s;
                    arg = tau;
                }
            }
        }
        score[t] = local[t] as f64 + best.max(0.0);
        back[t] = if best > 0.0 { arg } else { usize::MAX };
    }
    // Start from the best-scoring frame in the last period.
    let tail = n.saturating_sub(period.ceil() as usize);
    let mut t = (tail..n).max_by(|&a, &b| score[a].partial_cmp(&score[b]).unwrap()).unwrap_or(n - 1);
    let mut beats = vec![t];
    while back[t] != usize::MAX {
        t = back[t];
        beats.push(t);
    }
    beats.reverse();
    // Refine each beat to a fraction of a frame with a parabolic fit on the local score.
    beats
        .into_iter()
        .map(|b| {
            if b == 0 || b + 1 >= n {
                return b as f64;
            }
            let (a, c, d) = (local[b - 1] as f64, local[b] as f64, local[b + 1] as f64);
            let den = a - 2.0 * c + d;
            if den.abs() < 1e-12 { b as f64 } else { b as f64 + (0.5 * (a - d) / den).clamp(-0.5, 0.5) }
        })
        .collect()
}

/// A fitted constant grid: beat k is at `first + k * period` seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ConstantFit {
    pub period: f64,
    pub first: f64,
    pub score: f64,
}

/// Total onset strength sampled along a grid.
fn grid_score(onset: &[f32], rate: f64, period: f64, phase: f64, from: f64, to: f64) -> f64 {
    let mut k0 = ((from - phase) / period).ceil();
    let mut s = 0.0;
    let mut count = 0;
    loop {
        let t = phase + k0 * period;
        if t > to {
            break;
        }
        s += interp(onset, t * rate) as f64;
        count += 1;
        k0 += 1.0;
    }
    if count == 0 { 0.0 } else { s / count as f64 }
}

/// Robust least-squares line through beat times: returns (period, intercept, residual rms).
pub fn fit_line(times: &[f64]) -> Option<(f64, f64, f64)> {
    if times.len() < 4 {
        return None;
    }
    let mut idx: Vec<(f64, f64)> = Vec::new();
    // Number beats by their position relative to the first, using the median interval,
    // so a missed or doubled beat does not shift all later indices.
    let mut iv: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    iv.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = iv[iv.len() / 2];
    for &t in times {
        idx.push((((t - times[0]) / med).round(), t));
    }
    let mut keep: Vec<bool> = vec![true; idx.len()];
    let mut res = (med, times[0], 0.0);
    for _ in 0..4 {
        let pts: Vec<&(f64, f64)> = idx.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| p).collect();
        if pts.len() < 4 {
            break;
        }
        let n = pts.len() as f64;
        let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
        let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
        let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        if sxx <= 0.0 {
            break;
        }
        let slope = sxy / sxx;
        let icpt = my - slope * mx;
        let rms = (pts.iter().map(|p| (p.1 - (icpt + slope * p.0)).powi(2)).sum::<f64>() / n).sqrt();
        res = (slope, icpt, rms);
        for (k, p) in keep.iter_mut().zip(&idx) {
            *k = (p.1 - (icpt + slope * p.0)).abs() < 0.12 * slope;
        }
    }
    Some(res)
}

/// Fits the best constant grid near `period` (seconds), searching period and phase.
pub fn fit_constant(onset: &[f32], rate: f64, period: f64, phase: f64, span: (f64, f64)) -> ConstantFit {
    let sm = smooth(onset, rate * 0.004);
    let mut best = ConstantFit { period, first: phase, score: f64::MIN };
    // Coarse-to-fine joint search.
    let mut p_range = period * 0.003;
    let mut ph_range = period * 0.25;
    let (mut pc, mut phc) = (period, phase);
    for _ in 0..4 {
        let steps = 20;
        for i in 0..=steps {
            let p = pc - p_range + 2.0 * p_range * i as f64 / steps as f64;
            for j in 0..=steps {
                let ph = phc - ph_range + 2.0 * ph_range * j as f64 / steps as f64;
                let s = grid_score(&sm, rate, p, ph, span.0, span.1);
                if s > best.score {
                    best = ConstantFit { period: p, first: ph, score: s };
                }
            }
        }
        pc = best.period;
        phc = best.first;
        p_range /= 6.0;
        ph_range /= 6.0;
    }
    best
}

/// Re-optimises only the phase for a fixed period.
pub fn fit_phase(onset: &[f32], rate: f64, period: f64, phase: f64, span: (f64, f64)) -> ConstantFit {
    let sm = smooth(onset, rate * 0.004);
    let mut best = ConstantFit { period, first: phase, score: f64::MIN };
    let mut range = period * 0.1;
    let mut c = phase;
    for _ in 0..4 {
        for j in 0..=40 {
            let ph = c - range + 2.0 * range * j as f64 / 40.0;
            let s = grid_score(&sm, rate, period, ph, span.0, span.1);
            if s > best.score {
                best = ConstantFit { period, first: ph, score: s };
            }
        }
        c = best.first;
        range /= 8.0;
    }
    best
}

/// Snaps to a whole or half BPM when the fit stays (almost) as good.
pub fn snap_tempo(onset: &[f32], rate: f64, fit: ConstantFit, span: (f64, f64)) -> ConstantFit {
    let bpm = 60.0 / fit.period;
    for step in [1.0, 0.5] {
        let snapped = (bpm / step).round() * step;
        let tol = if step == 1.0 { 0.05 } else { 0.03 };
        if (snapped - bpm).abs() < tol && snapped != bpm {
            let f = fit_phase(onset, rate, 60.0 / snapped, fit.first, span);
            if f.score >= fit.score * 0.995 {
                return f;
            }
        } else if snapped == bpm {
            return fit;
        }
    }
    fit
}
