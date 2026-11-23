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
    /// The track split into stems, when it has been (see [`StemAudio`]).
    pub stems: Option<Arc<StemAudio>>,
    pub grid: Arc<Beatgrid>,
    /// Gain that brings the track to the target loudness (applied when auto-gain is on).
    pub auto_gain_db: f32,
    /// Main cue point (frames).
    pub cue: f64,
    pub hot_cues: [Option<HotCue>; HOT_CUES],
    /// Opaque token the UI uses to match telemetry and events to its own track record.
    pub token: u64,
    /// Where the music is last at full strength (frames): past it the track fades or falls
    /// silent. The safety loop loops the bars just before it.
    pub music_end: f64,
}

impl DeckTrack {
    /// Allocates a little (one pass over the audio): build off the audio thread.
    pub fn new(audio: Arc<TrackAudio>, grid: Arc<Beatgrid>) -> DeckTrack {
        let music_end = music_end(&audio);
        DeckTrack {
            audio,
            stems: None,
            grid,
            auto_gain_db: 0.0,
            cue: 0.0,
            hot_cues: [None; HOT_CUES],
            token: 0,
            music_end,
        }
    }
}

/// The stems a deck can turn up and down, in the order of [`StemAudio::parts`] and the
/// `deck.X.stem.*` actions. Melody is everything that is not one of the others.
pub const STEMS: [&str; 4] = ["vocals", "drums", "bass", "melody"];

/// A track split into stems: vocals, drums and bass, each interleaved stereo at the same
/// rate and length as the track. The fourth stem, melody, is not stored: it is the track
/// minus the other three, so the four always add back to the original exactly, whatever
/// the separation left behind in the wrong stem.
#[derive(Debug)]
pub struct StemAudio {
    pub vocals: Vec<f32>,
    pub drums: Vec<f32>,
    pub bass: Vec<f32>,
}

impl StemAudio {
    /// The stored stems in [`STEMS`] order (melody, the remainder, is not stored).
    pub fn parts(&self) -> [&[f32]; 3] {
        [&self.vocals, &self.drums, &self.bass]
    }

    /// The stems fit a track of this many interleaved samples.
    pub fn fits(&self, samples: usize) -> bool {
        self.parts().iter().all(|p| p.len() == samples)
    }
}

/// The end of the last quarter second that is within 12 dB of the track's typical level
/// (the median of its non-silent quarter seconds), in frames. A fade-out or a silent tail
/// comes after it; a track that plays at full level to the end gives its length.
pub fn music_end(audio: &TrackAudio) -> f64 {
    let frames = audio.frames();
    let win = (audio.sample_rate as usize / 4).max(1);
    if frames < win * 4 {
        return frames as f64;
    }
    let rms: Vec<f32> = audio
        .data
        .chunks(win * 2)
        .map(|c| (c.iter().map(|x| x * x).sum::<f32>() / c.len().max(1) as f32).sqrt())
        .collect();
    let mut loud: Vec<f32> = rms.iter().copied().filter(|&r| r > 1e-4).collect();
    if loud.is_empty() {
        return frames as f64;
    }
    loud.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let typical = loud[loud.len() / 2];
    match rms.iter().rposition(|&r| r >= typical * 0.25) {
        Some(i) => (((i + 1) * win).min(frames)) as f64,
        None => frames as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio(level: impl Fn(f32) -> f32, seconds: f32) -> TrackAudio {
        let sr = 8_000u32;
        let x: Vec<f32> = (0..(seconds * sr as f32) as usize)
            .map(|i| {
                let t = i as f32 / sr as f32;
                level(t) * (std::f32::consts::TAU * 220.0 * t).sin()
            })
            .collect();
        TrackAudio::from_mono(sr, &x)
    }

    #[test]
    fn music_ends_before_a_fade_or_a_silent_tail() {
        let full = audio(|_| 0.5, 20.0);
        assert_eq!(music_end(&full), full.frames() as f64);
        // A linear fade from 16 s to 18 s drops 12 dB (to a quarter) at 17.5 s.
        let fade = audio(
            |t| {
                if t < 16.0 {
                    0.5
                } else if t < 18.0 {
                    0.5 * (1.0 - (t - 16.0) / 2.0)
                } else {
                    0.0
                }
            },
            20.0,
        );
        let s = music_end(&fade) / 8_000.0;
        assert!((17.25..=17.5).contains(&s), "{s}");
        // A quiet intro does not count against the level.
        let tail = audio(
            |t| {
                if t < 2.0 {
                    0.02
                } else if t < 15.0 {
                    0.5
                } else {
                    0.0
                }
            },
            20.0,
        );
        assert!((music_end(&tail) / 8_000.0 - 15.0).abs() < 0.26);
    }
}
