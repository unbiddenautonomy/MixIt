//! Content hashing: identifies a track by its bytes, not its path.

use std::io::Read;
use std::path::Path;

use mixit_core::ContentHash;

use crate::{IoError, Result};

/// BLAKE3 of the whole file (streamed, about 1–2 GB/s).
pub fn hash_file(path: &Path) -> Result<ContentHash> {
    let mut f = std::fs::File::open(path).map_err(|e| IoError::Open { path: path.to_path_buf(), source: e })?;
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(ContentHash(*h.finalize().as_bytes()))
}

pub fn hash_bytes(bytes: &[u8]) -> ContentHash {
    ContentHash(*blake3::hash(bytes).as_bytes())
}
