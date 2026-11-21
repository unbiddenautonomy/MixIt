//! VirtualDJ libraries: `database.xml` in the VirtualDJ folder (Documents\VirtualDJ on
//! Windows, ~/Library/Application Support/VirtualDJ or ~/Documents/VirtualDJ on a Mac,
//! and a VirtualDJ folder at the top of each external drive), with playlists in
//! `Playlists/*.m3u` and `MyLists/*.vdjfolder`.
//!
//! Each `<Song FilePath=…>` holds `<Tags>` (details, Stars, a tag tempo), `<Infos>`,
//! `<Comment>`, `<Scan Bpm=… Key=…>` (the analysis; Bpm is the time between two beats
//! in seconds) and `<Poi>` points in seconds: hot cues (`Num` from 1), the beat-grid
//! anchor (`Type="beatgrid"`), saved loops (`Type="loop"`, `Size` in beats), named
//! points (`Type="remix"`), and Automix and action points, which are skipped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use mixit_core::{Beatgrid, Key};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::rekordbox::RekordboxImport;
use crate::{Cue, CueKind, Library, LibraryError, PlaylistKind, Result, TrackId};

/// What an import brought in (the same report as for Rekordbox).
pub type ImportReport = RekordboxImport;

fn attrs(e: &BytesStart) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for a in e.attributes().flatten() {
        let k = a.key.as_ref().to_string();
        let raw = a.value.to_string();
        let v = quick_xml::escape::unescape(&raw).map(|c| c.into_owned()).unwrap_or(raw);
        m.insert(k, v);
    }
    m
}

fn num(m: &HashMap<String, String>, k: &str) -> Option<f64> {
    m.get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite())
}

/// A VirtualDJ tempo: the analysis stores seconds per beat; tags may hold either that or
/// a plain BPM.
pub fn vdj_bpm(v: f64) -> Option<f64> {
    let bpm = if v > 0.0 && v < 10.0 { 60.0 / v } else { v };
    (20.0..=400.0).contains(&bpm).then_some(bpm)
}

#[derive(Default)]
struct Song {
    path: String,
    tags: HashMap<String, String>,
    infos: HashMap<String, String>,
    scan: HashMap<String, String>,
    comment: String,
    pois: Vec<HashMap<String, String>>,
}

/// The VirtualDJ folder for a folder someone picked: itself, or the one inside it.
pub fn find_vdj_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("database.xml").is_file() {
        return Some(dir.to_path_buf());
    }
    let inner = dir.join("VirtualDJ");
    inner.join("database.xml").is_file().then_some(inner)
}

/// A path from a VirtualDJ file: absolute paths as they are; relative ones (on external
/// drives) from the drive root, the folder above the VirtualDJ folder.
fn resolve(vdj_dir: &Path, p: &str) -> PathBuf {
    let b = p.as_bytes();
    let windows_abs = b.len() >= 3 && b[1] == b':' && b[0].is_ascii_alphabetic();
    if windows_abs || p.starts_with('/') || p.starts_with("\\\\") {
        return PathBuf::from(p);
    }
    let base = vdj_dir.parent().unwrap_or(vdj_dir);
    let mut out = base.to_path_buf();
    for part in p.split(['\\', '/']).filter(|s| !s.is_empty()) {
        out.push(part);
    }
    out
}

fn parse_database(text: &str) -> Result<Vec<Song>> {
    let mut r = Reader::from_str(text);
    r.config_mut().trim_text(true);
    let mut songs = Vec::new();
    let mut cur: Option<Song> = None;
    let mut in_comment = false;
    loop {
        let ev = r.read_event().map_err(|e| LibraryError::Xml(e.to_string()))?;
        match ev {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(ev, Event::Empty(_));
                match e.name().as_ref() {
                    "Song" => {
                        let a = attrs(e);
                        let s = Song { path: a.get("FilePath").cloned().unwrap_or_default(), ..Default::default() };
                        if empty {
                            songs.push(s);
                        } else {
                            cur = Some(s);
                        }
                    }
                    "Tags" => {
                        if let Some(c) = cur.as_mut() {
                            c.tags = attrs(e);
                        }
                    }
                    "Infos" => {
                        if let Some(c) = cur.as_mut() {
                            c.infos = attrs(e);
                        }
                    }
                    "Scan" => {
                        if let Some(c) = cur.as_mut() {
                            c.scan = attrs(e);
                        }
                    }
                    "Poi" => {
                        if let Some(c) = cur.as_mut() {
                            c.pois.push(attrs(e));
                        }
                    }
                    "Comment" => in_comment = !empty,
                    _ => {}
                }
            }
            Event::Text(t) if in_comment => {
                if let Some(c) = cur.as_mut() {
                    let raw = t.as_ref().to_string();
                    c.comment.push_str(&quick_xml::escape::unescape(&raw).map(|c| c.into_owned()).unwrap_or(raw));
                }
            }
            Event::End(ref e) => match e.name().as_ref() {
                "Song" => {
                    if let Some(s) = cur.take() {
                        songs.push(s);
                    }
                }
                "Comment" => in_comment = false,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(songs)
}

/// The tracks of a `.vdjfolder` list (`<song path=…>`); `None` for filter folders,
/// whose rules do not carry over.
fn parse_vdjfolder(text: &str) -> Option<Vec<String>> {
    let mut r = Reader::from_str(text);
    r.config_mut().trim_text(true);
    let mut out = Vec::new();
    let mut virtual_folder = false;
    loop {
        match r.read_event().ok()? {
            Event::Start(ref e) | Event::Empty(ref e) => match e.name().as_ref() {
                "VirtualFolder" => virtual_folder = true,
                "FilterFolder" => return None,
                "song" | "Song" => {
                    if let Some(p) = attrs(e).remove("path") {
                        out.push(p);
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    virtual_folder.then_some(out)
}

fn parse_m3u(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect()
}

impl Library {
    /// Imports a VirtualDJ library from its folder (the one holding `database.xml`):
    /// tracks with details, rating, tempo, key and comment; hot cues, saved loops, named
    /// points and the beat grid; and playlists from `Playlists` and `MyLists`, keeping
    /// their folders. Grids and cues only fill tracks that have none, and files that are
    /// not on this computer come in as missing.
    pub fn import_virtualdj(&self, dir: &Path) -> Result<ImportReport> {
        let vdir = find_vdj_dir(dir).ok_or_else(|| {
            LibraryError::Invalid(
                "this folder has no VirtualDJ library (look for database.xml in the VirtualDJ folder)".into(),
            )
        })?;
        let text = std::fs::read_to_string(vdir.join("database.xml"))?;
        let songs = parse_database(&text)?;

        let mut report = ImportReport::default();
        let mut ids: HashMap<PathBuf, TrackId> = HashMap::new();
        let tx = self.begin()?;
        for s in &songs {
            if s.path.is_empty() || s.path.starts_with("netsearch:") || s.path.contains("://") {
                continue;
            }
            let path = resolve(&vdir, &s.path);
            let t = |m: &HashMap<String, String>, k: &str| m.get(k).cloned().filter(|v| !v.trim().is_empty());
            let bpm = num(&s.scan, "Bpm").and_then(vdj_bpm).or_else(|| num(&s.tags, "Bpm").and_then(vdj_bpm));
            let key = t(&s.tags, "Key").or_else(|| t(&s.scan, "Key")).and_then(|k| Key::parse(&k));
            let tags = mixit_io::TrackTags {
                title: t(&s.tags, "Title"),
                artist: t(&s.tags, "Author"),
                album: t(&s.tags, "Album"),
                genre: t(&s.tags, "Genre"),
                label: t(&s.tags, "Label"),
                remixer: t(&s.tags, "Remixer"),
                comment: Some(s.comment.trim().to_string()).filter(|c| !c.is_empty()),
                bpm,
                key: key.map(|k| k.to_string()),
                year: t(&s.tags, "Year").and_then(|y| y.trim().get(..4).and_then(|y| y.parse().ok())),
                duration_s: num(&s.infos, "SongLength").unwrap_or(0.0),
                ..Default::default()
            };
            let id = self.track_for_import(&path, tags, &mut report.missing)?;
            report.tracks += 1;
            ids.insert(path.clone(), id);

            let tr = self.track(id)?;
            let set = |col: &str, v: rusqlite::types::Value| -> Result<()> {
                self.connection()
                    .execute(&format!("UPDATE tracks SET {col} = ? WHERE id = ?"), rusqlite::params![v, id])?;
                Ok(())
            };
            if tr.rating == 0 {
                if let Some(stars) = num(&s.tags, "Stars").map(|v| v.round().clamp(0.0, 5.0) as i64).filter(|v| *v > 0)
                {
                    set("rating", stars.into())?;
                }
            }
            if tr.tag_key.is_none() {
                if let Some(k) = key {
                    set("tag_key", k.to_string().into())?;
                }
            }
            if tr.tag_bpm.is_none() {
                if let Some(b) = bpm {
                    set("tag_bpm", b.into())?;
                }
            }
            if tr.comment.is_empty() && !s.comment.trim().is_empty() {
                set("comment", s.comment.trim().to_string().into())?;
            }

            let sr = tr.sample_rate.unwrap_or(44_100);
            let kind = |p: &HashMap<String, String>| {
                p.get("Type").map(|t| t.to_ascii_lowercase()).unwrap_or_else(|| "cue".into())
            };
            // The grid: VirtualDJ's anchor is a beat; MixIt counts bars from it.
            if let (Some(b), Some(pos)) =
                (bpm, s.pois.iter().filter(|p| kind(p) == "beatgrid").find_map(|p| num(p, "Pos")))
            {
                if self.grid(id)?.is_none() {
                    let mut g = Beatgrid::constant(sr, b, pos * sr as f64);
                    g.confidence = 1.0;
                    self.save_grid(id, &g)?;
                    report.grids += 1;
                }
            }
            if self.cues(id)?.is_empty() {
                let mut cues = Vec::new();
                for p in &s.pois {
                    let Some(pos) = num(p, "Pos").filter(|v| *v >= 0.0) else { continue };
                    let name = p.get("Name").cloned().unwrap_or_default();
                    // VirtualDJ names unnamed cues "Cue 1", "Cue 2"…; MixIt shows the pad number anyway.
                    let label = if name.starts_with("Cue ") && name[4..].trim().parse::<u32>().is_ok() {
                        String::new()
                    } else {
                        name
                    };
                    let color = num(p, "Color").map(|c| (c as i64 as u32) & 0xFF_FFFF);
                    match kind(p).as_str() {
                        "cue" => {
                            let slot =
                                num(p, "Num").map(|n| n as i64 - 1).filter(|n| (0..16).contains(n)).map(|n| n as u8);
                            cues.push(Cue {
                                kind: if slot.is_some() { CueKind::Hot } else { CueKind::Memory },
                                slot,
                                seconds: pos,
                                loop_seconds: None,
                                color,
                                label,
                            });
                        }
                        "loop" => {
                            let beats = num(p, "Size").filter(|v| *v > 0.0);
                            if let (Some(beats), Some(b)) = (beats, bpm) {
                                cues.push(Cue {
                                    kind: CueKind::Memory,
                                    slot: None,
                                    seconds: pos,
                                    loop_seconds: Some(beats * 60.0 / b),
                                    color,
                                    label,
                                });
                            }
                        }
                        "remix" => cues.push(Cue {
                            kind: CueKind::Memory,
                            slot: None,
                            seconds: pos,
                            loop_seconds: None,
                            color,
                            label,
                        }),
                        _ => {}
                    }
                }
                report.cues += cues.len();
                self.set_cues(id, &cues)?;
            }
        }

        // Playlists: Playlists/*.m3u and MyLists/*.vdjfolder, subfolders as folders.
        fn walk(
            lib: &Library,
            vdir: &Path,
            dir: &Path,
            parent: Option<i64>,
            ids: &mut HashMap<PathBuf, TrackId>,
            rep: &mut ImportReport,
        ) -> Result<()> {
            let Ok(rd) = std::fs::read_dir(dir) else { return Ok(()) };
            let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            entries.sort();
            for p in entries {
                let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
                if p.is_dir() {
                    let id = lib.playlist_for_import(&name, PlaylistKind::Folder, parent)?;
                    walk(lib, vdir, &p, Some(id), ids, rep)?;
                    continue;
                }
                let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
                let Ok(text) = std::fs::read_to_string(&p) else { continue };
                let tracks = match ext.as_str() {
                    "m3u" | "m3u8" => parse_m3u(&text),
                    "vdjfolder" => match parse_vdjfolder(&text) {
                        Some(t) => t,
                        None => continue,
                    },
                    _ => continue,
                };
                let mut list = Vec::new();
                for t in tracks {
                    let path = resolve(vdir, &t);
                    let id = match ids.get(&path) {
                        Some(id) => *id,
                        None => {
                            let id = lib.track_for_import(&path, mixit_io::TrackTags::default(), &mut rep.missing)?;
                            ids.insert(path, id);
                            id
                        }
                    };
                    list.push(id);
                }
                let id = lib.playlist_for_import(&name, PlaylistKind::List, parent)?;
                lib.set_playlist_tracks(id, &list)?;
                rep.playlists += 1;
            }
            Ok(())
        }
        walk(self, &vdir, &vdir.join("Playlists"), None, &mut ids, &mut report)?;
        walk(self, &vdir, &vdir.join("MyLists"), None, &mut ids, &mut report)?;
        tx.commit()?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tempos_and_paths() {
        assert!((vdj_bpm(0.5).unwrap() - 120.0).abs() < 1e-9);
        assert!((vdj_bpm(128.0).unwrap() - 128.0).abs() < 1e-9);
        assert!(vdj_bpm(0.0).is_none());
        assert_eq!(resolve(Path::new("/x/VirtualDJ"), "D:\\Music\\a.mp3"), PathBuf::from("D:\\Music\\a.mp3"));
        assert_eq!(
            resolve(Path::new("/Volumes/USB/VirtualDJ"), "Music\\a.mp3"),
            Path::new("/Volumes/USB").join("Music").join("a.mp3")
        );
        assert_eq!(parse_vdjfolder(r#"<FilterFolder filter="bpm &gt; 120" />"#), None);
        assert_eq!(
            parse_vdjfolder(
                r#"<?xml version="1.0"?><VirtualFolder noDuplicates="no"><song path="C:\a.mp3" idx="0" /><song path="C:\b.mp3" idx="1" /></VirtualFolder>"#
            ),
            Some(vec!["C:\\a.mp3".to_string(), "C:\\b.mp3".to_string()])
        );
    }
}
