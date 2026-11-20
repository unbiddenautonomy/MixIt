//! Key lock and key shift through the engine with the native Signalsmith stretcher.

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId};
use mixit_dsp::testkit;
use mixit_engine::*;
use mixit_stretch::{SignalsmithStretch, StretchQuality};

const SR: u32 = 48_000;

fn rig() -> (Engine, Controller) {
    let (e, mut c) = Engine::new(EngineConfig { sample_rate: SR, ..Default::default() });
    let x = testkit::sine(SR as usize * 30, 440.0, SR as f32, 0.25);
    let t = DeckTrack::new(Arc::new(TrackAudio::from_mono(SR, &x)), Arc::new(Beatgrid::constant(SR, 120.0, 0.0)));
    assert!(c.deck(DeckId::A, DeckCommand::Load(Box::new(t))).is_ok());
    let st = SignalsmithStretch::new(SR, StretchQuality::High);
    assert!(c.deck(DeckId::A, DeckCommand::SetStretcher(Box::new(st))).is_ok());
    (e, c)
}

fn run(e: &mut Engine, frames: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(frames);
    let mut m = vec![0.0f32; 1024];
    let mut c = vec![0.0f32; 1024];
    let mut left = frames;
    while left > 0 {
        let n = left.min(512);
        e.process(&mut m[..n * 2], &mut c[..n * 2]);
        out.extend(m[..n * 2].chunks(2).map(|f| f[0]));
        left -= n;
    }
    out
}

#[test]
fn key_lock_keeps_pitch_and_tracks_position() {
    let (mut e, mut c) = rig();
    let _ = c.deck(DeckId::A, DeckCommand::SetKeylock(true));
    let _ = c.deck(DeckId::A, DeckCommand::SetTempo(-1.0)); // −8 %: rate 0.92
    let _ = c.deck(DeckId::A, DeckCommand::Play);
    let out = run(&mut e, SR as usize * 3);
    let tail = &out[SR as usize..];
    assert!(testkit::tone_level(tail, 440.0, SR as f32) > 0.15, "440 Hz kept");
    assert!(testkit::tone_level(tail, 440.0 * 0.92, SR as f32) < 0.02, "no vinyl pitch drop");
    let t = e.snapshot();
    let expected = 3.0 * SR as f64 * 0.92;
    // The audible position accounts for the stretcher latency.
    assert!((t.decks[0].position - expected).abs() < 600.0, "{} vs {expected}", t.decks[0].position);
}

#[test]
fn key_shift_without_key_lock_transposes() {
    let (mut e, mut c) = rig();
    let _ = c.deck(DeckId::A, DeckCommand::SetKeyShift(-2.0));
    let _ = c.deck(DeckId::A, DeckCommand::Play);
    let out = run(&mut e, SR as usize * 3);
    let tail = &out[SR as usize..];
    let target = 440.0 * 2f32.powf(-2.0 / 12.0);
    let (peak_f, _) = (0..200)
        .map(|k| target - 10.0 + k as f32 * 0.1)
        .map(|f| (f, testkit::tone_level(tail, f, SR as f32)))
        .fold((0.0, 0.0), |b, x| if x.1 > b.1 { x } else { b });
    let cents = 1200.0 * (peak_f / target).log2();
    assert!(cents.abs() < 8.0, "{peak_f} Hz vs {target}");
}

#[test]
fn toggling_key_lock_while_playing_keeps_time() {
    let (mut e, mut c) = rig();
    let _ = c.deck(DeckId::A, DeckCommand::Play);
    run(&mut e, SR as usize);
    let _ = c.deck(DeckId::A, DeckCommand::SetKeylock(true));
    let _ = c.deck(DeckId::A, DeckCommand::SetTempo(0.5)); // +4 %
    run(&mut e, SR as usize);
    let _ = c.deck(DeckId::A, DeckCommand::SetKeylock(false));
    run(&mut e, SR as usize);
    let t = e.snapshot();
    let expected = SR as f64 * (1.0 + 1.04 + 1.04);
    assert!((t.decks[0].position - expected).abs() < 1_500.0, "{} vs {expected}", t.decks[0].position);
}

#[test]
fn hot_cue_under_key_lock_is_immediate() {
    let (mut e, mut c) = rig();
    let _ = c.send(Command::Global(GlobalCommand::SetQuantize(mixit_core::Quantize::Off)));
    let _ = c.deck(DeckId::A, DeckCommand::SetKeylock(true));
    let _ =
        c.deck(DeckId::A, DeckCommand::SetHotCue { index: 0, frame: Some(480_000.0), kind: CueKind::Point, color: 0 });
    let _ = c.deck(DeckId::A, DeckCommand::Play);
    run(&mut e, SR as usize);
    let _ = c.deck(DeckId::A, DeckCommand::HotCueDown(0));
    let _ = c.deck(DeckId::A, DeckCommand::HotCueUp(0));
    run(&mut e, 2_048);
    let p = e.snapshot().decks[0].position;
    // Within a few milliseconds of the press, not after the ~120 ms stretcher latency.
    assert!(p > 480_000.0 && p < 480_000.0 + 2_048.0 + 300.0, "{p}");
}
