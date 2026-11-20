//! Writing mixes, recordings, stems and edits.
//!
//! Integer formats get TPDF dither (±1 LSB triangular noise) before quantisation, which
//! turns truncation distortion into a constant, inaudible noise floor.

use std::path::Path;

use flacenc::component::BitRepr;
use flacenc::error::Verify;
use mixit_dsp::rng::Rng;

use crate::{IoError, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum WavDepth {
    Pcm16,
    Pcm24,
    Float32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ExportFormat {
    Wav(WavDepth),
    /// FLAC at 16 or 24 bits.
    Flac {
        bits: u8,
    },
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Wav(_) => "wav",
            ExportFormat::Flac { .. } => "flac",
        }
    }
}

/// Quantises to `bits`-bit integers with TPDF dither (deterministic seed).
pub fn quantize_dithered(data: &[f32], bits: u32, seed: u64) -> Vec<i32> {
    let full = (1i64 << (bits - 1)) as f32;
    let max = (full - 1.0) as i32;
    let min = -(full as i32);
    let mut rng = Rng::new(seed);
    data.iter()
        .map(|&v| {
            let x = v.clamp(-1.0, 1.0) * full + rng.tpdf();
            (x.round() as i32).clamp(min, max)
        })
        .collect()
}

/// Writes interleaved audio as WAV.
pub fn write_wav(path: &Path, data: &[f32], channels: u16, sample_rate: u32, depth: WavDepth) -> Result<()> {
    let (bits, fmt) = match depth {
        WavDepth::Pcm16 => (16, hound::SampleFormat::Int),
        WavDepth::Pcm24 => (24, hound::SampleFormat::Int),
        WavDepth::Float32 => (32, hound::SampleFormat::Float),
    };
    let spec = hound::WavSpec { channels, sample_rate, bits_per_sample: bits, sample_format: fmt };
    let mut w = hound::WavWriter::create(path, spec).map_err(|e| IoError::Write(e.to_string()))?;
    match depth {
        WavDepth::Float32 => {
            for &v in data {
                w.write_sample(v).map_err(|e| IoError::Write(e.to_string()))?;
            }
        }
        WavDepth::Pcm16 => {
            for v in quantize_dithered(data, 16, 0x0D17_7E12) {
                w.write_sample(v as i16).map_err(|e| IoError::Write(e.to_string()))?;
            }
        }
        WavDepth::Pcm24 => {
            for v in quantize_dithered(data, 24, 0x0D17_7E12) {
                w.write_sample(v).map_err(|e| IoError::Write(e.to_string()))?;
            }
        }
    }
    w.finalize().map_err(|e| IoError::Write(e.to_string()))
}

/// Writes interleaved audio as FLAC (lossless, about 55–65 % of WAV size).
pub fn write_flac(path: &Path, data: &[f32], channels: u16, sample_rate: u32, bits: u8) -> Result<()> {
    let bits = if bits >= 24 { 24 } else { 16 };
    let samples = quantize_dithered(data, bits as u32, 0x0F1A_C000);
    let config = flacenc::config::Encoder::default().into_verified().map_err(|e| IoError::Write(format!("{e:?}")))?;
    let source =
        flacenc::source::MemSource::from_samples(&samples, channels as usize, bits as usize, sample_rate as usize);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| IoError::Write(format!("{e:?}")))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).map_err(|e| IoError::Write(format!("{e:?}")))?;
    let mut bytes = sink.as_slice().to_vec();
    // STREAMINFO's minimum block size must exclude the final (short) block. flacenc counts
    // it, which makes readers treat the stream as variable-block; fix the field in place.
    if bytes.len() > 12 && &bytes[..4] == b"fLaC" && bytes[4] & 0x7F == 0 {
        let max = [bytes[10], bytes[11]];
        bytes[8] = max[0];
        bytes[9] = max[1];
    }
    std::fs::write(path, &bytes)?;
    Ok(())
}

/// Writes in the chosen format.
pub fn write_audio(path: &Path, data: &[f32], channels: u16, sample_rate: u32, format: ExportFormat) -> Result<()> {
    match format {
        ExportFormat::Wav(d) => write_wav(path, data, channels, sample_rate, d),
        ExportFormat::Flac { bits } => write_flac(path, data, channels, sample_rate, bits),
    }
}
