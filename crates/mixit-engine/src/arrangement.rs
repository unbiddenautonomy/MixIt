//! Plays a [`MixProject`] through the engine offline, so a bounced mix sounds exactly like
//! the live decks (same time-stretch, EQ, filter, FX and limiter). Used by the native
//! host for rendering and by the browser build for preview and render.
//!
//! Each clip plays on the deck of its lane. Clips are loaded a second before they
//! start, cued to their source beat and started on their exact frame. While a clip
//! plays, its tempo is set from the master tempo map and the track's beatgrid every
//! block, with a gentle correction that keeps it phase-locked to the timeline, and its
//! automation lanes drive the mixer.
//!
//! [`ProjectRenderer`] renders in pieces and asks for each track only when its clip is
//! about to start, so a caller can stream the output and fetch audio lazily (the
//! browser cannot hold a whole set's audio in memory at once).

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId, Quantize};
use mixit_dsp::stretch::TimeStretch;
use mixit_project::{Clip, MixProject, Param};

use crate::commands::{FxCommand, FxTarget, GlobalCommand};
use crate::{Command, Controller, DeckCommand, DeckTrack, Engine, EngineConfig, MixerCommand, TrackAudio};

/// Audio and grid for a clip's track, at the render sample rate.
pub struct ResolvedTrack {
    pub audio: Arc<TrackAudio>,
    pub grid: Beatgrid,
    pub auto_gain_db: f32,
}

/// What a resolver says about a clip's track.
pub enum Resolve {
    Ready(ResolvedTrack),
    /// The track cannot be found: the render fails.
    Missing,
    /// Not available yet: rendering pauses until the caller provides it.
    Later,
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

/// The result of one [`ProjectRenderer::render`] call.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    /// Frames written to the start of the output.
    pub frames: usize,
    /// A clip whose track is needed before rendering can go on.
    pub need: Option<u64>,
    /// The whole project has been rendered.
    pub done: bool,
}

struct Slot {
    clip: usize,
    started: bool,
    stopped: bool,
    grid: Beatgrid,
}

/// Makes a time-stretcher for a deck at the render rate.
pub type StretcherFactory = Box<dyn Fn(u32) -> Box<dyn TimeStretch>>;

/// Renders a project a piece at a time.
pub struct ProjectRenderer {
    project: MixProject,
    opts: RenderOptions,
    engine: Engine,
    ctl: Controller,
    order: Vec<usize>,
    next: usize,
    slots: [Option<Slot>; 4],
    pos: usize,
    total: usize,
    cue: Vec<f32>,
}

const PRELOAD_SECONDS: f64 = 1.0;

impl ProjectRenderer {
    pub fn new(project: MixProject, opts: RenderOptions, stretcher: StretcherFactory) -> ProjectRenderer {
        let sr = opts.sample_rate;
        let (engine, mut ctl) = Engine::new(EngineConfig { sample_rate: sr, decks: 4, ..Default::default() });
        let mut send = |c: Command| {
            let _ = ctl.send(c);
        };
        send(Command::Global(GlobalCommand::SetQuantize(Quantize::Off)));
        send(Command::Mixer(MixerCommand::SetMasterDb(project.master_gain_db)));
        send(Command::Mixer(MixerCommand::SetLimiter(opts.limiter)));
        send(Command::Mixer(MixerCommand::SetAutoGain(opts.auto_gain)));
        for d in 0..4u8 {
            let id = DeckId(d);
            send(Command::Deck(id, DeckCommand::SetTempoRange(1.0)));
            send(Command::Deck(id, DeckCommand::SetStretcher(stretcher(sr))));
            send(Command::Mixer(MixerCommand::SetFader(id, 0.0)));
        }
        let total = ((project.length_seconds() + opts.tail) * sr as f64).ceil() as usize;
        let mut order: Vec<usize> = (0..project.clips.len()).collect();
        order.sort_by(|&a, &b| project.clips[a].start.total_cmp(&project.clips[b].start));
        let cue = vec![0.0; opts.block * 2];
        ProjectRenderer {
            project,
            opts,
            engine,
            ctl,
            order,
            next: 0,
            slots: [None, None, None, None],
            pos: 0,
            total,
            cue,
        }
    }

    /// Length of the whole render in frames.
    pub fn total_frames(&self) -> usize {
        self.total
    }

    /// Frames rendered so far.
    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn sample_rate(&self) -> u32 {
        self.opts.sample_rate
    }

    pub fn project(&self) -> &MixProject {
        &self.project
    }

    /// Clips not loaded yet, in the order they will be.
    pub fn upcoming(&self) -> impl Iterator<Item = &Clip> {
        self.order[self.next..].iter().map(|&i| &self.project.clips[i])
    }

    fn send(&mut self, c: Command) {
        let _ = self.ctl.send(c);
    }

    /// Loads the clips that start within the preload window. Returns a clip whose track
    /// is not available yet.
    fn load_due(&mut self, resolve: &mut dyn FnMut(&Clip) -> Resolve) -> Result<Option<u64>, RenderError> {
        let srf = self.opts.sample_rate as f64;
        let now_s = self.pos as f64 / srf;
        while self.next < self.order.len() {
            let ci = self.order[self.next];
            let c = &self.project.clips[ci];
            let start_s = self.project.tempo.seconds_at_beat(c.start);
            if start_s - now_s > PRELOAD_SECONDS {
                break;
            }
            let lane = c.lane as usize % 4;
            // The lane must be free (previous clip ended) before loading.
            if self.slots[lane].as_ref().is_some_and(|s| !s.stopped) {
                break;
            }
            let r = match resolve(c) {
                Resolve::Ready(r) => r,
                Resolve::Missing => return Err(RenderError::MissingTrack { clip: c.id, title: c.track.title.clone() }),
                Resolve::Later => return Ok(Some(c.id)),
            };
            let c = c.clone();
            let id = DeckId(lane as u8);
            let grid = r.grid.resampled(r.audio.sample_rate);
            let mut dt = DeckTrack::new(r.audio.clone(), Arc::new(grid.clone()));
            dt.auto_gain_db = r.auto_gain_db;
            self.send(Command::Deck(id, DeckCommand::Load(Box::new(dt))));
            self.send(Command::Deck(id, DeckCommand::SetKeylock(c.keylock)));
            self.send(Command::Deck(id, DeckCommand::SetKeyShift(c.key_shift)));
            self.send(Command::Mixer(MixerCommand::SetTrim(id, c.gain_db)));
            if let Some(fx) = c.fx {
                let kind = mixit_dsp::fx::FxKind::from_index(fx.kind);
                let e = mixit_dsp::fx::create(kind, self.opts.sample_rate as f32);
                self.send(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetEffect(e)));
                self.send(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetBeats(fx.beats)));
                self.send(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetMix(0.0)));
                self.send(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetOn(false)));
            } else {
                self.send(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetEffect(None)));
            }
            let src_frame = grid.frame_at(c.source_start);
            self.send(Command::Deck(id, DeckCommand::Seek(src_frame)));
            let rate = self.project.tempo.bpm_at_beat(c.start) / grid.bpm_at(src_frame);
            self.send(Command::Deck(id, DeckCommand::SetTempo(rate - 1.0)));
            let start_frame = (self.project.tempo.seconds_at_beat(c.start) * srf).round().max(self.pos as f64) as u64;
            let _ = self.ctl.send_at(start_frame, Command::Deck(id, DeckCommand::Play));
            self.slots[lane] = Some(Slot { clip: ci, started: false, stopped: false, grid });
            self.next += 1;
        }
        Ok(None)
    }

    /// Per-block control of every playing clip: automation and phase-locked tempo.
    fn steer(&mut self, n: usize) {
        let srf = self.opts.sample_rate as f64;
        let now_s = self.pos as f64 / srf;
        let beat = self.project.tempo.beat_at_seconds(now_s);
        let b = self.project.tempo.beat_at_seconds(now_s + 0.5 * n as f64 / srf);
        let mut cmds: Vec<Command> = Vec::new();
        for (lane, slot) in self.slots.iter_mut().enumerate() {
            let Some(s) = slot else { continue };
            if s.stopped {
                continue;
            }
            let c = &self.project.clips[s.clip];
            let id = DeckId(lane as u8);
            if beat >= c.start {
                s.started = true;
            }
            if beat >= c.end() {
                cmds.push(Command::Deck(id, DeckCommand::Pause));
                cmds.push(Command::Mixer(MixerCommand::SetFader(id, 0.0)));
                s.stopped = true;
                continue;
            }
            // Automation, evaluated at the block's midpoint.
            let ab = if s.started { b } else { c.start };
            cmds.push(Command::Mixer(MixerCommand::SetFader(id, c.value_at(Param::Volume, ab))));
            for (band, p) in [Param::EqLow, Param::EqMid, Param::EqHigh].into_iter().enumerate() {
                cmds.push(Command::Mixer(MixerCommand::SetEq(id, band, c.value_at(p, ab))));
            }
            cmds.push(Command::Mixer(MixerCommand::SetFilter(id, c.value_at(Param::Filter, ab))));
            if c.fx.is_some() {
                let mix = c.value_at(Param::FxMix, ab);
                cmds.push(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetOn(mix > 0.001)));
                cmds.push(Command::Fx(FxTarget::Deck(id), 0, FxCommand::SetMix(mix)));
            }
            if s.started {
                // Tempo from the map and the grid, with phase correction.
                let expected = s.grid.frame_at(c.source_beat(b));
                let actual = self.engine.deck(id).map(|d| d.audible()).unwrap_or(expected);
                let fpb = s.grid.frames_per_beat_at(expected);
                let err_beats = (expected - actual) / fpb;
                let base = self.project.tempo.bpm_at_beat(b) / s.grid.bpm_at(expected);
                let corr = (err_beats * 0.5).clamp(-0.02, 0.02);
                cmds.push(Command::Deck(id, DeckCommand::SetTempo(base * (1.0 + corr) - 1.0)));
            }
        }
        for c in cmds {
            self.send(c);
        }
    }

    /// Renders up to `out.len() / 2` frames of interleaved stereo into `out`. Stops early
    /// when a clip's track is needed ([`Resolve::Later`]) or the project ends.
    pub fn render(&mut self, out: &mut [f32], resolve: &mut dyn FnMut(&Clip) -> Resolve) -> Result<Step, RenderError> {
        let want = out.len() / 2;
        let mut done = 0usize;
        while done < want && self.pos < self.total {
            if let Some(need) = self.load_due(resolve)? {
                return Ok(Step { frames: done, need: Some(need), done: false });
            }
            let n = self.opts.block.min(self.total - self.pos).min(want - done);
            self.steer(n);
            self.engine.process(&mut out[done * 2..(done + n) * 2], &mut self.cue[..n * 2]);
            self.ctl.collect_trash();
            let _ = self.ctl.events().count();
            self.pos += n;
            done += n;
        }
        Ok(Step { frames: done, need: None, done: self.pos >= self.total })
    }
}

/// Renders the whole project to interleaved stereo. `progress(fraction)` is called per
/// piece; `cancelled()` is checked as often.
pub fn render_all(
    project: &MixProject,
    opts: &RenderOptions,
    stretcher: StretcherFactory,
    mut resolve: impl FnMut(&Clip) -> Option<ResolvedTrack>,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(f32),
) -> Result<Vec<f32>, RenderError> {
    let mut r = ProjectRenderer::new(project.clone(), opts.clone(), stretcher);
    let total = r.total_frames();
    let mut out = vec![0.0f32; total * 2];
    let piece = opts.block.max(1) * 16;
    let mut res = |c: &Clip| match resolve(c) {
        Some(t) => Resolve::Ready(t),
        None => Resolve::Missing,
    };
    loop {
        if cancelled() {
            return Err(RenderError::Cancelled);
        }
        let pos = r.position();
        let end = (pos + piece).min(total);
        let step = r.render(&mut out[pos * 2..end * 2], &mut res)?;
        progress(r.position() as f32 / total.max(1) as f32);
        if step.done || (step.frames == 0 && step.need.is_none()) {
            break;
        }
    }
    Ok(out)
}
