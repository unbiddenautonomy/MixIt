//! Song structure: bar-level features, novelty, phrase alignment and section labels.
//!
//! Each bar is described by its band energies, onset activity (kick, full, hats) and
//! harmony. A boundary is where the bars before and after differ most (a tapered
//! difference-of-means novelty, close to Foote's checkerboard kernel). Dance music is
//! built in phrases of 8 or 16 bars, so the phrase offset is the bar alignment that
//! collects the most novelty, and boundaries snap to 4-bar positions on that phrase grid.

use serde::{Deserialize, Serialize};

use crate::grid::BeatModel;
use crate::key::Chromagram;
use crate::onset::Onsets;
use crate::stft::Spectrogram;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SectionLabel {
    Intro,
    Build,
    Drop,
    Breakdown,
    Main,
    Outro,
}

impl SectionLabel {
    pub fn name(self) -> &'static str {
        match self {
            SectionLabel::Intro => "Intro",
            SectionLabel::Build => "Build-up",
            SectionLabel::Drop => "Drop",
            SectionLabel::Breakdown => "Breakdown",
            SectionLabel::Main => "Main",
            SectionLabel::Outro => "Outro",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub start: f64,
    pub end: f64,
    /// Bars from the analysis' first bar (see [`Structure::first_bar_k`]).
    pub start_bar: usize,
    pub bars: usize,
    pub label: SectionLabel,
    /// 0..1 relative energy.
    pub energy: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Structure {
    /// Beat index (in the beat model) of bar 0's downbeat.
    pub first_bar_k: i64,
    pub beats_per_bar: u32,
    /// Bars analysed.
    pub bars: usize,
    /// Bar index (0..phrase_bars) of the first phrase start.
    pub phrase_offset: usize,
    pub phrase_bars: usize,
    pub sections: Vec<Section>,
    /// Per-bar 0..1 energy.
    pub energy: Vec<f32>,
    /// Per-bar boundary novelty (0..1).
    pub novelty: Vec<f32>,
}

/// Per-frame band energies (low < 150 Hz, mid, high > 4 kHz) from a spectrogram.
pub fn band_frames(spec: &Spectrogram) -> [Vec<f32>; 3] {
    let k_lo = (150.0 / spec.bin_hz(1)).round() as usize;
    let k_hi = (4_000.0 / spec.bin_hz(1)).round() as usize;
    let mut out = [Vec::with_capacity(spec.frames), Vec::with_capacity(spec.frames), Vec::with_capacity(spec.frames)];
    for f in 0..spec.frames {
        let fr = spec.frame(f);
        let e = |a: usize, b: usize| fr[a.min(fr.len())..b.min(fr.len())].iter().map(|v| v * v).sum::<f32>();
        out[0].push(e(1, k_lo));
        out[1].push(e(k_lo, k_hi));
        out[2].push(e(k_hi, fr.len()));
    }
    out
}

fn mean_range(x: &[f32], rate: f64, t0: f64, t1: f64) -> f32 {
    let a = (t0 * rate).max(0.0) as usize;
    let b = ((t1 * rate) as usize).min(x.len());
    if b <= a { 0.0 } else { x[a..b].iter().sum::<f32>() / (b - a) as f32 }
}

fn zscore(v: &mut [f32]) {
    let n = v.len().max(1) as f32;
    let m = v.iter().sum::<f32>() / n;
    let sd = (v.iter().map(|x| (x - m).powi(2)).sum::<f32>() / n).sqrt().max(1e-6);
    v.iter_mut().for_each(|x| *x = (*x - m) / sd);
}

fn novelty(feats: &[Vec<f32>], l: usize) -> Vec<f32> {
    let nb = feats.len();
    let taper: Vec<f32> = (0..l).map(|i| (std::f32::consts::FRAC_PI_2 * (i as f32 + 0.5) / l as f32).cos()).collect();
    let dim = feats[0].len();
    let mut nov = vec![0.0f32; nb];
    let mut before = vec![0.0f32; dim];
    let mut after = vec![0.0f32; dim];
    for j in 1..nb {
        before.iter_mut().for_each(|v| *v = 0.0);
        after.iter_mut().for_each(|v| *v = 0.0);
        let (mut wb, mut wa) = (0.0, 0.0);
        for (d, &w) in taper.iter().enumerate() {
            if j > d {
                for q in 0..dim {
                    before[q] += w * feats[j - 1 - d][q];
                }
                wb += w;
            }
            if j + d < nb {
                for q in 0..dim {
                    after[q] += w * feats[j + d][q];
                }
                wa += w;
            }
        }
        if wb > 0.0 && wa > 0.0 {
            nov[j] = (0..dim).map(|q| (before[q] / wb - after[q] / wa).powi(2)).sum::<f32>().sqrt();
        }
    }
    // Normalise by a high percentile of the interior (the track's edges can spike).
    let lo = 2.min(nb);
    let hi = nb.saturating_sub(2).max(lo);
    let mut inner: Vec<f32> = nov[lo..hi].to_vec();
    inner.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let nref = inner.get(((inner.len() as f32 - 1.0) * 0.98) as usize).copied().unwrap_or(1.0).max(1e-9);
    nov.iter_mut().for_each(|v| *v = (*v / nref).min(1.0));
    nov
}

/// Analyses bars `[first_bar_k, …)` of the beat model up to `span.1`.
pub fn structure(
    model: &BeatModel,
    first_bar_k: i64,
    beats_per_bar: u32,
    phrase_bars: usize,
    spec: &Spectrogram,
    o: &Onsets,
    chroma: &Chromagram,
    span: (f64, f64),
) -> Structure {
    let bpb = beats_per_bar as i64;
    let bands = band_frames(spec);
    let rate = spec.frame_rate();
    let mut bar_times = Vec::new();
    let mut k = first_bar_k;
    loop {
        let t0 = model.time(k as f64);
        let t1 = model.time((k + bpb) as f64);
        if t1 > span.1 + 0.5 * (t1 - t0) {
            break;
        }
        bar_times.push((t0, t1));
        k += bpb;
    }
    let nb = bar_times.len();
    let empty = Structure {
        first_bar_k,
        beats_per_bar,
        bars: nb,
        phrase_offset: 0,
        phrase_bars,
        sections: vec![],
        energy: vec![],
        novelty: vec![],
    };
    if nb < 4 {
        return empty;
    }
    // Scalar features per bar.
    let mut scal: Vec<Vec<f32>> = (0..8).map(|_| Vec::with_capacity(nb)).collect();
    let mut chroma_f: Vec<[f32; 12]> = Vec::with_capacity(nb);
    for &(t0, t1) in &bar_times {
        for b in 0..3 {
            scal[b].push((1e-6 + mean_range(&bands[b], rate, t0, t1)).ln());
        }
        scal[3].push(mean_range(&o.full, o.rate, t0, t1));
        scal[4].push(mean_range(&o.low, o.rate, t0, t1));
        scal[5].push(mean_range(&o.high, o.rate, t0, t1));
        scal[6].push(mean_range(&o.mid, o.rate, t0, t1));
        // Tonal energy: total spectral-peak magnitude (chords, leads, pads).
        scal[7].push((1e-6 + mean_range(&chroma.tonal, chroma.rate, t0, t1)).ln());
        let a = (t0 * chroma.rate) as usize;
        let b = ((t1 * chroma.rate) as usize).min(chroma.treble.len());
        let mut c = [0.0f32; 12];
        for i in a..b {
            let w = 1.0;
            for (q, v) in c.iter_mut().enumerate() {
                *v += chroma.treble[i][q] * w;
            }
        }
        let n = c.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-9);
        c.iter_mut().for_each(|v| *v /= n);
        chroma_f.push(c);
    }
    let raw_low_onset = scal[4].clone();
    let raw_tonal = scal[7].clone();
    let raw_density: Vec<f32> = (0..nb).map(|i| scal[3][i] + scal[6][i]).collect();
    // Bar loudness (dB) from the total band power.
    let bar_db: Vec<f32> =
        (0..nb).map(|i| 4.343 * (scal[0][i].exp() + scal[1][i].exp() + scal[2][i].exp()).ln()).collect();
    let mut energy: Vec<f32> = (0..nb).map(|i| bar_db[i] + 20.0 * scal[3][i]).collect();
    for s in scal.iter_mut() {
        zscore(s);
    }
    let feat = |i: usize| -> Vec<f32> {
        let mut v: Vec<f32> = scal.iter().map(|s| s[i]).collect();
        v[7] *= 2.0;
        v.extend(chroma_f[i].iter().map(|c| 2.0 * c));
        v
    };
    let feats: Vec<Vec<f32>> = (0..nb).map(feat).collect();

    // Novelty at the start of each bar: tapered difference of means over L bars each
    // side, at two scales (4 bars catches short sections, 8 bars ignores variation
    // inside a phrase).
    let n4 = novelty(&feats, 4);
    let n8 = novelty(&feats, 8);
    let nov: Vec<f32> = n4.iter().zip(&n8).map(|(a, b)| 0.5 * (a + b)).collect();

    // Phrase offset: the alignment that collects the most novelty on phrase and half-phrase starts.
    let mut best = (0usize, f32::MIN);
    for off in 0..phrase_bars {
        let mut s = 0.0;
        for (j, v) in nov.iter().enumerate() {
            if j % phrase_bars == off {
                s += v;
            } else if j % (phrase_bars / 2).max(1) == off % (phrase_bars / 2).max(1) {
                s += 0.5 * v;
            }
        }
        // The music usually starts on a phrase.
        if off == 0 {
            s += 0.5;
        }
        if s > best.1 {
            best = (off, s);
        }
    }
    let phrase_offset = best.0;

    // Boundaries: novelty peaks, snapped to the 4-bar grid of the phrase.
    let mean = nov.iter().sum::<f32>() / nb as f32;
    let sd = (nov.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / nb as f32).sqrt();
    let thresh = (mean + 0.5 * sd).max(0.25);
    let quarter = (phrase_bars / 2).max(1);
    let mut cands: Vec<(usize, f32)> = Vec::new();
    for j in 4.min(nb)..nb.saturating_sub(3) {
        let lo = j.saturating_sub(2);
        let hi = (j + 3).min(nb);
        // Off the 8-bar phrase grid a boundary needs stronger evidence.
        let on_phrase = (j + phrase_bars - phrase_offset % phrase_bars) % phrase_bars == 0;
        let need = if on_phrase { thresh } else { thresh.max(0.6) };
        if nov[j] >= need && nov[lo..hi].iter().all(|&v| v <= nov[j]) {
            let r = (j + quarter - phrase_offset % quarter) % quarter;
            let snapped = if r <= 1 {
                j - r
            } else if quarter - r <= 1 {
                j + (quarter - r)
            } else {
                j
            };
            cands.push((snapped.clamp(1, nb - 1), nov[j]));
        }
    }
    cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let mut bounds: Vec<usize> = Vec::new();
    for (j, _) in cands {
        if bounds.iter().all(|&b| (b as i64 - j as i64).abs() >= 4) {
            bounds.push(j);
        }
    }
    bounds.push(0);
    bounds.push(nb);
    bounds.sort_unstable();
    bounds.dedup();

    // Energy per bar, 0..1.
    let mut sorted = energy.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let emin = sorted[(nb as f32 * 0.02) as usize];
    let emax = sorted[((nb as f32 - 1.0) * 0.98) as usize];
    energy.iter_mut().for_each(|v| *v = if emax > emin { ((*v - emin) / (emax - emin)).clamp(0.0, 1.0) } else { 0.5 });

    // Segments and labels.
    let segs: Vec<(usize, usize)> = bounds.windows(2).map(|w| (w[0], w[1])).collect();
    let seg_energy: Vec<f32> = segs.iter().map(|&(a, b)| energy[a..b].iter().sum::<f32>() / (b - a) as f32).collect();
    let seg_kick: Vec<f32> =
        segs.iter().map(|&(a, b)| raw_low_onset[a..b].iter().sum::<f32>() / (b - a) as f32).collect();
    let kmax = seg_kick.iter().copied().fold(0.0, f32::max).max(1e-9);
    let seg_db: Vec<f32> = segs
        .iter()
        .map(|&(a, b)| {
            let p: f32 = bar_db[a..b].iter().map(|d| 10f32.powf(d / 10.0)).sum::<f32>() / (b - a) as f32;
            10.0 * p.max(1e-12).log10()
        })
        .collect();
    let db_max = seg_db.iter().copied().fold(f32::MIN, f32::max);
    // Onset density rising through the segment (snare rolls, risers).
    let rising: Vec<bool> = segs
        .iter()
        .map(|&(a, b)| {
            if b - a < 2 {
                return false;
            }
            let half = (a + b) / 2;
            let m1 = raw_density[a..half].iter().sum::<f32>() / (half - a) as f32;
            let m2 = raw_density[half..b].iter().sum::<f32>() / (b - half) as f32;
            m2 > m1 * 1.12
        })
        .collect();
    let (smin, smax) = seg_energy.iter().fold((f32::MAX, f32::MIN), |m, &v| (m.0.min(v), m.1.max(v)));
    let rel = |v: f32| if smax > smin { (v - smin) / (smax - smin) } else { 1.0 };
    let n = segs.len();
    let has_kick: Vec<bool> = seg_kick.iter().map(|k| k / kmax >= 0.5).collect();
    let loud: Vec<bool> = seg_db.iter().map(|d| *d >= db_max - 2.0).collect();
    // Harmonic content (log peak magnitude): drops carry the chords and leads.
    let seg_tonal: Vec<f32> = segs.iter().map(|&(a, b)| raw_tonal[a..b].iter().sum::<f32>() / (b - a) as f32).collect();
    let tonal_max = seg_tonal.iter().copied().fold(f32::MIN, f32::max);
    let tonal: Vec<bool> = seg_tonal.iter().map(|t| *t >= tonal_max - 0.9).collect();
    let mut labels = vec![SectionLabel::Main; n];
    for i in 0..n {
        labels[i] = if !has_kick[i] && i > 0 && i + 1 < n {
            SectionLabel::Breakdown
        } else if has_kick[i] && loud[i] && tonal[i] {
            SectionLabel::Drop
        } else {
            SectionLabel::Main
        };
    }
    // A short rising segment right before a drop is its build-up.
    for i in 0..n.saturating_sub(1) {
        let next_drop = labels[i + 1] == SectionLabel::Drop;
        if next_drop && rising[i] && segs[i].1 - segs[i].0 <= 16 && labels[i] != SectionLabel::Breakdown {
            labels[i] = SectionLabel::Build;
        }
    }
    if labels[0] == SectionLabel::Main || (labels[0] == SectionLabel::Build && !loud[0]) {
        labels[0] = SectionLabel::Intro;
    }
    if n > 1 && labels[n - 1] == SectionLabel::Main {
        labels[n - 1] = SectionLabel::Outro;
    }
    let mut sections: Vec<Section> = Vec::with_capacity(n);
    for ((&(a, b), &label), &e) in segs.iter().zip(&labels).zip(&seg_energy) {
        if let Some(prev) = sections.last_mut() {
            if prev.label == label && matches!(label, SectionLabel::Build | SectionLabel::Breakdown) {
                let w = prev.bars as f32;
                prev.energy = (prev.energy * w + rel(e) * (b - a) as f32) / (w + (b - a) as f32);
                prev.bars += b - a;
                prev.end = bar_times[b - 1].1;
                continue;
            }
        }
        sections.push(Section {
            start: bar_times[a].0,
            end: bar_times[b - 1].1,
            start_bar: a,
            bars: b - a,
            label,
            energy: rel(e),
        });
    }
    Structure { first_bar_k, beats_per_bar, bars: nb, phrase_offset, phrase_bars, sections, energy, novelty: nov }
}
