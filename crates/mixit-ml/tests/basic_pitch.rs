//! Runs the real note listener (Basic Pitch) on melodies made here, whose notes are
//! known exactly. Runs only when `MIXIT_BASIC_PITCH_MODEL` names the model file:
//!
//! ```sh
//! MIXIT_BASIC_PITCH_MODEL=/path/to/basic_pitch_nmp.onnx cargo test -p mixit-ml --release --test basic_pitch -- --nocapture
//! ```

use mixit_ml::notes::{BasicPitch, Note, hear};

const SR: u32 = 44_100;

/// Interleaved stereo of `notes` (start s, length s, MIDI), each a plucked tone (a few
/// harmonics, quick attack, decaying) or a steady hummed one.
fn play(notes: &[(f64, f64, u8)], seconds: f64, hummed: bool) -> Vec<f32> {
    let n = (seconds * SR as f64) as usize;
    let mut out = vec![0.0f32; n * 2];
    for &(start, len, midi) in notes {
        let f = 440.0 * 2f64.powf((midi as f64 - 69.0) / 12.0);
        let a = (start * SR as f64) as usize;
        let b = (((start + len) * SR as f64) as usize).min(n);
        for i in a..b {
            let t = (i - a) as f64 / SR as f64;
            let attack = (t / 0.005).min(1.0);
            let release = (((b - i) as f64 / SR as f64) / 0.01).min(1.0);
            let env = if hummed { attack * release } else { attack * release * (-3.0 * t).exp() };
            let tone: f64 = if hummed {
                (std::f64::consts::TAU * f * t).sin() + 0.3 * (std::f64::consts::TAU * 2.0 * f * t).sin()
            } else {
                (1..=6).map(|h| (std::f64::consts::TAU * f * h as f64 * t).sin() / h as f64).sum()
            };
            let v = (0.25 * env * tone) as f32;
            out[2 * i] += v;
            out[2 * i + 1] += v;
        }
    }
    out
}

/// Share of true notes heard (right key, start within 50 ms) and share of heard notes that are true.
fn scores(heard: &[Note], truth: &[(f64, f64, u8)]) -> (f64, f64) {
    let hit = |n: &Note| truth.iter().any(|t| t.2 == n.pitch && (t.0 - n.start).abs() <= 0.05);
    let found = truth.iter().filter(|t| heard.iter().any(|n| t.2 == n.pitch && (t.0 - n.start).abs() <= 0.05)).count();
    let right = heard.iter().filter(|n| hit(n)).count();
    (found as f64 / truth.len() as f64, right as f64 / heard.len().max(1) as f64)
}

#[test]
fn hears_the_notes_of_a_melody() {
    let Ok(path) = std::env::var("MIXIT_BASIC_PITCH_MODEL") else {
        eprintln!("MIXIT_BASIC_PITCH_MODEL not set: skipping");
        return;
    };
    let mut model = BasicPitch::load(path.as_ref()).expect("model loads");
    // A two-bar riff at 120 BPM in eighths and quarters, long enough to cross windows,
    // played twice: plucked, then hummed (smooth starts).
    let riff: [(f64, u8); 12] = [
        (0.0, 57),
        (0.25, 60),
        (0.5, 64),
        (1.0, 62),
        (1.25, 60),
        (1.5, 57),
        (2.0, 55),
        (2.5, 57),
        (2.75, 60),
        (3.0, 64),
        (3.5, 67),
        (3.75, 64),
    ];
    let mut truth = Vec::new();
    for rep in 0..3 {
        for (i, &(at, midi)) in riff.iter().enumerate() {
            let next = riff.get(i + 1).map_or(4.0, |r| r.0);
            truth.push((0.3 + rep as f64 * 4.0 + at, (next - at) * 0.9, midi));
        }
    }
    for hummed in [false, true] {
        let audio = play(&truth, 12.6, hummed);
        let t = std::time::Instant::now();
        let heard = hear(&mut model, SR, &audio, |_| true).expect("hears");
        let (found, right) = scores(&heard, &truth);
        eprintln!(
            "{}: {} notes heard in {:.2} s; {:.0} % of the notes found, {:.0} % of what it heard right",
            if hummed { "hummed" } else { "plucked" },
            heard.len(),
            t.elapsed().as_secs_f64(),
            found * 100.0,
            right * 100.0
        );
        if found < 0.9 || right < 0.9 {
            for n in &heard {
                eprintln!("  {:.3} {:.3} {} {:.2}", n.start, n.length, n.pitch, n.strength);
            }
        }
        assert!(found >= 0.9 && right >= 0.9, "{}: {found:.2} / {right:.2}", if hummed { "hummed" } else { "plucked" });
    }
}

#[test]
fn hears_a_chord_as_its_notes() {
    let Ok(path) = std::env::var("MIXIT_BASIC_PITCH_MODEL") else {
        eprintln!("MIXIT_BASIC_PITCH_MODEL not set: skipping");
        return;
    };
    let mut model = BasicPitch::load(path.as_ref()).expect("model loads");
    let truth = [(0.5, 1.0, 60), (0.5, 1.0, 64), (0.5, 1.0, 67), (2.0, 1.0, 57), (2.0, 1.0, 60), (2.0, 1.0, 64)];
    let heard = hear(&mut model, SR, &play(&truth, 3.5, false), |_| true).expect("hears");
    let (found, right) = scores(&heard, &truth);
    eprintln!("chords: {:.0} % found, {:.0} % right ({heard:?})", found * 100.0, right * 100.0);
    assert!(found >= 0.83 && right >= 0.8);
}
