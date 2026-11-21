//! Bounces an automixed project through the engine and checks, with the analyser,
//! that the result holds the master tempo and stays on one grid across the transition.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use mixit_analysis::{Analysis, AnalysisOptions, analyze};
use mixit_core::{Key, Mode};
use mixit_engine::TrackAudio;
use mixit_generator::{Style, TrackSpec, generate};
use mixit_host::project::{RenderError, RenderOptions, ResolvedTrack, render_project};
use mixit_project::automix::{AutomixOptions, PlanTrack, TempoPolicy, automix};
use mixit_project::transition::TransitionKind;
use mixit_project::{MixProject, TrackRef};

struct Source {
    audio: Arc<TrackAudio>,
    analysis: Analysis,
}

fn make(title: &str, style: Style, bpm: f64, key: Key, seed: u64) -> (PlanTrack, Source) {
    let mut spec = TrackSpec::short(style, bpm, key);
    spec.seed = seed;
    let g = generate(&spec);
    let a = analyze(&g.audio, g.sample_rate, &AnalysisOptions { waveform: false, ..Default::default() });
    let mp = a.mix_points();
    let plan = PlanTrack {
        track: TrackRef {
            title: title.into(),
            artist: "Generator".into(),
            bpm: a.bpm,
            key: a.key.as_ref().map(|k| k.key),
            duration: a.duration,
            ..Default::default()
        },
        first_beat: mp.first_beat,
        last_beat: mp.last_beat,
        mix_in: mp.mix_in,
        mix_out: mp.mix_out,
    };
    (plan, Source { audio: Arc::new(TrackAudio::new(g.sample_rate, g.audio)), analysis: a })
}

fn two_track_set(transition: TransitionKind) -> (MixProject, HashMap<String, Source>) {
    set_with(transition, TempoPolicy::FirstTrack, Key::new(4, Mode::Minor))
}

fn set_with(transition: TransitionKind, tempo: TempoPolicy, b_key: Key) -> (MixProject, HashMap<String, Source>) {
    let (pa, sa) = make("A", Style::House, 124.0, Key::new(9, Mode::Minor), 3);
    let (pb, sb) = make("B", Style::House, 127.0, b_key, 7);
    let opts = AutomixOptions { transition, tempo, max_overlap: 16.0, min_overlap: 8.0, ..Default::default() };
    let p = automix("Test set", &[pa, pb], &opts).unwrap();
    let mut m = HashMap::new();
    m.insert("A".to_string(), sa);
    m.insert("B".to_string(), sb);
    (p, m)
}

fn resolver(m: &HashMap<String, Source>) -> impl FnMut(&mixit_project::Clip) -> Option<ResolvedTrack> + '_ {
    |c| {
        m.get(&c.track.title).map(|s| ResolvedTrack {
            audio: s.audio.clone(),
            grid: s.analysis.grid.clone(),
            auto_gain_db: s.analysis.loudness.auto_gain_db as f32,
        })
    }
}

#[test]
fn bounced_mix_holds_the_master_tempo_and_grid() {
    let (p, m) = two_track_set(TransitionKind::Blend);
    assert_eq!(p.clips.len(), 2);
    let opts = RenderOptions { tail: 0.5, ..Default::default() };
    let mut last = 0.0;
    let out = render_project(&p, &opts, resolver(&m), &AtomicBool::new(false), |f| last = f).unwrap();
    assert!((last - 1.0).abs() < 1e-6);
    let expected_len = ((p.length_seconds() + opts.tail) * opts.sample_rate as f64).ceil() as usize;
    assert_eq!(out.len(), expected_len * 2);
    assert!(out.iter().all(|x| x.is_finite()));
    let peak = out.iter().fold(0.0f32, |a, &x| a.max(x.abs()));
    assert!(peak > 0.1 && peak <= 1.0, "peak {peak}");

    // The whole mix should analyse as one steady 124 BPM grid: the second track was
    // stretched from 127 and phase-locked to the timeline.
    let a = analyze(&out, opts.sample_rate, &AnalysisOptions { waveform: false, ..Default::default() });
    assert!((a.bpm - 124.0).abs() < 0.1, "bpm {}", a.bpm);
    assert!(a.drift_ms < 8.0, "drift {} ms", a.drift_ms);

    // Each timeline beat lands on a beat of the analysed grid (within 8 ms), in both
    // the first track, the overlap and the second track.
    let sr = opts.sample_rate as f64;
    let fpb = 60.0 / 124.0 * sr;
    let b_start = p.clips[1].start;
    let mut worst: f64 = 0.0;
    for beat in [8.0, 16.0, b_start - 4.0, b_start + 2.0, b_start + 8.0, p.length_beats() - 12.0] {
        let t = p.tempo.seconds_at_beat(beat) * sr;
        let g = a.grid.beat_at(t);
        let off = (g - g.round()) * fpb / sr * 1000.0;
        worst = worst.max(off.abs());
    }
    assert!(worst < 8.0, "worst beat offset {worst:.1} ms");
}

#[test]
fn render_reports_missing_tracks_and_cancels() {
    let (p, m) = two_track_set(TransitionKind::Cut);
    let opts = RenderOptions { tail: 0.0, ..Default::default() };
    let err = render_project(&p, &opts, |_| None, &AtomicBool::new(false), |_| {}).unwrap_err();
    assert!(matches!(err, RenderError::MissingTrack { .. }));
    let err = render_project(&p, &opts, resolver(&m), &AtomicBool::new(true), |_| {}).unwrap_err();
    assert_eq!(err, RenderError::Cancelled);
}

#[test]
fn follow_tempo_and_harmonic_shift_reach_the_output() {
    // B in Bbm clashes with A's Am: automix shifts it down a semitone with keylock,
    // and with Follow the tempo ramps from 124 to B's own 127 during the overlap.
    let (p, m) = set_with(TransitionKind::BassSwap, TempoPolicy::Follow, Key::new(10, Mode::Minor));
    assert_eq!(p.clips[1].key_shift, -1.0);
    let opts = RenderOptions { tail: 0.0, ..Default::default() };
    let out = render_project(&p, &opts, resolver(&m), &AtomicBool::new(false), |_| {}).unwrap();
    let sr = opts.sample_rate as usize;
    // B alone: from the end of the transition to the end of the set.
    let from = (p.tempo.seconds_at_beat(p.clips[0].end() + 4.0) * sr as f64) as usize;
    let tail = &out[from * 2..];
    let a = analyze(tail, opts.sample_rate, &AnalysisOptions { waveform: false, ..Default::default() });
    assert!((a.bpm - 127.0).abs() < 0.15, "bpm {}", a.bpm);
    let k = a.key.expect("key").key;
    assert_eq!(k, Key::new(9, Mode::Minor), "B shifted to Am, got {}", k.standard_name());
}
