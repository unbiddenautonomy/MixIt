//! Streams recorded audio to disk as it arrives (a set can run for hours).

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use crate::HostError;

/// Incremental WAV writer (24-bit PCM or 32-bit float, stereo).
pub struct StreamingWav {
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    float: bool,
    frames: u64,
    path: PathBuf,
}

impl StreamingWav {
    pub fn create(path: &Path, sample_rate: u32, float: bool) -> Result<StreamingWav, HostError> {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate,
            bits_per_sample: if float { 32 } else { 24 },
            sample_format: if float { hound::SampleFormat::Float } else { hound::SampleFormat::Int },
        };
        let writer = hound::WavWriter::create(path, spec).map_err(|e| HostError::Record(e.to_string()))?;
        Ok(StreamingWav { writer: Some(writer), float, frames: 0, path: path.to_path_buf() })
    }

    /// Appends interleaved stereo samples.
    pub fn write(&mut self, interleaved: &[f32]) -> Result<(), HostError> {
        let w = self.writer.as_mut().ok_or_else(|| HostError::Record("recording already finished".into()))?;
        for &s in interleaved {
            let r = if self.float {
                w.write_sample(s)
            } else {
                w.write_sample((s.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32)
            };
            r.map_err(|e| HostError::Record(e.to_string()))?;
        }
        self.frames += interleaved.len() as u64 / 2;
        Ok(())
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes the header sizes and closes the file.
    pub fn finish(mut self) -> Result<PathBuf, HostError> {
        if let Some(w) = self.writer.take() {
            w.finalize().map_err(|e| HostError::Record(e.to_string()))?;
        }
        Ok(self.path.clone())
    }
}

impl Drop for StreamingWav {
    fn drop(&mut self) {
        if let Some(w) = self.writer.take() {
            let _ = w.finalize();
        }
    }
}
