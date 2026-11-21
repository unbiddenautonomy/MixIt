//! Key detection.
//!
//! 1. The signal is decimated to about 5.5 kHz and analysed with long windows (8192
//!    samples, 0.67 Hz resolution), which resolve bass notes a semitone apart.
//! 2. Spectral peaks are picked and refined by parabolic interpolation. Their deviation
//!    from equal temperament gives the tuning (records are often a few cents off A440).
//! 3. A harmonic pitch class profile (HPCP, Gómez 2006) is built from the peaks: each
//!    peak counts towards its own pitch class and, with decaying weight, towards the
//!    fundamentals it could be a harmonic of. A separate bass profile (below 220 Hz)
//!    captures the root movement, which is strongly tonic-weighted in dance music. Bass
//!    is treated as monophonic: weaker peaks near a stronger one are sidebands of short
//!    repeated notes, and each note's constant floor (a kick drum's pitch) is removed.
//! 4. The profiles are correlated with rotated key profiles (Krumhansl–Kessler,
//!    Temperley, and a diatonic/triad profile suited to electronic music) and the
//!    scores averaged. The margin between the best and second key gives confidence.

use mixit_core::Key;
use serde::{Deserialize, Serialize};

use crate::prep::decimate;
use crate::stft::stft;

pub const CHROMA_SIZE: usize = 8_192;
pub const CHROMA_HOP: usize = 1_024;
/// Weight of the (moving) bass profile against the treble profile.
pub const BASS_WEIGHT: f32 = 0.35;
/// Bass peaks weaker than another within this many semitones are taken as sidebands
/// (see `chromagram_with`). Tuned with the `key_sweep` and `key_practice` diagnostics:
/// 243 of 252 generated tracks right, against 235 without it.
pub const BASS_SPREAD: f64 = 3.0;
/// Score bonus for the most common bass note as tonic.
pub const TONIC_BASS_BONUS: f32 = 0.15;

/// Per-frame pitch class profiles.
pub struct Chromagram {
    /// Treble (all peaks up to 1.8 kHz), magnitude-weighted (not normalised per frame,
    /// so quiet noisy frames count little).
    pub treble: Vec<[f32; 12]>,
    /// Bass (peaks 55–220 Hz, above most kick fundamentals), magnitude-weighted.
    pub bass: Vec<[f32; 12]>,
    /// Frame energy (sum of peak magnitudes), for weighting.
    pub energy: Vec<f32>,
    /// Sum of peak magnitudes above 250 Hz: chords, pads and leads rather than kick and bass.
    pub tonal: Vec<f32>,
    /// Frames per second; frame `i` is centred at `i / rate` seconds.
    pub rate: f64,
    /// Tuning offset from A440 in cents (−50..50).
    pub tuning_cents: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyEstimate {
    pub key: Key,
    /// 0..1.
    pub confidence: f32,
    /// The runner-up (often the relative or a fifth away).
    pub second: Key,
    pub tuning_cents: f32,
    /// The five best keys with their correlation scores.
    pub ranking: Vec<(Key, f32)>,
}

/// A key region inside a track (for key changes).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeySegment {
    pub start: f64,
    pub end: f64,
    pub key: Key,
    pub confidence: f32,
}

struct Peak {
    /// Fractional MIDI pitch.
    pitch: f64,
    mag: f32,
}

fn peaks(frame: &[f32], bin_hz: f64, fmin: f64, fmax: f64) -> Vec<Peak> {
    let mut out = Vec::new();
    let k0 = ((fmin / bin_hz).floor() as usize).max(1);
    let k1 = ((fmax / bin_hz).ceil() as usize).min(frame.len() - 2);
    let floor = frame[k0..=k1].iter().copied().fold(0.0f32, f32::max) * 0.02;
    for k in k0..=k1 {
        let (a, b, c) = (frame[k - 1], frame[k], frame[k + 1]);
        if b > a && b >= c && b > floor {
            let den = a - 2.0 * b + c;
            let d = if den.abs() > 1e-12 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
            let f = (k as f64 + d as f64) * bin_hz;
            let mag = b - 0.25 * (a - c) * d;
            out.push(Peak { pitch: 69.0 + 12.0 * (f / 440.0).log2(), mag });
        }
    }
    out
}

/// Decimates a mono signal to about 5.5 kHz for chroma analysis. Returns (signal, rate).
pub fn chroma_signal(mono: &[f32], sample_rate: f32) -> (Vec<f32>, f32) {
    let factor = ((sample_rate / 5_512.5).round() as usize).max(1);
    (decimate(mono, sample_rate, factor, 2_000.0f32.min(0.45 * sample_rate)), sample_rate / factor as f32)
}

/// Computes the key chromagram (long windows) of a signal from [`chroma_signal`].
pub fn chromagram(low: &[f32], sr: f32) -> Chromagram {
    chromagram_with(low, sr, CHROMA_SIZE, CHROMA_HOP, 50.0)
}

/// Chromagram with a chosen window; shorter windows follow chord changes beat by beat
/// (used for downbeats) at the cost of bass resolution.
pub fn chromagram_with(low: &[f32], sr: f32, size: usize, hop: usize, fmin: f64) -> Chromagram {
    let spec = stft(low, sr, size, hop);
    let bin_hz = sr as f64 / size as f64;
    let all: Vec<Vec<Peak>> = (0..spec.frames).map(|f| peaks(spec.frame(f), bin_hz, fmin, 1_800.0)).collect();

    // Tuning: magnitude-weighted circular mean of the deviation from the semitone grid.
    let (mut sx, mut sy) = (0.0f64, 0.0f64);
    for p in all.iter().flatten() {
        let ang = std::f64::consts::TAU * (p.pitch - p.pitch.round());
        let w = (p.mag as f64).sqrt();
        sx += w * ang.cos();
        sy += w * ang.sin();
    }
    let tuning = if sx == 0.0 && sy == 0.0 { 0.0 } else { sy.atan2(sx) / std::f64::consts::TAU };

    const HARMONICS: [(f64, f32); 4] = [(0.0, 1.0), (12.0, 0.6), (19.02, 0.36), (24.0, 0.22)];
    let mut treble = Vec::with_capacity(spec.frames);
    let mut bass = Vec::with_capacity(spec.frames);
    let mut energy = Vec::with_capacity(spec.frames);
    let mut tonal = Vec::with_capacity(spec.frames);
    let p250 = 69.0 + 12.0 * (250.0f64 / 440.0).log2();
    for fp in &all {
        tonal.push(fp.iter().filter(|p| p.pitch >= p250).map(|p| p.mag).sum::<f32>());
        let mut t = [0.0f32; 12];
        let mut b = [0.0f32; 12];
        let mut e = 0.0;
        for p in fp {
            let pitch = p.pitch - tuning;
            let w = p.mag.sqrt();
            e += p.mag;
            for &(down, hw) in &HARMONICS {
                let fund = pitch - down;
                if fund < 28.0 {
                    continue;
                }
                // Spread over the two nearest pitch classes with a cosine window.
                let r = fund.round();
                let dist = (fund - r).abs();
                let wgt = (std::f64::consts::PI * dist).cos().powi(2) as f32;
                let pc = (r as i64).rem_euclid(12) as usize;
                t[pc] += w * hw * wgt;
            }
            // Bass is close to monophonic, and short repeated notes (a rolling techno
            // bassline) put sidebands at the repetition rate, often a semitone or more
            // from the note at these frequencies. Only the strongest peak within
            // BASS_SPREAD semitones counts.
            if (33.0..57.0).contains(&p.pitch)
                && !fp.iter().any(|q| q.mag > p.mag && (q.pitch - p.pitch).abs() < BASS_SPREAD)
            {
                let r = pitch.round();
                b[(r as i64).rem_euclid(12) as usize] += p.mag;
            }
        }
        treble.push(t);
        bass.push(b);
        energy.push(e);
    }
    Chromagram { treble, bass, energy, tonal, rate: spec.frame_rate(), tuning_cents: (tuning * 100.0) as f32 }
}

const KK_MAJOR: [f32; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR: [f32; 12] = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const TEMPERLEY_MAJOR: [f32; 12] = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
const TEMPERLEY_MINOR: [f32; 12] = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];
/// Tonic, triad, other scale degrees, chromatic. Minor is natural (Aeolian), which
/// dominates electronic music.
const DIATONIC_MAJOR: [f32; 12] = [1.0, 0.1, 0.5, 0.1, 0.8, 0.5, 0.1, 0.8, 0.1, 0.5, 0.1, 0.4];
const DIATONIC_MINOR: [f32; 12] = [1.0, 0.1, 0.5, 0.8, 0.1, 0.5, 0.1, 0.8, 0.5, 0.1, 0.5, 0.1];

fn pearson(a: &[f32; 12], b: &[f32; 12], rot: usize) -> f32 {
    let ma = a.iter().sum::<f32>() / 12.0;
    let mb = b.iter().sum::<f32>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        let x = a[(i + rot) % 12] - ma;
        let y = b[i] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
    }
    if da <= 0.0 || db <= 0.0 { 0.0 } else { num / (da * db).sqrt() }
}

/// Correlation of a pitch class profile with each of the 24 keys (index as [`Key::index`]).
pub fn key_scores(profile: &[f32; 12]) -> [f32; 24] {
    let mut out = [0.0f32; 24];
    let sets = [(&KK_MAJOR, &KK_MINOR), (&TEMPERLEY_MAJOR, &TEMPERLEY_MINOR), (&DIATONIC_MAJOR, &DIATONIC_MINOR)];
    for tonic in 0..12 {
        let mut maj = 0.0;
        let mut min = 0.0;
        for (pm, pn) in sets {
            maj += pearson(profile, pm, tonic);
            min += pearson(profile, pn, tonic);
        }
        out[tonic] = maj / sets.len() as f32;
        out[12 + tonic] = min / sets.len() as f32;
    }
    out
}

/// Key scores for frames `range`: profile correlation plus a bonus for keys whose tonic
/// is the most common bass note (separates relative major and minor, which share
/// their notes but not their root).
fn scores_for(c: &Chromagram, range: std::ops::Range<usize>) -> [f32; 24] {
    let b = moving_bass(c, range.clone());
    let p = profile(c, range, &b);
    let mut s = key_scores(&p);
    let bm = b.iter().copied().fold(0.0, f32::max);
    if bm > 0.0 {
        let mean = b.iter().sum::<f32>() / 12.0 / bm;
        for t in 0..12 {
            let bonus = TONIC_BASS_BONUS * (b[t] / bm - mean);
            s[t] += bonus;
            s[12 + t] += bonus;
        }
    }
    s
}

/// The bass notes that move with the chords. A kick drum's pitch (and anything else held
/// throughout) stays put, so each note's floor over 2-second blocks (its lower quartile)
/// is removed before summing.
fn moving_bass(c: &Chromagram, range: std::ops::Range<usize>) -> [f32; 12] {
    let block = ((2.0 * c.rate) as usize).max(1);
    let blocks: Vec<[f32; 12]> = range
        .clone()
        .step_by(block)
        .map(|s| {
            let mut v = [0.0f32; 12];
            for i in s..(s + block).min(range.end) {
                for k in 0..12 {
                    v[k] += c.bass[i][k];
                }
            }
            v
        })
        .collect();
    let mut b = [0.0f32; 12];
    if !blocks.is_empty() {
        for k in 0..12 {
            let mut col: Vec<f32> = blocks.iter().map(|v| v[k]).collect();
            col.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let floor = col[col.len() / 4];
            b[k] = blocks.iter().map(|v| (v[k] - floor).max(0.0)).sum();
        }
    }
    b
}

/// Combined treble and (moving) bass profile of frames `range`.
fn profile(c: &Chromagram, range: std::ops::Range<usize>, bass: &[f32; 12]) -> [f32; 12] {
    let mut t = [0.0f32; 12];
    for i in range {
        for k in 0..12 {
            t[k] += c.treble[i][k];
        }
    }
    let nt = t.iter().copied().fold(0.0, f32::max).max(1e-12);
    let nb = bass.iter().copied().fold(0.0, f32::max).max(1e-12);
    let mut out = [0.0f32; 12];
    for k in 0..12 {
        out[k] = t[k] / nt + BASS_WEIGHT * bass[k] / nb;
    }
    out
}

fn estimate_from(scores: &[f32; 24], tuning: f32) -> KeyEstimate {
    let mut idx: Vec<usize> = (0..24).collect();
    idx.sort_by(|&a, &b| scores[b].partial_cmp(&scores[a]).unwrap());
    let best = scores[idx[0]];
    let second = scores[idx[1]];
    let margin = ((best - second) / 0.08).clamp(0.0, 1.0);
    let strength = ((best - 0.3) / 0.5).clamp(0.0, 1.0);
    KeyEstimate {
        key: Key::from_index(idx[0]),
        confidence: (0.6 * margin + 0.4 * strength).clamp(0.0, 1.0),
        second: Key::from_index(idx[1]),
        tuning_cents: tuning,
        ranking: idx.iter().take(5).map(|&i| (Key::from_index(i), scores[i])).collect(),
    }
}

/// Estimates the main key of the whole track.
pub fn estimate_key(c: &Chromagram) -> KeyEstimate {
    estimate_from(&scores_for(c, 0..c.treble.len()), c.tuning_cents)
}

/// Finds key regions: keys are estimated over sliding windows of about `window` seconds,
/// smoothed with a Viterbi pass that penalises changes, and merged into segments.
pub fn key_segments(c: &Chromagram, window: f64, global: Key) -> Vec<KeySegment> {
    let n = c.treble.len();
    let w = ((window * c.rate) as usize).max(1);
    let step = (w / 4).max(1);
    let mut obs: Vec<[f32; 24]> = Vec::new();
    let mut starts = Vec::new();
    let mut s = 0;
    while s < n {
        let e = (s + w).min(n);
        obs.push(scores_for(c, s..e));
        starts.push(s);
        if e == n {
            break;
        }
        s += step;
    }
    if obs.is_empty() {
        return vec![];
    }
    // Viterbi over 24 states: score = correlation, change penalty, bias to the global key.
    let change = 0.25f32;
    let mut acc: Vec<f32> = (0..24).map(|k| obs[0][k] + if k == global.index() { 0.05 } else { 0.0 }).collect();
    let mut back: Vec<[u8; 24]> = vec![[0; 24]];
    for o in obs.iter().skip(1) {
        let (bi, bv) = acc.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m });
        let mut next = vec![0.0f32; 24];
        let mut bk = [0u8; 24];
        for k in 0..24 {
            let stay = acc[k];
            let (from, v) = if stay >= bv - change { (k, stay) } else { (bi, bv - change) };
            next[k] = v + o[k] + if k == global.index() { 0.05 } else { 0.0 };
            bk[k] = from as u8;
        }
        acc = next;
        back.push(bk);
    }
    let mut k = acc.iter().enumerate().fold((0, f32::MIN), |m, (i, &v)| if v > m.1 { (i, v) } else { m }).0;
    let mut path = vec![0usize; obs.len()];
    for i in (0..obs.len()).rev() {
        path[i] = k;
        k = back[i][k] as usize;
    }
    let mut segs: Vec<KeySegment> = Vec::new();
    for (i, &k) in path.iter().enumerate() {
        let t0 = starts[i] as f64 / c.rate;
        let t1 = (starts[i] + w).min(n) as f64 / c.rate;
        let conf = estimate_from(&obs[i], c.tuning_cents).confidence;
        match segs.last_mut() {
            Some(s) if s.key.index() == k => {
                s.end = t1;
                s.confidence = s.confidence.max(conf);
            }
            _ => {
                if let Some(s) = segs.last_mut() {
                    s.end = t0 + (s.end - t0) * 0.5;
                }
                let start = segs.last().map(|s| s.end).unwrap_or(0.0);
                segs.push(KeySegment { start, end: t1, key: Key::from_index(k), confidence: conf });
            }
        }
    }
    segs
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::Mode;

    #[test]
    fn profiles_pick_their_own_key() {
        // A pure A-minor scale profile (tonic-weighted) scores highest as A minor.
        let mut p = [0.0f32; 12];
        for (deg, w) in [(0, 1.0), (2, 0.5), (3, 0.8), (5, 0.5), (7, 0.8), (8, 0.5), (10, 0.5)] {
            p[(9 + deg) % 12] = w;
        }
        let s = key_scores(&p);
        let best = (0..24).max_by(|&a, &b| s[a].partial_cmp(&s[b]).unwrap()).unwrap();
        assert_eq!(Key::from_index(best), Key::new(9, Mode::Minor));
    }

    #[test]
    fn chroma_finds_a_sine_and_its_tuning() {
        // 440 Hz × 2^(20/1200): A4 twenty cents sharp.
        let sr = 22_050.0f32;
        let f = 440.0 * 2f64.powf(20.0 / 1_200.0);
        let x: Vec<f32> = (0..sr as usize * 4)
            .map(|i| (std::f64::consts::TAU * f * i as f64 / sr as f64).sin() as f32 * 0.5)
            .collect();
        let (low, lsr) = chroma_signal(&x, sr);
        let c = chromagram(&low, lsr);
        assert!((c.tuning_cents - 20.0).abs() < 3.0, "{}", c.tuning_cents);
        let mid = c.treble.len() / 2;
        let pc = (0..12).max_by(|&a, &b| c.treble[mid][a].partial_cmp(&c.treble[mid][b]).unwrap()).unwrap();
        assert_eq!(pc, 9);
    }
}
