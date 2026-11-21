//! End-to-end engine tests: transport, cueing, loops, sync, scheduling, recording and the
//! real-time guarantee (no allocation on the audio thread).

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId, Quantize};
use mixit_dsp::testkit::{self, ClickDetector};
use mixit_engine::*;

const SR: u32 = 48_000;
const A: DeckId = DeckId::A;
const B: DeckId = DeckId::B;

#[global_allocator]
static ALLOC: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

struct Rig {
    engine: Engine,
    ctl: Controller,
}

impl Rig {
    fn new() -> Rig {
        let (engine, ctl) = Engine::new(EngineConfig { sample_rate: SR, ..Default::default() });
        Rig { engine, ctl }
    }

    fn send(&mut self, cmd: Command) {
        assert!(self.ctl.send(cmd).is_ok());
    }

    fn deck(&mut self, d: DeckId, c: DeckCommand) {
        self.send(Command::Deck(d, c));
    }

    /// Renders `frames` and returns the master's left channel, without allocating inside
    /// the engine (checked).
    fn run(&mut self, frames: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames);
        let mut m = vec![0.0f32; 1024];
        let mut c = vec![0.0f32; 1024];
        let mut left = frames;
        while left > 0 {
            let n = left.min(512);
            let (mm, cc) = (&mut m[..n * 2], &mut c[..n * 2]);
            assert_no_alloc::assert_no_alloc(|| self.engine.process(mm, cc));
            out.extend(mm.chunks(2).map(|f| f[0]));
            left -= n;
        }
        self.ctl.collect_trash();
        out
    }

    fn tel(&mut self) -> Telemetry {
        self.engine.snapshot()
    }

    fn latency(&self) -> usize {
        self.engine.mixer().limiter.latency()
    }
}

fn track(seconds: f32, f: f32, bpm: f64) -> Box<DeckTrack> {
    let n = (seconds * SR as f32) as usize;
    let x = testkit::sine(n, f, SR as f32, 0.25);
    let audio = Arc::new(TrackAudio::from_mono(SR, &x));
    let grid = Arc::new(Beatgrid::constant(SR, bpm, 0.0));
    let mut t = DeckTrack::new(audio, grid);
    t.token = 7;
    Box::new(t)
}

/// A track whose sample value is its own frame index (scaled), for position checks.
fn ramp_track(seconds: f32, bpm: f64) -> Box<DeckTrack> {
    let n = (seconds * SR as f32) as usize;
    let x: Vec<f32> = (0..n).map(|i| i as f32 / n as f32).collect();
    let audio = Arc::new(TrackAudio::from_mono(SR, &x));
    Box::new(DeckTrack::new(audio, Arc::new(Beatgrid::constant(SR, bpm, 0.0))))
}

#[test]
fn plays_a_track_at_unity() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(5.0, 440.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    let out = r.run(48_000);
    let lat = r.latency();
    let expect = testkit::sine(48_000, 440.0, SR as f32, 0.25);
    // After the start fade and limiter delay the output is the track, bit for bit close.
    for i in 2_000..40_000 {
        assert!((out[i + lat] - expect[i]).abs() < 1e-3, "frame {i}: {} vs {}", out[i + lat], expect[i]);
    }
    let t = r.tel();
    assert!(t.decks[0].playing && t.decks[0].loaded);
    assert!((t.decks[0].bpm - 120.0).abs() < 1e-6);
}

#[test]
fn cue_follows_the_cdj_state_machine() {
    let mut r = Rig::new();
    r.send(Command::Global(GlobalCommand::SetQuantize(Quantize::Off)));
    r.deck(A, DeckCommand::Load(ramp_track(20.0, 120.0)));
    r.deck(A, DeckCommand::Seek(48_000.0));
    r.run(256);
    // Paused away from the cue: pressing cue sets it here.
    r.deck(A, DeckCommand::CueDown);
    r.deck(A, DeckCommand::CueUp);
    r.run(256);
    let events: Vec<Event> = r.ctl.events().collect();
    assert!(events.iter().any(|e| matches!(e, Event::CueSet { frame, .. } if (*frame - 48_000.0).abs() < 1.0)));
    // Play, then cue while playing returns to the cue and stops.
    r.deck(A, DeckCommand::Play);
    r.run(24_000);
    assert!(r.tel().decks[0].position > 60_000.0);
    r.deck(A, DeckCommand::CueDown);
    r.run(2_048);
    let t = r.tel();
    assert!(!t.decks[0].playing);
    assert!((t.decks[0].position - 48_000.0).abs() < 1.0, "{}", t.decks[0].position);
    // Holding cue at the cue point previews; releasing returns.
    r.deck(A, DeckCommand::CueDown);
    r.run(12_000);
    assert!(r.tel().decks[0].position > 55_000.0);
    r.deck(A, DeckCommand::CueUp);
    r.run(2_048);
    let t = r.tel();
    assert!(!t.decks[0].playing && (t.decks[0].position - 48_000.0).abs() < 1.0);
}

#[test]
fn hot_cue_jump_keeps_the_beat_phase() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(30.0, 120.0)));
    // Hot cue 1 on beat 4 (frame 96 000 at 120 BPM).
    r.deck(A, DeckCommand::SetHotCue { index: 0, frame: Some(96_000.0), kind: CueKind::Point, color: 0 });
    r.deck(A, DeckCommand::Play);
    r.run(30_000); // 1.25 beats in: phase 0.25
    r.deck(A, DeckCommand::HotCueDown(0));
    r.deck(A, DeckCommand::HotCueUp(0));
    r.run(1_024);
    let t = r.tel();
    let phase = (t.decks[0].beat).rem_euclid(1.0);
    assert!(t.decks[0].position >= 96_000.0 && t.decks[0].position < 96_000.0 + 24_000.0);
    // Phase preserved (within the time the chunk took to render).
    let expected = ((30_000.0 + 1_024.0) / 24_000.0f64).rem_euclid(1.0);
    assert!((phase - expected).abs() < 0.02, "phase {phase} vs {expected}");
}

#[test]
fn auto_loop_holds_the_position_without_clicks() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(30.0, 440.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.run(30_000);
    r.deck(A, DeckCommand::LoopAuto(1.0));
    let out = r.run(96_000); // four passes of a one-beat loop
    let t = r.tel();
    let l = t.decks[0].looping;
    assert!(l.active && (l.beats - 1.0).abs() < 1e-9, "{l:?}");
    assert!(t.decks[0].position >= l.start && t.decks[0].position < l.end);
    // A 440 Hz tone looped on a 1-beat boundary has phase jumps; the crossfade must hide them.
    let clicks = ClickDetector { threshold: 0.01 }.clicks(&out[2_000..]);
    assert!(clicks.is_empty(), "clicks at {clicks:?}");
    // Exiting resumes normal playback from inside the loop.
    r.deck(A, DeckCommand::LoopExit);
    r.run(48_000);
    assert!(r.tel().decks[0].position > l.end);
}

#[test]
fn loop_roll_returns_to_where_the_track_would_be() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(30.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.run(48_000);
    r.deck(A, DeckCommand::LoopRollDown(0.25));
    r.run(48_000);
    r.deck(A, DeckCommand::LoopRollUp);
    r.run(512);
    let pos = r.tel().decks[0].position;
    // Played 96 000 + 512 frames in total; slip puts us back on that timeline.
    assert!((pos - 96_512.0).abs() < 600.0, "{pos}");
}

#[test]
fn beat_jump_and_loop_move() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(60.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.run(24_000);
    let before = r.tel().decks[0].position;
    r.deck(A, DeckCommand::BeatJump(8.0));
    r.run(256);
    let after = r.tel().decks[0].position;
    assert!((after - before - 8.0 * 24_000.0 - 256.0).abs() < 300.0, "{before} → {after}");
    // With a loop active, beat jump moves the loop.
    r.deck(A, DeckCommand::LoopAuto(4.0));
    r.run(256);
    let l0 = r.tel().decks[0].looping;
    r.deck(A, DeckCommand::BeatJump(4.0));
    r.run(256);
    let l1 = r.tel().decks[0].looping;
    assert!((l1.start - l0.start - 96_000.0).abs() < 1e-6);
}

#[test]
fn sync_matches_tempo_and_phase() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(60.0, 120.0)));
    r.deck(B, DeckCommand::Load(ramp_track(60.0, 126.0)));
    r.deck(A, DeckCommand::Play);
    r.deck(A, DeckCommand::Sync(true)); // first synced deck becomes master
    r.run(10_000);
    r.deck(B, DeckCommand::Seek(5_000.0));
    r.deck(B, DeckCommand::Play);
    r.deck(B, DeckCommand::Sync(true));
    r.run(96_000);
    let t = r.tel();
    assert_eq!(t.master_deck, Some(A));
    assert!((t.decks[1].bpm - 120.0).abs() < 0.2, "B at {} BPM", t.decks[1].bpm);
    let phase = (t.decks[0].beat - t.decks[1].beat).rem_euclid(1.0);
    let phase = phase.min(1.0 - phase);
    assert!(phase < 0.01, "phase difference {phase} beats");
}

#[test]
fn clock_follows_the_playing_deck_without_sync() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(20.0, 124.0)));
    r.deck(A, DeckCommand::Play);
    r.run(24_000);
    let t = r.tel();
    assert_eq!(t.master_deck, None);
    assert!((t.clock_bpm - 124.0).abs() < 1e-6, "clock at {}", t.clock_bpm);
    // Paused, the clock keeps the last tempo.
    r.deck(A, DeckCommand::Pause);
    r.run(4_800);
    assert!((r.tel().clock_bpm - 124.0).abs() < 1e-6);
}

#[test]
fn half_tempo_tracks_sync_at_double() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(60.0, 140.0)));
    r.deck(B, DeckCommand::Load(ramp_track(60.0, 72.0)));
    r.deck(A, DeckCommand::Play);
    r.deck(A, DeckCommand::Sync(true));
    r.deck(B, DeckCommand::Play);
    r.deck(B, DeckCommand::Sync(true));
    r.run(48_000);
    let t = r.tel();
    // 72 BPM is matched to 70 (half of 140), not stretched to 140.
    assert!((t.decks[1].bpm - 70.0).abs() < 0.2, "{}", t.decks[1].bpm);
}

#[test]
fn scheduled_command_lands_on_its_frame() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(5.0, 440.0, 120.0)));
    r.run(1_000);
    let at = 3_333u64;
    assert!(r.ctl.send_at(at, Command::Deck(A, DeckCommand::Play)).is_ok());
    let out = r.run(8_000);
    let lat = r.latency();
    let first = out.iter().position(|v| v.abs() > 0.0).unwrap();
    // Output index 0 here is engine frame 1 000.
    // The play head starts exactly on the scheduled frame (plus the limiter look-ahead).
    assert_eq!(first + 1_000, at as usize + lat, "first sound at {}", first + 1_000);
}

#[test]
fn crossfader_and_faders_route_channels() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(5.0, 440.0, 120.0)));
    r.deck(B, DeckCommand::Load(track(5.0, 1_000.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.deck(B, DeckCommand::Play);
    r.send(Command::Mixer(MixerCommand::SetAssign(A, XfAssign::A)));
    r.send(Command::Mixer(MixerCommand::SetAssign(B, XfAssign::B)));
    r.send(Command::Mixer(MixerCommand::SetCrossfader(-1.0)));
    let out = r.run(48_000);
    let tail = &out[24_000..];
    assert!(testkit::tone_level(tail, 440.0, SR as f32) > 0.2);
    assert!(testkit::tone_level(tail, 1_000.0, SR as f32) < 0.001);
    r.send(Command::Mixer(MixerCommand::SetCrossfader(1.0)));
    let out = r.run(24_000);
    let tail = &out[4_800..];
    assert!(testkit::tone_level(tail, 440.0, SR as f32) < 0.001);
    assert!(testkit::tone_level(tail, 1_000.0, SR as f32) > 0.2);
}

#[test]
fn echo_out_tail_survives_the_fader() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(5.0, 440.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    let echo = mixit_dsp::fx::create(mixit_dsp::fx::FxKind::Echo, SR as f32);
    r.send(Command::Fx(FxTarget::Deck(A), 0, FxCommand::SetEffect(echo)));
    r.send(Command::Fx(FxTarget::Deck(A), 0, FxCommand::SetParam(0, 0.7)));
    r.send(Command::Fx(FxTarget::Deck(A), 0, FxCommand::SetMix(1.0)));
    r.send(Command::Fx(FxTarget::Deck(A), 0, FxCommand::SetOn(true)));
    r.run(24_000);
    r.send(Command::Mixer(MixerCommand::SetFader(A, 0.0)));
    r.run(4_800);
    let tail = r.run(24_000);
    assert!(testkit::rms(&tail) > 0.01, "the echo tail should keep ringing");
}

#[test]
fn recorder_captures_the_master() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(5.0, 440.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.send(Command::Global(GlobalCommand::SetRecording(true)));
    let out = r.run(9_600);
    let mut rec = Vec::new();
    r.ctl.drain_recorder(&mut rec);
    assert_eq!(rec.len(), 9_600 * 2);
    for i in 0..9_600 {
        assert_eq!(rec[i * 2], out[i]);
    }
}

#[test]
fn scratch_moves_backwards_and_resumes() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(ramp_track(30.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.run(48_000);
    r.deck(A, DeckCommand::ScratchStart);
    r.deck(A, DeckCommand::ScratchVelocity(-1.0));
    r.run(24_000);
    let p = r.tel().decks[0].position;
    assert!(p < 48_000.0 && p > 20_000.0, "{p}");
    r.deck(A, DeckCommand::ScratchEnd);
    r.run(24_000);
    assert!(r.tel().decks[0].position > p + 20_000.0);
}

#[test]
fn brake_stops_the_deck() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(30.0, 440.0, 120.0)));
    r.deck(A, DeckCommand::Play);
    r.run(4_800);
    r.deck(A, DeckCommand::Brake(0.5));
    r.run(30_000);
    let t = r.tel();
    assert!(!t.decks[0].playing);
}

#[test]
fn sampler_quantised_trigger_waits_for_the_beat() {
    let mut r = Rig::new();
    let x = vec![0.5f32; 4_800];
    let audio = Arc::new(TrackAudio::from_mono(SR, &x));
    r.send(Command::Sampler(SamplerCommand::Load { pad: 0, audio, bpm: None }));
    r.send(Command::Global(GlobalCommand::SetClockBpm(120.0)));
    r.run(6_000); // internal clock: 0.25 beats in
    r.send(Command::Sampler(SamplerCommand::Down(0)));
    let out = r.run(30_000);
    let first = out.iter().position(|v| v.abs() > 1e-4).unwrap();
    let lat = r.latency();
    // Next beat is at frame 24 000, i.e. 18 000 into this run.
    assert!((first as i64 - (18_000 + lat) as i64).abs() <= 2, "{first}");
}

#[test]
fn every_deck_feature_runs_without_allocating() {
    let mut r = Rig::new();
    r.deck(A, DeckCommand::Load(track(30.0, 440.0, 128.0)));
    r.deck(B, DeckCommand::Load(track(30.0, 220.0, 124.0)));
    r.deck(A, DeckCommand::SetStretcher(Box::new(mixit_dsp::stretch::ResampleStretch::new())));
    for kind in mixit_dsp::fx::FxKind::ALL {
        let fx = mixit_dsp::fx::create(kind, SR as f32);
        r.send(Command::Fx(FxTarget::Master, 0, FxCommand::SetEffect(fx)));
        r.send(Command::Fx(FxTarget::Master, 0, FxCommand::SetOn(true)));
        r.run(512);
    }
    let script: Vec<Command> = vec![
        Command::Deck(A, DeckCommand::Play),
        Command::Deck(B, DeckCommand::Play),
        Command::Deck(A, DeckCommand::Sync(true)),
        Command::Deck(B, DeckCommand::Sync(true)),
        Command::Deck(A, DeckCommand::SetKeylock(true)),
        Command::Deck(A, DeckCommand::SetTempo(0.5)),
        Command::Deck(A, DeckCommand::LoopAuto(0.5)),
        Command::Deck(A, DeckCommand::LoopHalve),
        Command::Deck(A, DeckCommand::LoopDouble),
        Command::Deck(A, DeckCommand::LoopExit),
        Command::Deck(A, DeckCommand::HotCueDown(3)),
        Command::Deck(A, DeckCommand::HotCueUp(3)),
        Command::Deck(A, DeckCommand::HotCueDown(3)),
        Command::Deck(A, DeckCommand::HotCueUp(3)),
        Command::Deck(B, DeckCommand::Slip(true)),
        Command::Deck(B, DeckCommand::Censor(true)),
        Command::Deck(B, DeckCommand::Censor(false)),
        Command::Deck(B, DeckCommand::ScratchStart),
        Command::Deck(B, DeckCommand::ScratchVelocity(-2.0)),
        Command::Deck(B, DeckCommand::ScratchEnd),
        Command::Deck(A, DeckCommand::Reverse(true)),
        Command::Deck(A, DeckCommand::Reverse(false)),
        Command::Deck(A, DeckCommand::SetKeyShift(2.0)),
        Command::Deck(B, DeckCommand::BeatJump(-4.0)),
        Command::Deck(B, DeckCommand::Brake(0.3)),
        Command::Mixer(MixerCommand::SetEq(A, 0, -26.0)),
        Command::Mixer(MixerCommand::SetFilter(B, -0.6)),
        Command::Mixer(MixerCommand::SetCue(A, true)),
        Command::Mixer(MixerCommand::SetCrossfader(0.3)),
        Command::Mixer(MixerCommand::SetEqMode(mixit_dsp::djeq::EqMode::Isolator)),
        Command::Global(GlobalCommand::SetRecording(true)),
        Command::Deck(B, DeckCommand::SpinUp(0.5)),
        Command::Deck(A, DeckCommand::Eject),
    ];
    for c in script {
        r.send(c);
        r.run(2_048);
        let mut sink = Vec::new();
        r.ctl.drain_recorder(&mut sink);
    }
    let t = r.tel();
    assert_eq!(t.leaked, 0);
}

#[test]
fn mic_goes_on_air_without_allocating_and_its_feed_is_freed_off_the_audio_thread() {
    let mut rig = Rig::new();
    let (mut tx, feed) = InputFeed::new(SR, SR, 256);
    rig.send(Command::Mic(MicCommand::SetFeed(Some(Box::new(feed)))));
    let mut d = mixit_engine::actions::ActionDispatcher::new(SR, 4);
    for (id, input) in [
        ("mic.on_air", mixit_engine::actions::ActionInput::Set(true)),
        ("mic.level", mixit_engine::actions::ActionInput::Value(1.0)),
        ("mic.talkover", mixit_engine::actions::ActionInput::Set(false)),
    ] {
        for c in d.dispatch(id, input).unwrap() {
            rig.send(c);
        }
    }
    assert!(d.dispatch("mic.record", mixit_engine::actions::ActionInput::Press).is_err());
    let tone: Vec<f32> =
        (0..512).flat_map(|i| [0.25 * (i as f32 * 0.05).sin(), 0.25 * (i as f32 * 0.05).sin()]).collect();
    let mut peak = 0.0f32;
    for k in 0..200 {
        push_input(&mut tx, &tone);
        let out = rig.run(512);
        if k > 100 {
            peak = peak.max(out.iter().fold(0.0f32, |m, x| m.max(x.abs())));
        }
    }
    assert!((peak - 0.25).abs() < 0.03, "mic peak on master {peak}");
    let t = rig.tel();
    assert!(t.mic.connected && t.mic.live && t.mic.on_air);
    assert_eq!(t.mic.underruns, 0);
    // Disconnecting hands the feed back to be freed here, not on the audio thread.
    rig.send(Command::Mic(MicCommand::SetFeed(None)));
    rig.run(512);
    assert!(!rig.tel().mic.connected);
}
