//! From onsets to a beatgrid: tempo, tracked beats, a constant or warped beat model,
//! and the downbeat (which beat is "one").

use serde::{Deserialize, Serialize};

use crate::key::Chromagram;
use crate::onset::Onsets;
use crate::tempo::{TempoEstimate, estimate_tempo, fit_constant, fit_line, interp, snap_tempo, track_beats};

/// How far the onset envelope's peak trails the true note start (seconds). Measured
/// against generated tracks with known beat times (see the calibration test).
pub const ONSET_LATENCY: f64 = -0.0033;

/// Beat model in seconds: beat index `k` (integer = a beat) maps to a time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum BeatModel {
    Constant {
        period: f64,
        first: f64,
    },
    /// Piecewise linear through (k, seconds) anchors, k strictly increasing.
    Warped {
        anchors: Vec<(f64, f64)>,
    },
}

impl BeatModel {
    pub fn time(&self, k: f64) -> f64 {
        match self {
            BeatModel::Constant { period, first } => first + k * period,
            BeatModel::Warped { anchors } => {
                let n = anchors.len();
                let i = anchors.partition_point(|a| a.0 <= k).saturating_sub(1).min(n - 2);
                let (a, b) = (anchors[i], anchors[i + 1]);
                a.1 + (k - a.0) * (b.1 - a.1) / (b.0 - a.0)
            }
        }
    }

    /// Fractional beat index at time `t`.
    pub fn index(&self, t: f64) -> f64 {
        match self {
            BeatModel::Constant { period, first } => (t - first) / period,
            BeatModel::Warped { anchors } => {
                let n = anchors.len();
                let i = anchors.partition_point(|a| a.1 <= t).saturating_sub(1).min(n - 2);
                let (a, b) = (anchors[i], anchors[i + 1]);
                a.0 + (t - a.1) * (b.0 - a.0) / (b.1 - a.1)
            }
        }
    }

    /// Beat period near time `t` (seconds).
    pub fn period_at(&self, t: f64) -> f64 {
        let k = self.index(t);
        self.time(k + 0.5) - self.time(k - 0.5)
    }

    /// Shifts every beat by `dt` seconds.
    pub fn shifted(&self, dt: f64) -> BeatModel {
        match self {
            BeatModel::Constant { period, first } => BeatModel::Constant { period: *period, first: first + dt },
            BeatModel::Warped { anchors } => {
                BeatModel::Warped { anchors: anchors.iter().map(|&(k, t)| (k, t + dt)).collect() }
            }
        }
    }

    pub fn is_warped(&self) -> bool {
        matches!(self, BeatModel::Warped { .. })
    }
}

#[derive(Clone, Debug)]
pub struct Rhythm {
    pub tempo: TempoEstimate,
    /// Final tempo (snapped, or the mean tempo of a warped grid).
    pub bpm: f64,
    /// Grid in seconds of the true audio (latency-corrected).
    pub model: BeatModel,
    /// Tracked beat times (seconds), for display and diagnostics.
    pub tracked: Vec<f64>,
    /// Spread of the beats around the best constant grid (ms, smoothed max − min).
    pub drift_ms: f64,
    /// Mean onset strength on the beats relative to between them (≥ 1 for a clear pulse).
    pub beat_strength: f32,
    /// Normalised autocorrelation of the onset envelope at the beat period (0..1):
    /// how strongly the music repeats at this tempo. Unlike `beat_strength` it is not
    /// inflated by fitting a grid to noise.
    pub pulse_clarity: f32,
    /// Overall grid confidence 0..1.
    pub confidence: f32,
}

/// Normalised autocorrelation of the mean-removed envelope at `period` (frames),
/// taking the best lag within ±2 %.
pub fn pulse_clarity(env: &[f32], period: f64) -> f32 {
    let n = env.len();
    if n < 4 || period < 2.0 {
        return 0.0;
    }
    let mean = env.iter().sum::<f32>() / n as f32;
    let x: Vec<f32> = env.iter().map(|v| v - mean).collect();
    let e0: f64 = x.iter().map(|v| (*v as f64).powi(2)).sum();
    if e0 <= 0.0 {
        return 0.0;
    }
    let lo = (period * 0.98).floor() as usize;
    let hi = ((period * 1.02).ceil() as usize).min(n - 1);
    let mut best = 0.0f64;
    for lag in lo.max(1)..=hi {
        let c: f64 = (0..n - lag).map(|i| x[i] as f64 * x[i + lag] as f64).sum();
        best = best.max(c * n as f64 / (n - lag) as f64 / e0);
    }
    best.clamp(0.0, 1.0) as f32
}

/// Onset envelope used for tempo and beats: full-band flux with extra weight on kicks.
pub fn pulse_envelope(o: &Onsets) -> Vec<f32> {
    o.full.iter().zip(&o.low).map(|(f, l)| f + 0.5 * l).collect()
}

/// Indexes beats consecutively, counting skipped beats from the local interval.
pub(crate) fn index_beats(times: &[f64]) -> Vec<(f64, f64)> {
    if times.is_empty() {
        return vec![];
    }
    let mut iv: Vec<f64> = times.windows(2).map(|w| w[1] - w[0]).collect();
    iv.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = iv.get(iv.len() / 2).copied().unwrap_or(0.5);
    let mut out = vec![(0.0, times[0])];
    let mut k = 0.0;
    for w in times.windows(2) {
        k += ((w[1] - w[0]) / med).round().max(1.0);
        out.push((k, w[1]));
    }
    out
}

/// Robust local regression time at index `k` from (k, t) pairs within `radius` beats.
pub(crate) fn local_time(pts: &[(f64, f64)], k: f64, radius: f64) -> Option<f64> {
    let mut sel: Vec<(f64, f64)> = pts.iter().copied().filter(|p| (p.0 - k).abs() <= radius).collect();
    for _ in 0..3 {
        if sel.len() < 4 {
            return None;
        }
        let n = sel.len() as f64;
        let mx = sel.iter().map(|p| p.0).sum::<f64>() / n;
        let my = sel.iter().map(|p| p.1).sum::<f64>() / n;
        let sxx: f64 = sel.iter().map(|p| (p.0 - mx).powi(2)).sum();
        let sxy: f64 = sel.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
        if sxx <= 0.0 {
            return None;
        }
        let slope = sxy / sxx;
        let icpt = my - slope * mx;
        let before = sel.len();
        sel.retain(|p| (p.1 - (icpt + slope * p.0)).abs() < 0.1 * slope);
        if sel.len() == before {
            return Some(icpt + slope * k);
        }
    }
    None
}

/// Drops anchors that the straight line between their neighbours predicts within `tol`.
pub(crate) fn simplify(anchors: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if anchors.len() <= 2 {
        return anchors.to_vec();
    }
    // Douglas–Peucker.
    let (a, b) = (anchors[0], *anchors.last().unwrap());
    let mut worst = (0, 0.0);
    for (i, p) in anchors.iter().enumerate().take(anchors.len() - 1).skip(1) {
        let pred = a.1 + (p.0 - a.0) * (b.1 - a.1) / (b.0 - a.0);
        let d = (p.1 - pred).abs();
        if d > worst.1 {
            worst = (i, d);
        }
    }
    if worst.1 <= tol {
        return vec![a, b];
    }
    let mut left = simplify(&anchors[..=worst.0], tol);
    let right = simplify(&anchors[worst.0..], tol);
    left.pop();
    left.extend(right);
    left
}

/// Mean of `x` sampled on beats `k + offset` of a model, over a time span.
fn sample_on(x: &[f32], rate: f64, model: &BeatModel, span: (f64, f64), offset: f64) -> f64 {
    let (k0, k1) = (model.index(span.0).ceil() as i64, model.index(span.1).floor() as i64);
    let mut s = 0.0;
    let mut c = 0;
    for k in k0..k1 {
        s += interp(x, model.time(k as f64 + offset) * rate) as f64;
        c += 1;
    }
    if c == 0 { 0.0 } else { s / c as f64 }
}

/// Runs tempo estimation, beat tracking and grid fitting. `span` limits the fit to the
/// audible part of the track (seconds).
///
/// Half-time ambiguity: when snares and claps land halfway between the detected beats
/// (drum & bass read at half speed), and double the tempo is in range, the analysis is
/// repeated around double the tempo.
pub fn rhythm(o: &Onsets, bpm_range: (f64, f64), allow_warp: bool, span: (f64, f64)) -> Option<Rhythm> {
    let r = rhythm_once(o, bpm_range, allow_warp, span)?;
    let double = r.bpm * 2.0;
    if double <= bpm_range.1 && double <= 190.0 {
        let m = r.model.shifted(ONSET_LATENCY);
        let on = sample_on(&o.mid, o.rate, &m, span, 0.0);
        let half = sample_on(&o.mid, o.rate, &m, span, 0.5);
        if half > 1.4 * on {
            if let Some(r2) = rhythm_once(o, (double * 0.97, double * 1.03), allow_warp, span) {
                return Some(r2);
            }
        }
    }
    Some(r)
}

fn rhythm_once(o: &Onsets, bpm_range: (f64, f64), allow_warp: bool, span: (f64, f64)) -> Option<Rhythm> {
    let env = pulse_envelope(o);
    let rate = o.rate;
    let tempo = estimate_tempo(&env, rate, bpm_range);
    if tempo.candidates.is_empty() {
        return None;
    }
    let period_frames = 60.0 * rate / tempo.bpm;
    let raw = track_beats(&env, period_frames, 100.0);
    // Onset-time beats within the audible span.
    let times: Vec<f64> = raw.iter().map(|f| f / rate).filter(|&t| t >= span.0 - 0.05 && t <= span.1 + 0.05).collect();
    if times.len() < 8 {
        return None;
    }
    let (period, icpt, _) = fit_line(&times)?;
    let fit_span = (times[0] - period * 0.5, times[times.len() - 1] + period * 0.5);
    let fit = fit_constant(&env, rate, period, icpt, fit_span);
    let fit = snap_tempo(&env, rate, fit, fit_span);

    // Drift: smoothed residuals of the tracked beats against the constant grid.
    let pts = index_beats(&times);
    let k_off = ((pts[0].1 - fit.first) / fit.period).round();
    let resid: Vec<f64> = pts.iter().map(|&(k, t)| t - (fit.first + (k + k_off) * fit.period)).collect();
    let smooth_r: Vec<f64> = (0..resid.len())
        .map(|i| {
            let a = i.saturating_sub(16);
            let b = (i + 17).min(resid.len());
            let mut w: Vec<f64> = resid[a..b].to_vec();
            w.sort_by(|x, y| x.partial_cmp(y).unwrap());
            w[w.len() / 2]
        })
        .collect();
    let lo = smooth_r.iter().copied().fold(f64::MAX, f64::min);
    let hi = smooth_r.iter().copied().fold(f64::MIN, f64::max);
    let drift = (hi - lo).max(0.0);

    let mut model = BeatModel::Constant { period: fit.period, first: fit.first };
    if allow_warp && drift > 0.030 && pts.len() >= 32 {
        // Anchors every bar from local regressions over ±8 beats.
        let shifted: Vec<(f64, f64)> = pts.iter().map(|&(k, t)| (k + k_off, t)).collect();
        let k_first = shifted[0].0;
        let k_last = shifted[shifted.len() - 1].0;
        let mut anchors = Vec::new();
        let mut k = k_first;
        while k <= k_last {
            if let Some(t) = local_time(&shifted, k, 8.0) {
                if anchors.last().is_none_or(|&(_, pt): &(f64, f64)| t > pt) {
                    anchors.push((k, t));
                }
            }
            k += 4.0;
        }
        if let Some(t) = local_time(&shifted, k_last, 8.0) {
            if anchors.last().is_none_or(|&(pk, pt): &(f64, f64)| k_last > pk && t > pt) {
                anchors.push((k_last, t));
            }
        }
        let anchors = simplify(&anchors, 0.002);
        if anchors.len() >= 2 {
            // Keep the warp only if it lines up with the onsets clearly better.
            let warped = BeatModel::Warped { anchors };
            let sc = sample_on(&env, rate, &model, fit_span, 0.0);
            let sw = sample_on(&env, rate, &warped, fit_span, 0.0);
            if sw > sc * 1.03 {
                model = warped;
            }
        }
    }

    // Beat strength: onset on the beats versus halfway between them.
    let (mut on, mut off) = (0.0f64, 0.0f64);
    let (k0, k1) = (model.index(fit_span.0).ceil() as i64, model.index(fit_span.1).floor() as i64);
    for k in k0..k1 {
        on += interp(&env, model.time(k as f64) * rate) as f64;
        off += interp(&env, model.time(k as f64 + 0.5) * rate) as f64;
    }
    let beat_strength = if off > 0.0 { (on / off) as f32 } else { 10.0 };
    let bpm = match &model {
        BeatModel::Constant { period, .. } => 60.0 / period,
        BeatModel::Warped { anchors } => {
            let (a, b) = (anchors[0], anchors[anchors.len() - 1]);
            60.0 * (b.0 - a.0) / (b.1 - a.1)
        }
    };
    let clarity = pulse_clarity(&env, 60.0 * rate / bpm);
    let clarity_conf = (clarity / 0.4).clamp(0.0, 1.0);
    let confidence = (0.4 * tempo.confidence + 0.6 * clarity_conf).clamp(0.0, 1.0);
    Some(Rhythm {
        tempo,
        bpm,
        model: model.shifted(-ONSET_LATENCY),
        tracked: times.iter().map(|t| t - ONSET_LATENCY).collect(),
        drift_ms: drift * 1_000.0,
        beat_strength,
        pulse_clarity: clarity,
        confidence,
    })
}

/// Mean of chroma frames between two times.
fn chroma_mean(c: &Chromagram, t0: f64, t1: f64) -> [f32; 12] {
    let a = (t0 * c.rate).round().max(0.0) as usize;
    let b = ((t1 * c.rate).round() as usize).min(c.treble.len());
    let mut m = [0.0f32; 12];
    for i in a..b {
        let w = 1.0;
        for k in 0..12 {
            m[k] += c.treble[i][k] * w;
        }
    }
    m
}

fn cosine(a: &[f32; 12], b: &[f32; 12]) -> f32 {
    let (mut d, mut na, mut nb) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        d += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= 0.0 || nb <= 0.0 { 1.0 } else { d / (na * nb).sqrt() }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Downbeat {
    /// Beat indices `k` with `k mod beats_per_bar == phase` are downbeats.
    pub phase: i64,
    pub beats_per_bar: u32,
    pub confidence: f32,
}

/// Per-beat evidence for "this beat starts a bar".
pub struct BeatFeatures {
    pub k0: i64,
    /// Harmonic change entering the beat (0..2).
    pub harm: Vec<f32>,
    /// Kick onset at the beat.
    pub low: Vec<f32>,
    /// Bright onset (crashes) at the beat.
    pub high: Vec<f32>,
    /// Loudness jump entering the beat.
    pub energy: Vec<f32>,
}

pub fn beat_features(model: &BeatModel, o: &Onsets, chroma: &Chromagram, span: (f64, f64)) -> BeatFeatures {
    let k0 = model.index(span.0).ceil() as i64;
    let k1 = model.index(span.1).floor() as i64;
    let mut f = BeatFeatures { k0, harm: vec![], low: vec![], high: vec![], energy: vec![] };
    let rms = |t0: f64, t1: f64| -> f32 {
        let a = (t0 * o.rate).max(0.0) as usize;
        let b = ((t1 * o.rate) as usize).min(o.full.len());
        if b <= a { 0.0 } else { o.full[a..b].iter().sum::<f32>() / (b - a) as f32 }
    };
    for k in k0..=k1 {
        let t = model.time(k as f64);
        let tp = model.time(k as f64 - 1.0);
        let tn = model.time(k as f64 + 1.0);
        let before = chroma_mean(chroma, tp, t);
        let after = chroma_mean(chroma, t, tn);
        f.harm.push(1.0 - cosine(&before, &after));
        // Peak onset within ±1/8 beat (tracks small timing errors).
        let w = (tn - t) / 8.0;
        let peak = |x: &[f32]| -> f32 {
            let a = ((t - w) * o.rate).max(0.0) as usize;
            let b = (((t + w) * o.rate).ceil() as usize).min(x.len().saturating_sub(1));
            x.get(a..=b).map(|s| s.iter().copied().fold(0.0, f32::max)).unwrap_or(0.0)
        };
        f.low.push(peak(&o.low));
        f.high.push(peak(&o.high));
        f.energy.push((rms(t, tn) - rms(tp, t)).max(0.0));
    }
    f
}

/// Chooses the downbeat phase (and 3/4 vs 4/4) from beat-synchronous evidence.
pub fn downbeat(f: &BeatFeatures) -> Downbeat {
    let n = f.harm.len();
    if n < 8 {
        return Downbeat { phase: 0, beats_per_bar: 4, confidence: 0.0 };
    }
    let feats: [(&Vec<f32>, f32); 4] = [(&f.harm, 1.0), (&f.low, 0.5), (&f.high, 0.35), (&f.energy, 0.35)];
    let eval = |bpb: usize| -> (usize, f32, f32) {
        let mut total = vec![0.0f32; bpb];
        for (x, w) in feats {
            let mut m = vec![0.0f32; bpb];
            let mut c = vec![0usize; bpb];
            for (i, v) in x.iter().enumerate() {
                m[i % bpb] += v;
                c[i % bpb] += 1;
            }
            for p in 0..bpb {
                m[p] /= c[p].max(1) as f32;
            }
            let mean = m.iter().sum::<f32>() / bpb as f32;
            let sd = (m.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / bpb as f32).sqrt();
            if sd > 1e-6 {
                // Scale-free: what matters is how one phase stands out.
                let scale = sd.max(0.05 * mean.abs());
                for p in 0..bpb {
                    total[p] += w * (m[p] - mean) / scale;
                }
            }
        }
        let mut idx: Vec<usize> = (0..bpb).collect();
        idx.sort_by(|&a, &b| total[b].partial_cmp(&total[a]).unwrap());
        (idx[0], total[idx[0]], total[idx[0]] - total[idx[1]])
    };
    let (p4, s4, m4) = eval(4);
    let (p3, s3, m3) = eval(3);
    let (phase, bpb, margin) = if s3 > s4 * 1.5 && m3 > m4 * 1.5 && s3 > 2.0 { (p3, 3, m3) } else { (p4, 4, m4) };
    let k = (f.k0 + phase as i64).rem_euclid(bpb as i64);
    Downbeat { phase: k, beats_per_bar: bpb, confidence: (margin / 2.0).clamp(0.0, 1.0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warped_model_is_invertible() {
        let m = BeatModel::Warped { anchors: vec![(0.0, 1.0), (8.0, 5.0), (16.0, 8.6)] };
        for k in [-2.0, 0.0, 3.5, 8.0, 12.25, 20.0] {
            assert!((m.index(m.time(k)) - k).abs() < 1e-9);
        }
        assert!((m.period_at(2.0) - 0.5).abs() < 1e-9);
        assert!((m.period_at(10.0) - 0.45).abs() < 1e-9);
        let c = BeatModel::Constant { period: 0.5, first: 0.25 };
        assert!((c.shifted(0.1).time(2.0) - 1.35).abs() < 1e-12);
    }

    #[test]
    fn index_beats_counts_missed_beats() {
        let times = [0.0, 0.5, 1.0, 2.0, 2.5, 3.0];
        let k: Vec<f64> = index_beats(&times).iter().map(|p| p.0).collect();
        assert_eq!(k, vec![0.0, 1.0, 2.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn simplify_keeps_corners_only() {
        let pts: Vec<(f64, f64)> =
            (0..20).map(|k| (k as f64, if k < 10 { k as f64 * 0.5 } else { 5.0 + (k - 10) as f64 * 0.4 })).collect();
        let s = simplify(&pts, 0.001);
        assert_eq!(s.len(), 3);
        assert_eq!(s[1].0, 10.0);
    }

    #[test]
    fn pulse_clarity_separates_pulse_from_noise() {
        let pulse: Vec<f32> = (0..2_000).map(|i| if i % 40 == 0 { 1.0 } else { 0.0 }).collect();
        assert!(pulse_clarity(&pulse, 40.0) > 0.9);
        let mut rng = mixit_dsp::rng::Rng::new(3);
        let noise: Vec<f32> = (0..2_000).map(|_| rng.next_f32()).collect();
        assert!(pulse_clarity(&noise, 40.0) < 0.1);
    }
}
