//! Getting audio in and out of MixIt.
//!
//! * [`decode`]: every common format (MP3, AAC/M4A, ALAC, FLAC, WAV, AIFF, Ogg Vorbis,
//!   CAF, MKV/WebM audio) via Symphonia, to interleaved stereo `f32`.
//! * [`resample`]: high-quality FFT resampling to the engine rate (rubato).
//! * [`hash`]: BLAKE3 content hashes, so a track is recognised after a rename or move.
//! * [`cache`]: decoded audio kept on disk per (content, sample rate) for instant reloads.
//! * [`tags`]: title, artist, album, genre, BPM, key, artwork and audio properties.
//! * [`export`]: WAV (16/24-bit with TPDF dither, or 32-bit float) and FLAC.
//!
//! [`load_track`] chains them: hash → cache hit, or decode → resample → cache.

pub mod cache;
pub mod decode;
pub mod export;
pub mod hash;
pub mod resample;
pub mod tags;

use std::path::{Path, PathBuf};

use mixit_core::ContentHash;

pub use cache::DecodeCache;
pub use decode::{Decoded, decode_file};
pub use export::{ExportFormat, WavDepth, write_flac, write_wav};
pub use hash::hash_file;
pub use resample::resample_interleaved;
pub use tags::{TagUpdate, TrackTags, read_tags, write_tags};

#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("could not open {path}: {source}")]
    Open { path: PathBuf, source: std::io::Error },
    #[error("unsupported or unrecognised audio format: {0}")]
    Unsupported(String),
    #[error("decoding failed: {0}")]
    Decode(String),
    #[error("resampling failed: {0}")]
    Resample(String),
    #[error("writing failed: {0}")]
    Write(String),
    #[error("file has no audio")]
    Empty,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, IoError>;

/// A track ready for a deck: stereo at the requested rate, plus where it came from.
#[derive(Debug)]
pub struct LoadedTrack {
    pub hash: ContentHash,
    /// Interleaved stereo at `sample_rate`.
    pub data: Vec<f32>,
    pub sample_rate: u32,
    pub source_rate: u32,
    pub source_channels: u16,
    pub from_cache: bool,
}

impl LoadedTrack {
    pub fn frames(&self) -> usize {
        self.data.len() / 2
    }
}

/// Loads a file for playback at `sample_rate`, using the cache when given.
pub fn load_track(path: &Path, sample_rate: u32, cache: Option<&DecodeCache>) -> Result<LoadedTrack> {
    let hash = hash_file(path)?;
    if let Some(c) = cache {
        if let Some(hit) = c.get(&hash, sample_rate) {
            return Ok(LoadedTrack {
                hash,
                data: hit.data,
                sample_rate,
                source_rate: hit.source_rate,
                source_channels: hit.source_channels,
                from_cache: true,
            });
        }
    }
    let d = decode_file(path)?;
    let data = if d.sample_rate == sample_rate {
        d.data
    } else {
        resample_interleaved(&d.data, 2, d.sample_rate, sample_rate)?
    };
    if let Some(c) = cache {
        // A cache write failure only costs speed next time.
        let _ = c.put(&hash, sample_rate, d.sample_rate, d.source_channels, &data);
    }
    Ok(LoadedTrack {
        hash,
        data,
        sample_rate,
        source_rate: d.sample_rate,
        source_channels: d.source_channels,
        from_cache: false,
    })
}

/// File extensions the decoder accepts (lower case, without the dot).
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "mp4", "aac", "alac", "flac", "wav", "wave", "aif", "aiff", "aifc", "ogg", "oga", "caf", "mka",
    "webm",
];

/// True when the path looks like an audio file the decoder can read.
pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}
