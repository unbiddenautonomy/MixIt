//! Finish my mix: a recorded mix's tone and loudness, finished like a track the person
//! picks (its balance from deep bass to air, and how loud it is), or to a loudness on
//! its own (club or streaming) with the mix's own bumps smoothed out.
//!
//! Clean-room and plain: the average spectrum over the music's louder parts in ten
//! octave bands, the difference turned into gentle EQ (bells an octave wide, shelves at
//! the ends, each limited so nothing is pushed far), then a gain to the loudness wanted
//! and a true-peak limiter so nothing clips. No model, nothing downloaded, and it runs
//! the same in the browser.

use mixit_dsp::dynamics::Limiter;
use mixit_dsp::peq::{BandSettings, BandShape, ParametricEq};
use serde::{Deserialize, Serialize};

use crate::loudness;

/// Band centres (Hz), an octave apart.
pub const BANDS: [f32; 10] = [31.5, 63.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0];
/// What each band is, in plain words.
const BAND_NAMES: [&str; 10] = [
    "the deep sub",
    "the sub bass",
    "the bass",
    "the low mids, where mud builds up",
    "the body",
    "the mids",
    "the upper mids, where voices cut through",
    "the bite",
    "the brightness",
    "the air",
];
/// Most a band is moved towards a reference (dB).
const MAX_MATCH_DB: f32 = 6.0;
/// Most a band is moved when smoothing the mix's own balance (dB).
const MAX_SMOOTH_DB: f32 = 3.0;
/// Peaks are kept this far below full scale (dBTP).
pub const CEILING_DBTP: f32 = -1.0;
/// Most the loudness is raised (dB).
const MAX_GAIN_DB: f64 = 18.0;
const N_FFT: usize = 8_192;

/// How a piece of music sounds overall: its balance over the bands (dB, relative to
/// their mean) and its loudness.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToneProfile {
    pub bands: [f32; 10],
    pub lufs: f64,
}

/// What to finish a mix like.
#[derive(Clone, Debug, PartialEq)]
pub enum FinishTarget {
    /// Another track's balance and loudness.
    Like(ToneProfile),
    /// A loudness (LUFS), with the mix's own balance smoothed.
    Loudness(f64),
}

/// Club level and streaming level (LUFS).
pub const CLUB_LUFS: f64 = -9.0;
pub const STREAMING_LUFS: f64 = -14.0;

/// What finishing does to a mix.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FinishPlan {
    /// EQ gain at each band (dB).
    pub eq_db: [f32; 10],
    /// Gain after the EQ (dB), before the limiter.
    pub gain_db: f64,
    pub target_lufs: f64,
}

/// What was done, and how it came out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Finished {
    pub plan: FinishPlan,
    pub before_lufs: f64,
    pub after_lufs: f64,
    pub after_true_peak_dbtp: f32,
    /// Most the limiter took off (dB): above about 4 the mix is being squashed.
    pub limited_db: f32,
    /// Each change in plain words.
    pub notes: Vec<String>,
}

/// The balance and loudness of interleaved stereo `audio`.
pub fn profile(audio: &[f32], sample_rate: u32) -> ToneProfile {
    let lufs = loudness::measure(audio, sample_rate, loudness::DEFAULT_TARGET_LUFS).integrated_lufs;
    let mono: Vec<f32> = audio.chunks_exact(2).map(|f| 0.5 * (f[0] + f[1])).collect();
    let window: Vec<f32> =
        (0..N_FFT).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N_FFT as f32).cos()).collect();
    let mut planner = realfft::RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut buf = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    // Power per band for each frame, and each frame's total.
    let edges: Vec<(usize, usize)> = BANDS
        .iter()
        .map(|&c| {
            let bin = |f: f32| ((f * N_FFT as f32 / sample_rate as f32).round() as usize).clamp(1, N_FFT / 2);
            let (a, b) = (bin(c / std::f32::consts::SQRT_2), bin(c * std::f32::consts::SQRT_2));
            (a, b.max(a + 1))
        })
        .collect();
    let mut frames: Vec<([f64; 10], f64)> = Vec::new();
    let mut start = 0;
    while start + N_FFT <= mono.len() {
        for (k, v) in buf.iter_mut().enumerate() {
            *v = mono[start + k] * window[k];
        }
        fft.process(&mut buf, &mut spec).expect("sizes match the plan");
        let mut p = [0.0f64; 10];
        for (b, &(lo, hi)) in edges.iter().enumerate() {
            p[b] = spec[lo..hi.min(spec.len())].iter().map(|z| z.norm_sqr() as f64).sum::<f64>() / (hi - lo) as f64;
        }
        frames.push((p, p.iter().sum()));
        start += N_FFT / 2;
    }
    // The louder half of the music: quiet intros and breakdowns don't set the balance.
    let mut totals: Vec<f64> = frames.iter().map(|f| f.1).filter(|&t| t > 0.0).collect();
    totals.sort_by(f64::total_cmp);
    let floor = totals.get(totals.len() / 2).copied().unwrap_or(0.0);
    let mut mean = [0.0f64; 10];
    let mut n = 0usize;
    for (p, t) in &frames {
        if *t >= floor && *t > 0.0 {
            mean.iter_mut().zip(p).for_each(|(m, v)| *m += v);
            n += 1;
        }
    }
    let mut bands = [0.0f32; 10];
    for (b, m) in bands.iter_mut().zip(&mean) {
        *b = (10.0 * (m / n.max(1) as f64).max(1e-20).log10()) as f32;
    }
    let avg = bands.iter().sum::<f32>() / 10.0;
    bands.iter_mut().for_each(|b| *b -= avg);
    ToneProfile { bands, lufs }
}

/// The EQ and gain that take a mix with profile `mix` towards `target`.
pub fn plan(mix: &ToneProfile, target: &FinishTarget) -> FinishPlan {
    let (want, max, target_lufs) = match target {
        FinishTarget::Like(r) => {
            let d: Vec<f32> = mix.bands.iter().zip(&r.bands).map(|(m, r)| r - m).collect();
            (d, MAX_MATCH_DB, r.lufs)
        }
        FinishTarget::Loudness(lufs) => {
            // The mix's own straight-line tilt is kept; half of each bump away from it is
            // taken out.
            let x: Vec<f32> = (0..10).map(|i| i as f32).collect();
            let (mx, my) = (4.5, mix.bands.iter().sum::<f32>() / 10.0);
            let sxy: f32 = x.iter().zip(&mix.bands).map(|(x, y)| (x - mx) * (y - my)).sum();
            let sxx: f32 = x.iter().map(|x| (x - mx).powi(2)).sum();
            let slope = sxy / sxx;
            let d = (0..10).map(|i| -0.5 * (mix.bands[i] - (my + slope * (i as f32 - mx)))).collect();
            (d, MAX_SMOOTH_DB, *lufs)
        }
    };
    let mut eq_db = [0.0f32; 10];
    for (e, w) in eq_db.iter_mut().zip(&want) {
        *e = w.clamp(-max, max);
    }
    // Overall level is the loudness step's job: centre the curve on 0 dB.
    let mid = eq_db.iter().sum::<f32>() / 10.0;
    eq_db.iter_mut().for_each(|e| *e = (*e - mid).clamp(-max, max));
    FinishPlan { eq_db, gain_db: 0.0, target_lufs }
}

/// The filters that give `eq_db` at the band centres: shelves at the two ends, bells an
/// octave wide between, their gains adjusted until the overlaps add up to the curve.
fn equaliser(sample_rate: u32, eq_db: &[f32; 10]) -> [ParametricEq; 2] {
    let sr = sample_rate as f32;
    let shape = |i: usize| match i {
        0 => (BandShape::LowShelf, 45.0),
        9 => (BandShape::HighShelf, 11_000.0),
        _ => (BandShape::Bell, BANDS[i]),
    };
    let mut gains = *eq_db;
    let build = |gains: &[f32; 10]| {
        let mut eqs = [ParametricEq::new(sr), ParametricEq::new(sr)];
        for i in 0..10 {
            let (shape, freq) = shape(i);
            let freq = freq.min(0.45 * sr);
            eqs[i / 5].set_band(
                i % 5,
                BandSettings { enabled: gains[i].abs() > 0.01, shape, freq, q: 1.4, gain_db: gains[i], slope_db: 12 },
            );
        }
        eqs
    };
    for _ in 0..12 {
        let eqs = build(&gains);
        for i in 0..10 {
            let f = BANDS[i].min(0.45 * sr);
            let got = eqs[0].response_db(f) + eqs[1].response_db(f);
            gains[i] = (gains[i] + 0.7 * (eq_db[i] - got)).clamp(-12.0, 12.0);
        }
    }
    build(&gains)
}

fn run_eq(audio: &[f32], sample_rate: u32, eq_db: &[f32; 10]) -> Vec<f32> {
    let mut eqs = equaliser(sample_rate, eq_db);
    // Let the parameters settle on silence, then start clean.
    let mut z = (vec![0.0f32; 8_192], vec![0.0f32; 8_192]);
    for eq in &mut eqs {
        eq.process(&mut z.0, &mut z.1);
        eq.reset();
    }
    let n = audio.len() / 2;
    let mut l: Vec<f32> = (0..n).map(|i| audio[2 * i]).collect();
    let mut r: Vec<f32> = (0..n).map(|i| audio[2 * i + 1]).collect();
    for (lc, rc) in l.chunks_mut(4_096).zip(r.chunks_mut(4_096)) {
        for eq in &mut eqs {
            eq.process(lc, rc);
        }
    }
    l.into_iter().zip(r).flat_map(|(a, b)| [a, b]).collect()
}

/// Gain then the limiter, with the limiter's delay taken back out.
fn level(audio: &[f32], sample_rate: u32, gain_db: f64) -> (Vec<f32>, f32) {
    let g = 10f64.powf(gain_db / 20.0) as f32;
    let mut lim = Limiter::new(sample_rate as f32, CEILING_DBTP, 3.0, 80.0);
    let lat = lim.latency();
    let n = audio.len() / 2;
    let mut l: Vec<f32> = (0..n).map(|i| audio[2 * i] * g).chain(std::iter::repeat_n(0.0, lat)).collect();
    let mut r: Vec<f32> = (0..n).map(|i| audio[2 * i + 1] * g).chain(std::iter::repeat_n(0.0, lat)).collect();
    let mut most = 0.0f32;
    for (lc, rc) in l.chunks_mut(1_024).zip(r.chunks_mut(1_024)) {
        lim.process(lc, rc);
        most = most.max(lim.meter_gr_db);
    }
    ((0..n).flat_map(|i| [l[lat + i], r[lat + i]]).collect(), most)
}

/// Finishes interleaved stereo `audio`: EQ towards the target, then loud enough (within
/// half a LU, a couple of tries since the limiter takes a little off) and no peak above
/// [`CEILING_DBTP`].
pub fn finish(audio: &[f32], sample_rate: u32, target: &FinishTarget) -> (Vec<f32>, Finished) {
    let mix = profile(audio, sample_rate);
    let mut plan = plan(&mix, target);
    let eqd = run_eq(audio, sample_rate, &plan.eq_db);
    let eq_lufs = loudness::measure(&eqd, sample_rate, plan.target_lufs).integrated_lufs;
    let mut gain = if eq_lufs > -70.0 { (plan.target_lufs - eq_lufs).min(MAX_GAIN_DB) } else { 0.0 };
    let mut out = (Vec::new(), 0.0);
    let mut after = loudness::measure(&[], sample_rate, plan.target_lufs);
    for _ in 0..3 {
        out = level(&eqd, sample_rate, gain);
        after = loudness::measure(&out.0, sample_rate, plan.target_lufs);
        let short = plan.target_lufs - after.integrated_lufs;
        // Silence (or near it) has no loudness to aim at: leave it as it is.
        if eq_lufs <= -70.0 || short.abs() <= 0.3 || gain >= MAX_GAIN_DB {
            break;
        }
        gain = (gain + short).min(MAX_GAIN_DB);
    }
    plan.gain_db = gain;
    let notes = notes(&plan, &mix, &after, out.1, target);
    let finished = Finished {
        before_lufs: mix.lufs,
        after_lufs: after.integrated_lufs,
        after_true_peak_dbtp: after.true_peak_dbtp,
        limited_db: out.1,
        notes,
        plan,
    };
    (out.0, finished)
}

fn notes(
    plan: &FinishPlan,
    mix: &ToneProfile,
    after: &loudness::Loudness,
    limited: f32,
    target: &FinishTarget,
) -> Vec<String> {
    let mut notes = Vec::new();
    // The two biggest moves each way, in words.
    let mut moves: Vec<(usize, f32)> = plan.eq_db.iter().copied().enumerate().filter(|(_, g)| g.abs() >= 1.0).collect();
    moves.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
    for (i, g) in moves.into_iter().take(3) {
        notes.push(format!(
            "{} {} by {:.0} dB",
            if g > 0.0 { "Brought up" } else { "Turned down" },
            BAND_NAMES[i],
            g.abs()
        ));
    }
    if notes.is_empty() {
        notes.push(match target {
            FinishTarget::Like(_) => "The balance already matched, so the tone is as it was".into(),
            FinishTarget::Loudness(_) => "The balance was already even, so the tone is as it was".into(),
        });
    }
    let change = after.integrated_lufs - mix.lufs;
    notes.push(if change.abs() < 0.5 {
        format!("Loudness was already right ({:.0} LUFS)", after.integrated_lufs)
    } else {
        format!(
            "Made it {:.1} dB {} ({:.0} LUFS{})",
            change.abs(),
            if change > 0.0 { "louder" } else { "quieter" },
            after.integrated_lufs,
            match target {
                FinishTarget::Loudness(l) if (*l - CLUB_LUFS).abs() < 0.1 => ", club level",
                FinishTarget::Loudness(l) if (*l - STREAMING_LUFS).abs() < 0.1 => ", streaming level",
                FinishTarget::Like(_) => ", as loud as the track you picked",
                _ => "",
            }
        )
    });
    notes.push(if limited > 4.0 {
        format!("The limiter had to hold the loudest moments down by up to {limited:.0} dB, so the biggest hits are a little squashed. A quieter target keeps them punchier")
    } else {
        format!("Peaks are kept below {CEILING_DBTP:.0} dB so nothing clips")
    });
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pink-ish noise (equal energy per octave) with a short pattern of loud and quiet
    /// bars, stereo, so the balance and loudness are known.
    fn music(sr: u32, seconds: f32) -> Vec<f32> {
        let n = (sr as f32 * seconds) as usize;
        let mut rng = 12345u64;
        let mut white = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng >> 11) as f32 / (1u64 << 53) as f32 * 2.0 - 1.0
        };
        // Paul Kellet's pink filter.
        let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5, mut b6) = (0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let mut out = Vec::with_capacity(2 * n);
        for i in 0..n {
            let w = white();
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.153_852;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            let p = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05;
            b6 = w * 0.115926;
            let loud = if (i / (sr as usize * 2)) % 4 == 3 { 0.3 } else { 1.0 };
            out.push(p * loud);
            out.push(p * loud * 0.9);
        }
        out
    }

    #[test]
    fn a_muddy_quiet_mix_comes_out_like_the_reference() {
        let sr = 44_100;
        let reference = music(sr, 30.0);
        let reference: Vec<f32> = reference.iter().map(|v| v * 2.0).collect();
        let want = profile(&reference, sr);
        // The mix: 6 dB of mud at 250 Hz, less air, and 8 dB quieter.
        let mut eq = ParametricEq::new(sr as f32);
        eq.set_band(
            0,
            BandSettings { enabled: true, shape: BandShape::Bell, freq: 250.0, q: 1.4, gain_db: 6.0, slope_db: 12 },
        );
        eq.set_band(
            1,
            BandSettings {
                enabled: true,
                shape: BandShape::HighShelf,
                freq: 11_000.0,
                q: 0.7,
                gain_db: -4.0,
                slope_db: 12,
            },
        );
        let n = reference.len() / 2;
        let mut l: Vec<f32> = (0..n).map(|i| reference[2 * i] * 0.4).collect();
        let mut r: Vec<f32> = (0..n).map(|i| reference[2 * i + 1] * 0.4).collect();
        for (a, b) in l.chunks_mut(4_096).zip(r.chunks_mut(4_096)) {
            eq.process(a, b);
        }
        let mix: Vec<f32> = l.into_iter().zip(r).flat_map(|(a, b)| [a, b]).collect();
        let before = profile(&mix, sr);
        assert!(before.bands[3] - want.bands[3] > 4.0, "the mix is muddy: {:?}", before.bands);

        let (out, done) = finish(&mix, sr, &FinishTarget::Like(want.clone()));
        let got = profile(&out, sr);
        for i in 1..10 {
            assert!((got.bands[i] - want.bands[i]).abs() < 1.5, "band {i}: {:?} vs {:?}", got.bands, want.bands);
        }
        assert!((done.after_lufs - want.lufs).abs() < 0.5, "{} vs {}", done.after_lufs, want.lufs);
        assert!(done.after_true_peak_dbtp <= CEILING_DBTP + 0.1, "{}", done.after_true_peak_dbtp);
        assert!(done.notes[0].starts_with("Turned down the low mids"), "{:?}", done.notes);
    }

    #[test]
    fn a_mix_gets_to_streaming_level_with_its_balance_kept() {
        let sr = 48_000;
        let mix: Vec<f32> = music(sr, 20.0).iter().map(|v| v * 0.3).collect();
        let before = profile(&mix, sr);
        let (out, done) = finish(&mix, sr, &FinishTarget::Loudness(STREAMING_LUFS));
        assert!((done.after_lufs - STREAMING_LUFS).abs() < 0.5, "{}", done.after_lufs);
        assert!(done.after_true_peak_dbtp <= CEILING_DBTP + 0.1);
        // An even mix: hardly any EQ.
        assert!(done.plan.eq_db.iter().all(|g| g.abs() < 1.5), "{:?}", done.plan.eq_db);
        let got = profile(&out, sr);
        for i in 1..10 {
            assert!((got.bands[i] - before.bands[i]).abs() < 1.5, "band {i}");
        }
        assert_eq!(out.len(), mix.len());
    }

    #[test]
    fn silence_stays_silent() {
        let (out, done) = finish(&vec![0.0; 44_100 * 4], 44_100, &FinishTarget::Loudness(CLUB_LUFS));
        assert!(out.iter().all(|v| *v == 0.0));
        assert_eq!(done.plan.gain_db, 0.0);
    }
}
