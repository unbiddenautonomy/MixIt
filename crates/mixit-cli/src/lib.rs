//! The `mixit` command line: everything the engine, analyser and library can do,
//! scriptable from a terminal. The binary is in `main.rs`; the work lives here.

pub mod format;
pub mod ops;
pub mod resolve;

use std::path::PathBuf;

/// Where the library lives unless `--db` or `MIXIT_DB` says otherwise.
pub fn default_db_path() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("MixIt").join("library.db")
}

/// Where decoded audio is cached for instant loading.
pub fn default_cache_dir() -> PathBuf {
    dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("MixIt").join("decoded")
}
