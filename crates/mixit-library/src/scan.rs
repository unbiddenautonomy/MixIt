//! Importing files and folders.
//!
//! A scan walks a folder, adds new audio files, refreshes files whose size or
//! modification time changed, recognises moved files by their content hash (so cues,
//! grids and history follow a file to its new place) and flags files that vanished.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use mixit_core::TrackId;
use serde::{Deserialize, Serialize};

use crate::{Library, NewTrack, Result};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ScanReport {
    pub added: Vec<TrackId>,
    pub updated: Vec<TrackId>,
    /// Files recognised by content at a new path.
    pub moved: Vec<TrackId>,
    pub missing: Vec<TrackId>,
    pub unchanged: usize,
    /// Files that could not be read: (path, error).
    pub errors: Vec<(PathBuf, String)>,
}

/// What happened to one file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Imported {
    Added(TrackId),
    Updated(TrackId),
    Moved(TrackId),
    Unchanged(TrackId),
}

fn file_info(path: &Path) -> std::io::Result<(u64, i64)> {
    let m = std::fs::metadata(path)?;
    let mtime =
        m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
    Ok((m.len(), mtime))
}

fn read_new(path: &Path, size: u64, mtime: i64) -> Result<NewTrack> {
    let hash = mixit_io::hash_file(path)?;
    let tags = mixit_io::read_tags(path).unwrap_or_default();
    Ok(NewTrack { path: path.to_path_buf(), hash: Some(hash), file_size: size, file_mtime: mtime, tags })
}

impl Library {
    /// Adds or refreshes a single file.
    pub fn import_file(&self, path: &Path) -> Result<Imported> {
        let (size, mtime) = file_info(path)?;
        if let Some(t) = self.track_by_path(path)? {
            if t.file_size == size && t.file_mtime == mtime && !t.missing {
                return Ok(Imported::Unchanged(t.id));
            }
            let nt = read_new(path, size, mtime)?;
            self.refresh_track(t.id, &nt)?;
            return Ok(Imported::Updated(t.id));
        }
        let nt = read_new(path, size, mtime)?;
        let hex = nt.hash.map(|h| h.to_hex()).unwrap_or_default();
        // A missing track with the same audio moved here.
        if let Some(t) = self.tracks_by_hash(&hex)?.into_iter().find(|t| t.missing || !t.path.exists()) {
            self.refresh_track(t.id, &nt)?;
            return Ok(Imported::Moved(t.id));
        }
        Ok(Imported::Added(self.insert_track(&nt)?))
    }

    /// Looks through a folder for the files of missing tracks and points the tracks at
    /// them: a file with the same name (and the same size, when several have it), or with
    /// the same audio when the name changed. Returns the tracks found and where.
    pub fn find_missing_in(&self, root: &Path) -> Result<Vec<(TrackId, PathBuf)>> {
        let missing = self.missing_tracks()?;
        if missing.is_empty() {
            return Ok(vec![]);
        }
        let files: Vec<PathBuf> = walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && mixit_io::is_audio_file(e.path()))
            .filter(|e| !e.file_name().to_string_lossy().starts_with("._"))
            .map(|e| e.into_path())
            .collect();
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_lowercase());
        let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).ok();
        let taken: HashSet<PathBuf> = self.all_tracks()?.into_iter().filter(|t| !t.missing).map(|t| t.path).collect();
        let mut used: HashSet<PathBuf> = HashSet::new();
        let mut found = vec![];
        let mut unmatched = vec![];
        for t in &missing {
            let same_name: Vec<&PathBuf> = files
                .iter()
                .filter(|f| name(f) == name(&t.path) && !taken.contains(*f) && !used.contains(*f))
                .collect();
            let pick = match same_name.len() {
                0 => None,
                1 => Some(same_name[0]),
                _ => same_name.iter().copied().find(|f| size(f) == Some(t.file_size)).or(Some(same_name[0])),
            };
            match pick {
                Some(f) => {
                    used.insert(f.clone());
                    found.push((t.id, f.clone()));
                }
                None if t.hash.is_some() => unmatched.push(t),
                None => {}
            }
        }
        // Renamed files: the same bytes, so the same size and hash. Only files of a
        // matching size are hashed.
        if !unmatched.is_empty() {
            let rest: Vec<&PathBuf> = files.iter().filter(|f| !taken.contains(*f) && !used.contains(*f)).collect();
            for f in rest {
                let Some(sz) = size(f) else { continue };
                if !unmatched.iter().any(|t| t.file_size == sz) {
                    continue;
                }
                let Ok(h) = mixit_io::hash_file(f).map(|h| h.to_hex()) else { continue };
                if let Some(i) = unmatched.iter().position(|t| t.hash.as_deref() == Some(h.as_str())) {
                    let t = unmatched.remove(i);
                    used.insert(f.clone());
                    found.push((t.id, f.clone()));
                    if unmatched.is_empty() {
                        break;
                    }
                }
            }
        }
        let tx = self.begin()?;
        for (id, p) in &found {
            self.relocate(*id, p)?;
        }
        tx.commit()?;
        Ok(found)
    }

    /// Scans a folder recursively. `progress(done_files, path)` is called per file.
    pub fn scan_folder(&self, root: &Path, mut progress: impl FnMut(usize, &Path)) -> Result<ScanReport> {
        let mut report = ScanReport::default();
        let mut seen: HashSet<TrackId> = HashSet::new();
        let files: Vec<PathBuf> = walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && mixit_io::is_audio_file(e.path()))
            .filter(|e| !e.file_name().to_string_lossy().starts_with("._"))
            .map(|e| e.into_path())
            .collect();
        let tx = self.begin()?;
        for (i, f) in files.iter().enumerate() {
            progress(i, f);
            match self.import_file(f) {
                Ok(Imported::Added(id)) => {
                    seen.insert(id);
                    report.added.push(id);
                }
                Ok(Imported::Updated(id)) => {
                    seen.insert(id);
                    report.updated.push(id);
                }
                Ok(Imported::Moved(id)) => {
                    seen.insert(id);
                    report.moved.push(id);
                }
                Ok(Imported::Unchanged(id)) => {
                    seen.insert(id);
                    report.unchanged += 1;
                }
                Err(e) => report.errors.push((f.clone(), e.to_string())),
            }
        }
        // Tracks under this folder that were not found.
        let prefix = root.to_string_lossy().into_owned();
        for t in self.all_tracks()? {
            if t.path.to_string_lossy().starts_with(&prefix) && !seen.contains(&t.id) && !t.path.exists() && !t.missing
            {
                self.set_missing(t.id, true)?;
                report.missing.push(t.id);
            }
        }
        tx.commit()?;
        self.mark_folder_scanned(root)?;
        Ok(report)
    }

    /// Rescans every watched folder.
    pub fn rescan_all(&self, mut progress: impl FnMut(usize, &Path)) -> Result<ScanReport> {
        let mut total = ScanReport::default();
        for f in self.folders()? {
            let r = self.scan_folder(&f, &mut progress)?;
            total.added.extend(r.added);
            total.updated.extend(r.updated);
            total.moved.extend(r.moved);
            total.missing.extend(r.missing);
            total.unchanged += r.unchanged;
            total.errors.extend(r.errors);
        }
        Ok(total)
    }
}
