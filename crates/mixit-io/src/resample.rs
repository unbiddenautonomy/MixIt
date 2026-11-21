//! Sample-rate conversion with rubato's FFT resampler (synchronous, linear phase,
//! better than −140 dB aliasing in the passband).

use audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

use crate::{IoError, Result};

/// Resamples interleaved audio with `channels` channels from `from` Hz to `to` Hz.
pub fn resample_interleaved(data: &[f32], channels: usize, from: u32, to: u32) -> Result<Vec<f32>> {
    if from == to || data.is_empty() {
        return Ok(data.to_vec());
    }
    let frames = data.len() / channels;
    let mut r = Fft::<f32>::new(from as usize, to as usize, 1_024, channels, FixedSync::Input)
        .map_err(|e| IoError::Resample(e.to_string()))?;
    let input = InterleavedSlice::new(data, channels, frames).map_err(|e| IoError::Resample(e.to_string()))?;
    let out = r.process_all(&input, frames, None).map_err(|e| IoError::Resample(e.to_string()))?;
    Ok(out.take_data())
}
