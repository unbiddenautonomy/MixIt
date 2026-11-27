//! On-disk stems: a track's vocals, drums and bass, keyed by the file's content hash, the
//! engine sample rate and how they were made ("quick", or a model's name). The fourth
//! stem, melody, is never stored: the engine plays it as the track minus the others, so
//! the stems add back to the track exactly even though they are kept at 16 bits.
//!
//! Like the decode cache, entries are written to a temporary file and renamed, so a crash
//! or a cancelled split never leaves a torn entry.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use mixit_core::ContentHash;

use crate::Result;

const MAGIC: &[u8; 8] = b"MIXITSTM";
const VERSION: u32 = 1;
const HEADER: usize = 8 + 4 + 4 + 8;

/// How stems were made, best first: the trained splitter with cleaner vocals, then the
/// trained splitter alone, then the quick split.
pub const METHODS: &[&str] = &["htdemucs+mel-roformer", "htdemucs", "quick"];

/// Vocals, drums and bass, interleaved stereo.
pub struct CachedStems {
    pub method: &'static str,
    pub parts: [Vec<f32>; 3],
}

#[derive(Clone, Debug)]
pub struct StemCache {
    dir: PathBuf,
}

impl StemCache {
    pub fn new(dir: impl Into<PathBuf>) -> std::io::Result<StemCache> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(StemCache { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, hash: &ContentHash, sr: u32, method: &str) -> PathBuf {
        let hex = hash.to_hex();
        self.dir.join(&hex[..2]).join(format!("{hex}-{sr}-{method}.stems"))
    }

    /// The best method there are stems for, if any.
    pub fn best(&self, hash: &ContentHash, sr: u32) -> Option<&'static str> {
        METHODS.iter().copied().find(|m| self.path(hash, sr, m).exists())
    }

    /// Reads the best stems there are for a track of `frames` frames (stems for another
    /// length, or an unreadable entry, are removed and skipped).
    pub fn get(&self, hash: &ContentHash, sr: u32, frames: usize) -> Option<CachedStems> {
        for &method in METHODS {
            let p = self.path(hash, sr, method);
            let Ok(mut f) = std::fs::File::open(&p) else { continue };
            let mut bytes = Vec::new();
            if f.read_to_end(&mut bytes).is_err() {
                continue;
            }
            match parse(&bytes, sr, frames) {
                Some(parts) => return Some(CachedStems { method, parts }),
                None => {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
        None
    }

    pub fn put(&self, hash: &ContentHash, sr: u32, method: &str, parts: [&[f32]; 3]) -> Result<()> {
        let frames = parts[0].len() / 2;
        if parts.iter().any(|p| p.len() != frames * 2) {
            return Err(crate::IoError::Write("stems of different lengths".into()));
        }
        let p = self.path(hash, sr, method);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = p.with_extension("mixit-tmp");
        {
            let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
            f.write_all(MAGIC)?;
            f.write_all(&VERSION.to_le_bytes())?;
            f.write_all(&sr.to_le_bytes())?;
            f.write_all(&(frames as u64).to_le_bytes())?;
            let mut buf = Vec::with_capacity(1 << 16);
            for part in parts {
                for chunk in part.chunks(1 << 15) {
                    buf.clear();
                    for &v in chunk {
                        let q = (v.clamp(-1.0, 1.0) * 32767.0).round() as i16;
                        buf.extend_from_slice(&q.to_le_bytes());
                    }
                    f.write_all(&buf)?;
                }
            }
            f.flush()?;
        }
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }

    /// Removes every set of stems of a track.
    pub fn remove(&self, hash: &ContentHash, sr: u32) {
        for m in METHODS {
            let _ = std::fs::remove_file(self.path(hash, sr, m));
        }
    }
}

fn parse(bytes: &[u8], sr: u32, frames: usize) -> Option<[Vec<f32>; 3]> {
    if bytes.len() < HEADER || &bytes[..8] != MAGIC {
        return None;
    }
    let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap_or_default());
    if u32_at(8) != VERSION || u32_at(12) != sr {
        return None;
    }
    let n = u64::from_le_bytes(bytes[16..24].try_into().ok()?) as usize;
    if n != frames || bytes.len() != HEADER + n * 2 * 2 * 3 {
        return None;
    }
    let body = &bytes[HEADER..];
    let part = |k: usize| -> Vec<f32> {
        body[k * n * 4..(k + 1) * n * 4]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32767.0)
            .collect()
    };
    Some([part(0), part(1), part(2)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems_round_trip_and_the_model_wins() {
        let dir = std::env::temp_dir().join(format!("mixit-stems-{}", std::process::id()));
        let c = StemCache::new(&dir).unwrap();
        let h = ContentHash([7u8; 32]);
        let a: Vec<f32> = (0..200).map(|i| (i as f32 * 0.1).sin() * 0.5).collect();
        let b = vec![0.25f32; 200];
        let z = vec![0.0f32; 200];
        assert!(c.get(&h, 48_000, 100).is_none());
        c.put(&h, 48_000, "quick", [&a, &b, &z]).unwrap();
        let got = c.get(&h, 48_000, 100).unwrap();
        assert_eq!(got.method, "quick");
        assert!(got.parts[0].iter().zip(&a).all(|(x, y)| (x - y).abs() < 1e-4));
        // Another rate or length is not these stems.
        assert!(c.get(&h, 44_100, 100).is_none());
        assert!(c.get(&h, 48_000, 99).is_none());
        c.put(&h, 48_000, "quick", [&a, &b, &z]).unwrap();
        c.put(&h, 48_000, "htdemucs", [&z, &z, &b]).unwrap();
        assert_eq!(c.best(&h, 48_000), Some("htdemucs"));
        assert_eq!(c.get(&h, 48_000, 100).unwrap().method, "htdemucs");
        c.remove(&h, 48_000);
        assert!(c.best(&h, 48_000).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
