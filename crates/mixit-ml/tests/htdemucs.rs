//! Runs the real HTDemucs model on a generated track, whose parts are known exactly.
//! The model file is large, so this runs only when `MIXIT_HTDEMUCS_MODEL` names it:
//!
//! ```sh
//! MIXIT_HTDEMUCS_MODEL=/path/to/htdemucs_fp16weights.onnx cargo test -p mixit-ml --test htdemucs -- --nocapture
//! ```

use mixit_core::{Key, Mode};
use mixit_generator::{STEM_PARTS, Style, TrackSpec, generate};
use mixit_ml::stems::{HtDemucs, split};

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| (v as f64) * (v as f64)).sum()
}

/// Signal-to-distortion ratio of an estimate against the true part, in dB.
fn sdr(est: &[f32], truth: &[f32]) -> f64 {
    let err: f64 = est.iter().zip(truth).map(|(&a, &b)| ((a - b) as f64).powi(2)).sum();
    10.0 * (energy(truth).max(1e-12) / err.max(1e-12)).log10()
}

#[test]
fn splits_a_generated_track_cleanly() {
    let Ok(path) = std::env::var("MIXIT_HTDEMUCS_MODEL") else {
        eprintln!("MIXIT_HTDEMUCS_MODEL not set: skipping");
        return;
    };
    let mut model = HtDemucs::load(path.as_ref()).expect("model loads");
    let mut spec = TrackSpec::short(Style::House, 124.0, Key::new(9, Mode::Minor));
    spec.vocals = true;
    let g = generate(&spec);
    let t = std::time::Instant::now();
    let s = split(&mut model, g.sample_rate, &g.audio, |_| true).expect("splits");
    let secs = g.audio.len() as f64 / 2.0 / g.sample_rate as f64;
    eprintln!("{secs:.1} s of audio at {} Hz split in {:.1} s", g.sample_rate, t.elapsed().as_secs_f64());
    let est = [&s.vocals, &s.drums, &s.bass];
    let quick = quick_scores(&g);
    for (i, e) in est.iter().enumerate() {
        let model_sdr = sdr(e, &g.stems[i]);
        eprintln!("{}: model {model_sdr:.1} dB, quick split {:.1} dB", STEM_PARTS[i], quick[i]);
        // Every stem comes out clearly, and better than the quick split did.
        assert!(model_sdr > 3.0, "{} {model_sdr:.1} dB", STEM_PARTS[i]);
        assert!(model_sdr > quick[i], "{}: model {model_sdr:.1} vs quick {:.1}", STEM_PARTS[i], quick[i]);
    }
}

/// The quick split's scores on the same track, for comparison.
fn quick_scores(g: &mixit_generator::Generated) -> [f64; 3] {
    let q = mixit_analysis::stems::quick_split(g.sample_rate, &g.audio, |_| true).expect("not cancelled");
    [sdr(&q.vocals, &g.stems[0]), sdr(&q.drums, &g.stems[1]), sdr(&q.bass, &g.stems[2])]
}
