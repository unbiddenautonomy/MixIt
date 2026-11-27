//! A grid from beats someone else heard: the beat helper (a trained beat tracker in
//! `mixit-ml`) gives beat and downbeat times, and this turns them into a beatgrid the
//! same shape as the analysis's own (constant, or warped with an anchor a bar where
//! the tempo wanders), and says how it differs from the grid a track has.

use mixit_core::{Beatgrid, GridAnchor};

use crate::grid::{BeatModel, index_beats, local_time, simplify};

/// How far beats may wander from one tempo (seconds) before the grid follows them.
const WARP_DRIFT: f64 = 0.030;

/// Least-squares line through (k, t): (seconds per beat, time of beat 0).
fn line(pts: &[(f64, f64)]) -> Option<(f64, f64)> {
    let n = pts.len() as f64;
    if pts.len() < 2 {
        return None;
    }
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
    let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
    let sxy: f64 = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
    if sxx <= 0.0 {
        return None;
    }
    let slope = sxy / sxx;
    (slope > 0.0).then_some((slope, my - slope * mx))
}

/// The beat model through numbered beats: one tempo, or anchors a bar apart when the
/// beats wander from it by more than 30 ms.
fn model_through(pts: &[(f64, f64)], allow_warp: bool) -> Option<BeatModel> {
    let (period, first) = line(pts)?;
    let constant = BeatModel::Constant { period, first };
    if !allow_warp || pts.len() < 32 {
        return Some(constant);
    }
    // Drift: residuals against the one tempo, smoothed over ±16 beats.
    let resid: Vec<f64> = pts.iter().map(|&(k, t)| t - (first + k * period)).collect();
    let smooth: Vec<f64> = (0..resid.len())
        .map(|i| {
            let mut w = resid[i.saturating_sub(16)..(i + 17).min(resid.len())].to_vec();
            w.sort_by(f64::total_cmp);
            w[w.len() / 2]
        })
        .collect();
    let lo = smooth.iter().copied().fold(f64::MAX, f64::min);
    let hi = smooth.iter().copied().fold(f64::MIN, f64::max);
    if hi - lo <= WARP_DRIFT {
        return Some(constant);
    }
    let (k_first, k_last) = (pts[0].0, pts[pts.len() - 1].0);
    let mut anchors: Vec<(f64, f64)> = Vec::new();
    let mut k = k_first;
    while k <= k_last + 1e-9 {
        if let Some(t) = local_time(pts, k, 8.0) {
            if anchors.last().is_none_or(|&(pk, pt)| k > pk && t > pt) {
                anchors.push((k, t));
            }
        }
        k += 4.0;
    }
    if let Some(t) = local_time(pts, k_last, 8.0) {
        if anchors.last().is_none_or(|&(pk, pt)| k_last > pk && t > pt) {
            anchors.push((k_last, t));
        }
    }
    let anchors = simplify(&anchors, 0.002);
    Some(if anchors.len() >= 2 { BeatModel::Warped { anchors } } else { constant })
}

/// A grid through heard beats (seconds) and downbeats (each also a beat), in
/// `sample_rate` frames. Bars are 3 or 4 beats, from how far apart the downbeats are;
/// beat 0 is the first downbeat. `None` when there are too few beats to tell.
pub fn grid_from_beats(
    beats: &[f64],
    downbeats: &[f64],
    sample_rate: u32,
    allow_warp: bool,
    phrase_bars: u32,
) -> Option<Beatgrid> {
    if beats.len() < 8 {
        return None;
    }
    let pts = index_beats(beats);
    let model = model_through(&pts, allow_warp)?;
    // Bars: the commonest gap between downbeats, in beats.
    let ks: Vec<i64> = downbeats.iter().map(|&d| model.index(d).round() as i64).collect();
    let mut gaps = [0usize; 2];
    for w in ks.windows(2) {
        match w[1] - w[0] {
            3 => gaps[0] += 1,
            4 => gaps[1] += 1,
            _ => {}
        }
    }
    let bpb: i64 = if gaps[0] > gaps[1] { 3 } else { 4 };
    // Which beat of the bar is "one": the phase most downbeats agree on.
    let mut votes = vec![0usize; bpb as usize];
    for &k in &ks {
        votes[k.rem_euclid(bpb) as usize] += 1;
    }
    let phase = (0..bpb as usize).max_by_key(|&p| (votes[p], std::cmp::Reverse(p))).unwrap_or(0) as i64;
    // Beat 0: the first downbeat at or after the first heard beat.
    let mut k0 = pts[0].0.round() as i64;
    while (k0 - phase).rem_euclid(bpb) != 0 {
        k0 += 1;
    }
    let sr = sample_rate as f64;
    let (k_a, k_b) = (pts[0].0, pts[pts.len() - 1].0);
    let bpm = 60.0 * (k_b - k_a) / (model.time(k_b) - model.time(k_a));
    let mut grid = match &model {
        BeatModel::Constant { .. } => Beatgrid::constant(sample_rate, bpm, model.time(k0 as f64) * sr),
        BeatModel::Warped { anchors } => {
            let mut g = Beatgrid::constant(sample_rate, bpm, 0.0);
            g.anchors = anchors.iter().map(|&(k, t)| GridAnchor { frame: t * sr, beat: k - k0 as f64 }).collect();
            g
        }
    };
    grid.beats_per_bar = bpb as u32;
    grid.phrase_bars = phrase_bars.max(1);
    // Confidence: the share of heard beats within 40 ms of the grid's.
    let near = beats.iter().filter(|&&t| (model.time(model.index(t).round()) - t).abs() <= 0.040).count();
    grid.confidence = near as f32 / beats.len() as f32;
    Some(grid)
}

/// Renumbers `grid`'s beats (by whole bars) so its beat 0 is the downbeat nearest
/// `frame`: lines its phrases up with another grid's when both agree where bars start.
pub fn renumber_near(grid: &mut Beatgrid, frame: f64) {
    let bpb = grid.beats_per_bar.max(1) as f64;
    let shift = (grid.beat_at(frame) / bpb).round() * bpb;
    if shift != 0.0 {
        grid.anchors.iter_mut().for_each(|a| a.beat -= shift);
    }
}

/// What differs between two grids of the same track over `span` (seconds), in plain
/// words, or `None` when they put the beats and bars in the same places (within 25 ms,
/// and the same beat as "one").
pub fn grids_differ(a: &Beatgrid, b: &Beatgrid, span: (f64, f64)) -> Option<&'static str> {
    let (sa, sb) = (a.sample_rate as f64, b.sample_rate as f64);
    let (t0, t1) = (span.0.max(0.0), span.1);
    if t1 <= t0 {
        return None;
    }
    let ratio = a.bpm_at((t0 + t1) / 2.0 * sa) / b.bpm_at((t0 + t1) / 2.0 * sb);
    // Every beat of `a` over the span, and how far the nearest beat of `b` is.
    let (mut far, mut count, mut bars, mut other_one) = (0usize, 0usize, 0usize, 0usize);
    let mut ka = a.beat_at(t0 * sa).ceil();
    while a.frame_at(ka) / sa <= t1 {
        let t = a.frame_at(ka) / sa;
        let kb = b.beat_at(t * sb).round();
        if (b.frame_at(kb) / sb - t).abs() > 0.025 {
            far += 1;
        } else if a.is_downbeat(ka as i64) {
            bars += 1;
            if !b.is_downbeat(kb as i64) {
                other_one += 1;
            }
        }
        count += 1;
        ka += 1.0;
    }
    if count == 0 {
        return None;
    }
    let share = |n: usize| n as f64 / count as f64;
    if (ratio - 1.0).abs() > 0.01 && share(far) > 0.2 {
        Some(if !(0.7..=1.4).contains(&ratio) { "a different tempo (double or half)" } else { "a different tempo" })
    } else if share(far) > 0.2 {
        Some("the beats in different places")
    } else if bars > 0 && other_one * 2 > bars {
        Some("the bars starting on a different beat")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steady(bpm: f64, first: f64, n: usize) -> Vec<f64> {
        (0..n).map(|i| first + i as f64 * 60.0 / bpm).collect()
    }

    #[test]
    fn steady_beats_make_a_constant_grid() {
        let beats = steady(124.0, 0.31, 200);
        // Downbeats on the second heard beat and every fourth after.
        let downs: Vec<f64> = beats.iter().skip(1).step_by(4).copied().collect();
        let g = grid_from_beats(&beats, &downs, 44_100, true, 8).unwrap();
        assert!(g.is_constant());
        assert!((g.bpm - 124.0).abs() < 1e-6, "{}", g.bpm);
        assert_eq!(g.beats_per_bar, 4);
        // Beat 0 is the first downbeat.
        assert!((g.frame_at(0.0) / 44_100.0 - beats[1]).abs() < 1e-6);
        assert!(g.confidence > 0.99);
    }

    #[test]
    fn waltz_downbeats_make_three_beat_bars() {
        let beats = steady(90.0, 0.0, 120);
        let downs: Vec<f64> = beats.iter().step_by(3).copied().collect();
        let g = grid_from_beats(&beats, &downs, 44_100, true, 8).unwrap();
        assert_eq!(g.beats_per_bar, 3);
    }

    #[test]
    fn a_drifting_drummer_gets_a_warped_grid() {
        // 120 BPM speeding up to about 126 over three minutes.
        let mut t = 0.5;
        let mut beats = Vec::new();
        for i in 0..360 {
            beats.push(t);
            t += 60.0 / (120.0 + 6.0 * i as f64 / 360.0);
        }
        let downs: Vec<f64> = beats.iter().step_by(4).copied().collect();
        let g = grid_from_beats(&beats, &downs, 44_100, true, 8).unwrap();
        assert!(!g.is_constant());
        let worst =
            beats.iter().enumerate().map(|(i, &b)| (g.frame_at(i as f64) / 44_100.0 - b).abs()).fold(0.0f64, f64::max);
        assert!(worst < 0.01, "worst {worst}");
        // Without warping it stays one tempo.
        assert!(grid_from_beats(&beats, &downs, 44_100, false, 8).unwrap().is_constant());
    }

    #[test]
    fn a_missed_beat_does_not_shift_the_rest() {
        let mut beats = steady(128.0, 0.0, 100);
        beats.remove(40);
        let downs: Vec<f64> = beats.iter().step_by(4).take(10).copied().collect();
        let g = grid_from_beats(&beats, &downs, 44_100, true, 8).unwrap();
        assert!((g.bpm - 128.0).abs() < 1e-6);
        assert!((g.frame_at(99.0) / 44_100.0 - 99.0 * 60.0 / 128.0).abs() < 1e-6);
    }

    #[test]
    fn renumbering_keeps_the_beats_and_moves_beat_zero_by_bars() {
        let mut g = Beatgrid::constant(44_100, 120.0, 0.0);
        // Beat 0 wanted near 9.1 s: beat 18 is there, so the nearest bar line (beat 20).
        renumber_near(&mut g, 9.1 * 44_100.0);
        assert!((g.frame_at(0.0) / 44_100.0 - 10.0).abs() < 1e-9);
        assert!((g.frame_at(-20.0)).abs() < 1e-9);
    }

    #[test]
    fn differences_are_named() {
        let a = Beatgrid::constant(44_100, 124.0, 0.5 * 44_100.0);
        let span = (0.0, 120.0);
        assert_eq!(grids_differ(&a, &a.clone(), span), None);
        // 10 ms off: the same.
        let b = Beatgrid::constant(44_100, 124.0, 0.51 * 44_100.0);
        assert_eq!(grids_differ(&a, &b, span), None);
        // Half a beat off.
        let b = Beatgrid::constant(44_100, 124.0, (0.5 + 30.0 / 124.0) * 44_100.0);
        assert_eq!(grids_differ(&a, &b, span), Some("the beats in different places"));
        // Double time.
        let b = Beatgrid::constant(44_100, 248.0, 0.5 * 44_100.0);
        assert_eq!(grids_differ(&b, &a, span), Some("a different tempo (double or half)"));
        // One beat later: the same beats, but "one" moves.
        let b = Beatgrid::constant(44_100, 124.0, (0.5 + 60.0 / 124.0) * 44_100.0);
        assert_eq!(grids_differ(&a, &b, span), Some("the bars starting on a different beat"));
        // Slightly faster: beats drift apart over the track.
        let b = Beatgrid::constant(44_100, 126.0, 0.5 * 44_100.0);
        assert_eq!(grids_differ(&a, &b, span), Some("a different tempo"));
    }
}
