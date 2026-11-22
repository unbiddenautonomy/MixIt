use mixit_dsp::testkit;
use mixit_io::*;

fn tmpdir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mixit-io-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn stereo_sine(n: usize, f: f32, sr: u32) -> Vec<f32> {
    let l = testkit::sine(n, f, sr as f32, 0.5);
    let r = testkit::sine(n, f * 1.5, sr as f32, 0.25);
    l.iter().zip(&r).flat_map(|(a, b)| [*a, *b]).collect()
}

#[test]
fn wav_and_flac_round_trip() {
    let dir = tmpdir("rt");
    let x = stereo_sine(44_100, 440.0, 44_100);
    for (name, fmt, tol) in [
        ("f.wav", ExportFormat::Wav(WavDepth::Float32), 1e-7),
        ("i16.wav", ExportFormat::Wav(WavDepth::Pcm16), 2.0 / 32768.0),
        ("i24.wav", ExportFormat::Wav(WavDepth::Pcm24), 2.0 / 8_388_608.0),
        ("a.flac", ExportFormat::Flac { bits: 16 }, 2.0 / 32768.0),
        ("b.flac", ExportFormat::Flac { bits: 24 }, 2.0 / 8_388_608.0),
    ] {
        let p = dir.join(name);
        export::write_audio(&p, &x, 2, 44_100, fmt).unwrap();
        let d = decode_file(&p).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(d.sample_rate, 44_100, "{name}");
        assert_eq!(d.source_channels, 2);
        assert_eq!(d.data.len(), x.len(), "{name}");
        let err = d.data.iter().zip(&x).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err <= tol, "{name}: max error {err}");
    }
}

#[test]
fn mono_files_become_stereo() {
    let dir = tmpdir("mono");
    let x = testkit::sine(4_800, 300.0, 48_000.0, 0.5);
    let p = dir.join("m.wav");
    write_wav(&p, &x, 1, 48_000, WavDepth::Float32).unwrap();
    let d = decode_file(&p).unwrap();
    assert_eq!(d.source_channels, 1);
    assert_eq!(d.frames(), 4_800);
    assert_eq!(d.data[200], d.data[201]);
}

#[test]
fn resampling_keeps_pitch_and_length() {
    let x = stereo_sine(44_100, 1_000.0, 44_100);
    let y = resample_interleaved(&x, 2, 44_100, 48_000).unwrap();
    let frames = y.len() / 2;
    assert!((frames as i64 - 48_000).abs() <= 2, "{frames}");
    let left: Vec<f32> = y.chunks(2).map(|c| c[0]).collect();
    let mid = &left[4_800..43_200];
    assert!((testkit::tone_level(mid, 1_000.0, 48_000.0) - 0.5).abs() < 0.01);
}

#[test]
fn load_track_uses_the_cache() {
    let dir = tmpdir("cache");
    let cache = DecodeCache::new(dir.join("cache")).unwrap();
    let p = dir.join("t.wav");
    write_wav(&p, &stereo_sine(44_100, 440.0, 44_100), 2, 44_100, WavDepth::Pcm16).unwrap();
    let a = load_track(&p, 48_000, Some(&cache)).unwrap();
    assert!(!a.from_cache);
    assert_eq!(a.source_rate, 44_100);
    let b = load_track(&p, 48_000, Some(&cache)).unwrap();
    assert!(b.from_cache);
    assert_eq!(a.data, b.data);
    assert_eq!(a.hash, b.hash);
    // Renaming does not change the identity.
    let q = dir.join("renamed.wav");
    std::fs::rename(&p, &q).unwrap();
    assert_eq!(hash_file(&q).unwrap(), a.hash);
    assert!(cache.size() > 0);
    cache.prune(0);
    assert_eq!(cache.size(), 0);
}

#[test]
fn tags_report_properties() {
    let dir = tmpdir("tags");
    let p = dir.join("t.wav");
    write_wav(&p, &stereo_sine(96_000, 440.0, 48_000), 2, 48_000, WavDepth::Pcm24).unwrap();
    let t = read_tags(&p).unwrap();
    assert!((t.duration_s - 2.0).abs() < 0.01, "{}", t.duration_s);
    assert_eq!(t.sample_rate, Some(48_000));
    assert_eq!(t.channels, Some(2));
    assert!(is_audio_file(&p));
    assert!(!is_audio_file(std::path::Path::new("notes.txt")));
}

#[test]
fn rejects_non_audio() {
    let dir = tmpdir("bad");
    let p = dir.join("x.mp3");
    std::fs::write(&p, b"this is not audio at all").unwrap();
    assert!(decode_file(&p).is_err());
}

#[test]
fn writes_tags_into_wav_and_flac() {
    let dir = tmpdir("tags-write");
    let x = stereo_sine(4_800, 440.0, 48_000);
    for name in ["t.wav", "t.flac"] {
        let p = dir.join(name);
        if name.ends_with(".wav") {
            write_wav(&p, &x, 2, 48_000, WavDepth::Pcm16).unwrap();
        } else {
            write_flac(&p, &x, 2, 48_000, 16).unwrap();
        }
        let u = TagUpdate {
            title: Some("Night Drive".into()),
            artist: Some("Ann".into()),
            genre: Some("House".into()),
            label: Some("Own".into()),
            year: Some(2024),
            bpm: Some(124.5),
            key: Some("8A".into()),
            ..Default::default()
        };
        write_tags(&p, &u).unwrap();
        let t = read_tags(&p).unwrap();
        assert_eq!(t.title.as_deref(), Some("Night Drive"), "{name}");
        assert_eq!(t.artist.as_deref(), Some("Ann"), "{name}");
        assert_eq!(t.genre.as_deref(), Some("House"), "{name}");
        assert_eq!(t.label.as_deref(), Some("Own"), "{name}");
        assert_eq!(t.year, Some(2024), "{name}");
        assert_eq!(t.key.as_deref(), Some("8A"), "{name}");
        assert!(t.bpm.is_some_and(|b| (b - 124.5).abs() < 0.6), "{name}: {:?}", t.bpm);
        // Only what is given changes; an empty text removes a field.
        write_tags(&p, &TagUpdate { genre: Some(String::new()), ..Default::default() }).unwrap();
        let t = read_tags(&p).unwrap();
        assert_eq!(t.genre, None, "{name}");
        assert_eq!(t.title.as_deref(), Some("Night Drive"), "{name}");
        // The audio is untouched.
        let d = decode_file(&p).unwrap();
        assert_eq!(d.frames(), 4_800, "{name}");
    }
}
