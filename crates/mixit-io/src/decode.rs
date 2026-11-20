//! Decoding with Symphonia to interleaved stereo `f32` at the file's own rate.

use std::fs::File;
use std::path::Path;

use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::{IoError, Result};

#[derive(Debug, Clone)]
pub struct Decoded {
    pub sample_rate: u32,
    /// Channels in the source (the data is always stereo: mono is duplicated, and more
    /// than two channels are folded down with ITU-style gains).
    pub source_channels: u16,
    /// Interleaved stereo.
    pub data: Vec<f32>,
}

impl Decoded {
    pub fn frames(&self) -> usize {
        self.data.len() / 2
    }
    pub fn seconds(&self) -> f64 {
        self.frames() as f64 / self.sample_rate as f64
    }
}

/// Decodes a whole file.
pub fn decode_file(path: &Path) -> Result<Decoded> {
    let file = File::open(path).map_err(|e| IoError::Open { path: path.to_path_buf(), source: e })?;
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    decode_source(Box::new(file), hint)
}

/// Decodes audio held in memory (drag-and-drop, downloads, tests).
pub fn decode_bytes(bytes: Vec<u8>, extension: Option<&str>) -> Result<Decoded> {
    let mut hint = Hint::new();
    if let Some(ext) = extension {
        hint.with_extension(ext);
    }
    decode_source(Box::new(std::io::Cursor::new(bytes)), hint)
}

fn decode_source(src: Box<dyn symphonia::core::io::MediaSource>, hint: Hint) -> Result<Decoded> {
    let mss = MediaSourceStream::new(src, Default::default());
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| IoError::Unsupported(e.to_string()))?;
    let track = format.default_track(TrackType::Audio).ok_or(IoError::Empty)?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| IoError::Unsupported("no audio codec parameters".into()))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| IoError::Unsupported(e.to_string()))?;

    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut channels = params.channels.as_ref().map(|c| c.count()).unwrap_or(0);
    let mut out: Vec<f32> = Vec::new();
    let mut scratch: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(IoError::Decode(e.to_string())),
        };
        if packet.track_id != track_id {
            continue;
        }
        let buf = match decoder.decode(&packet) {
            Ok(b) => b,
            // Corrupt frames are skipped, as every player does.
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(IoError::Decode(e.to_string())),
        };
        let spec = buf.spec();
        sample_rate = spec.rate();
        channels = spec.channels().count();
        if buf.frames() == 0 || channels == 0 {
            continue;
        }
        scratch.resize(buf.samples_interleaved(), 0.0);
        buf.copy_to_slice_interleaved(&mut scratch);
        fold_to_stereo(&scratch, channels, &mut out);
    }
    if out.is_empty() || sample_rate == 0 {
        return Err(IoError::Empty);
    }
    Ok(Decoded { sample_rate, source_channels: channels as u16, data: out })
}

/// Appends interleaved `channels`-channel audio to `out` as stereo.
fn fold_to_stereo(x: &[f32], channels: usize, out: &mut Vec<f32>) {
    let frames = x.len() / channels;
    out.reserve(frames * 2);
    match channels {
        1 => {
            for &v in x {
                out.push(v);
                out.push(v);
            }
        }
        2 => out.extend_from_slice(&x[..frames * 2]),
        _ => {
            // L, R, C, LFE, Ls, Rs …: centre and surrounds at −3 dB, LFE dropped.
            const G: f32 = std::f32::consts::FRAC_1_SQRT_2;
            for f in x.chunks_exact(channels) {
                let c = if channels > 2 { f[2] } else { 0.0 };
                let (sl, sr) = if channels >= 6 { (f[4], f[5]) } else { (0.0, 0.0) };
                let l = f[0] + G * c + G * sl;
                let r = f[1] + G * c + G * sr;
                let norm = 1.0 / (1.0 + G + if channels >= 6 { G } else { 0.0 });
                out.push(l * norm);
                out.push(r * norm);
            }
        }
    }
}
