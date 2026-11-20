//! Messages from the audio thread to the control side: periodic state snapshots and
//! discrete events. Both are plain `Copy` data so producing them never allocates.

use mixit_core::DeckId;

use crate::track::HotCue;

/// A loop as reported to the UI.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct LoopInfo {
    pub start: f64,
    pub end: f64,
    pub active: bool,
    /// Length in beats (when it matches the grid), for the loop-size display.
    pub beats: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct DeckTelemetry {
    pub loaded: bool,
    pub token: u64,
    pub playing: bool,
    /// Position the listener hears (frames), after stretcher latency.
    pub position: f64,
    pub duration: f64,
    /// Effective tempo (BPM) and the track's own tempo at the play head.
    pub bpm: f64,
    pub base_bpm: f64,
    /// Playback rate (1.0 = normal) including tempo, nudge and sync corrections.
    pub rate: f64,
    pub tempo: f64,
    pub tempo_range: f64,
    pub beat: f64,
    pub beats_per_bar: u32,
    pub keylock: bool,
    pub key_shift: f32,
    pub sync: bool,
    pub master: bool,
    /// Phase difference to the master in beats (−0.5 … 0.5), for the phase meter.
    pub phase_offset: f64,
    pub slip: bool,
    pub slip_position: f64,
    pub reverse: bool,
    pub scratching: bool,
    pub cue: f64,
    pub looping: LoopInfo,
    /// Seconds until the end of the track (for the end-of-track warning).
    pub remaining: f64,
    /// Channel meters (post-EQ, pre-fader), linear peak.
    pub peak: [f32; 2],
    pub rms: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct MasterTelemetry {
    pub peak: [f32; 2],
    pub true_peak_db: f32,
    pub momentary_lufs: f32,
    pub short_term_lufs: f32,
    pub correlation: f32,
    pub limiter_gr_db: f32,
    pub cue_peak: [f32; 2],
    pub clipped: bool,
}

/// A state snapshot, published several times per second.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Telemetry {
    /// Engine frames rendered since start.
    pub frame: u64,
    pub decks: [DeckTelemetry; DeckId::MAX],
    pub master: MasterTelemetry,
    pub clock_bpm: f64,
    pub clock_beat: f64,
    /// Master deck, if a deck is master (otherwise the internal clock).
    pub master_deck: Option<DeckId>,
    pub recording: bool,
    pub recorded_frames: u64,
    pub sampler_playing: u32,
    /// Objects that could not be handed back for freeing (should stay 0).
    pub leaked: u32,
    pub dropped_commands: u32,
}

/// Something that happened, for the UI to react to or persist.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Event {
    Loaded {
        deck: DeckId,
        token: u64,
    },
    Ejected {
        deck: DeckId,
    },
    TrackEnded {
        deck: DeckId,
    },
    CueSet {
        deck: DeckId,
        frame: f64,
    },
    HotCueSet {
        deck: DeckId,
        index: u8,
        cue: HotCue,
    },
    HotCueDeleted {
        deck: DeckId,
        index: u8,
    },
    LoopChanged {
        deck: DeckId,
        looping: LoopInfo,
    },
    MasterChanged {
        deck: Option<DeckId>,
    },
    /// The recorder ring was full and audio was lost.
    RecorderOverrun {
        frames: u32,
    },
    /// The master output clipped (before the limiter, when it is off).
    Clip,
    PadStarted {
        pad: usize,
    },
    PadStopped {
        pad: usize,
    },
}

/// The audio-thread end of the event ring. Full rings drop events and count them.
pub struct EventSink {
    tx: rtrb::Producer<Event>,
    pub dropped: u32,
}

impl EventSink {
    pub fn new(tx: rtrb::Producer<Event>) -> EventSink {
        EventSink { tx, dropped: 0 }
    }

    #[inline]
    pub fn send(&mut self, e: Event) {
        if self.tx.push(e).is_err() {
            self.dropped += 1;
        }
    }
}
