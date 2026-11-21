use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId};
use mixit_engine::{Command, DeckCommand, DeckTrack, Engine, EngineConfig, MixerCommand, TrackAudio};
use mixit_host::recorder::StreamingWav;

#[test]
fn offline_render_plays_a_loaded_track() {
    let sr = 48_000;
    let (mut engine, mut ctl) = Engine::new(EngineConfig { sample_rate: sr, ..Default::default() });
    let tone: Vec<f32> =
        (0..sr as usize * 2).map(|i| 0.5 * (i as f32 * 440.0 * std::f32::consts::TAU / sr as f32).sin()).collect();
    let audio = Arc::new(TrackAudio::from_mono(sr, &tone));
    let grid = Arc::new(Beatgrid::constant(sr, 120.0, 0.0));
    ctl.deck(DeckId::A, DeckCommand::Load(Box::new(DeckTrack::new(audio, grid)))).ok().unwrap();
    ctl.send(Command::Mixer(MixerCommand::SetFader(DeckId::A, 1.0))).ok().unwrap();
    ctl.deck(DeckId::A, DeckCommand::Play).ok().unwrap();
    let mut blocks = 0;
    let (master, cue) = mixit_host::offline::render(&mut engine, sr as usize, 512, |_| blocks += 1);
    assert_eq!(blocks, (sr as usize).div_ceil(512));
    assert_eq!(master.len(), sr as usize * 2);
    assert_eq!(cue.len(), master.len());
    let peak = master[sr as usize..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.2, "expected the tone on the master, peak {peak}");
}

#[test]
fn streaming_wav_round_trip() {
    let dir = std::env::temp_dir().join(format!("mixit-host-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rec.wav");
    let mut w = StreamingWav::create(&path, 44_100, false).unwrap();
    let chunk: Vec<f32> = (0..2_000).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
    for _ in 0..5 {
        w.write(&chunk).unwrap();
    }
    assert_eq!(w.frames(), 5_000);
    w.finish().unwrap();
    let r = hound::WavReader::open(&path).unwrap();
    assert_eq!(r.spec().bits_per_sample, 24);
    assert_eq!(r.len(), 10_000);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn listing_devices_never_panics() {
    // Containers and CI machines usually have no sound card; this must still work.
    let devs = mixit_host::list_outputs();
    for d in &devs {
        assert!(!d.id.is_empty());
        assert!(d.max_channels >= 1);
    }
}

#[test]
fn virtual_output_runs_in_real_time() {
    use mixit_host::AudioHost;
    let (host, mut ctl) = AudioHost::start_virtual(48_000, 480, mixit_engine::EngineConfig::default()).unwrap();
    assert!(host.is_virtual());
    std::thread::sleep(std::time::Duration::from_millis(300));
    let frames = ctl.telemetry().frame;
    // About 0.3 s of audio at 48 kHz, give or take scheduling.
    assert!((9_000..=24_000).contains(&frames), "{frames} frames in 300 ms");
    drop(host);
}
