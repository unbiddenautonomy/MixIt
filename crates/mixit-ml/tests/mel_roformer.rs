//! Runs the real vocal splitter (Mel-Band RoFormer) on a generated track with a singer,
//! whose parts are known exactly, next to HTDemucs's vocal stem when that model is there
//! too. Runs only when `MIXIT_MEL_ROFORMER_MODEL` names the model file:
//!
//! ```sh
//! MIXIT_MEL_ROFORMER_MODEL=/path/to/mel_roformer_kj_fp16.onnx [MIXIT_HTDEMUCS_MODEL=…] cargo test -p mixit-ml --release --test mel_roformer -- --nocapture
//! ```

use mixit_core::{Key, Mode};
use mixit_generator::{Style, TrackSpec, generate};
use mixit_ml::stems::{HtDemucs, split};
use mixit_ml::vocal_split::{MelRoformer, vocals};

/// Signal-to-distortion ratio of an estimate against the true part, in dB.
fn sdr(est: &[f32], truth: &[f32]) -> f64 {
    let e: f64 = truth.iter().map(|&v| (v as f64).powi(2)).sum();
    let err: f64 = est.iter().zip(truth).map(|(&a, &b)| ((a - b) as f64).powi(2)).sum();
    10.0 * (e.max(1e-12) / err.max(1e-12)).log10()
}

#[test]
fn takes_the_vocals_out_of_a_generated_track() {
    let Ok(path) = std::env::var("MIXIT_MEL_ROFORMER_MODEL") else {
        eprintln!("MIXIT_MEL_ROFORMER_MODEL not set: skipping");
        return;
    };
    let mut model = MelRoformer::load(path.as_ref()).expect("model loads");
    let mut spec = TrackSpec::short(Style::House, 124.0, Key::new(9, Mode::Minor));
    spec.vocals = true;
    let g = generate(&spec);
    // The first 20 s keep the run short on a small machine.
    let n = (20 * g.sample_rate as usize * 2).min(g.audio.len());
    let (audio, truth) = (&g.audio[..n], &g.stems[0][..n]);
    let t = std::time::Instant::now();
    let v = vocals(&mut model, g.sample_rate, audio, |_| true).expect("runs");
    eprintln!("20 s of vocals in {:.1} s", t.elapsed().as_secs_f64());
    let ours = sdr(&v, truth);
    eprintln!("vocal splitter: {ours:.1} dB");
    if let Ok(h) = std::env::var("MIXIT_HTDEMUCS_MODEL") {
        let mut demucs = HtDemucs::load(h.as_ref()).expect("loads");
        let s = split(&mut demucs, g.sample_rate, audio, |_| true).expect("splits");
        eprintln!("HTDemucs vocals: {:.1} dB", sdr(&s.vocals, truth));
    }
    assert!(ours > 6.0, "{ours:.1} dB");
}
