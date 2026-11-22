//! Where a track has singing or rapping, without a neural network.
//!
//! Voices never hold a pitch the way instruments do: they wobble (vibrato), scoop into
//! notes and glide between them. And because one throat makes every harmonic, all the
//! harmonics of a voice wobble together, by the same number of cents at the same moment.
//! Spectral peaks in the voice range are followed from frame to frame and each one's
//! wobble around its own smooth course is measured; summed across the peaks sounding at
//! once, a voice's wobbles add up while the independent drift of detuned synths, chords
//! and noise cancels (what chance alone would give is taken off). The result, weighted by
//! how much of the tonal sound takes part, is smoothed over about a second and turned
//! into regions.
use crate::stft::Spectrogram;
use serde::{Deserialize, Serialize};

const LOW_HZ: f32 = 250.0;
const HIGH_HZ: f32 = 4_000.0;

/// Where the voice is, and how much of the track has one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Vocals {
    /// (start, end) seconds.
    pub regions: Vec<(f64, f64)>,
    /// Share of the audible track with a voice, 0..1.
    pub share: f32,
}

/// A spectral peak followed from frame to frame.
struct PeakTrack {
    start: usize,
    cents: Vec<f32>,
    mags: Vec<f32>,
}

/// Per-frame share of the tonal sound in the voice range that wobbles like a voice:
/// spectral peaks are followed across frames, and the ones whose pitch moves around its
/// own course by a few cents (vibrato, scoops, glides) count.
pub fn voiced_share(spec: &Spectrogram) -> Vec<f32> {
    let bin_hz = spec.sample_rate / spec.size as f32;
    let lo = (LOW_HZ / bin_hz).ceil() as usize;
    let hi = ((HIGH_HZ / bin_hz) as usize).min(spec.bins.saturating_sub(3));
    let mut active: Vec<PeakTrack> = Vec::new();
    let mut done: Vec<PeakTrack> = Vec::new();
    let mut tonal = vec![0.0f32; spec.frames];
    let mut peaks: Vec<(f32, f32)> = Vec::new();
    for t in 0..spec.frames {
        let fr = spec.frame(t);
        peaks.clear();
        for k in lo.max(5)..hi.min(fr.len().saturating_sub(5)) {
            let m = fr[k];
            if !(m > fr[k - 1] && m >= fr[k + 1] && m > fr[k - 2] && m > fr[k + 2]) {
                continue;
            }
            let around = (fr[k - 5] + fr[k - 4] + fr[k - 3] + fr[k + 3] + fr[k + 4] + fr[k + 5]) / 6.0;
            if m < 3.0 * around.max(1e-9) {
                continue;
            }
            let (l, c, r) = ((fr[k - 1] + 1e-9).ln(), (m + 1e-9).ln(), (fr[k + 1] + 1e-9).ln());
            let d = l - 2.0 * c + r;
            let off = if d.abs() > 1e-9 { (0.5 * (l - r) / d).clamp(-0.5, 0.5) } else { 0.0 };
            let hz = (k as f32 + off) * bin_hz;
            peaks.push((1_200.0 * (hz / LOW_HZ).log2(), m));
            tonal[t] += m;
        }
        peaks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        peaks.truncate(40);
        let mut taken = vec![false; active.len()];
        let mut next: Vec<PeakTrack> = Vec::with_capacity(peaks.len());
        for &(cents, mag) in &peaks {
            let mut best: Option<(usize, f32)> = None;
            for (i, tr) in active.iter().enumerate() {
                if taken[i] {
                    continue;
                }
                let d = (tr.cents[tr.cents.len() - 1] - cents).abs();
                if d < 50.0 && best.is_none_or(|(_, bd)| d < bd) {
                    best = Some((i, d));
                }
            }
            match best {
                Some((i, _)) => {
                    taken[i] = true;
                    let mut tr = std::mem::replace(&mut active[i], PeakTrack { start: 0, cents: vec![], mags: vec![] });
                    tr.cents.push(cents);
                    tr.mags.push(mag);
                    next.push(tr);
                }
                None => next.push(PeakTrack { start: t, cents: vec![cents], mags: vec![mag] }),
            }
        }
        for (i, tr) in active.drain(..).enumerate() {
            if !taken[i] && !tr.cents.is_empty() {
                done.push(tr);
            }
        }
        active = next;
    }
    done.append(&mut active);
    // A voice moves all its harmonics together (the same cents at the same moment);
    // detuned synths and mixes of instruments wobble each partial on its own. So the
    // wobble of overlapping peaks is summed: in step it adds up, out of step it cancels.
    let half = 4usize;
    let n = spec.frames;
    let (mut s1, mut s2, mut wsum, mut w2) = (vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]);
    let mut count = vec![0u16; n];
    for tr in &done {
        let len = tr.cents.len();
        if len < 2 * half + 6 {
            continue;
        }
        for i in half..len - half {
            let avg = tr.cents[i - half..=i + half].iter().sum::<f32>() / (2 * half + 1) as f32;
            let r = tr.cents[i] - avg;
            let m = tr.mags[i];
            let t = tr.start + i;
            s1[t] += m * r;
            s2[t] += m * r * r;
            wsum[t] += m;
            w2[t] += m * m;
            count[t] += 1;
        }
    }
    let mut out = vec![0.0f32; n];
    for t in 0..n {
        if count[t] >= 3 && wsum[t] > 0.0 && tonal[t] > 0.0 {
            let mean = s1[t] / wsum[t];
            let var = s2[t] / wsum[t];
            // In-step share of the wobble, less what independent wobbles give by chance
            // (one over the effective number of peaks), and how much of the tonal sound
            // takes part.
            let chance = w2[t] / (wsum[t] * wsum[t]);
            let raw = if var > 1.0 { mean * mean / var } else { 0.0 };
            let coherent = ((raw - chance) / (1.0 - chance).max(1e-3)).max(0.0);
            out[t] = coherent * (wsum[t] / tonal[t]).min(1.0);
        }
    }
    out
}

/// Mean over a window of `half` frames each side.
fn smooth(x: &[f32], half: usize) -> Vec<f32> {
    let mut pre = vec![0.0f64; x.len() + 1];
    for (i, &v) in x.iter().enumerate() {
        pre[i + 1] = pre[i] + v as f64;
    }
    (0..x.len())
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(x.len());
            ((pre[b] - pre[a]) / (b - a) as f64) as f32
        })
        .collect()
}

/// Evidence above this (after smoothing over about a second) counts as a voice.
const THRESHOLD: f32 = 0.06;
/// Gaps shorter than this inside singing are bridged (breaths, short words).
const BRIDGE_S: f64 = 1.0;
/// Regions shorter than this are dropped (a sung sample, a wobbly synth note).
const MIN_REGION_S: f64 = 1.5;

/// Where the voices are in the audible part of a track.
pub fn detect(spec: &Spectrogram, audible: (f64, f64)) -> Vocals {
    let rate = spec.frame_rate();
    let ev = smooth(&voiced_share(spec), (0.5 * rate) as usize);
    let mut regions: Vec<(f64, f64)> = Vec::new();
    let mut open: Option<f64> = None;
    for (i, &e) in ev.iter().enumerate() {
        let t = spec.frame_time(i);
        let on = e > THRESHOLD && t >= audible.0 && t <= audible.1;
        match (on, open) {
            (true, None) => open = Some(t),
            (false, Some(a)) => {
                regions.push((a, t));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(a) = open {
        regions.push((a, spec.frame_time(ev.len().saturating_sub(1)).min(audible.1)));
    }
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for r in regions {
        match merged.last_mut() {
            Some(last) if r.0 - last.1 < BRIDGE_S => last.1 = r.1,
            _ => merged.push(r),
        }
    }
    merged.retain(|r| r.1 - r.0 >= MIN_REGION_S);
    let span = (audible.1 - audible.0).max(1e-9);
    // (`+ 0.0` turns the -0.0 an empty float sum gives into 0.)
    let share = (merged.iter().map(|r| r.1 - r.0).sum::<f64>() / span).clamp(0.0, 1.0) as f32 + 0.0;
    Vocals { regions: merged, share }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_tone_is_not_a_voice_and_a_wobbling_one_is() {
        let sr = 22_050.0f32;
        let n = (sr * 3.0) as usize;
        let tone = |depth: f32| -> Vec<f32> {
            let mut phase = 0.0f32;
            (0..n)
                .map(|i| {
                    let t = i as f32 / sr;
                    let f = 330.0 * 2f32.powf(depth / 12.0 * (std::f32::consts::TAU * 5.5 * t).sin());
                    phase = (phase + f / sr).fract();
                    (1..10).map(|k| (std::f32::consts::TAU * phase * k as f32).sin() / k as f32).sum()
                })
                .collect()
        };
        let mean = |x: &[f32]| {
            let v = voiced_share(&crate::stft::stft(x, sr, 1_024, 256));
            v[20..v.len() - 20].iter().sum::<f32>() / (v.len() - 40) as f32
        };
        let (held, sung) = (mean(&tone(0.0)), mean(&tone(0.35)));
        assert!(held < 0.02 && sung > 0.3, "held {held}, sung {sung}");
        let d = detect(&crate::stft::stft(&tone(0.35), sr, 1_024, 256), (0.0, 3.0));
        assert_eq!(d.regions.len(), 1);
        assert!(d.share > 0.8, "{d:?}");
        assert!(detect(&crate::stft::stft(&tone(0.0), sr, 1_024, 256), (0.0, 3.0)).regions.is_empty());
    }
}
