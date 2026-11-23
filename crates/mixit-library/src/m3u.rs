//! M3U8 playlists (understood by nearly every player and DJ program) and CSV exports.

use std::path::{Path, PathBuf};

use mixit_core::TrackId;

use crate::{Library, Result};

/// What copying a playlist's files did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CopyReport {
    /// The folder the files went into.
    pub folder: PathBuf,
    /// The playlist written next to them.
    pub playlist: PathBuf,
    pub copied: usize,
    /// Already there with the same size (a second copy to the same stick is quick).
    pub kept: usize,
    /// Tracks whose files could not be copied, with why.
    pub failed: Vec<(TrackId, String)>,
    /// Stopped before the end.
    pub cancelled: bool,
}

/// A name that is safe as a file or folder name on Windows, macOS and USB sticks (FAT).
pub fn safe_file_name(s: &str) -> String {
    let mut out: String =
        s.chars()
            .map(|c| {
                if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                    '_'
                } else {
                    c
                }
            })
            .collect();
    out = out.trim().trim_end_matches(['.', ' ']).to_string();
    // Windows refuses its device names as a file name, with or without an extension
    // ("CON", "com3.wav").
    let stem = out.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if out.is_empty() || reserved {
        out = format!("_{out}");
    }
    // Long names break on some players and file systems.
    if out.chars().count() > 120 {
        out = out.chars().take(120).collect::<String>().trim_end().to_string();
    }
    out
}

impl Library {
    /// Copies the tracks' files into `dest/<name>/` with a playlist (`<name>.m3u8`, paths
    /// relative to it) beside them, so the set plays from a USB stick on other gear or
    /// another computer. `numbered` names files "01 Artist - Title" in playlist order;
    /// otherwise they keep their names. Files already there with the same size are kept.
    /// `progress(done, total, title)` is called per track; `cancel` stops between files.
    pub fn copy_files(
        &self,
        tracks: &[TrackId],
        dest: &Path,
        name: &str,
        numbered: bool,
        cancel: &std::sync::atomic::AtomicBool,
        mut progress: impl FnMut(usize, usize, &str),
    ) -> Result<CopyReport> {
        let folder = dest.join(safe_file_name(name));
        std::fs::create_dir_all(&folder)?;
        let mut rep = CopyReport {
            folder: folder.clone(),
            playlist: folder.join(format!("{}.m3u8", safe_file_name(name))),
            ..Default::default()
        };
        let width = tracks.len().to_string().len().max(2);
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut m3u = String::from("#EXTM3U\n");
        for (i, &id) in tracks.iter().enumerate() {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                rep.cancelled = true;
                break;
            }
            let t = self.track(id)?;
            progress(i, tracks.len(), &t.display_title());
            if t.missing || !t.path.is_file() {
                rep.failed.push((id, format!("{}: the file is missing", t.display_title())));
                continue;
            }
            let ext = t.path.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
            let stem = if numbered {
                let who = if t.artist.is_empty() { String::new() } else { format!("{} - ", t.artist) };
                safe_file_name(&format!("{:0width$} {who}{}", i + 1, t.display_title()))
            } else {
                safe_file_name(&t.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default())
            };
            // Two tracks with the same name get "(2)", "(3)"…
            let mut file = if ext.is_empty() { stem.clone() } else { format!("{stem}.{ext}") };
            let mut n = 2;
            while !used.insert(file.to_lowercase()) {
                file = if ext.is_empty() { format!("{stem} ({n})") } else { format!("{stem} ({n}).{ext}") };
                n += 1;
            }
            let target = folder.join(&file);
            let size = std::fs::metadata(&t.path).map(|m| m.len()).unwrap_or(0);
            if std::fs::metadata(&target).is_ok_and(|m| m.len() == size) {
                rep.kept += 1;
            } else {
                match std::fs::copy(&t.path, &target) {
                    Ok(_) => rep.copied += 1,
                    Err(e) => {
                        let _ = std::fs::remove_file(&target);
                        rep.failed.push((id, format!("{}: {e}", t.display_title())));
                        continue;
                    }
                }
            }
            let who = if t.artist.is_empty() { String::new() } else { format!("{} - ", t.artist) };
            m3u.push_str(&format!("#EXTINF:{},{}{}\n{file}\n", t.duration.round() as i64, who, t.display_title()));
        }
        progress(tracks.len(), tracks.len(), "");
        std::fs::write(&rep.playlist, m3u)?;
        Ok(rep)
    }

    /// Writes a playlist as extended M3U8. With `relative`, paths are written relative
    /// to the playlist file's folder when possible (portable USB sticks).
    pub fn export_m3u(&self, tracks: &[TrackId], out: &Path, relative: bool) -> Result<()> {
        let base = out.parent().map(Path::to_path_buf).unwrap_or_default();
        let mut s = String::from("#EXTM3U\n");
        for &id in tracks {
            let t = self.track(id)?;
            let who = if t.artist.is_empty() { String::new() } else { format!("{} - ", t.artist) };
            s.push_str(&format!("#EXTINF:{},{}{}\n", t.duration.round() as i64, who, t.display_title()));
            let p = if relative {
                t.path.strip_prefix(&base).map(Path::to_path_buf).unwrap_or(t.path.clone())
            } else {
                t.path.clone()
            };
            s.push_str(&p.to_string_lossy());
            s.push('\n');
        }
        std::fs::write(out, s)?;
        Ok(())
    }

    /// Reads an M3U/M3U8 playlist, importing files not yet in the library. Returns the
    /// track ids in order and the entries that could not be found.
    pub fn import_m3u(&self, file: &Path) -> Result<(Vec<TrackId>, Vec<String>)> {
        let text = std::fs::read(file)?;
        let text = String::from_utf8_lossy(&text);
        let base = file.parent().map(Path::to_path_buf).unwrap_or_default();
        let mut ids = Vec::new();
        let mut missing = Vec::new();
        for line in text.lines() {
            let line = line.trim().trim_start_matches('\u{feff}');
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let raw = line.strip_prefix("file://").map(percent_decode).unwrap_or_else(|| line.to_string());
            let mut p = PathBuf::from(&raw);
            if p.is_relative() {
                p = base.join(p);
            }
            if !p.exists() {
                missing.push(line.to_string());
                continue;
            }
            match self.import_file(&p) {
                Ok(r) => ids.push(match r {
                    crate::scan::Imported::Added(i)
                    | crate::scan::Imported::Updated(i)
                    | crate::scan::Imported::Moved(i)
                    | crate::scan::Imported::Unchanged(i) => i,
                }),
                Err(_) => missing.push(line.to_string()),
            }
        }
        Ok((ids, missing))
    }

    /// CSV of tracks for spreadsheets (artist, title, BPM, key, energy, duration, path).
    pub fn export_csv(&self, tracks: &[TrackId], out: &Path) -> Result<()> {
        let esc = |s: &str| {
            if s.contains([',', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
        };
        let mut s = String::from("artist,title,album,genre,bpm,key,camelot,energy,duration,rating,path\n");
        for &id in tracks {
            let t = self.track(id)?;
            let key = t.best_key();
            s.push_str(&format!(
                "{},{},{},{},{},{},{},{},{:.0},{},{}\n",
                esc(&t.artist),
                esc(&t.display_title()),
                esc(&t.album),
                esc(&t.genre),
                t.best_bpm().map(|b| format!("{b:.2}")).unwrap_or_default(),
                key.map(|k| k.standard_name()).unwrap_or_default(),
                key.map(|k| format!("{}{}", k.camelot().0, k.camelot().1)).unwrap_or_default(),
                t.energy.map(|e| e.to_string()).unwrap_or_default(),
                t.duration,
                t.rating,
                esc(&t.path.to_string_lossy()),
            ));
        }
        std::fs::write(out, s)?;
        Ok(())
    }
}

/// Decodes %XX escapes (file URLs).
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Encodes a path as a file URL path component (RFC 3986 unreserved characters and `/`).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &c in s.as_bytes() {
        if c.is_ascii_alphanumeric() || b"-._~/:".contains(&c) {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}
