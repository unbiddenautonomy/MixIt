//! Accuracy tests against generated tracks with exact ground truth.

use mixit_analysis::*;
use mixit_core::{Key, Mode};
use mixit_generator::{Generated, SectionKind, Style, TrackSpec, generate};

fn run(g: &Generated) -> Analysis {
    analyze(&g.audio, g.sample_rate, &AnalysisOptions::default())
}

/// Signed offsets (seconds) from each true beat to the nearest grid beat.
fn grid_offsets(a: &Analysis, g: &Generated) -> Vec<f64> {
    let sr = g.sample_rate as f64;
    g.truth
        .beats
        .iter()
        .map(|&t| {
            let b = a.grid.beat_at(t * sr).round();
            a.grid.frame_at(b) / sr - t
        })
        .collect()
}

fn downbeat_hits(a: &Analysis, g: &Generated) -> f64 {
    let sr = g.sample_rate as f64;
    let hits = g.truth.downbeats.iter().filter(|&&t| a.grid.is_downbeat(a.grid.beat_at(t * sr).round() as i64)).count();
    hits as f64 / g.truth.downbeats.len() as f64
}

const STYLES: [(Style, f64, u8, Mode); 5] = [
    (Style::House, 124.0, 9, Mode::Minor),
    (Style::Techno, 130.0, 2, Mode::Minor),
    (Style::Trance, 138.0, 7, Mode::Major),
    (Style::HipHop, 90.0, 0, Mode::Minor),
    (Style::DrumAndBass, 174.0, 5, Mode::Minor),
];

#[test]
fn tempo_grid_and_downbeats_on_every_style() {
    for (style, bpm, tonic, mode) in STYLES {
        let mut spec = TrackSpec::short(style, bpm, Key::new(tonic, mode));
        spec.lead_in = 0.77;
        let g = generate(&spec);
        let a = run(&g);
        assert!((a.bpm - bpm).abs() < 0.02, "{style:?}: bpm {} vs {bpm}", a.bpm);
        assert!(a.grid.is_constant(), "{style:?}: constant tempo must give a constant grid");
        let offs = grid_offsets(&a, &g);
        let worst = offs.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        assert!(worst < 0.006, "{style:?}: grid off by up to {:.1} ms", worst * 1e3);
        let db = downbeat_hits(&a, &g);
        assert!(db > 0.95, "{style:?}: downbeats {:.0}%", db * 100.0);
        assert_eq!(a.grid.beats_per_bar, 4);
        assert!(a.is_rhythmic(), "{style:?}: clarity {}", a.pulse_clarity);
        assert!(a.tempo_confidence > 0.5, "{style:?}: confidence {}", a.tempo_confidence);
    }
}

#[test]
fn phrases_line_up_with_the_arrangement() {
    let g = generate(&TrackSpec::standard(Style::House, 126.0, Key::new(9, Mode::Minor)));
    let a = run(&g);
    let sr = g.sample_rate as f64;
    // Every section in the standard arrangement starts on an 8-bar phrase boundary.
    for &(t, kind) in &g.truth.sections {
        let beat = a.grid.beat_at(t * sr).round() as i64;
        assert!(a.grid.is_phrase_start(beat), "{kind:?} at {t:.1}s is not on a phrase start (beat {beat})");
    }
}

#[test]
fn keys_are_detected() {
    let cases = [
        (Style::House, 124.0, Key::new(9, Mode::Minor)),
        (Style::Trance, 138.0, Key::new(7, Mode::Major)),
        (Style::HipHop, 90.0, Key::new(0, Mode::Minor)),
        (Style::DrumAndBass, 174.0, Key::new(5, Mode::Minor)),
        (Style::House, 122.0, Key::new(4, Mode::Major)),
        (Style::Trance, 136.0, Key::new(1, Mode::Minor)),
    ];
    for (style, bpm, key) in cases {
        let a = run(&generate(&TrackSpec::short(style, bpm, key)));
        let k = a.key.expect("key");
        assert_eq!(k.key, key, "{style:?}: {} vs {}", k.key.standard_name(), key.standard_name());
        assert!(k.tuning_cents.abs() < 8.0, "tuning {}", k.tuning_cents);
    }
    // Staccato techno bass makes minor vs relative major genuinely ambiguous: the truth
    // must at least be in the top two.
    let key = Key::new(2, Mode::Minor);
    let a = run(&generate(&TrackSpec::short(Style::Techno, 130.0, key)));
    let k = a.key.unwrap();
    assert!(k.key == key || k.second == key, "techno: {} / {}", k.key.standard_name(), k.second.standard_name());
}

#[test]
fn detuned_tracks_report_their_tuning() {
    // Resampling by 1.01 raises pitch 17 cents and tempo by 1 %.
    let g = generate(&TrackSpec::short(Style::Trance, 138.0, Key::new(7, Mode::Major)));
    let a = analyze(&g.audio, (g.sample_rate as f64 * 1.01) as u32, &AnalysisOptions::default());
    let k = a.key.unwrap();
    assert_eq!(k.key, Key::new(7, Mode::Major));
    assert!((k.tuning_cents - 17.2).abs() < 5.0, "tuning {}", k.tuning_cents);
    assert!((a.bpm - 138.0 * 1.01).abs() < 0.05, "bpm {}", a.bpm);
}

#[test]
fn drifting_tempo_gives_a_warped_grid() {
    let mut spec = TrackSpec::short(Style::House, 120.0, Key::new(0, Mode::Major));
    spec.end_bpm = Some(126.0);
    let g = generate(&spec);
    let a = run(&g);
    assert!(!a.grid.is_constant(), "expected a warped grid (drift {:.1} ms)", a.drift_ms);
    let offs = grid_offsets(&a, &g);
    let good = offs.iter().filter(|o| o.abs() < 0.012).count() as f64 / offs.len() as f64;
    assert!(good > 0.95, "only {:.0}% of beats within 12 ms", good * 100.0);
    assert!(a.bpm > 121.0 && a.bpm < 125.0, "nominal bpm {}", a.bpm);
}

#[test]
fn lead_in_silence_and_load_cue() {
    let mut spec = TrackSpec::short(Style::Techno, 128.0, Key::new(2, Mode::Minor));
    spec.lead_in = 3.4;
    let g = generate(&spec);
    let a = run(&g);
    assert!((a.audible.0 - 3.4).abs() < 0.01, "audible from {}", a.audible.0);
    let load = a.cues.iter().find(|c| c.role == CueRole::Load).unwrap();
    assert!(
        (load.seconds - g.truth.downbeats[0]).abs() < 0.006,
        "load cue {} vs {}",
        load.seconds,
        g.truth.downbeats[0]
    );
    assert!(a.cues.iter().any(|c| c.role == CueRole::MixOut));
    // Cues are sorted and inside the track.
    assert!(a.cues.windows(2).all(|w| w[0].seconds <= w[1].seconds));
    assert!(a.cues.iter().all(|c| c.seconds >= 0.0 && c.seconds < a.duration));
}

#[test]
fn sections_follow_the_arrangement() {
    let g = generate(&TrackSpec::standard(Style::HipHop, 92.0, Key::new(0, Mode::Minor)));
    let a = run(&g);
    let bar = 4.0 * 60.0 / 92.0;
    let truth: Vec<(f64, SectionKind)> = g.truth.sections.clone();
    // Each detected boundary is within one bar of a true one.
    for s in a.sections.iter().skip(1) {
        let near = truth.iter().any(|(t, _)| (t - s.start).abs() < bar);
        assert!(near, "spurious boundary at {:.1}s", s.start);
    }
    // Most true boundaries are found.
    let found = truth.iter().skip(1).filter(|(t, _)| a.sections.iter().any(|s| (s.start - t).abs() < bar)).count();
    assert!(found + 1 >= truth.len() - 1, "found {found} of {}", truth.len() - 1);
    // Labels for the unambiguous parts.
    assert_eq!(a.sections[0].label, SectionLabel::Intro);
    let label_at = |t: f64| a.sections.iter().find(|s| s.start <= t + 0.01 && t < s.end).map(|s| s.label);
    for &(t, kind) in &truth {
        let mid = t + 2.0 * bar;
        match kind {
            SectionKind::Breakdown => assert_eq!(label_at(mid), Some(SectionLabel::Breakdown)),
            SectionKind::Drop => assert_eq!(label_at(mid), Some(SectionLabel::Drop)),
            SectionKind::Build => assert_eq!(label_at(mid), Some(SectionLabel::Build)),
            _ => {}
        }
    }
    assert!(a.energy >= 1 && a.energy <= 10);
    assert!(!a.energy_curve.is_empty());
}

#[test]
fn loudness_and_auto_gain() {
    let sr = 44_100u32;
    let n = sr as usize * 10;
    let amp = 0.1f32;
    let x: Vec<f32> = (0..n)
        .flat_map(|i| {
            let v = amp * (std::f64::consts::TAU * 1_000.0 * i as f64 / sr as f64).sin() as f32;
            [v, v]
        })
        .collect();
    let l = loudness::measure(&x, sr, -12.0);
    assert!((l.integrated_lufs - -20.0).abs() < 0.3, "{}", l.integrated_lufs);
    assert!((l.auto_gain_db - 8.0).abs() < 0.3, "{}", l.auto_gain_db);
    assert!((l.true_peak_dbtp - -20.0).abs() < 0.2, "{}", l.true_peak_dbtp);
    assert!(l.range_lu < 0.5);
    // A loud master is turned down.
    let y: Vec<f32> = x.iter().map(|v| v * 8.0).collect();
    let l = loudness::measure(&y, sr, -12.0);
    assert!(l.auto_gain_db < -1.0, "{}", l.auto_gain_db);
}

#[test]
fn silence_and_noise_do_not_break_analysis() {
    let sr = 44_100u32;
    let silent = vec![0.0f32; sr as usize * 2 * 5];
    let a = analyze(&silent, sr, &AnalysisOptions::default());
    assert!(!a.is_rhythmic());
    assert_eq!(a.grid.confidence, 0.0);
    let mut rng = mixit_dsp::rng::Rng::new(7);
    let noise: Vec<f32> = (0..sr as usize * 2 * 8).map(|_| 0.2 * rng.bipolar()).collect();
    let a = analyze(&noise, sr, &AnalysisOptions::default());
    assert!(a.bpm > 0.0);
    assert!(!a.is_rhythmic(), "noise has no pulse: clarity {}", a.pulse_clarity);
    let short = vec![0.1f32; 200];
    let _ = analyze(&short, sr, &AnalysisOptions::default());
}

#[test]
fn works_at_48k_and_serialises() {
    let mut spec = TrackSpec::short(Style::House, 125.0, Key::new(9, Mode::Minor));
    spec.sample_rate = 48_000;
    let g = generate(&spec);
    let a = run(&g);
    assert!((a.bpm - 125.0).abs() < 0.02);
    assert_eq!(a.grid.sample_rate, 48_000);
    let offs = grid_offsets(&a, &g);
    assert!(offs.iter().all(|o| o.abs() < 0.006));
    let json = serde_json::to_string(&a).unwrap();
    let back: Analysis = serde_json::from_str(&json).unwrap();
    assert_eq!(serde_json::to_string(&back).unwrap(), json);
    assert_eq!(back.grid, a.grid);
}

#[test]
fn waveform_pyramid() {
    let g = generate(&TrackSpec::short(Style::Trance, 138.0, Key::new(7, Mode::Major)));
    let w = waveform::waveform(&g.audio, g.sample_rate);
    assert_eq!(w.levels.len(), waveform::LEVELS);
    let frames = g.frames();
    assert_eq!(w.levels[0].columns.len(), frames.div_ceil(waveform::BASE_COLUMN));
    for pair in w.levels.windows(2) {
        assert_eq!(pair[1].columns.len(), pair[0].columns.len().div_ceil(waveform::LEVEL_FACTOR));
        assert_eq!(pair[1].frames_per_column, pair[0].frames_per_column * waveform::LEVEL_FACTOR);
    }
    let peak = w.levels[0].columns.iter().map(|c| c.peak).max().unwrap();
    assert!((225..=228).contains(&peak), "peak {peak}"); // −1 dBFS
    let ov = w.overview(1_000);
    assert_eq!(ov.len(), 1_000);
    assert!(ov.iter().any(|c| c.low > 100) && ov.iter().any(|c| c.high > 30));
}
