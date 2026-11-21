//! A deck: transport, cueing, loops, slip, scratch, tempo, sync and key lock.
//!
//! ## Positions
//!
//! The reader's `head` is where the deck reads the track. On the direct (vinyl) path it is
//! also what the listener hears. On the key-lock path the time-stretcher delays its output,
//! so the head runs ahead of the audible position by the stretcher latency; every user
//! action (cue, loop in, sync phase) works on [`Deck::audible`], and the head is derived
//! from it. While the deck is stopped the head always equals the audible position.
//!
//! ## Discontinuities
//!
//! Every jump is covered: on the direct path by a short equal-power crossfade between the
//! old and new read positions (the old stream keeps playing past the jump while it fades),
//! on the key-lock path by a 3 ms dip while the stretcher is re-primed at the new place.
//! Loop wraps on the key-lock path are crossfaded in the stretcher's input, so they stay
//! seamless and sample-accurate.

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId};
use mixit_dsp::interp::SincTable;
use mixit_dsp::ramp::MicroFade;
use mixit_dsp::stretch::TimeStretch;
use mixit_dsp::util::equal_power;

use crate::commands::{DeckCommand, EndBehaviour, HotCueMode, SyncMode};
use crate::kernels::PlaybackKernels;
use crate::telemetry::{DeckTelemetry, Event, EventSink, LoopInfo};
use crate::track::{CueKind, DeckTrack, HotCue};
use crate::trash::{Trash, TrashBin};

/// Largest number of frames a deck renders per call (the engine splits host blocks).
pub const BLOCK: usize = 256;
/// Momentary pitch bend at full nudge.
pub const NUDGE_AMOUNT: f64 = 0.03;
/// Sync may bend the tempo by at most this much to pull the phase in.
pub const MAX_SYNC_CORRECTION: f64 = 0.03;
/// Time constant for pulling the phase in (seconds).
const SYNC_PULL_S: f64 = 0.4;
/// Key lock is used between these speeds; outside them (scratch, brake) playback is vinyl.
pub const STRETCH_MIN_RATE: f64 = 0.5;
pub const STRETCH_MAX_RATE: f64 = 2.0;
/// Seconds of stretcher pre-roll the deck can hold.
const PREROLL_SECONDS: f64 = 0.4;
/// Jump crossfade length (seconds).
const JUMP_XFADE_S: f64 = 0.004;
const TRANSPORT_FADE_S: f64 = 0.003;
const DIP_S: f64 = 0.003;
/// Scratch velocity smoothing (seconds).
const SCRATCH_SMOOTH_S: f64 = 0.006;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Loop {
    pub start: f64,
    pub end: f64,
    pub active: bool,
}

impl Loop {
    #[inline]
    pub fn len(&self) -> f64 {
        self.end - self.start
    }
}

/// Musical timing shared by all decks for one block.
#[derive(Clone, Copy, Debug)]
pub struct DeckEnv {
    /// Quantum in beats when quantise is on.
    pub quantize: Option<f64>,
    /// Master clock tempo and beat position at the start of the block.
    pub clock_bpm: f64,
    pub clock_beat: f64,
    /// True when the clock is driven by a playing deck or the internal clock is running.
    pub clock_running: bool,
    /// True when this deck is the master (so it never follows).
    pub is_master: bool,
}

impl Default for DeckEnv {
    fn default() -> Self {
        DeckEnv { quantize: Some(1.0), clock_bpm: 120.0, clock_beat: 0.0, clock_running: false, is_master: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Path {
    Direct,
    Stretch,
}

/// Fractional-position reader with loop wrapping and jump crossfades.
#[derive(Clone, Debug)]
struct Reader {
    head: f64,
    xf_from: f64,
    xf_left: u32,
    xf_len: u32,
    lp: Option<Loop>,
}

impl Reader {
    fn new() -> Reader {
        Reader { head: 0.0, xf_from: 0.0, xf_left: 0, xf_len: 1, lp: None }
    }

    /// Starts a crossfade from the current head to `to`.
    fn jump(&mut self, to: f64, xf: u32) {
        if self.xf_left > 0 {
            // A jump during a crossfade: fade from wherever is loudest now.
            let t = 1.0 - self.xf_left as f32 / self.xf_len as f32;
            if t < 0.5 {
                self.head = to;
                return;
            }
        }
        self.xf_from = self.head;
        self.xf_len = xf.max(1);
        self.xf_left = self.xf_len;
        self.head = to;
    }

    fn loop_xfade(&self, xf: u32) -> u32 {
        match self.lp {
            Some(l) => xf.min((l.len() * 0.25) as u32).max(1),
            None => xf,
        }
    }

    /// Reads one frame at the head and advances by `step` (negative for reverse).
    #[inline]
    fn step(&mut self, data: &[f32], frames: usize, k: &SincTable, step: f64, xf: u32) -> (f32, f32) {
        let (mut l, mut r) = k.read_stereo(data, frames, self.head);
        if self.xf_left > 0 {
            let (ol, or) = k.read_stereo(data, frames, self.xf_from);
            let t = 1.0 - self.xf_left as f32 / self.xf_len as f32;
            let (go, gi) = equal_power(t);
            l = l * gi + ol * go;
            r = r * gi + or * go;
            self.xf_from += step;
            self.xf_left -= 1;
        }
        self.head += step;
        if let Some(lp) = self.lp {
            if lp.active && lp.len() > 1.0 {
                if step >= 0.0 && self.head >= lp.end {
                    let to = lp.start + (self.head - lp.start).rem_euclid(lp.len());
                    let x = self.loop_xfade(xf);
                    self.jump(to, x);
                } else if step < 0.0 && self.head < lp.start && self.head > lp.start - lp.len() * 0.5 {
                    let to = lp.end - (lp.start - self.head).rem_euclid(lp.len());
                    let x = self.loop_xfade(xf);
                    self.jump(to, x);
                }
            }
        }
        (l, r)
    }
}

#[derive(Clone, Copy, Debug)]
struct Ramp {
    total: f64,
    left: f64,
}

pub struct Deck {
    pub id: DeckId,
    sr: f64,
    kernels: Arc<PlaybackKernels>,
    track: Option<Box<DeckTrack>>,
    reader: Reader,
    xf_frames: u32,

    // Transport.
    playing: bool,
    running: bool,
    fade: MicroFade,
    /// Whether the previous block advanced (rate ramps only between moving blocks).
    was_moving: bool,
    end_behaviour: EndBehaviour,
    ended: bool,
    /// Where to park the head once the stop fade has closed.
    park: Option<f64>,

    // Tempo.
    tempo: f64,
    range: f64,
    nudge: f64,
    rate: f64,
    slip_rate: f64,
    brake: Option<Ramp>,
    spin: Option<Ramp>,

    // Sync.
    sync: bool,
    sync_mode: SyncMode,
    sync_mult: f64,
    phase_offset: f64,
    phase_error: f64,

    // Key.
    keylock: bool,
    key_shift: f32,
    stretcher: Option<Box<dyn TimeStretch>>,
    path: Path,
    path_fade: MicroFade,
    primed: bool,
    stretch_in: Vec<f32>,
    stretch_out: Vec<f32>,
    stretch_frac: f64,
    dip: MicroFade,
    pending_seek: Option<f64>,

    // Cues and loops.
    cue_preview: bool,
    hot_mode: HotCueMode,
    hot_held: Option<u8>,
    hot_preview: bool,
    loop_in: Option<f64>,
    roll: bool,
    roll_slip_was: bool,

    // Slip, reverse, scratch.
    slip: bool,
    ghost: f64,
    reverse: bool,
    censor: bool,
    censor_slip_was: bool,
    scratching: bool,
    scratch_target: f64,
    scratch_vel: f64,

    /// Rendered audio of the last block (pre-mixer).
    pub out_l: Vec<f32>,
    pub out_r: Vec<f32>,
}

impl Deck {
    /// Allocates: build on a control thread.
    pub fn new(id: DeckId, sample_rate: u32, kernels: Arc<PlaybackKernels>) -> Deck {
        let sr = sample_rate as f64;
        let pre = (PREROLL_SECONDS * sr) as usize;
        let stretch_cap = pre.max(BLOCK * STRETCH_MAX_RATE as usize + 8);
        Deck {
            id,
            sr,
            kernels,
            track: None,
            reader: Reader::new(),
            xf_frames: (JUMP_XFADE_S * sr) as u32,
            playing: false,
            running: false,
            fade: MicroFade::new((TRANSPORT_FADE_S * sr) as u32, false),
            was_moving: false,
            end_behaviour: EndBehaviour::Stop,
            ended: false,
            park: None,
            tempo: 0.0,
            range: 0.08,
            nudge: 0.0,
            rate: 0.0,
            slip_rate: 0.0,
            brake: None,
            spin: None,
            sync: false,
            sync_mode: SyncMode::Beat,
            sync_mult: 1.0,
            phase_offset: 0.0,
            phase_error: 0.0,
            keylock: false,
            key_shift: 0.0,
            stretcher: None,
            path: Path::Direct,
            path_fade: MicroFade::new((0.004 * sr) as u32, true),
            primed: false,
            stretch_in: vec![0.0; stretch_cap * 2],
            stretch_out: vec![0.0; BLOCK * 2],
            stretch_frac: 0.0,
            dip: MicroFade::new((DIP_S * sr) as u32, true),
            pending_seek: None,
            cue_preview: false,
            hot_mode: HotCueMode::Jump,
            hot_held: None,
            hot_preview: false,
            loop_in: None,
            roll: false,
            roll_slip_was: false,
            slip: false,
            ghost: 0.0,
            reverse: false,
            censor: false,
            censor_slip_was: false,
            scratching: false,
            scratch_target: 0.0,
            scratch_vel: 0.0,
            out_l: vec![0.0; BLOCK],
            out_r: vec![0.0; BLOCK],
        }
    }

    // ---------------------------------------------------------------------------------
    // Queries
    // ---------------------------------------------------------------------------------

    pub fn is_loaded(&self) -> bool {
        self.track.is_some()
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    /// True while the deck produces sound (playing, fading or scratching).
    pub fn is_audible(&self) -> bool {
        self.track.is_some() && (self.running || self.scratching) && !self.fade.is_silent()
    }

    pub fn sync_enabled(&self) -> bool {
        self.sync
    }

    pub fn track(&self) -> Option<&DeckTrack> {
        self.track.as_deref()
    }

    pub fn grid(&self) -> Option<&Beatgrid> {
        self.track.as_ref().map(|t| &*t.grid)
    }

    pub fn auto_gain_db(&self) -> f32 {
        self.track.as_ref().map(|t| t.auto_gain_db).unwrap_or(0.0)
    }

    fn frames(&self) -> f64 {
        self.track.as_ref().map(|t| t.audio.frames() as f64).unwrap_or(0.0)
    }

    fn latency(&self) -> f64 {
        match &self.stretcher {
            Some(s) if self.path == Path::Stretch && self.primed => {
                s.input_latency() as f64 + s.output_latency() as f64 * self.rate.abs().max(0.25)
            }
            _ => 0.0,
        }
    }

    /// The position the listener hears (track frames).
    pub fn audible(&self) -> f64 {
        let lat = self.latency();
        let mut a = self.reader.head - lat;
        if lat > 0.0 {
            if let Some(lp) = self.reader.lp {
                if lp.active && a < lp.start && self.reader.head >= lp.start && self.reader.head < lp.end {
                    a += lp.len();
                }
            }
        }
        a
    }

    /// Track tempo at the audible position.
    pub fn base_bpm(&self) -> f64 {
        self.grid().map(|g| g.bpm_at(self.audible())).unwrap_or(120.0)
    }

    /// Effective tempo (track tempo × playback rate).
    pub fn effective_bpm(&self) -> f64 {
        self.base_bpm() * self.rate.abs()
    }

    /// Tempo the deck would play at from its tempo fader alone.
    pub fn fader_bpm(&self) -> f64 {
        self.base_bpm() * self.fader_rate()
    }

    /// Beat position at the audible point.
    pub fn beat(&self) -> f64 {
        self.grid().map(|g| g.beat_at(self.audible())).unwrap_or(0.0)
    }

    /// Rate the tempo fader asks for (before sync and bends).
    fn fader_rate(&self) -> f64 {
        1.0 + self.tempo * self.range
    }

    fn diverted(&self) -> bool {
        self.reader.lp.is_some_and(|l| l.active) || self.reverse || self.scratching || self.roll || self.censor
    }

    // ---------------------------------------------------------------------------------
    // Positioning
    // ---------------------------------------------------------------------------------

    fn advancing(&self) -> bool {
        self.running || self.scratching
    }

    /// Moves the audible position to `target`, click-free.
    fn jump_to(&mut self, target: f64) {
        let target = target.max(-self.sr * 10.0);
        self.ended = false;
        if !self.advancing() {
            self.reader.head = target;
            self.reader.xf_left = 0;
            self.primed = false;
            return;
        }
        match self.path {
            Path::Direct => self.reader.jump(target, self.xf_frames),
            Path::Stretch => {
                self.pending_seek = Some(target);
                self.dip.fade_out();
            }
        }
    }

    /// Re-primes the stretcher so its output starts at audible position `target`.
    fn prime_stretcher(&mut self, target: f64) {
        let rate = self.rate.abs().clamp(STRETCH_MIN_RATE, STRETCH_MAX_RATE);
        let (Some(st), Some(track)) = (self.stretcher.as_mut(), self.track.as_ref()) else { return };
        let lat = st.input_latency() as f64 + st.output_latency() as f64 * rate;
        let head = target + lat;
        let cap = self.stretch_in.len() / 2;
        let pre = (((st.input_latency() + st.output_latency()) * 5 / 4).max(64)).min(cap);
        let data = &track.audio.data;
        let frames = track.audio.frames();
        let k = self.kernels.for_speed(1.0);
        let start = head - pre as f64;
        for j in 0..pre {
            let (l, r) = k.read_stereo(data, frames, start + j as f64);
            self.stretch_in[j * 2] = l;
            self.stretch_in[j * 2 + 1] = r;
        }
        st.reset();
        st.set_transpose(Self::transpose_for(self.keylock, self.key_shift, rate));
        st.seek(&self.stretch_in[..pre * 2], rate);
        self.reader.head = head;
        self.reader.xf_left = 0;
        self.stretch_frac = 0.0;
        self.primed = true;
    }

    fn transpose_for(keylock: bool, shift: f32, rate: f64) -> f32 {
        let base = if keylock { 1.0 } else { rate as f32 };
        base * 2f32.powf(shift / 12.0)
    }

    /// Quantised jump target: lands on `target`'s beat with the current phase kept.
    fn phase_kept(&self, target: f64, q: f64) -> f64 {
        let Some(g) = self.grid() else { return target };
        let now = g.beat_at(self.audible());
        let tb = g.beat_at(target);
        let offset = (now - tb).rem_euclid(q);
        // Land within the quantum after the target, keeping the phase.
        let mut b = tb + offset;
        if offset > q - 1e-6 {
            b -= q;
        }
        g.frame_at(b)
    }

    fn quantized_jump(&mut self, target: f64, env: &DeckEnv) {
        match env.quantize {
            Some(q) if self.running && self.track.is_some() => {
                let t = self.phase_kept(target, q.max(1.0 / 32.0));
                self.jump_to(t)
            }
            _ => self.jump_to(target),
        }
    }

    fn snap(&self, frame: f64, env: &DeckEnv) -> f64 {
        match (env.quantize, self.grid()) {
            (Some(q), Some(g)) => g.nearest_boundary(frame, q.min(1.0)),
            _ => frame,
        }
    }

    fn slip_return(&mut self) {
        if self.slip && self.running {
            let g = self.ghost;
            self.jump_to(g);
        }
    }

    // ---------------------------------------------------------------------------------
    // Transport
    // ---------------------------------------------------------------------------------

    fn start(&mut self, env: &DeckEnv) {
        if self.track.is_none() {
            return;
        }
        if let Some(p) = self.park.take() {
            // Restarting before the stop fade finished: go to the parked point now.
            self.jump_to(p);
        }
        if self.ended {
            // Pressing play at the end restarts from the cue point (like a CDJ).
            let cue = self.track.as_ref().map(|t| t.cue).unwrap_or(0.0);
            self.reader.head = cue;
            self.ended = false;
        }
        if !self.running && self.sync && self.sync_mode != SyncMode::Tempo && env.clock_running && !env.is_master {
            // Start in phase with the master.
            let err = self.phase_error_at(env, self.audible());
            if let Some(g) = self.grid() {
                let b = g.beat_at(self.reader.head) + err;
                self.reader.head = g.frame_at(b);
            }
        }
        self.playing = true;
        self.running = true;
        self.brake = None;
        self.fade.fade_in();
        self.ghost = self.audible();
    }

    fn stop(&mut self) {
        self.playing = false;
        self.cue_preview = false;
        self.hot_preview = false;
        if !self.scratching {
            self.fade.fade_out();
        }
    }

    /// Called once the transport fade has closed.
    fn halt(&mut self) {
        let a = self.audible();
        self.running = false;
        self.reader.head = a;
        self.reader.xf_left = 0;
        self.primed = false;
        self.pending_seek = None;
        self.dip.set_open(true);
        self.spin = None;
        if let Some(p) = self.park.take() {
            self.reader.head = p;
        }
    }

    /// Stops (with the usual short fade) and then parks the head at `frame`.
    fn pause_at(&mut self, frame: f64) {
        self.stop();
        self.park = Some(frame);
        if !self.running {
            self.halt();
        }
    }

    // ---------------------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------------------

    pub fn handle(&mut self, cmd: DeckCommand, env: &DeckEnv, trash: &mut TrashBin, ev: &mut EventSink) {
        use DeckCommand as C;
        let id = self.id;
        match cmd {
            C::Load(t) => {
                let token = t.token;
                let old = self.track.replace(t);
                trash.put_opt(old, Trash::Track);
                let cue = self.track.as_ref().map(|t| t.cue).unwrap_or(0.0);
                self.playing = false;
                self.running = false;
                self.fade.set_open(false);
                self.reader = Reader::new();
                self.reader.head = cue;
                self.primed = false;
                self.pending_seek = None;
                self.dip.set_open(true);
                self.loop_in = None;
                self.ended = false;
                self.reverse = false;
                self.censor = false;
                self.roll = false;
                self.scratching = false;
                self.brake = None;
                self.spin = None;
                ev.send(Event::Loaded { deck: id, token });
            }
            C::Eject => {
                let old = self.track.take();
                trash.put_opt(old, Trash::Track);
                self.playing = false;
                self.running = false;
                self.fade.set_open(false);
                self.reader = Reader::new();
                ev.send(Event::Ejected { deck: id });
            }
            C::SetGrid(g) => {
                if let Some(t) = self.track.as_mut() {
                    let old = std::mem::replace(&mut t.grid, g);
                    trash.put(Trash::Grid(old));
                } else {
                    trash.put(Trash::Grid(g));
                }
            }
            C::Play => {
                if self.cue_preview || self.hot_preview {
                    // Play while previewing: keep playing after release.
                    self.cue_preview = false;
                    self.hot_preview = false;
                } else if !self.playing {
                    self.start(env);
                }
            }
            C::Pause => {
                if self.playing {
                    self.stop()
                }
            }
            C::PlayPause => {
                if self.playing && !self.cue_preview && !self.hot_preview {
                    self.stop()
                } else {
                    self.handle(C::Play, env, trash, ev)
                }
            }
            C::SpinUp(s) => {
                self.spin = Some(Ramp { total: (s.max(0.01) as f64) * self.sr, left: (s.max(0.01) as f64) * self.sr });
                self.start(env);
                self.fade.set_open(true);
            }
            C::Brake(s) => {
                if self.running {
                    let f = (s.max(0.02) as f64) * self.sr;
                    self.brake = Some(Ramp { total: f, left: f });
                }
            }
            C::CueDown => self.cue_down(env, ev),
            C::CueUp => {
                if self.cue_preview {
                    self.cue_preview = false;
                    let cue = self.track.as_ref().map(|t| t.cue).unwrap_or(0.0);
                    self.pause_at(cue);
                }
            }
            C::SetCuePoint(f) => {
                if let Some(t) = self.track.as_mut() {
                    t.cue = f;
                    ev.send(Event::CueSet { deck: id, frame: f });
                }
            }
            C::HotCueDown(i) => self.hot_down(i, env, ev),
            C::HotCueUp(i) => self.hot_up(i),
            C::SetHotCue { index, frame, kind, color } => {
                let f = frame.unwrap_or_else(|| self.snap(self.audible(), env));
                if let Some(t) = self.track.as_mut() {
                    if (index as usize) < t.hot_cues.len() {
                        let cue = HotCue { frame: f, kind, color };
                        t.hot_cues[index as usize] = Some(cue);
                        ev.send(Event::HotCueSet { deck: id, index, cue });
                    }
                }
            }
            C::DeleteHotCue(i) => {
                if let Some(t) = self.track.as_mut() {
                    if let Some(slot) = t.hot_cues.get_mut(i as usize) {
                        *slot = None;
                        ev.send(Event::HotCueDeleted { deck: id, index: i });
                    }
                }
            }
            C::HotCueMode(m) => self.hot_mode = m,
            C::Seek(f) => self.quantized_jump(f, env),
            C::SeekFraction(x) => {
                let f = x.clamp(0.0, 1.0) * self.frames();
                self.quantized_jump(f, env)
            }
            C::BeatJump(beats) => {
                if self.reader.lp.is_some_and(|l| l.active) {
                    self.move_loop(beats, ev);
                } else if let Some(g) = self.grid() {
                    let t = g.offset_by_beats(self.audible(), beats);
                    self.jump_to(t);
                }
            }
            C::LoopAuto(beats) => {
                let same = self.reader.lp.is_some_and(|l| l.active && (self.loop_beats(&l) - beats).abs() < 1e-6);
                if same {
                    self.exit_loop(ev);
                } else {
                    self.auto_loop(beats, env, ev);
                }
            }
            C::LoopIn => {
                let p = self.snap(self.audible(), env);
                match self.reader.lp {
                    Some(mut l) if l.active && p < l.end - 16.0 => {
                        l.start = p;
                        self.set_loop(Some(l), ev);
                    }
                    _ => self.loop_in = Some(p),
                }
            }
            C::LoopOut => {
                let start = self.loop_in.or_else(|| self.reader.lp.map(|l| l.start));
                if let Some(s) = start {
                    let mut e = self.snap(self.audible(), env);
                    if e <= s + 16.0 {
                        // Too short: default to one beat.
                        e = self.grid().map(|g| g.offset_by_beats(s, 1.0)).unwrap_or(s + self.sr * 0.5);
                    }
                    self.set_loop(Some(Loop { start: s, end: e, active: true }), ev);
                    self.loop_in = None;
                    self.after_loop_change();
                }
            }
            C::LoopExit => self.exit_loop(ev),
            C::Reloop => match self.reader.lp {
                Some(l) if l.active => self.exit_loop(ev),
                Some(mut l) => {
                    l.active = true;
                    self.set_loop(Some(l), ev);
                    self.jump_to(l.start);
                }
                None => {}
            },
            C::LoopHalve => self.resize_loop(0.5, ev),
            C::LoopDouble => self.resize_loop(2.0, ev),
            C::LoopMove(beats) => self.move_loop(beats, ev),
            C::SetLoop { start, end, active } => {
                if end > start + 16.0 {
                    self.set_loop(Some(Loop { start, end, active }), ev);
                    self.after_loop_change();
                }
            }
            C::LoopRollDown(beats) => {
                if !self.roll {
                    self.roll_slip_was = self.slip;
                    if !self.slip {
                        self.slip = true;
                        self.ghost = self.audible();
                    }
                    self.roll = true;
                }
                self.auto_loop(beats, env, ev);
            }
            C::LoopRollUp => {
                if self.roll {
                    self.roll = false;
                    if let Some(mut l) = self.reader.lp {
                        l.active = false;
                        self.set_loop(Some(l), ev);
                    }
                    self.slip_return();
                    self.slip = self.roll_slip_was;
                }
            }
            C::SetTempo(t) => self.tempo = t.clamp(-1.0, 1.0),
            C::SetTempoRange(r) => {
                // Keep the same rate when the range changes.
                let rate = self.fader_rate();
                self.range = r.clamp(0.01, 1.0);
                self.tempo = ((rate - 1.0) / self.range).clamp(-1.0, 1.0);
            }
            C::TempoReset => self.tempo = 0.0,
            C::Nudge(n) => self.nudge = n.clamp(-1.0, 1.0),
            C::SetKeylock(on) => self.keylock = on,
            C::SetKeyShift(s) => self.key_shift = s.clamp(-12.0, 12.0),
            C::Sync(on) => {
                if on && !self.sync {
                    self.sync = true;
                    self.engage_sync(env);
                } else if !on && self.sync {
                    // Releasing sync keeps the current tempo on the fader (no jump).
                    let rate = self.rate.abs().max(0.01);
                    self.sync = false;
                    self.tempo = ((rate - 1.0) / self.range).clamp(-1.0, 1.0);
                }
            }
            C::SetSyncMode(m) => self.sync_mode = m,
            C::BecomeMaster => {}
            C::Slip(on) => {
                if on && !self.slip {
                    self.ghost = self.audible();
                } else if !on && self.slip {
                    // Turning slip off keeps the current position.
                }
                self.slip = on;
            }
            C::Censor(on) => {
                if on && !self.censor {
                    self.censor = true;
                    self.censor_slip_was = self.slip;
                    if !self.slip {
                        self.slip = true;
                        self.ghost = self.audible();
                    }
                    self.reverse = true;
                } else if !on && self.censor {
                    self.censor = false;
                    self.reverse = false;
                    self.slip_return();
                    self.slip = self.censor_slip_was;
                }
            }
            C::Reverse(on) => {
                if self.reverse && !on {
                    self.reverse = false;
                    self.slip_return();
                } else {
                    self.reverse = on;
                }
            }
            C::ScratchStart => {
                if self.track.is_some() {
                    self.scratching = true;
                    let r = if self.running { self.rate } else { 0.0 };
                    self.scratch_target = r;
                    self.scratch_vel = r;
                    self.fade.fade_in();
                    self.brake = None;
                }
            }
            C::ScratchVelocity(v) => {
                if self.scratching {
                    self.scratch_target = v.clamp(-8.0, 8.0);
                }
            }
            C::ScratchEnd => {
                if self.scratching {
                    self.scratching = false;
                    if !self.playing {
                        self.fade.fade_out();
                    } else {
                        self.slip_return();
                    }
                }
            }
            C::SetStretcher(s) => {
                let old = self.stretcher.replace(s);
                trash.put_opt(old, Trash::Stretch);
                if self.path == Path::Stretch {
                    // Re-prime the new stretcher at the current audible point.
                    let a = self.audible();
                    self.primed = false;
                    self.reader.head = a;
                    if self.advancing() {
                        self.prime_stretcher(a);
                    }
                }
            }
            C::DuplicateFrom(_) => {} // handled by the engine (needs the other deck)
            C::SetEndBehaviour(b) => self.end_behaviour = b,
        }
    }

    fn engage_sync(&mut self, env: &DeckEnv) {
        if env.is_master || !env.clock_running || self.track.is_none() {
            self.sync_mult = 1.0;
            self.phase_offset = 0.0;
            return;
        }
        let deck_bpm = self.base_bpm();
        // Half/double tempo matching: pick the multiple that keeps the rate nearest 1.
        let ratio = deck_bpm / env.clock_bpm.max(1.0);
        self.sync_mult = 2f64.powf(ratio.log2().round()).clamp(0.5, 2.0);
        self.phase_offset = 0.0;
        if self.running && self.sync_mode != SyncMode::Tempo {
            let err = self.phase_error_at(env, self.audible());
            if let Some(g) = self.grid() {
                let t = g.frame_at(g.beat_at(self.audible()) + err);
                self.jump_to(t);
            }
        }
    }

    /// Beats this deck must move to be in phase with the master clock.
    fn phase_error_at(&self, env: &DeckEnv, at: f64) -> f64 {
        let Some(g) = self.grid() else { return 0.0 };
        let deck_beat = g.beat_at(at);
        let master = env.clock_beat * self.sync_mult + self.phase_offset;
        let span = if self.sync_mode == SyncMode::Bar { g.beats_per_bar.max(1) as f64 } else { 1.0 };
        let d = (master - deck_beat).rem_euclid(span);
        if d >= span * 0.5 { d - span } else { d }
    }

    fn cue_down(&mut self, env: &DeckEnv, ev: &mut EventSink) {
        let Some(cue) = self.track.as_ref().map(|t| t.cue) else { return };
        if self.playing && !self.cue_preview {
            // Back-cue: return to the cue point and stop.
            self.pause_at(cue);
            return;
        }
        let here = self.audible();
        if (here - cue).abs() < 2.0 {
            // At the cue: preview while held.
            self.cue_preview = true;
            self.start(env);
        } else {
            let f = self.snap(here, env);
            if let Some(t) = self.track.as_mut() {
                t.cue = f;
            }
            self.reader.head = f;
            ev.send(Event::CueSet { deck: self.id, frame: f });
        }
    }

    fn hot_down(&mut self, i: u8, env: &DeckEnv, ev: &mut EventSink) {
        let Some(t) = self.track.as_ref() else { return };
        let Some(slot) = t.hot_cues.get(i as usize).copied() else { return };
        match slot {
            None => {
                let f = self.snap(self.audible(), env);
                let cue = HotCue { frame: f, kind: CueKind::Point, color: 0 };
                if let Some(t) = self.track.as_mut() {
                    t.hot_cues[i as usize] = Some(cue);
                }
                ev.send(Event::HotCueSet { deck: self.id, index: i, cue });
            }
            Some(cue) => {
                self.hot_held = Some(i);
                if !self.running || !self.playing {
                    self.jump_to(cue.frame);
                    self.hot_preview = true;
                    self.start(env);
                } else {
                    match self.hot_mode {
                        HotCueMode::Stutter => self.jump_to(cue.frame),
                        _ => self.quantized_jump(cue.frame, env),
                    }
                }
                if let CueKind::Loop { length } = cue.kind {
                    self.set_loop(Some(Loop { start: cue.frame, end: cue.frame + length, active: true }), ev);
                }
            }
        }
    }

    fn hot_up(&mut self, i: u8) {
        if self.hot_held != Some(i) {
            return;
        }
        self.hot_held = None;
        let frame = self.track.as_ref().and_then(|t| t.hot_cues[i as usize]).map(|c| c.frame);
        if self.hot_preview || self.hot_mode == HotCueMode::Gate {
            self.hot_preview = false;
            if let Some(f) = frame {
                self.pause_at(f);
            }
        } else if self.slip {
            self.slip_return();
        }
    }

    // ---------------------------------------------------------------------------------
    // Loops
    // ---------------------------------------------------------------------------------

    fn loop_beats(&self, l: &Loop) -> f64 {
        self.grid().map(|g| g.beat_at(l.end) - g.beat_at(l.start)).unwrap_or(0.0)
    }

    fn loop_info(&self) -> LoopInfo {
        match self.reader.lp {
            Some(l) => LoopInfo { start: l.start, end: l.end, active: l.active, beats: self.loop_beats(&l) },
            None => LoopInfo::default(),
        }
    }

    fn set_loop(&mut self, l: Option<Loop>, ev: &mut EventSink) {
        self.reader.lp = l;
        ev.send(Event::LoopChanged { deck: self.id, looping: self.loop_info() });
    }

    fn auto_loop(&mut self, beats: f64, env: &DeckEnv, ev: &mut EventSink) {
        let Some(g) = self.grid() else { return };
        let here = self.audible();
        let start = match env.quantize {
            Some(_) => g.floor_boundary(here, beats.min(1.0)),
            None => here,
        };
        let end = g.offset_by_beats(start, beats);
        if end <= start + 4.0 {
            return;
        }
        self.set_loop(Some(Loop { start, end, active: true }), ev);
        self.after_loop_change();
    }

    /// On the key-lock path the head may already be past a newly set loop end.
    fn after_loop_change(&mut self) {
        let Some(l) = self.reader.lp else { return };
        if !l.active {
            return;
        }
        let a = self.audible();
        let inside = |x: f64| x >= l.start && x < l.end;
        if self.path == Path::Stretch && self.primed && (self.reader.head >= l.end || !inside(a)) {
            let t = if a >= l.end { l.start + (a - l.start).rem_euclid(l.len()) } else { a.max(l.start) };
            self.jump_to(t);
        } else if self.path == Path::Direct && a >= l.end {
            let t = l.start + (a - l.start).rem_euclid(l.len());
            self.jump_to(t);
        }
    }

    fn exit_loop(&mut self, ev: &mut EventSink) {
        if let Some(mut l) = self.reader.lp {
            if l.active {
                l.active = false;
                self.set_loop(Some(l), ev);
                self.slip_return();
            }
        }
    }

    fn resize_loop(&mut self, factor: f64, ev: &mut EventSink) {
        let Some(l) = self.reader.lp else { return };
        let Some(g) = self.grid() else { return };
        let beats = self.loop_beats(&l) * factor;
        if !(1.0 / 64.0..=512.0).contains(&beats) {
            return;
        }
        let end = g.offset_by_beats(l.start, beats);
        self.set_loop(Some(Loop { end, ..l }), ev);
        self.after_loop_change();
    }

    fn move_loop(&mut self, beats: f64, ev: &mut EventSink) {
        let Some(l) = self.reader.lp else { return };
        let Some(g) = self.grid() else { return };
        let start = g.offset_by_beats(l.start, beats);
        let end = g.offset_by_beats(l.end, beats);
        let delta = start - l.start;
        self.set_loop(Some(Loop { start, end, active: l.active }), ev);
        if l.active {
            let t = self.audible() + delta;
            self.jump_to(t);
        }
    }

    // ---------------------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------------------

    /// Playback rate for the next block, with sync and bends applied.
    fn target_rate(&mut self, env: &DeckEnv, n: usize) -> f64 {
        let mut base = self.fader_rate();
        self.phase_error = 0.0;
        if self.sync && !env.is_master && env.clock_running {
            let deck_bpm = self.base_bpm().max(1.0);
            base = env.clock_bpm * self.sync_mult / deck_bpm;
            if self.sync_mode != SyncMode::Tempo && self.running {
                let err = self.phase_error_at(env, self.audible());
                self.phase_error = err;
                if self.nudge != 0.0 {
                    // The DJ is bending by hand: remember the new offset instead of fighting it.
                    self.phase_offset -= err;
                } else {
                    let bps = deck_bpm * base / 60.0;
                    let corr = (err / (SYNC_PULL_S * bps.max(0.1))).clamp(-MAX_SYNC_CORRECTION, MAX_SYNC_CORRECTION);
                    base *= 1.0 + corr;
                }
            }
        }
        base *= 1.0 + self.nudge * NUDGE_AMOUNT;
        self.slip_rate = base;
        let mut rate = base;
        if let Some(b) = self.brake.as_mut() {
            b.left -= n as f64;
            let f = (b.left / b.total).max(0.0);
            rate *= f * f;
        }
        if let Some(s) = self.spin.as_mut() {
            s.left -= n as f64;
            let f = 1.0 - (s.left / s.total).max(0.0);
            rate *= f.sqrt();
            if s.left <= 0.0 {
                self.spin = None;
            }
        }
        if self.reverse {
            rate = -rate;
        }
        if self.scratching {
            let a = (-(n as f64) / (SCRATCH_SMOOTH_S * self.sr)).exp();
            self.scratch_vel = self.scratch_target + a * (self.scratch_vel - self.scratch_target);
            rate = self.scratch_vel;
        }
        if !self.running && !self.scratching {
            rate = 0.0;
        }
        rate
    }

    fn wants_stretch(&self, rate: f64) -> bool {
        self.stretcher.is_some()
            && (self.keylock || self.key_shift != 0.0)
            && !self.scratching
            && !self.reverse
            && self.brake.is_none()
            && self.spin.is_none()
            && (STRETCH_MIN_RATE..=STRETCH_MAX_RATE).contains(&rate)
    }

    /// Renders `n` (≤ [`BLOCK`]) frames into `out_l`/`out_r`.
    pub fn render(&mut self, n: usize, env: &DeckEnv, ev: &mut EventSink) {
        let n = n.min(BLOCK);
        if self.track.is_none() || (!self.advancing() && self.fade.is_silent()) {
            self.out_l[..n].fill(0.0);
            self.out_r[..n].fill(0.0);
            self.rate = 0.0;
            self.was_moving = false;
            return;
        }
        let rate = self.target_rate(env, n);
        // Ramp the rate across the block, except when starting from a standstill.
        let prev_rate = if self.was_moving { self.rate } else { rate };
        self.was_moving = self.advancing();

        // Path selection: switch with a short fade so the change is inaudible.
        let want = if self.wants_stretch(rate) { Path::Stretch } else { Path::Direct };
        if want != self.path && !self.path_fade.is_closing_or_closed() {
            self.path_fade.fade_out();
        }

        self.rate = rate;
        match self.path {
            Path::Stretch if self.stretcher.is_some() => self.render_stretch(n, rate),
            _ => self.render_direct(n, prev_rate, rate),
        }

        // Gains: transport fade, seek dip and path fade.
        for i in 0..n {
            let g = self.fade.next() * self.dip.next() * self.path_fade.next();
            self.out_l[i] *= g;
            self.out_r[i] *= g;
        }

        // Slip ghost.
        if self.slip && self.running {
            if self.diverted() {
                self.ghost += self.slip_rate * n as f64;
            } else {
                self.ghost = self.audible();
            }
        }

        // Deferred actions once fades have closed.
        if self.path_fade.is_silent() {
            let a = self.audible();
            self.path = want;
            self.primed = false;
            self.reader.head = a;
            self.reader.xf_left = 0;
            self.pending_seek = None;
            self.dip.set_open(true);
            if self.path == Path::Stretch && self.advancing() {
                self.prime_stretcher(a);
            }
            self.path_fade.fade_in();
        }
        if let Some(t) = self.pending_seek {
            if self.dip.is_silent() {
                self.pending_seek = None;
                if self.path == Path::Stretch {
                    self.prime_stretcher(t);
                } else {
                    self.reader.head = t;
                }
                self.dip.fade_in();
            }
        }
        if self.brake.is_some_and(|b| b.left <= 0.0) {
            self.brake = None;
            self.playing = false;
            self.fade.set_open(false);
            self.halt();
        }
        if !self.playing && !self.scratching && self.fade.is_silent() && self.running {
            self.halt();
        }

        // End of track.
        let a = self.audible();
        let looping = self.reader.lp.is_some_and(|l| l.active);
        let at_end = (rate > 0.0 && a >= self.frames()) || (rate < 0.0 && a <= 0.0);
        if self.playing && !looping && self.end_behaviour == EndBehaviour::Stop && !self.ended && at_end {
            self.ended = true;
            self.stop();
            ev.send(Event::TrackEnded { deck: self.id });
        }
    }

    fn render_direct(&mut self, n: usize, r0: f64, r1: f64) {
        let Some(track) = self.track.as_ref() else { return };
        let data = &track.audio.data;
        let frames = track.audio.frames();
        let k = self.kernels.for_speed(r0.abs().max(r1.abs()));
        let xf = self.xf_frames;
        let inv = 1.0 / n as f64;
        for i in 0..n {
            let step = r0 + (r1 - r0) * (i + 1) as f64 * inv;
            let (l, r) = self.reader.step(data, frames, k, step, xf);
            self.out_l[i] = l;
            self.out_r[i] = r;
        }
    }

    fn render_stretch(&mut self, n: usize, rate: f64) {
        if !self.primed {
            let a = self.reader.head;
            self.prime_stretcher(a);
        }
        let (Some(track), Some(st)) = (self.track.as_ref(), self.stretcher.as_mut()) else { return };
        let data = &track.audio.data;
        let frames = track.audio.frames();
        let k = self.kernels.for_speed(1.0);
        let xf = self.xf_frames;
        let need = self.stretch_frac + n as f64 * rate;
        let m = (need.floor() as usize).min(self.stretch_in.len() / 2);
        self.stretch_frac = need - m as f64;
        for j in 0..m {
            let (l, r) = self.reader.step(data, frames, k, 1.0, xf);
            self.stretch_in[j * 2] = l;
            self.stretch_in[j * 2 + 1] = r;
        }
        st.set_transpose(Self::transpose_for(self.keylock, self.key_shift, rate));
        st.process(&self.stretch_in[..m * 2], &mut self.stretch_out[..n * 2]);
        for i in 0..n {
            self.out_l[i] = self.stretch_out[i * 2];
            self.out_r[i] = self.stretch_out[i * 2 + 1];
        }
    }

    // ---------------------------------------------------------------------------------
    // Duplicate and telemetry
    // ---------------------------------------------------------------------------------

    /// Copies transport state from `other` (which plays the same track).
    pub fn copy_transport_from(&mut self, other: &Deck) {
        if self.track.is_none() {
            return;
        }
        self.reader.head = other.audible();
        self.reader.xf_left = 0;
        self.reader.lp = other.reader.lp;
        self.primed = false;
        self.tempo = other.tempo;
        self.range = other.range;
        self.keylock = other.keylock;
        self.key_shift = other.key_shift;
        self.reverse = other.reverse;
        if other.running && other.playing {
            self.playing = true;
            self.running = true;
            self.fade.fade_in();
        }
    }

    pub fn telemetry(&self, env: &DeckEnv) -> DeckTelemetry {
        let Some(t) = self.track.as_ref() else { return DeckTelemetry::default() };
        let a = self.audible();
        let frames = t.audio.frames() as f64;
        let base = t.grid.bpm_at(a);
        DeckTelemetry {
            loaded: true,
            token: t.token,
            playing: self.playing,
            position: a,
            duration: frames,
            bpm: base * self.rate.abs().max(if self.running { 0.0 } else { self.fader_rate() }),
            base_bpm: base,
            rate: self.rate,
            tempo: self.tempo,
            tempo_range: self.range,
            beat: t.grid.beat_at(a),
            beats_per_bar: t.grid.beats_per_bar,
            keylock: self.keylock,
            key_shift: self.key_shift,
            sync: self.sync,
            master: env.is_master,
            phase_offset: if self.sync { self.phase_error } else { 0.0 },
            slip: self.slip,
            slip_position: self.ghost,
            reverse: self.reverse,
            scratching: self.scratching,
            cue: t.cue,
            looping: self.loop_info(),
            remaining: ((frames - a) / self.sr).max(0.0),
            peak: [0.0; 2],
            rms: 0.0,
            ..DeckTelemetry::default()
        }
    }
}
