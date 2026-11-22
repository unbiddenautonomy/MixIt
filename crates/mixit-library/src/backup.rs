//! Library backups: a copy of the whole catalogue (tracks, analysis, grids, cues,
//! playlists, tags, history) in one file, made by hand or automatically once a day, and
//! put back when something went wrong.
//!
//! Backups are written with `VACUUM INTO`, a consistent, compact copy taken while the
//! library stays open. Restoring goes through SQLite's backup API, which writes the pages
//! under SQLite's own locks, so other open connections (background scans) see either the
//! old library or the restored one, never a half-copied file.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::{Library, LibraryError, Result};

/// The file extension of library backups.
pub const EXTENSION: &str = "mixitlib";

/// Automatic backups kept; older ones are removed.
pub const KEEP_AUTO: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    /// Made by hand.
    Manual,
    /// Made by the daily backup.
    Auto,
    /// The library as it was just before a restore.
    BeforeRestore,
}

impl BackupKind {
    fn prefix(self) -> &'static str {
        match self {
            BackupKind::Manual => "library",
            BackupKind::Auto => "auto",
            BackupKind::BeforeRestore => "before-restore",
        }
    }

    fn from_name(name: &str) -> BackupKind {
        if name.starts_with("auto-") {
            BackupKind::Auto
        } else if name.starts_with("before-restore-") {
            BackupKind::BeforeRestore
        } else {
            BackupKind::Manual
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: PathBuf,
    pub kind: BackupKind,
    /// When it was made (Unix seconds).
    pub created: i64,
    pub bytes: u64,
    /// Tracks in it (None when the file could not be read).
    pub tracks: Option<i64>,
}

/// Year, month, day, hour and minute (UTC) of a Unix time.
pub fn civil(unix: i64) -> (i64, u32, u32, u32, u32) {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, (secs / 3_600) as u32, (secs % 3_600 / 60) as u32)
}

/// `auto-2026-11-21-2141.mixitlib` (UTC), with `-2`, `-3`… when that name is taken.
pub fn backup_path(dir: &Path, kind: BackupKind, unix: i64) -> PathBuf {
    let (y, m, d, h, min) = civil(unix);
    let stem = format!("{}-{y:04}-{m:02}-{d:02}-{h:02}{min:02}", kind.prefix());
    let mut p = dir.join(format!("{stem}.{EXTENSION}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}.{EXTENSION}"));
        n += 1;
    }
    p
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Opens a backup read-only and checks that it is a MixIt library this version can read.
/// Returns its number of tracks.
pub fn check(path: &Path) -> Result<i64> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| LibraryError::Invalid("this file is not a MixIt library backup".into()))?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| LibraryError::Invalid("this file is not a MixIt library backup".into()))?;
    if version == 0 {
        return Err(LibraryError::Invalid("this file is not a MixIt library backup".into()));
    }
    if version > crate::schema::SCHEMA_VERSION {
        return Err(LibraryError::Invalid(
            "this backup was made by a newer version of MixIt; update MixIt to restore it".into(),
        ));
    }
    conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
        .map_err(|_| LibraryError::Invalid("this file is not a MixIt library backup".into()))
}

/// The backups in `dir`, newest first.
pub fn list(dir: &Path) -> Vec<BackupInfo> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<BackupInfo> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == EXTENSION))
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            let created = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some(BackupInfo {
                kind: BackupKind::from_name(&name),
                created,
                bytes: meta.len(),
                tracks: check(&path).ok(),
                path,
            })
        })
        .collect();
    out.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| b.path.cmp(&a.path)));
    out
}

/// Removes all but the newest `keep` automatic backups. Hand-made ones stay.
pub fn prune(dir: &Path, keep: usize) {
    for b in list(dir).into_iter().filter(|b| b.kind == BackupKind::Auto).skip(keep) {
        let _ = std::fs::remove_file(&b.path);
    }
}

/// Whether the daily backup is due: no automatic backup in the last `every` seconds.
pub fn due(dir: &Path, every: i64, unix: i64) -> bool {
    !list(dir).iter().any(|b| b.kind == BackupKind::Auto && unix - b.created < every)
}

impl Library {
    /// Writes a consistent copy of the whole library to `path`.
    pub fn backup_to(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if path.exists() {
            std::fs::remove_file(path)?;
        }
        self.conn.execute("VACUUM INTO ?", [path.to_string_lossy()])?;
        Ok(())
    }

    /// A new backup of `kind` in `dir`. Returns its path.
    pub fn backup_into(&self, dir: &Path, kind: BackupKind) -> Result<PathBuf> {
        let p = backup_path(dir, kind, now());
        self.backup_to(&p)?;
        Ok(p)
    }

    /// The daily backup: makes one in `dir` when none was made in the last day, and
    /// keeps the newest [`KEEP_AUTO`]. Returns the new backup's path, if one was made.
    pub fn auto_backup(&self, dir: &Path) -> Result<Option<PathBuf>> {
        if !due(dir, 86_400, now()) {
            return Ok(None);
        }
        let p = self.backup_into(dir, BackupKind::Auto)?;
        prune(dir, KEEP_AUTO);
        Ok(Some(p))
    }

    /// Replaces the library with a backup, after saving the current one in `dir` (so a
    /// restore can be undone). Returns the path of that safety copy.
    pub fn restore_from(&mut self, backup: &Path, dir: &Path) -> Result<PathBuf> {
        check(backup)?;
        let safety = self.backup_into(dir, BackupKind::BeforeRestore)?;
        self.conn.restore(rusqlite::MAIN_DB, backup, None::<fn(rusqlite::backup::Progress)>).map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::DatabaseBusy => {
                LibraryError::Invalid(
                    "the library is busy (a scan or analysis is running); try again when it finishes".into(),
                )
            }
            e => e.into(),
        })?;
        // An older backup is brought up to this version's schema.
        crate::schema::migrate(&mut self.conn)?;
        Ok(safety)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_names() {
        assert_eq!(civil(0), (1970, 1, 1, 0, 0));
        // 2024-02-29 13:05 UTC.
        assert_eq!(civil(1_709_211_900), (2024, 2, 29, 13, 5));
        assert_eq!(civil(1_795_297_260), (2026, 11, 21, 21, 41));
        let dir = std::env::temp_dir().join(format!("mixit-backup-names-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = backup_path(&dir, BackupKind::Auto, 1_795_297_260);
        assert_eq!(a.file_name().unwrap(), "auto-2026-11-21-2141.mixitlib");
        std::fs::write(&a, b"x").unwrap();
        assert_eq!(
            backup_path(&dir, BackupKind::Auto, 1_795_297_260).file_name().unwrap(),
            "auto-2026-11-21-2141-2.mixitlib"
        );
        assert!(check(&a).is_err(), "not a library");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
