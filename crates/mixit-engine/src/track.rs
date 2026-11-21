//! Audio the engine plays: decoded, resampled to the engine rate, interleaved stereo.

use std::sync::Arc;

use mixit_core::Beatgrid;

/// Decoded audio in memory. Immutable once built and shared by `Arc`, so a deck, its
/// duplicate and the waveform view can all read the same samples without copying.
#[derive(Debug)]
pub struct TrackAudio {
    /// Engine sample rate the samples are stored at.
    pub sample_rate: u32,
    /// Interleaved stereo samples (`frames * 2` values).
    pub data: Vec<f32>,
}

impl TrackAudio {
    /// Builds from interleaved stereo samples.
    pub fn new(sample_rate: u32, data: Vec<f32>) -> TrackAudio {
        debug_assert!(data.len() % 2 == 0);
        TrackAudio { sample_rate, data }
    }

    /// Builds from separate channels.
    pub fn from_channels(sample_rate: u32, l: &[f32], r: &[f32]) -> TrackAudio {
        let n = l.len().min(r.len());
        let mut data = Vec::with_capacity(n * 2);
        for i in 0..n {
            data.push(l[i]);
            data.push(r[i]);
        }
        TrackAudio { sample_rate, data }
    }

    /// Builds from a mono signal.
    pub fn from_mono(sample_rate: u32, x: &[f32]) -> TrackAudio {
        Self::from_channels(sample_rate, x, x)
    }

    #[inline]
    pub fn frames(&self) -> usize {
        self.data.len() / 2
    }

    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }
}

/// What kind of point a hot cue is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CueKind {
    /// Jump to a point.
    Point,
    /// A saved loop of this many frames; triggering it jumps and activates the loop.
    Loop { length: f64 },
}

/// A hot cue slot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HotCue {
    pub frame: f64,
    pub kind: CueKind,
    /// Display colour (RGB), chosen by the UI.
    pub color: u32,
}

/// Number of hot cue slots per deck.
pub const HOT_CUES: usize = 16;

/// Everything the engine needs to play a track on a deck.
#[derive(Clone, Debug)]
pub struct DeckTrack {
    pub audio: Arc<TrackAudio>,
    pub grid: Arc<Beatgrid>,
    /// Gain that brings the track to the target loudness (applied when auto-gain is on).
    pub auto_gain_db: f32,
    /// Main cue point (frames).
    pub cue: f64,
    pub hot_cues: [Option<HotCue>; HOT_CUES],
    /// Opaque token the UI uses to match telemetry and events to its own track record.
    pub token: u64,
}

impl DeckTrack {
    pub fn new(audio: Arc<TrackAudio>, grid: Arc<Beatgrid>) -> DeckTrack {
        DeckTrack { audio, grid, auto_gain_db: 0.0, cue: 0.0, hot_cues: [None; HOT_CUES], token: 0 }
    }
}
