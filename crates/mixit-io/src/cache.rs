//! On-disk cache of decoded audio, keyed by content hash and sample rate.
//!
//! Decoding a 6-minute MP3 takes 100–300 ms; reading the cached PCM takes about 10 ms.
//! Entries are written to a temporary file and renamed, so a crash never leaves a torn
//! entry, and the cache can be pruned to a size budget (oldest first).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use mixit_core::ContentHash;

use crate::Result;

const MAGIC: &[u8; 8] = b"MIXITPCM";
const VERSION: u32 = 1;
const HEADER: usize = 8 + 4 + 4 + 4 + 2 + 8;

pub struct CachedAudio {
    pub data: Vec<f32>,
    pub source_rate: u32,
    pub source_channels: u16,
}

#[derive(Clone, Debug)]
pub struct DecodeCache {
    dir: PathBuf,
}

impl DecodeCache {
    pub fn new(dir: impl Into<PathBuf>) -> std::io::Result<DecodeCache> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(DecodeCache { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, hash: &ContentHash, sr: u32) -> PathBuf {
        let hex = hash.to_hex();
        self.dir.join(&hex[..2]).join(format!("{hex}-{sr}.pcm"))
    }

    pub fn contains(&self, hash: &ContentHash, sr: u32) -> bool {
        self.path(hash, sr).exists()
    }

    /// Reads an entry, or `None` if missing or unreadable (a bad entry is removed).
    pub fn get(&self, hash: &ContentHash, sr: u32) -> Option<CachedAudio> {
        let p = self.path(hash, sr);
        let mut f = std::fs::File::open(&p).ok()?;
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).ok()?;
        let parsed = parse(&bytes, sr);
        if parsed.is_none() {
            let _ = std::fs::remove_file(&p);
        } else {
            // Touch for least-recently-used pruning.
            let _ = std::fs::File::options()
                .append(true)
                .open(&p)
                .and_then(|f| f.set_modified(std::time::SystemTime::now()));
        }
        parsed
    }

    pub fn put(&self, hash: &ContentHash, sr: u32, source_rate: u32, source_channels: u16, data: &[f32]) -> Result<()> {
        let p = self.path(hash, sr);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = p.with_extension("mixit-tmp");
        {
            let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
            f.write_all(MAGIC)?;
            f.write_all(&VERSION.to_le_bytes())?;
            f.write_all(&sr.to_le_bytes())?;
            f.write_all(&source_rate.to_le_bytes())?;
            f.write_all(&source_channels.to_le_bytes())?;
            f.write_all(&((data.len() / 2) as u64).to_le_bytes())?;
            for v in data {
                f.write_all(&v.to_le_bytes())?;
            }
            f.flush()?;
        }
        std::fs::rename(&tmp, &p)?;
        Ok(())
    }

    /// Total bytes used.
    pub fn size(&self) -> u64 {
        self.entries().iter().map(|e| e.1).sum()
    }

    fn entries(&self) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
        let mut out = Vec::new();
        let Ok(dirs) = std::fs::read_dir(&self.dir) else { return out };
        for d in dirs.flatten() {
            let Ok(files) = std::fs::read_dir(d.path()) else { continue };
            for f in files.flatten() {
                if let Ok(m) = f.metadata() {
                    if m.is_file() {
                        out.push((f.path(), m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)));
                    }
                }
            }
        }
        out
    }

    /// Deletes the least recently used entries until the cache fits in `max_bytes`.
    pub fn prune(&self, max_bytes: u64) -> u64 {
        let mut e = self.entries();
        e.sort_by_key(|x| x.2);
        let mut total: u64 = e.iter().map(|x| x.1).sum();
        let mut freed = 0;
        for (p, len, _) in e {
            if total <= max_bytes {
                break;
            }
            if std::fs::remove_file(&p).is_ok() {
                total -= len;
                freed += len;
            }
        }
        freed
    }
}

fn parse(b: &[u8], sr: u32) -> Option<CachedAudio> {
    if b.len() < HEADER || &b[..8] != MAGIC {
        return None;
    }
    let u32_at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    if u32_at(8) != VERSION || u32_at(12) != sr {
        return None;
    }
    let source_rate = u32_at(16);
    let source_channels = u16::from_le_bytes(b[20..22].try_into().unwrap());
    let frames = u64::from_le_bytes(b[22..30].try_into().unwrap()) as usize;
    let body = &b[HEADER..];
    if body.len() != frames * 8 {
        return None;
    }
    let data = body.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
    Some(CachedAudio { data, source_rate, source_channels })
}
