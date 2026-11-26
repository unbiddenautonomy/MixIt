//! Runs the real CLAP models on generated tracks, whose styles are known exactly. The
//! models are large, so this runs only when `MIXIT_CLAP_DIR` names a folder holding the
//! three files (as the app downloads them):
//!
//! ```sh
//! MIXIT_CLAP_DIR=/path/to/models cargo test -p mixit-ml --release --test clap -- --nocapture
//! ```

#![cfg(feature = "sound")]

use mixit_core::{Key, Mode};
use mixit_generator::{Style, TrackSpec, generate};
use mixit_ml::models::{CLAP_AUDIO, CLAP_TEXT, CLAP_TOKENIZER};
use mixit_ml::sound::{Clap, cosine, embed_track};

#[test]
fn hears_the_style_of_generated_tracks() {
    let Ok(dir) = std::env::var("MIXIT_CLAP_DIR") else {
        eprintln!("MIXIT_CLAP_DIR not set: skipping");
        return;
    };
    let dir = std::path::Path::new(&dir);
    let mut clap =
        Clap::load(&dir.join(CLAP_AUDIO.file), Some((&dir.join(CLAP_TEXT.file), &dir.join(CLAP_TOKENIZER.file))))
            .expect("the models load");
    // The word pieces are RoBERTa's, as CLAP's own tokenizer gives them.
    assert_eq!(clap.tokens("house music").unwrap(), vec![0, 3138, 930, 2]);
    assert_eq!(
        clap.tokens("dark rolling bass with a punchy kick").unwrap(),
        vec![0, 30423, 6346, 9590, 19, 10, 10064, 219, 3151, 2]
    );

    let styles = [(Style::DrumAndBass, 172.0, "drum and bass music"), (Style::HipHop, 90.0, "hip hop music")];
    let mut emb = Vec::new();
    for (style, bpm, _) in styles {
        for seed in [1, 2] {
            let mut spec = TrackSpec::short(style, bpm, Key::new(9, Mode::Minor));
            spec.seed = seed;
            let g = generate(&spec);
            let t = std::time::Instant::now();
            emb.push(embed_track(&mut clap, g.sample_rate, &g.audio).expect("listens"));
            eprintln!("{style:?} seed {seed}: {:.2} s", t.elapsed().as_secs_f64());
        }
    }
    // Two tracks in one style sound more alike than tracks in different styles.
    let same = [cosine(&emb[0], &emb[1]), cosine(&emb[2], &emb[3])];
    let across =
        [cosine(&emb[0], &emb[2]), cosine(&emb[0], &emb[3]), cosine(&emb[1], &emb[2]), cosine(&emb[1], &emb[3])];
    eprintln!("same style {same:?}, across {across:?}");
    let best_across = across.iter().cloned().fold(f32::MIN, f32::max);
    assert!(same.iter().all(|&s| s > best_across), "{same:?} vs {across:?}");
    // And each track is closer to its own style's description than to the other's.
    let words: Vec<Vec<f32>> = styles.iter().map(|s| clap.embed_text(s.2).unwrap()).collect();
    for (i, e) in emb.iter().enumerate() {
        let scores: Vec<f32> = words.iter().map(|w| cosine(e, w)).collect();
        eprintln!("track {i}: {scores:?}");
        assert!(scores[i / 2] > scores[1 - i / 2], "track {i}: {scores:?}");
    }
}
