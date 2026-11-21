//! Renders a [`MixProject`] by playing it through the real engine, so a bounced mix
//! sounds exactly like the live decks (same time-stretch, EQ, filter, FX and limiter).
//!
//! Each clip plays on the deck of its lane. Clips are loaded a second before they
//! start, cued to their source beat and started on their exact frame. While a clip
//! plays, its tempo is set from the master tempo map and the track's beatgrid every
//! block, with a gentle correction that keeps it phase-locked to the timeline, and its
//! automation lanes drive the mixer.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use mixit_core::{Beatgrid, DeckId, Quantize};
use mixit_engine::commands::{FxCommand, FxTarget, GlobalCommand};
use mixit_engine::{Command, DeckCommand, DeckTrack, Engine, EngineConfig, MixerCommand, TrackAudio};
use mixit_project::{Clip, MixProject, Param};

/// Audio and grid for a clip's track, at the render sample rate.
pub struct ResolvedTrack {
    pub audio: Arc<TrackAudio>,
    pub grid: Beatgrid,
    pub auto_gain_db: f32,
}

#[derive(Clone, Debug)]
pub struct RenderOptions {
    pub sample_rate: u32,
    /// Extra seconds after the last clip (tails, echoes).
    pub tail: f64,
    pub block: usize,
    pub limiter: bool,
    pub auto_gain: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions { sample_rate: 44_100, tail: 2.0, block: 256, limiter: true, auto_gain: true }
    }
}

#[derive(Debug, PartialEq)]
pub enum RenderError {
    MissingTrack { clip: u64, title: String },
    Cancelled,
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::MissingTrack { title, .. } => write!(f, "track not found: {title}"),
            RenderError::Cancelled => f.write_str("render cancelled"),
        }
    }
}

impl std::error::Error for RenderError {}

struct Slot {
    clip: usize,
    started: bool,
    stopped: bool,
    grid: Beatgrid,
}

/// Renders the project to interleaved stereo. `progress(fraction)` is called per block.
pub fn render_project(
    project: &MixProject,
    opts: &RenderOptions,
    mut resolve: impl FnMut(&Clip) -> Option<ResolvedTrack>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<Vec<f32>, RenderError> {
    let sr = opts.sample_rate;
    let srf = sr as f64;
    let (mut engine, mut ctl) = Engine::new(EngineConfig { sample_rate: sr, decks: 4, ..Default::default() });
    let send = |ctl: &mut mixit_engine::Controller, c: Command| {
        let _ = ctl.send(c);
    };
    send(&mut ctl, Command::Global(GlobalCommand::SetQuantize(Quantize::Off)));
    send(&mut ctl, Command::Mixer(MixerCommand::SetMasterDb(project.master_gain_db)));
    send(&mut ctl, Command::Mixer(MixerCommand::SetLimiter(opts.limiter)));
    send(&mut ctl, Command::Mixer(MixerCommand::SetAutoGain(opts.auto_gain)));
    for d in 0..4u8 {
        let id = DeckId(d);
        send(&mut ctl, Command::Deck(id, DeckCommand::SetTempoRange(1.0)));
        send(
            &mut ctl,
            Command::Deck(
                id,
                DeckCommand::SetStretcher(Box::new(mixit_stretch::SignalsmithStretch::new(
                    sr,
                    mixit_stretch::StretchQuality::High,
                ))),
            ),
        );
        send(&mut ctl, Command::Mixer(MixerCommand::SetFader(id, 0.0)));
    }

    let total_secs = project.length_seconds() + opts.tail;
    let total = (total_secs * srf).ceil() as usize;
    let mut out = vec![0.0f32; total * 2];
    let mut cue = vec![0.0f32; opts.block * 2];
    // Clips in order of start, with their resolved audio once loaded.
    let mut order: Vec<usize> = (0..project.clips.len()).collect();
    order.sort_by(|&a, &b| project.clips[a].start.partial_cmp(&project.clips[b].start).unwrap());
    let mut next = 0usize;
    let mut slots: [Option<Slot>; 4] = [None, None, None, None];
    let preload = 1.0; // seconds
    let mut pos = 0usize;
    while pos < total {
        if cancel.load(Ordering::Relaxed) {
            return Err(RenderError::Cancelled);
        }
        let n = opts.block.min(total - pos);
        let now_s = pos as f64 / srf;
        let beat = project.tempo.beat_at_seconds(now_s);
        // Load clips that start soon onto their deck.
        while next < order.len() {
            let c = &project.clips[order[next]];
            let start_s = project.tempo.seconds_at_beat(c.start);
            if start_s - now_s > preload {
                break;
            }
            let lane = c.lane as usize % 4;
            // The lane must be free (previous clip ended) before loading.
            if let Some(s) = &slots[lane] {
                if !s.stopped {
                    break;
                }
            }
            let Some(r) = resolve(c) else {
                return Err(RenderError::MissingTrack { clip: c.id, title: c.track.title.clone() });
            };
            let id = DeckId(lane as u8);
            let grid = r.grid.resampled(r.audio.sample_rate);
            let mut dt = DeckTrack::new(r.audio.clone(), Arc::new(grid.clone()));
            dt.auto_gain_db = r.auto_gain_db;
            send(&mut ctl, Command::Deck(id, DeckCommand::Load(Box::new(dt))));
            send(&mut ctl, Command::Deck(id, DeckCommand::SetKeylock(c.keylock)));
            send(&mut ctl, Command::Deck(id, DeckCommand::SetKeyShift(c.key_shift)));
            send(&mut ctl, Command::Mixer(MixerCommand::SetTrim(id, c.gain_db)));
            if let Some(fx) = c.fx {
                let kind = mixit_dsp::fx::FxKind::from_index(fx.kind);
                let e = mixit_dsp::fx::create(kind, sr as f32);
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetEffect(e)));
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetBeats(fx.beats)));
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetMix(0.0)));
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetOn(false)));
            } else {
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetEffect(None)));
            }
            let src_frame = grid.frame_at(c.source_start);
            send(&mut ctl, Command::Deck(id, DeckCommand::Seek(src_frame)));
            let rate = project.tempo.bpm_at_beat(c.start) / grid.bpm_at(src_frame);
            send(&mut ctl, Command::Deck(id, DeckCommand::SetTempo(rate - 1.0)));
            let start_frame = (project.tempo.seconds_at_beat(c.start) * srf).round().max(pos as f64) as u64;
            let _ = ctl.send_at(start_frame, Command::Deck(id, DeckCommand::Play));
            slots[lane] = Some(Slot { clip: order[next], started: false, stopped: false, grid });
            next += 1;
        }
        // Per-block control of every playing clip.
        for (lane, slot) in slots.iter_mut().enumerate() {
            let Some(s) = slot else { continue };
            if s.stopped {
                continue;
            }
            let c = &project.clips[s.clip];
            let id = DeckId(lane as u8);
            if beat >= c.start {
                s.started = true;
            }
            if beat >= c.end() {
                send(&mut ctl, Command::Deck(id, DeckCommand::Pause));
                send(&mut ctl, Command::Mixer(MixerCommand::SetFader(id, 0.0)));
                s.stopped = true;
                continue;
            }
            // Automation, evaluated at the block's midpoint.
            let b = project.tempo.beat_at_seconds(now_s + 0.5 * n as f64 / srf);
            let ab = if s.started { b } else { c.start };
            send(&mut ctl, Command::Mixer(MixerCommand::SetFader(id, c.value_at(Param::Volume, ab))));
            for (band, p) in [Param::EqLow, Param::EqMid, Param::EqHigh].into_iter().enumerate() {
                send(&mut ctl, Command::Mixer(MixerCommand::SetEq(id, band, c.value_at(p, ab))));
            }
            send(&mut ctl, Command::Mixer(MixerCommand::SetFilter(id, c.value_at(Param::Filter, ab))));
            if c.fx.is_some() {
                let mix = c.value_at(Param::FxMix, ab);
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetOn(mix > 0.001)));
                send(&mut ctl, Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetMix(mix)));
            }
            if s.started {
                // Tempo from the map and the grid, with phase correction.
                let expected = s.grid.frame_at(c.source_beat(b));
                let actual = engine.deck(id).map(|d| d.audible()).unwrap_or(expected);
                let fpb = s.grid.frames_per_beat_at(expected);
                let err_beats = (expected - actual) / fpb;
                let base = project.tempo.bpm_at_beat(b) / s.grid.bpm_at(expected);
                let corr = (err_beats * 0.5).clamp(-0.02, 0.02);
                send(&mut ctl, Command::Deck(id, DeckCommand::SetTempo(base * (1.0 + corr) - 1.0)));
            }
        }
        engine.process(&mut out[pos * 2..(pos + n) * 2], &mut cue[..n * 2]);
        ctl.collect_trash();
        let _ = ctl.events().count();
        pos += n;
        progress(pos as f32 / total as f32);
    }
    Ok(out)
}
