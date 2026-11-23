//! The `mixit` command line: everything the engine, analyser and library can do,
//! scriptable from a terminal. The binary is in `main.rs`; the work lives here.

pub mod format;
pub mod ops;
pub mod resolve;

use std::path::PathBuf;

/// Where the library lives unless `--db` or `MIXIT_DB` says otherwise.
/// The same file the desktop app uses (see `mixit_host::platform`).
pub fn default_db_path() -> PathBuf {
    mixit_host::platform::AppDirs::system().db
}

/// Where decoded audio is cached for instant loading.
pub fn default_cache_dir() -> PathBuf {
    mixit_host::platform::AppDirs::system().cache
}
