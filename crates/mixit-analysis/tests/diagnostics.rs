//! Diagnostics (ignored by default): `cargo test -p mixit-analysis --release --test diagnostics -- --ignored --nocapture`
//! prints accuracy figures per style for tuning the analysis.

use mixit_analysis::*;
use mixit_core::{Key, Mode};
use mixit_generator::*;

#[test]
#[ignore]
fn calibrate() {
    for (style, bpm, key) in [
        (Style::House, 124.0, Key::new(9, Mode::Minor)),
        (Style::Techno, 130.0, Key::new(2, Mode::Minor)),
        (Style::Trance, 138.0, Key::new(7, Mode::Major)),
        (Style::HipHop, 90.0, Key::new(0, Mode::Minor)),
        (Style::DrumAndBass, 174.0, Key::new(5, Mode::Minor)),
    ] {
        let mut spec = TrackSpec::standard(style, bpm, key);
        spec.lead_in = 1.3;
        let g = generate(&spec);
        let t0 = std::time::Instant::now();
        let a = analyze(&g.audio, g.sample_rate, &AnalysisOptions::default());
        let el = t0.elapsed();
        let sr = g.sample_rate as f64;
        // Offset: grid beat nearest each true beat.
        let mut offs: Vec<f64> = g
            .truth
            .beats
            .iter()
            .map(|&t| {
                let b = a.grid.beat_at(t * sr).round();
                a.grid.frame_at(b) / sr - t
            })
            .collect();
        offs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let med = offs[offs.len() / 2];
        let db_ok = g
            .truth
            .downbeats
            .iter()
            .filter(|&&t| {
                let b = a.grid.beat_at(t * sr).round() as i64;
                a.grid.is_downbeat(b)
            })
            .count();
        let ph = g
            .truth
            .downbeats
            .iter()
            .filter(|&&t| {
                let b = a.grid.beat_at(t * sr).round() as i64;
                a.grid.is_phrase_start(b)
            })
            .count();
        println!(
            "{style:?} {bpm}: bpm {:.3} conf {:.2} off med {:.1} ms min {:.1} max {:.1} | downbeats {}/{} phrase-starts-hit {} | key {} ({:.2}) truth {} | drift {:.1} ms warped {} | energy {} | {:?}",
            a.bpm,
            a.tempo_confidence,
            med * 1e3,
            offs[0] * 1e3,
            offs[offs.len() - 1] * 1e3,
            db_ok,
            g.truth.downbeats.len(),
            ph,
            a.key.as_ref().unwrap().key.standard_name(),
            a.key.as_ref().unwrap().confidence,
            key.standard_name(),
            a.drift_ms,
            !a.grid.is_constant(),
            a.energy,
            el
        );
        let truth_secs: Vec<String> = g.truth.sections.iter().map(|(t, k)| format!("{:.1}:{:?}", t, k)).collect();
        let got: Vec<String> = a.sections.iter().map(|s| format!("{:.1}:{:?}", s.start, s.label)).collect();
        println!("   truth {}\n   got   {}", truth_secs.join(" "), got.join(" "));
        println!(
            "   audible {:.3}..{:.3} (lead-in 1.3) LUFS {:.1} gain {:.1}",
            a.audible.0, a.audible.1, a.loudness.integrated_lufs, a.loudness.auto_gain_db
        );
    }
}

#[test]
#[ignore]
fn debug_structure() {
    use mixit_analysis::*;
    let spec = TrackSpec::standard(Style::House, 124.0, Key::new(9, Mode::Minor));
    let g = generate(&spec);
    let sr = g.sample_rate;
    let (mono, msr) = prep::analysis_mono(&g.audio, sr);
    let spec_ = stft::stft(&mono, msr, onset::ONSET_WINDOW, onset::ONSET_HOP);
    let ons = onset::onsets_from(&spec_);
    let (low, lsr) = key::chroma_signal(&mono, msr);
    let bc = key::chromagram_with(&low, lsr, 2048, 256, 100.0);
    let kc = key::chromagram(&low, lsr);
    let audible = (0.0, g.truth.duration);
    let r = grid::rhythm(&ons, (60.0, 200.0), true, audible).unwrap();
    let st = sections::structure(&r.model, 0, 4, 8, &spec_, &ons, &bc, audible);
    for (i, n) in st.novelty.iter().enumerate() {
        print!("{i}:{:.2}/{:.2} ", n, st.energy[i]);
    }
    println!();
    for s in &st.sections {
        println!("{:?} bars {}+{} energy {:.2}", s.label, s.start_bar, s.bars, s.energy);
    }
    let k = key::estimate_key(&kc);
    println!("{:?}", k.ranking.iter().map(|(k, s)| format!("{} {:.3}", k.standard_name(), s)).collect::<Vec<_>>());
}

#[test]
#[ignore]
fn debug_key() {
    use mixit_analysis::*;
    for (style, bpm, key) in [
        (Style::House, 124.0, Key::new(9, Mode::Minor)),
        (Style::Techno, 130.0, Key::new(2, Mode::Minor)),
        (Style::Trance, 138.0, Key::new(7, Mode::Major)),
        (Style::HipHop, 90.0, Key::new(0, Mode::Minor)),
        (Style::DrumAndBass, 174.0, Key::new(5, Mode::Minor)),
        (Style::House, 122.0, Key::new(4, Mode::Major)),
        (Style::Techno, 128.0, Key::new(11, Mode::Minor)),
    ] {
        let g = generate(&TrackSpec::short(style, bpm, key));
        let (mono, msr) = prep::analysis_mono(&g.audio, g.sample_rate);
        let (low, lsr) = key::chroma_signal(&mono, msr);
        let kc = key::chromagram(&low, lsr);
        let k = key::estimate_key(&kc);
        let mut tb = [0.0f32; 12];
        let mut bb = [0.0f32; 12];
        for i in 0..kc.treble.len() {
            for q in 0..12 {
                tb[q] += kc.treble[i][q];
                bb[q] += kc.bass[i][q];
            }
        }
        let mt = tb.iter().cloned().fold(0.0, f32::max);
        let mb = bb.iter().cloned().fold(0.0, f32::max);
        println!(
            "  treble {:?}\n  bass   {:?}",
            tb.iter().map(|v| format!("{:.2}", v / mt)).collect::<Vec<_>>(),
            bb.iter().map(|v| format!("{:.2}", v / mb)).collect::<Vec<_>>()
        );
        println!(
            "{style:?} truth {} -> {:?} tuning {:.1}",
            key.standard_name(),
            k.ranking.iter().map(|(k, s)| format!("{} {:.3}", k.standard_name(), s)).collect::<Vec<_>>(),
            k.tuning_cents
        );
    }
}
