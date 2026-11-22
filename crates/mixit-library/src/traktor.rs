//! Traktor collections (`collection.nml`): bringing a Traktor DJ's library across with
//! its tempos, beat grids, keys, hot cues, loops, ratings and playlists.
//!
//! Traktor names files by volume, a directory written with `/:` separators, and a file
//! name; cue positions and loop lengths are in milliseconds; ratings run 0–255; keys are
//! numbered 0–23 (C major to B major, then C minor to B minor).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use mixit_core::{Beatgrid, Key};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::rekordbox::RekordboxImport;
use crate::{Cue, CueKind, Library, LibraryError, PlaylistKind, Result};

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

/// A Traktor location as a local path. `C:` volumes are Windows drives; on a Mac other
/// volumes live under /Volumes, and the start-up disk is the root.
pub fn nml_path(volume: &str, dir: &str, file: &str) -> PathBuf {
    let parts: Vec<&str> = dir.split("/:").filter(|s| !s.is_empty()).collect();
    let v = volume.trim();
    if v.len() == 2 && v.ends_with(':') && v.as_bytes()[0].is_ascii_alphabetic() {
        let mut s = format!("{v}\\");
        for p in &parts {
            s.push_str(p);
            s.push('\\');
        }
        s.push_str(file);
        return PathBuf::from(s);
    }
    let mut p = if !v.is_empty() && Path::new("/Volumes").join(v).is_dir() && !is_boot_volume(v) {
        Path::new("/Volumes").join(v)
    } else {
        PathBuf::from("/")
    };
    for part in parts {
        p.push(part);
    }
    p.push(file);
    p
}

/// A path as Traktor names it: (volume, directory with `/:` separators, file name).
/// Windows drives are volumes (`C:`); on a Mac a disk under /Volumes is its volume, and
/// anything else is written without one (Traktor then looks on the start-up disk).
pub fn nml_location(path: &Path) -> (String, String, String) {
    let s = path.to_string_lossy().replace('\\', "/");
    let b = s.as_bytes();
    let (volume, rest) = if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        (s[..2].to_string(), &s[2..])
    } else if let Some(r) = s.strip_prefix("/Volumes/") {
        match r.split_once('/') {
            Some((v, rest)) => (v.to_string(), rest),
            None => (String::new(), s.as_str()),
        }
    } else {
        (String::new(), s.as_str())
    };
    let mut parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
    let file = parts.pop().unwrap_or_default().to_string();
    let mut dir = String::from("/:");
    for p in parts {
        dir.push_str(p);
        dir.push_str("/:");
    }
    (volume, dir, file)
}

fn esc(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

/// The Mac start-up disk shows under /Volumes as a link to /.
fn is_boot_volume(v: &str) -> bool {
    std::fs::canonicalize(Path::new("/Volumes").join(v)).is_ok_and(|p| p == Path::new("/"))
}

/// Traktor's key number (0–23) as a key.
pub fn key_from_traktor(v: i64) -> Option<Key> {
    (0..24).contains(&v).then(|| Key::from_index(v as usize))
}

#[derive(Default)]
struct Entry {
    a: HashMap<String, String>,
    location: HashMap<String, String>,
    album: Option<String>,
    info: HashMap<String, String>,
    bpm: Option<f64>,
    key: Option<i64>,
    cues: Vec<HashMap<String, String>>,
}

impl Entry {
    /// Traktor's own key for the file, as playlists refer to it.
    fn primary_key(&self) -> String {
        let g = |k: &str| self.location.get(k).map(String::as_str).unwrap_or("");
        format!("{}{}{}", g("VOLUME"), g("DIR"), g("FILE"))
    }
}

enum Node {
    Folder(String, Vec<Node>),
    List(String, Vec<String>),
}

impl Library {
    /// Imports a Traktor `collection.nml`: tracks (missing files are added as missing so
    /// playlists stay whole), tempo and beat grid, key, rating, comment, hot cues and
    /// loops, and playlists in their folders. Grids and cues only fill tracks that have
    /// none yet, so nothing set up in MixIt is overwritten.
    pub fn import_traktor_nml(&self, file: &Path) -> Result<ImportReport> {
        let text = std::fs::read_to_string(file)?;
        let mut r = Reader::from_str(&text);
        r.config_mut().trim_text(true);
        let mut entries: Vec<Entry> = Vec::new();
        let mut cur: Option<Entry> = None;
        let mut in_collection = false;
        let mut in_playlists = false;
        // (name, is list, children, track keys)
        let mut stack: Vec<(String, bool, Vec<Node>, Vec<String>)> = Vec::new();
        let mut roots: Vec<Node> = Vec::new();
        loop {
            let ev = r.read_event().map_err(|e| LibraryError::Xml(e.to_string()))?;
            match ev {
                Event::Start(ref e) | Event::Empty(ref e) => {
                    let empty = matches!(ev, Event::Empty(_));
                    match e.name().as_ref() {
                        "COLLECTION" => in_collection = !empty,
                        "PLAYLISTS" => in_playlists = !empty,
                        "ENTRY" if in_collection => {
                            let en = Entry { a: attrs(e), ..Default::default() };
                            if empty {
                                entries.push(en);
                            } else {
                                cur = Some(en);
                            }
                        }
                        "LOCATION" => {
                            if let Some(c) = cur.as_mut() {
                                c.location = attrs(e);
                            }
                        }
                        "ALBUM" => {
                            if let Some(c) = cur.as_mut() {
                                c.album = attrs(e).remove("TITLE");
                            }
                        }
                        "INFO" => {
                            if let Some(c) = cur.as_mut() {
                                c.info = attrs(e);
                            }
                        }
                        "TEMPO" => {
                            if let Some(c) = cur.as_mut() {
                                c.bpm = num(&attrs(e), "BPM").filter(|b| *b > 0.0);
                            }
                        }
                        "MUSICAL_KEY" => {
                            if let Some(c) = cur.as_mut() {
                                c.key = num(&attrs(e), "VALUE").map(|v| v as i64);
                            }
                        }
                        "CUE_V2" => {
                            if let Some(c) = cur.as_mut() {
                                c.cues.push(attrs(e));
                            }
                        }
                        "NODE" if in_playlists => {
                            let a = attrs(e);
                            let list = a.get("TYPE").map(String::as_str) == Some("PLAYLIST");
                            let folder = a.get("TYPE").map(String::as_str) == Some("FOLDER");
                            let name = a.get("NAME").cloned().unwrap_or_default();
                            // Smart lists and other kinds are left out (their rules do not carry over).
                            if !(list || folder) {
                                if !empty {
                                    stack.push((String::new(), false, vec![], vec![]));
                                    stack.last_mut().unwrap().0 = "\u{0}skip".into();
                                }
                            } else if empty {
                                let node = if list { Node::List(name, vec![]) } else { Node::Folder(name, vec![]) };
                                match stack.last_mut() {
                                    Some(p) => p.2.push(node),
                                    None => roots.push(node),
                                }
                            } else {
                                stack.push((name, list, vec![], vec![]));
                            }
                        }
                        "PRIMARYKEY" if in_playlists => {
                            let a = attrs(e);
                            if a.get("TYPE").map(String::as_str) == Some("TRACK") {
                                if let (Some(top), Some(k)) = (stack.last_mut(), a.get("KEY")) {
                                    top.3.push(k.clone());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Event::End(ref e) => match e.name().as_ref() {
                    "COLLECTION" => in_collection = false,
                    "PLAYLISTS" => in_playlists = false,
                    "ENTRY" if in_collection => {
                        if let Some(en) = cur.take() {
                            entries.push(en);
                        }
                    }
                    "NODE" if in_playlists => {
                        if let Some((name, list, children, keys)) = stack.pop() {
                            if name == "\u{0}skip" {
                                continue;
                            }
                            let node = if list { Node::List(name, keys) } else { Node::Folder(name, children) };
                            match stack.last_mut() {
                                Some(p) => p.2.push(node),
                                None => roots.push(node),
                            }
                        }
                    }
                    _ => {}
                },
                Event::Eof => break,
                _ => {}
            }
        }

        let mut report = ImportReport::default();
        let mut by_key: HashMap<String, i64> = HashMap::new();
        let tx = self.begin()?;
        for en in &entries {
            let (Some(dir), Some(file_name)) = (en.location.get("DIR"), en.location.get("FILE")) else { continue };
            let path = nml_path(en.location.get("VOLUME").map(String::as_str).unwrap_or(""), dir, file_name);
            let s = |m: &HashMap<String, String>, k: &str| m.get(k).cloned().filter(|v| !v.is_empty());
            let key = en.key.and_then(key_from_traktor);
            let tags = mixit_io::TrackTags {
                title: s(&en.a, "TITLE"),
                artist: s(&en.a, "ARTIST"),
                album: en.album.clone().filter(|a| !a.is_empty()),
                genre: s(&en.info, "GENRE"),
                label: s(&en.info, "LABEL"),
                remixer: s(&en.info, "REMIXER"),
                comment: s(&en.info, "COMMENT"),
                bpm: en.bpm,
                key: key.map(|k| k.to_string()),
                duration_s: num(&en.info, "PLAYTIME_FLOAT").or_else(|| num(&en.info, "PLAYTIME")).unwrap_or(0.0),
                bitrate_kbps: num(&en.info, "BITRATE").map(|b| (b / 1000.0) as u32),
                ..Default::default()
            };
            let id = self.track_for_import(&path, tags, &mut report.missing)?;
            report.tracks += 1;
            by_key.insert(en.primary_key(), id);

            let tr = self.track(id)?;
            if let Some(v) = num(&en.info, "RANKING") {
                if tr.rating == 0 {
                    let stars = ((v / 51.0).round() as i64).clamp(0, 5);
                    self.connection()
                        .execute("UPDATE tracks SET rating = ? WHERE id = ?", rusqlite::params![stars, id])?;
                }
            }
            if tr.tag_key.is_none() {
                if let Some(k) = key {
                    self.connection()
                        .execute("UPDATE tracks SET tag_key = ? WHERE id = ?", rusqlite::params![k.to_string(), id])?;
                }
            }
            if tr.tag_bpm.is_none() {
                if let Some(b) = en.bpm {
                    self.connection()
                        .execute("UPDATE tracks SET tag_bpm = ? WHERE id = ?", rusqlite::params![b, id])?;
                }
            }
            if tr.comment.is_empty() {
                if let Some(c) = s(&en.info, "COMMENT") {
                    self.connection()
                        .execute("UPDATE tracks SET comment = ? WHERE id = ?", rusqlite::params![c, id])?;
                }
            }

            // The beat grid: Traktor's grid marker (type 4) is a downbeat, with the tempo.
            let sr = tr.sample_rate.unwrap_or(44_100);
            let marker = en
                .cues
                .iter()
                .filter(|c| c.get("TYPE").map(String::as_str) == Some("4"))
                .filter_map(|c| num(c, "START"))
                .next();
            if let (Some(bpm), Some(ms)) = (en.bpm, marker) {
                let none_yet =
                    self.connection()
                        .query_row("SELECT COUNT(*) FROM grids WHERE track_id = ?", [id], |r| r.get::<_, i64>(0))?
                        == 0;
                if none_yet {
                    let mut g = Beatgrid::constant(sr, bpm, ms / 1000.0 * sr as f64);
                    g.confidence = 1.0;
                    self.save_grid(id, &g)?;
                    report.grids += 1;
                }
            }

            if self.cues(id)?.is_empty() {
                let mut cues = Vec::new();
                for c in &en.cues {
                    let Some(ms) = num(c, "START") else { continue };
                    let kind = c.get("TYPE").map(String::as_str).unwrap_or("0");
                    // 0 cue, 1 fade-in, 2 fade-out, 3 load, 4 grid, 5 loop.
                    if kind == "4" {
                        continue;
                    }
                    let hot = num(c, "HOTCUE").map(|h| h as i64).filter(|h| *h >= 0);
                    let len = num(c, "LEN").filter(|l| *l > 0.0 && kind == "5");
                    let name = c.get("NAME").cloned().unwrap_or_default();
                    cues.push(Cue {
                        kind: match (kind, hot) {
                            (_, Some(_)) => CueKind::Hot,
                            ("3", None) => CueKind::Main,
                            _ => CueKind::Memory,
                        },
                        slot: hot.map(|h| h.min(15) as u8),
                        seconds: ms / 1000.0,
                        loop_seconds: len.map(|l| l / 1000.0),
                        color: None,
                        label: if name == "n.n." { String::new() } else { name },
                    });
                }
                report.cues += cues.len();
                self.set_cues(id, &cues)?;
            }
        }

        fn add(
            lib: &Library,
            nodes: &[Node],
            parent: Option<i64>,
            ids: &HashMap<String, i64>,
            rep: &mut ImportReport,
        ) -> Result<()> {
            for n in nodes {
                match n {
                    Node::Folder(name, children) => {
                        if parent.is_none() && name == "$ROOT" {
                            add(lib, children, None, ids, rep)?;
                        } else {
                            let id = lib.playlist_for_import(name, PlaylistKind::Folder, parent)?;
                            add(lib, children, Some(id), ids, rep)?;
                        }
                    }
                    Node::List(name, keys) => {
                        let id = lib.playlist_for_import(name, PlaylistKind::List, parent)?;
                        let tracks: Vec<i64> = keys.iter().filter_map(|k| ids.get(k).copied()).collect();
                        lib.set_playlist_tracks(id, &tracks)?;
                        rep.playlists += 1;
                    }
                }
            }
            Ok(())
        }
        add(self, &roots, None, &by_key, &mut report)?;
        tx.commit()?;
        Ok(report)
    }
}

impl Library {
    /// Writes the library (or the given tracks) as a Traktor `collection.nml`: details,
    /// tempo and beat grid, key, rating, hot cues, loops and every playlist in its folder
    /// (smart lists as the tracks they hold now). Traktor grids keep one tempo, so a
    /// track that drifts gets its first tempo.
    pub fn export_traktor_nml(&self, tracks: Option<&[crate::TrackId]>, out: &Path) -> Result<()> {
        let all: Vec<crate::TrackId> = match tracks {
            Some(t) => t.to_vec(),
            None => self.all_tracks()?.iter().map(|t| t.id).collect(),
        };
        let mut keys: HashMap<crate::TrackId, String> = HashMap::new();
        let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\" ?>\n<NML VERSION=\"19\">");
        x.push_str("<HEAD COMPANY=\"www.native-instruments.com\" PROGRAM=\"Traktor\"></HEAD>\n");
        x.push_str(&format!("<COLLECTION ENTRIES=\"{}\">\n", all.len()));
        for &id in &all {
            let t = self.track(id)?;
            let (volume, dir, file) = nml_location(&t.path);
            keys.insert(id, format!("{volume}{dir}{file}"));
            x.push_str(&format!(
                "<ENTRY TITLE=\"{}\" ARTIST=\"{}\">\n<LOCATION DIR=\"{}\" FILE=\"{}\" VOLUME=\"{}\" VOLUMEID=\"\"></LOCATION>\n",
                esc(&t.display_title()),
                esc(&t.artist),
                esc(&dir),
                esc(&file),
                esc(&volume)
            ));
            if !t.album.is_empty() {
                x.push_str(&format!("<ALBUM TITLE=\"{}\"></ALBUM>\n", esc(&t.album)));
            }
            let mut info = format!(
                "<INFO GENRE=\"{}\" LABEL=\"{}\" COMMENT=\"{}\" PLAYTIME=\"{}\" PLAYTIME_FLOAT=\"{:.6}\" RANKING=\"{}\" PLAYCOUNT=\"{}\"",
                esc(&t.genre),
                esc(&t.label),
                esc(&t.comment),
                t.duration.round() as i64,
                t.duration,
                t.rating as u32 * 51,
                t.play_count
            );
            if !t.remixer.is_empty() {
                info.push_str(&format!(" REMIXER=\"{}\"", esc(&t.remixer)));
            }
            if let Some(b) = t.bitrate_kbps {
                info.push_str(&format!(" BITRATE=\"{}\"", b * 1000));
            }
            if let Some(k) = t.best_key() {
                info.push_str(&format!(" KEY=\"{}\"", k.standard_name()));
            }
            x.push_str(&info);
            x.push_str("></INFO>\n");
            let grid = self.grid(id)?;
            let bpm = grid.as_ref().map(|g| g.bpm).or(t.best_bpm());
            if let Some(b) = bpm {
                x.push_str(&format!("<TEMPO BPM=\"{b:.6}\" BPM_QUALITY=\"100.000000\"></TEMPO>\n"));
            }
            if let Some(k) = t.best_key() {
                x.push_str(&format!("<MUSICAL_KEY VALUE=\"{}\"></MUSICAL_KEY>\n", k.index()));
            }
            if let Some(g) = &grid {
                // The first downbeat in the track.
                let mut beat = g.beat_at(0.0).ceil() as i64;
                while !g.is_downbeat(beat) {
                    beat += 1;
                }
                let ms = g.frame_at(beat as f64) / g.sample_rate as f64 * 1000.0;
                x.push_str(&format!(
                    "<CUE_V2 NAME=\"Beat Marker\" DISPL_ORDER=\"0\" TYPE=\"4\" START=\"{ms:.6}\" LEN=\"0.000000\" REPEATS=\"-1\" HOTCUE=\"-1\"></CUE_V2>\n"
                ));
            }
            for c in self.cues(id)? {
                let ty = match (c.kind, c.loop_seconds) {
                    (_, Some(_)) => 5,
                    (CueKind::Main, None) => 3,
                    _ => 0,
                };
                let hot = match c.kind {
                    CueKind::Hot => c.slot.map(i64::from).unwrap_or(-1),
                    _ => -1,
                };
                let name = if c.label.is_empty() { "n.n.".to_string() } else { esc(&c.label) };
                x.push_str(&format!(
                    "<CUE_V2 NAME=\"{name}\" DISPL_ORDER=\"0\" TYPE=\"{ty}\" START=\"{:.6}\" LEN=\"{:.6}\" REPEATS=\"-1\" HOTCUE=\"{hot}\"></CUE_V2>\n",
                    c.seconds * 1000.0,
                    c.loop_seconds.unwrap_or(0.0) * 1000.0
                ));
            }
            x.push_str("</ENTRY>\n");
        }
        x.push_str("</COLLECTION>\n<PLAYLISTS>\n");

        let lists = self.playlists()?;
        fn node(
            lib: &Library,
            lists: &[crate::Playlist],
            parent: Option<i64>,
            keys: &HashMap<crate::TrackId, String>,
            x: &mut String,
        ) -> Result<()> {
            let kids: Vec<&crate::Playlist> = lists.iter().filter(|p| p.parent == parent).collect();
            x.push_str(&format!("<SUBNODES COUNT=\"{}\">\n", kids.len()));
            for p in kids {
                match p.kind {
                    PlaylistKind::Folder => {
                        x.push_str(&format!("<NODE TYPE=\"FOLDER\" NAME=\"{}\">", esc(&p.name)));
                        node(lib, lists, Some(p.id), keys, x)?;
                        x.push_str("</NODE>\n");
                    }
                    _ => {
                        let tracks: Vec<&String> =
                            lib.playlist_tracks(p.id)?.iter().filter_map(|t| keys.get(t)).collect();
                        x.push_str(&format!(
                            "<NODE TYPE=\"PLAYLIST\" NAME=\"{}\"><PLAYLIST ENTRIES=\"{}\" TYPE=\"LIST\" UUID=\"mixit-{}\">\n",
                            esc(&p.name),
                            tracks.len(),
                            p.id
                        ));
                        for k in tracks {
                            x.push_str(&format!(
                                "<ENTRY><PRIMARYKEY TYPE=\"TRACK\" KEY=\"{}\"></PRIMARYKEY></ENTRY>\n",
                                esc(k)
                            ));
                        }
                        x.push_str("</PLAYLIST></NODE>\n");
                    }
                }
            }
            x.push_str("</SUBNODES>");
            Ok(())
        }
        x.push_str("<NODE TYPE=\"FOLDER\" NAME=\"$ROOT\">");
        node(self, &lists, None, &keys, &mut x)?;
        x.push_str("</NODE>\n</PLAYLISTS>\n</NML>\n");
        std::fs::write(out, x)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_keys() {
        assert_eq!(nml_path("C:", "/:Users/:dj/:Music/:", "a b.mp3"), PathBuf::from("C:\\Users\\dj\\Music\\a b.mp3"));
        assert_eq!(nml_path("", "/:home/:dj/:", "x.flac"), PathBuf::from("/home/dj/x.flac"));
        // A volume that is not mounted here falls back to the root.
        assert_eq!(nml_path("Nowhere Disk", "/:Music/:", "y.wav"), PathBuf::from("/Music/y.wav"));
        assert_eq!(key_from_traktor(0).unwrap().to_string(), "8B");
        assert_eq!(key_from_traktor(21).unwrap().to_string(), "8A"); // A minor
        assert!(key_from_traktor(24).is_none());
        let loc = |p: &str| nml_location(Path::new(p));
        assert_eq!(loc("C:\\Users\\dj\\a b.mp3"), ("C:".into(), "/:Users/:dj/:".into(), "a b.mp3".into()));
        assert_eq!(loc("/Volumes/USB/Music/x.flac"), ("USB".into(), "/:Music/:".into(), "x.flac".into()));
        assert_eq!(loc("/home/dj/x.flac"), (String::new(), "/:home/:dj/:".into(), "x.flac".into()));
        let (v, d, f) = loc("/home/dj/x.flac");
        assert_eq!(nml_path(&v, &d, &f), PathBuf::from("/home/dj/x.flac"));
    }
}
