//! Plays a [`MixProject`] through the engine offline, so a bounced mix sounds exactly like
//! the live decks (same time-stretch, EQ, filter, FX and limiter). Used by the native
//! host for rendering and by the browser build for preview and render.
//!
//! Each clip plays on the deck of its lane. Clips are loaded a second before they
//! start, cued to their source beat and started on their exact frame. While a clip
//! plays, its tempo is set from the master tempo map and the track's beatgrid every
//! block, with a gentle correction that keeps it phase-locked to the timeline, and its
//! automation lanes drive the mixer (fader, EQ, filter, effect, pan and the reverb and
//! echo sends). Each lane's studio strip, the master strip and the shared returns come
//! from the project. A reversed clip plays its range of the track backwards.
//!
//! [`ProjectRenderer`] renders in pieces and asks for each track only when its clip is
//! about to start, so a caller can stream the output and fetch audio lazily (the
//! browser cannot hold a whole set's audio in memory at once).

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId, Quantize};
use mixit_dsp::stretch::TimeStretch;
use mixit_project::{Clip, MixProject, Param};

use crate::commands::{FxCommand, FxTarget, GlobalCommand};
use crate::mixer::ReturnParam;
use crate::view::studio_settings;
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
    /// Render exactly this many seconds instead of the project's length plus the tail
    /// (stems of one project all get the same length, so they line up).
    pub length_seconds: Option<f64>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        RenderOptions {
            sample_rate: 44_100,
            tail: 2.0,
            block: 256,
            limiter: true,
            auto_gain: true,
            length_seconds: None,
        }
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
        let r = project.returns;
        send(Command::Mixer(MixerCommand::SetReturn(0, ReturnParam::Level(r.space_level_db))));
        send(Command::Mixer(MixerCommand::SetReturn(0, ReturnParam::Param(0, r.space_size))));
        send(Command::Mixer(MixerCommand::SetReturn(1, ReturnParam::Level(r.echo_level_db))));
        send(Command::Mixer(MixerCommand::SetReturn(1, ReturnParam::Param(0, r.echo_feedback))));
        send(Command::Mixer(MixerCommand::SetReturn(1, ReturnParam::Beats(r.echo_beats))));
        if let Some(m) = &project.master_strip {
            send(Command::Mixer(MixerCommand::SetStudio(None, Box::new(studio_settings(m)))));
        }
        for d in 0..4u8 {
            let id = DeckId(d);
            if let Some(st) = project.strips.get(d as usize).filter(|s| !s.is_transparent()) {
                send(Command::Mixer(MixerCommand::SetStudio(Some(id), Box::new(studio_settings(st)))));
            }
            send(Command::Deck(id, DeckCommand::SetTempoRange(1.0)));
            send(Command::Deck(id, DeckCommand::SetStretcher(stretcher(sr))));
            send(Command::Mixer(MixerCommand::SetFader(id, 0.0)));
        }
        let seconds = opts.length_seconds.unwrap_or(project.length_seconds() + opts.tail);
        let total = (seconds.max(0.0) * sr as f64).ceil() as usize;
        // Muted lanes (and the others while a lane is soloed) are left out.
        let mut order: Vec<usize> =
            (0..project.clips.len()).filter(|&i| project.lane_heard(project.clips[i].lane)).collect();
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
            let src_frame = grid.frame_at(c.source_beat(c.start));
            self.send(Command::Deck(id, DeckCommand::Reverse(c.reverse)));
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
            cmds.push(Command::Mixer(MixerCommand::SetPan(id, c.value_at(Param::Pan, ab))));
            cmds.push(Command::Mixer(MixerCommand::SetSend(id, 0, c.value_at(Param::Space, ab))));
            cmds.push(Command::Mixer(MixerCommand::SetSend(id, 1, c.value_at(Param::Echo, ab))));
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
                // A reversed clip runs down the track, so being behind means a higher frame.
                let err_beats = (if c.reverse { actual - expected } else { expected - actual }) / fpb;
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

/// What [`normalize_loudness`] did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoudnessFix {
    /// Integrated loudness before (LUFS).
    pub measured_lufs: f64,
    /// Gain applied (dB).
    pub gain_db: f64,
    /// The gain had to stop short of the target to keep peaks under the ceiling.
    pub peak_limited: bool,
}

/// Turns interleaved stereo up or down so its integrated loudness (EBU R128) meets
/// `target_lufs`, without letting the sample peak pass `ceiling_db` (dBFS). Silence is
/// left alone.
pub fn normalize_loudness(audio: &mut [f32], sample_rate: u32, target_lufs: f64, ceiling_db: f64) -> LoudnessFix {
    let mut m = mixit_dsp::meters::LoudnessMeter::new(sample_rate as f32);
    let mut l = vec![0.0f32; 4096];
    let mut r = vec![0.0f32; 4096];
    let mut peak = 0.0f32;
    for chunk in audio.chunks(8192) {
        let n = chunk.len() / 2;
        for i in 0..n {
            l[i] = chunk[i * 2];
            r[i] = chunk[i * 2 + 1];
            peak = peak.max(l[i].abs()).max(r[i].abs());
        }
        m.process(&l[..n], &r[..n]);
    }
    let measured = m.integrated();
    if !measured.is_finite() || measured < -70.0 || peak <= 0.0 {
        return LoudnessFix { measured_lufs: measured, gain_db: 0.0, peak_limited: false };
    }
    let want = target_lufs - measured;
    let room = ceiling_db - 20.0 * (peak as f64).log10();
    let gain_db = want.min(room);
    let g = 10f64.powf(gain_db / 20.0) as f32;
    for x in audio.iter_mut() {
        *x *= g;
    }
    LoudnessFix { measured_lufs: measured, gain_db, peak_limited: want > room + 1e-9 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_dsp::stretch::ResampleStretch;
    use mixit_project::LaneState;
    use mixit_project::{Curve, Point, StudioDto};

    const SR: u32 = 22_050;
    const BPM: f64 = 120.0;

    /// A 440 Hz tone that gets louder over 32 beats (16 s), so the direction of play shows.
    fn ramp() -> ResolvedTrack {
        let n = (16.0 * SR as f64) as usize;
        let mut data = Vec::with_capacity(n * 2);
        for i in 0..n {
            let a = 0.05 + 0.6 * i as f32 / n as f32;
            let v = a * (std::f32::consts::TAU * 440.0 * i as f32 / SR as f32).sin();
            data.extend([v, v]);
        }
        ResolvedTrack {
            audio: Arc::new(TrackAudio::new(SR, data)),
            grid: Beatgrid::constant(SR, BPM, 0.0),
            auto_gain_db: 0.0,
        }
    }

    fn project(f: impl FnOnce(&mut MixProject, &mut Clip)) -> MixProject {
        let mut p = MixProject::new("t", BPM);
        let mut c = mixit_project::Clip {
            id: 0,
            track: Default::default(),
            lane: 0,
            start: 0.0,
            length: 16.0,
            source_start: 8.0,
            key_shift: 0.0,
            keylock: false,
            gain_db: 0.0,
            lanes: vec![],
            fx: None,
            name: String::new(),
            reverse: false,
        };
        f(&mut p, &mut c);
        p.add_clip(c);
        p
    }

    fn render(p: &MixProject) -> Vec<f32> {
        let opts = RenderOptions { sample_rate: SR, tail: 1.0, limiter: false, auto_gain: false, ..Default::default() };
        render_all(p, &opts, Box::new(|_| Box::new(ResampleStretch::new())), |_| Some(ramp()), || false, |_| {})
            .unwrap()
    }

    /// RMS of each channel over a stretch of seconds.
    fn rms(out: &[f32], from: f64, to: f64) -> (f32, f32) {
        let (a, b) = ((from * SR as f64) as usize, (to * SR as f64) as usize);
        let s = &out[a * 2..b * 2];
        let n = (b - a) as f32;
        let l = (s.iter().step_by(2).map(|x| x * x).sum::<f32>() / n).sqrt();
        let r = (s.iter().skip(1).step_by(2).map(|x| x * x).sum::<f32>() / n).sqrt();
        (l, r)
    }

    #[test]
    fn normalizing_meets_the_target_or_stops_at_the_ceiling() {
        let mut a = render(&project(|_, _| {}));
        let fix = normalize_loudness(&mut a, SR, -20.0, -1.0);
        assert!(!fix.peak_limited);
        let again = normalize_loudness(&mut a.clone(), SR, -20.0, -1.0);
        assert!((again.measured_lufs + 20.0).abs() < 0.2, "{again:?}");
        // A loud target on a peaky signal is held back by the ceiling.
        let loud = normalize_loudness(&mut a, SR, 0.0, -1.0);
        assert!(loud.peak_limited);
        let peak = a.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((20.0 * peak.log10() + 1.0).abs() < 0.01, "peak {peak}");
        let mut silence = vec![0.0; 44_100];
        assert_eq!(normalize_loudness(&mut silence, SR, -14.0, -1.0).gain_db, 0.0);
    }

    #[test]
    fn stems_line_up_with_the_full_render() {
        let mut p = project(|_, _| {});
        let mut c2 = p.clips[0].clone();
        c2.lane = 1;
        c2.start = 8.0;
        p.add_clip(c2);
        let opts = |len| RenderOptions {
            sample_rate: SR,
            tail: 1.0,
            limiter: false,
            auto_gain: false,
            length_seconds: len,
            ..Default::default()
        };
        let go = |p: &MixProject, len| {
            render_all(
                p,
                &opts(len),
                Box::new(|_| Box::new(ResampleStretch::new())),
                |_| Some(ramp()),
                || false,
                |_| {},
            )
            .unwrap()
        };
        let full = go(&p, None);
        let a = go(&p.lane_only(0), Some(full.len() as f64 / 2.0 / SR as f64));
        let b = go(&p.lane_only(1), Some(full.len() as f64 / 2.0 / SR as f64));
        assert_eq!(a.len(), full.len());
        assert_eq!(b.len(), full.len());
        // Lane A stops at 8 s, lane B plays on: together they make the mix.
        assert!(rms(&a, 9.0, 11.0).0 < 1e-4);
        assert!(rms(&b, 9.0, 11.0).0 > 0.05);
        let sum: Vec<f32> = a.iter().zip(&b).map(|(x, y)| x + y).collect();
        let err = rms(&sum.iter().zip(&full).map(|(x, y)| x - y).collect::<Vec<_>>(), 1.0, 10.0).0;
        assert!(err < 0.01 * rms(&full, 1.0, 10.0).0.max(1e-3), "stems differ from the mix by {err}");
    }

    #[test]
    fn muted_and_soloed_lanes() {
        let mut p = project(|_, _| {});
        let mut c2 = p.clips[0].clone();
        c2.lane = 1;
        c2.start = 8.0;
        p.add_clip(c2);
        let opts = RenderOptions {
            sample_rate: SR,
            tail: 1.0,
            limiter: false,
            auto_gain: false,
            length_seconds: Some(12.0),
            ..Default::default()
        };
        let go = |p: &MixProject| {
            render_all(p, &opts, Box::new(|_| Box::new(ResampleStretch::new())), |_| Some(ramp()), || false, |_| {})
                .unwrap()
        };
        let only_b = go(&p.lane_only(1));
        // Muting A leaves B; soloing B does the same; muting both is silence.
        p.lane_states = vec![LaneState { muted: true, solo: false }];
        assert_eq!(go(&p), only_b);
        p.lane_states = vec![LaneState::default(), LaneState { muted: false, solo: true }];
        assert_eq!(go(&p), only_b);
        // The stem of a lane ignores what is muted in the mix.
        assert!(rms(&go(&p.lane_only(0)), 1.0, 3.0).0 > 0.05);
        p.lane_states = vec![LaneState { muted: true, solo: false }, LaneState { muted: true, solo: false }];
        assert!(rms(&go(&p), 0.5, 11.0).0 < 1e-6);
    }

    #[test]
    fn a_reversed_clip_plays_its_range_backwards() {
        let fwd = render(&project(|_, _| {}));
        let rev = render(&project(|_, c| c.reverse = true));
        // Forward the tone grows over the clip; reversed it shrinks, over the same range.
        let (f0, f1) = (rms(&fwd, 0.5, 1.5).0, rms(&fwd, 6.5, 7.5).0);
        let (r0, r1) = (rms(&rev, 0.5, 1.5).0, rms(&rev, 6.5, 7.5).0);
        assert!(f1 > f0 * 1.3, "forward {f0} → {f1}");
        assert!(r0 > r1 * 1.3, "reversed {r0} → {r1}");
        // Reversed starts about where forward ends.
        assert!((r0 / f1 - 1.0).abs() < 0.2, "{r0} vs {f1}");
    }

    #[test]
    fn pan_automation_and_lane_strips_are_heard() {
        let panned = render(&project(|_, c| {
            c.lane_mut(Param::Pan).set_point(Point { beat: 0.0, value: -1.0, curve: Curve::Hold });
        }));
        let (l, r) = rms(&panned, 2.0, 6.0);
        assert!(l > r * 4.0, "pan left: {l} {r}");

        let plain = render(&project(|_, _| {}));
        let quiet = render(&project(|p, _| {
            p.strips = vec![StudioDto { output_db: -12.0, ..StudioDto::default() }];
        }));
        let ratio = rms(&quiet, 2.0, 6.0).0 / rms(&plain, 2.0, 6.0).0;
        assert!((ratio - 0.251).abs() < 0.03, "strip output −12 dB gave ×{ratio}");
    }

    #[test]
    fn the_reverb_send_rings_on_after_the_clip() {
        let dry = render(&project(|p, c| {
            p.returns.space_level_db = 0.0;
            c.length = 12.0;
        }));
        let wet = render(&project(|p, c| {
            p.returns.space_level_db = 0.0;
            c.lane_mut(Param::Space).set_point(Point { beat: 0.0, value: 1.0, curve: Curve::Hold });
            // Stop the clip early so the tail is in the render.
            c.length = 12.0;
        }));
        let after = |o: &[f32]| rms(o, 6.1, 6.6).0;
        assert!(after(&wet) > 1e-3, "no reverb tail");
        assert!(after(&dry) < 1e-4, "dry clip should be silent after it ends: {}", after(&dry));
    }
}
