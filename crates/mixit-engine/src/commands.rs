//! Messages from the control side to the audio thread.
//!
//! Every heavy payload (tracks, grids, effects, stretchers) is built on a control thread
//! and moved in through the command ring; the audio thread only swaps pointers.

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId, Quantize};
use mixit_dsp::curves::{CrossfaderCurve, FaderCurve};
use mixit_dsp::djeq::EqMode;
use mixit_dsp::fx::Effect;
use mixit_dsp::stretch::TimeStretch;
use mixit_dsp::studio::StudioSettings;

use crate::mixer::{ReturnParam, ScopeSource};

use crate::track::{CueKind, DeckTrack, TrackAudio};

/// A command, optionally scheduled for an exact engine frame.
pub struct Timed {
    /// Engine frame (see [`crate::Telemetry::frame`]) at which to apply, or `None` for
    /// the start of the next block.
    pub at: Option<u64>,
    pub cmd: Command,
}

impl From<Command> for Timed {
    fn from(cmd: Command) -> Timed {
        Timed { at: None, cmd }
    }
}

pub enum Command {
    Deck(DeckId, DeckCommand),
    Mixer(MixerCommand),
    Fx(FxTarget, usize, FxCommand),
    Sampler(SamplerCommand),
    Mic(crate::input::MicCommand),
    Global(GlobalCommand),
}

/// How hot cues behave when pressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum HotCueMode {
    /// Jump (and keep playing); when paused, play while held.
    #[default]
    Jump,
    /// Play only while held, then return and pause.
    Gate,
    /// Restart from the cue on every press, without quantise (finger drumming).
    Stutter,
}

/// How sync locks a deck to the master.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SyncMode {
    /// Match tempo only.
    Tempo,
    /// Match tempo and beat phase.
    #[default]
    Beat,
    /// Match tempo, beat and position in the bar.
    Bar,
}

pub enum DeckCommand {
    Load(Box<DeckTrack>),
    Eject,
    /// Replaces the beatgrid (after an edit) without touching playback.
    SetGrid(Arc<Beatgrid>),
    Play,
    Pause,
    PlayPause,
    /// Starts from a stop with a turntable spin-up lasting this many seconds.
    SpinUp(f32),
    /// Stops like a turntable losing power, over this many seconds.
    Brake(f32),
    CueDown,
    CueUp,
    SetCuePoint(f64),
    HotCueDown(u8),
    HotCueUp(u8),
    SetHotCue {
        index: u8,
        frame: Option<f64>,
        kind: CueKind,
        color: u32,
    },
    DeleteHotCue(u8),
    HotCueMode(HotCueMode),
    /// Jumps to a frame (quantised to the beat phase when quantise is on and playing).
    Seek(f64),
    /// Jumps to a fraction (0..1) of the track (needle search).
    SeekFraction(f64),
    BeatJump(f64),
    /// Toggles an auto loop of this many beats.
    LoopAuto(f64),
    LoopIn,
    LoopOut,
    LoopExit,
    Reloop,
    LoopHalve,
    LoopDouble,
    LoopMove(f64),
    SetLoop {
        start: f64,
        end: f64,
        active: bool,
    },
    /// Loop roll: a slip loop while held.
    LoopRollDown(f64),
    LoopRollUp,
    /// Slicer pad held: the bar (or `beats` long stretch) the track is in is cut into
    /// `count` slices and slice `index` loops while held, as a slip roll; the track carries
    /// on underneath and comes back on release.
    SliceDown {
        index: u8,
        count: u8,
        beats: f64,
    },
    /// Slicer pad released (only the pad that is playing ends the slice).
    SliceUp(u8),
    /// Tempo fader, −1 … +1 of the tempo range.
    SetTempo(f64),
    /// Tempo range as a fraction (0.08 = ±8 %).
    SetTempoRange(f64),
    TempoReset,
    /// Momentary pitch bend, −1 … +1 (buttons or the jog rim).
    Nudge(f64),
    SetKeylock(bool),
    SetKeyShift(f32),
    /// Engages or releases sync.
    Sync(bool),
    SetSyncMode(SyncMode),
    /// Makes this deck the tempo master.
    BecomeMaster,
    Slip(bool),
    Censor(bool),
    Reverse(bool),
    ScratchStart,
    /// Platter velocity in track frames per output frame (1.0 = normal forward speed).
    ScratchVelocity(f64),
    ScratchEnd,
    /// Installs the time-stretcher (built on a control thread).
    SetStretcher(Box<dyn TimeStretch>),
    /// Copies another deck's track, position and state (instant doubles).
    DuplicateFrom(DeckId),
    /// Stops at the end of the track (default) or keeps going into silence.
    SetEndBehaviour(EndBehaviour),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum EndBehaviour {
    #[default]
    Stop,
    Continue,
}

/// Which side of the crossfader a channel is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum XfAssign {
    A,
    #[default]
    Thru,
    B,
}

pub enum MixerCommand {
    SetTrim(DeckId, f32),
    SetEq(DeckId, usize, f32),
    SetEqKill(DeckId, usize, bool),
    SetFilter(DeckId, f32),
    SetFilterResonance(DeckId, f32),
    SetFader(DeckId, f32),
    SetPan(DeckId, f32),
    SetCue(DeckId, bool),
    SetAssign(DeckId, XfAssign),
    SetCrossfader(f32),
    SetCrossfaderCurve(CrossfaderCurve),
    SetCrossfaderReverse(bool),
    SetFaderCurve(FaderCurve),
    SetEqMode(EqMode),
    SetMasterDb(f32),
    SetBoothDb(f32),
    /// 0 = cue only in headphones, 1 = master only.
    SetCueMix(f32),
    SetHeadphonesDb(f32),
    SetSplitCue(bool),
    SetAutoGain(bool),
    SetLimiter(bool),
    /// Puts the deck FX rack before (false) or after (true, default) the channel fader.
    SetFxPostFader(DeckId, bool),
    /// A channel's (or, with `None`, the master's) studio insert chain.
    SetStudio(Option<DeckId>, Box<StudioSettings>),
    /// How much of a channel goes to return `k` (0 = reverb, 1 = echo), 0 … 1.
    SetSend(DeckId, usize, f32),
    /// Turns a channel down by up to `depth_db` while another channel plays (None = off).
    SetDuck(DeckId, Option<DeckId>, f32),
    SetReturn(usize, ReturnParam),
    /// What feeds the spectrum analyser.
    SetScope(ScopeSource),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FxTarget {
    Deck(DeckId),
    Master,
}

pub enum FxCommand {
    SetEffect(Option<Box<dyn Effect>>),
    SetOn(bool),
    SetMix(f32),
    SetBeats(f32),
    SetParam(usize, f32),
}

/// How a sampler pad plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PadMode {
    /// Plays to the end once per press.
    #[default]
    OneShot,
    /// Plays while held.
    Gate,
    /// Loops until pressed again.
    Loop,
}

pub enum SamplerCommand {
    Load {
        pad: usize,
        audio: Arc<TrackAudio>,
        bpm: Option<f64>,
    },
    Unload(usize),
    Down(usize),
    Up(usize),
    Stop(usize),
    StopAll,
    SetMode(usize, PadMode),
    SetGainDb(usize, f32),
    SetPan(usize, f32),
    /// Locks a looped pad to the master tempo (resampled).
    SetSync(usize, bool),
    /// Waits for the next beat boundary before starting.
    SetQuantized(usize, bool),
    SetVolume(f32),
    /// Step sequencer: which steps pad `pad` plays (bit n = step n).
    SeqPattern {
        pad: usize,
        steps: u64,
    },
    /// Step sequencer settings: running, number of steps (1..=64), the length of a step in
    /// beats (0.25 = sixteenth notes) and swing (0 = straight … 0.5 = full triplet feel,
    /// delaying every second step).
    SeqSettings {
        on: bool,
        steps: u8,
        step_beats: f64,
        swing: f32,
    },
}

pub enum GlobalCommand {
    SetQuantize(Quantize),
    /// Tempo of the internal clock (used when no deck is master).
    SetClockBpm(f64),
    /// Makes the internal clock the master.
    ClockMaster,
    SetRecording(bool),
    /// Telemetry rate in snapshots per second.
    SetTelemetryRate(f32),
}
