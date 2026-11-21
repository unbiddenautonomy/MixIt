//! M3U8 playlists (understood by nearly every player and DJ program) and CSV exports.

use std::path::{Path, PathBuf};

use mixit_core::TrackId;

use crate::{Library, Result};

impl Library {
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
