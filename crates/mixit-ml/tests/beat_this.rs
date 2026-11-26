//! Runs the real beat helper (Beat This!) on generated tracks, whose beats are known
//! exactly. Runs only when `MIXIT_BEAT_THIS_MODEL` names the model file:
//!
//! ```sh
//! MIXIT_BEAT_THIS_MODEL=/path/to/beat_this_final0.onnx cargo test -p mixit-ml --release --test beat_this -- --nocapture
//! ```

use mixit_core::{Key, Mode};
use mixit_generator::{Style, TrackSpec, generate};
use mixit_ml::beats::{BeatThis, hear};

/// Share of `truth` with a heard time within 70 ms (the usual beat-tracking F-measure
/// window), and the share of heard times that are true.
fn scores(heard: &[f64], truth: &[f64]) -> (f64, f64) {
    let near = |t: f64, xs: &[f64]| xs.iter().any(|x| (x - t).abs() <= 0.07);
    let recall = truth.iter().filter(|&&t| near(t, heard)).count() as f64 / truth.len().max(1) as f64;
    let precision = heard.iter().filter(|&&t| near(t, truth)).count() as f64 / heard.len().max(1) as f64;
    (recall, precision)
}

#[test]
fn hears_the_beats_of_generated_tracks() {
    let Ok(path) = std::env::var("MIXIT_BEAT_THIS_MODEL") else {
        eprintln!("MIXIT_BEAT_THIS_MODEL not set: skipping");
        return;
    };
    let mut model = BeatThis::load(path.as_ref()).expect("model loads");
    let cases = [
        (Style::House, 124.0, 0.0),
        (Style::Techno, 132.0, 0.0),
        (Style::HipHop, 92.0, 0.4),
        (Style::DrumAndBass, 172.0, 0.0),
    ];
    for (style, bpm, swing) in cases {
        let mut spec = TrackSpec::short(style, bpm, Key::new(9, Mode::Minor));
        spec.swing = swing;
        let g = generate(&spec);
        let t = std::time::Instant::now();
        let h = hear(&mut model, g.sample_rate, &g.audio, |_| true).expect("hears");
        let secs = g.truth.duration;
        let (br, bp) = scores(&h.beats, &g.truth.beats);
        let (dr, dp) = scores(&h.downbeats, &g.truth.downbeats);
        eprintln!(
            "{style:?} {bpm}: {secs:.0} s heard in {:.2} s; beats {:.0} % found, {:.0} % right; downbeats {:.0} % found, {:.0} % right",
            t.elapsed().as_secs_f64(),
            br * 100.0,
            bp * 100.0,
            dr * 100.0,
            dp * 100.0
        );
        assert!(br > 0.9 && bp > 0.9, "{style:?}: beats {br:.2} / {bp:.2}");
    }
}

/// The helper's grid against the true one, next to the analysis's own, on tracks that
/// are hard for the analysis: swing, a tempo that glides, and a plain one for scale.
#[test]
fn its_grid_matches_the_true_grid() {
    use mixit_analysis::heard::{grid_from_beats, grids_differ};
    let Ok(path) = std::env::var("MIXIT_BEAT_THIS_MODEL") else {
        eprintln!("MIXIT_BEAT_THIS_MODEL not set: skipping");
        return;
    };
    let mut model = BeatThis::load(path.as_ref()).expect("model loads");
    let cases: [(Style, f64, Option<f64>, f64); 4] = [
        (Style::House, 124.0, None, 0.0),
        (Style::HipHop, 88.0, None, 0.6),
        (Style::Techno, 126.0, Some(134.0), 0.0),
        (Style::DrumAndBass, 174.0, None, 0.0),
    ];
    for (style, bpm, end, swing) in cases {
        let mut spec = TrackSpec::standard(style, bpm, Key::new(2, Mode::Major));
        spec.swing = swing;
        spec.end_bpm = end;
        let g = generate(&spec);
        let span = (0.0, g.truth.duration);
        let truth = grid_from_beats(&g.truth.beats, &g.truth.downbeats, g.sample_rate, true, 8).unwrap();
        let own = mixit_analysis::analyze(&g.audio, g.sample_rate, &Default::default());
        let h = hear(&mut model, g.sample_rate, &g.audio, |_| true).expect("hears");
        let helper = grid_from_beats(&h.beats, &h.downbeats, g.sample_rate, true, 8).expect("a grid");
        eprintln!(
            "{style:?} {bpm}{}: own grid confidence {:.2}, own vs truth: {:?}; helper confidence {:.2}, helper vs truth: {:?}",
            end.map(|e| format!("→{e}")).unwrap_or_default(),
            own.grid.confidence,
            grids_differ(&own.grid, &truth, span),
            helper.confidence,
            grids_differ(&helper, &truth, span),
        );
        assert_eq!(grids_differ(&helper, &truth, span), None, "{style:?}");
    }
}
