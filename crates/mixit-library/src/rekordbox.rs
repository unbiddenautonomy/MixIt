//! Rekordbox XML collections: the format Rekordbox, Serato (via converters), Traktor
//! (via converters), djay and most DJ tools exchange. Importing brings a DJ's existing
//! library across with its beatgrids, cue points, ratings and playlists; exporting lets
//! MixIt prepare USB sticks through Rekordbox.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use mixit_core::{Beatgrid, GridAnchor, Key, TrackId};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use serde::{Deserialize, Serialize};

use crate::m3u::{percent_decode, percent_encode};
use crate::{Cue, CueKind, Library, LibraryError, NewTrack, PlaylistKind, Result};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RekordboxImport {
    pub tracks: usize,
    /// Tracks whose files were not found (added as missing so playlists stay complete).
    pub missing: Vec<PathBuf>,
    pub grids: usize,
    pub cues: usize,
    pub playlists: usize,
}

/// A file URL from Rekordbox to a local path.
pub fn location_to_path(loc: &str) -> PathBuf {
    let rest = loc.strip_prefix("file://localhost").or_else(|| loc.strip_prefix("file://")).unwrap_or(loc);
    let decoded = percent_decode(rest);
    // Windows: "/C:/Music/x.mp3" → "C:/Music/x.mp3".
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[2] == b':' && b[1].is_ascii_alphabetic() {
        return PathBuf::from(&decoded[1..]);
    }
    PathBuf::from(decoded)
}

pub fn path_to_location(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = if s.as_bytes().get(1) == Some(&b':') { format!("/{s}") } else { s };
    format!("file://localhost{}", percent_encode(&s))
}

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

#[derive(Default)]
struct XmlTrack {
    a: HashMap<String, String>,
    tempos: Vec<HashMap<String, String>>,
    marks: Vec<HashMap<String, String>>,
}

enum XmlNode {
    Folder(String, Vec<XmlNode>),
    List(String, Vec<String>),
}

fn num(m: &HashMap<String, String>, k: &str) -> Option<f64> {
    m.get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite())
}

fn grid_from_tempos(tempos: &[HashMap<String, String>], sr: u32) -> Option<Beatgrid> {
    let mut pts: Vec<(f64, f64, u32)> = tempos
        .iter()
        .filter_map(|t| Some((num(t, "Inizio")?, num(t, "Bpm")?, num(t, "Battito").unwrap_or(1.0) as u32)))
        .filter(|p| p.1 > 0.0)
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let &(t0, bpm0, bat0) = pts.first()?;
    let srf = sr as f64;
    let first_beat = (bat0.clamp(1, 4) - 1) as f64;
    let mut g = Beatgrid::constant(sr, bpm0, 0.0);
    g.anchors = vec![GridAnchor { frame: t0 * srf, beat: first_beat }];
    if pts.len() > 1 {
        let mut beat = first_beat;
        let mut prev = (t0, bpm0);
        for &(t, bpm, _) in &pts[1..] {
            beat += ((t - prev.0) * prev.1 / 60.0).round();
            if t <= prev.0 {
                continue;
            }
            g.anchors.push(GridAnchor { frame: t * srf, beat });
            prev = (t, bpm);
        }
        // Close the last segment at its own tempo so it keeps its BPM.
        let last = *g.anchors.last().unwrap();
        g.anchors.push(GridAnchor { frame: last.frame + 4.0 * 60.0 / prev.1 * srf, beat: last.beat + 4.0 });
        let a = g.anchors[0];
        let b = *g.anchors.last().unwrap();
        g.bpm = 60.0 * srf * (b.beat - a.beat) / (b.frame - a.frame);
    }
    g.confidence = 1.0;
    Some(g)
}

fn rating_from_rb(v: f64) -> u8 {
    ((v / 51.0).round() as i64).clamp(0, 5) as u8
}

fn esc(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

impl Library {
    pub fn import_rekordbox_xml(&self, file: &Path) -> Result<RekordboxImport> {
        let text = std::fs::read_to_string(file)?;
        let mut r = Reader::from_str(&text);
        r.config_mut().trim_text(true);
        let mut tracks: Vec<XmlTrack> = Vec::new();
        let mut cur: Option<XmlTrack> = None;
        let mut in_collection = false;
        let mut in_playlists = false;
        // Stack of (name, kind 0 folder / 1 list, children, entries).
        let mut stack: Vec<(String, u8, Vec<XmlNode>, Vec<String>)> = Vec::new();
        let mut roots: Vec<XmlNode> = Vec::new();
        loop {
            let ev = r.read_event().map_err(|e| LibraryError::Xml(e.to_string()))?;
            match ev {
                Event::Start(ref e) | Event::Empty(ref e) => {
                    let empty = matches!(ev, Event::Empty(_));
                    let name = e.name();
                    match name.as_ref() {
                        "COLLECTION" => in_collection = !empty,
                        "PLAYLISTS" => in_playlists = !empty,
                        "TRACK" if in_collection => {
                            let t = XmlTrack { a: attrs(e), ..Default::default() };
                            if empty {
                                tracks.push(t);
                            } else {
                                cur = Some(t);
                            }
                        }
                        "TEMPO" => {
                            if let Some(t) = cur.as_mut() {
                                t.tempos.push(attrs(e));
                            }
                        }
                        "POSITION_MARK" => {
                            if let Some(t) = cur.as_mut() {
                                t.marks.push(attrs(e));
                            }
                        }
                        "NODE" if in_playlists => {
                            let a = attrs(e);
                            let kind = if a.get("Type").map(|s| s.as_str()) == Some("1") { 1 } else { 0 };
                            let nm = a.get("Name").cloned().unwrap_or_default();
                            if empty {
                                let node =
                                    if kind == 1 { XmlNode::List(nm, vec![]) } else { XmlNode::Folder(nm, vec![]) };
                                match stack.last_mut() {
                                    Some(p) => p.2.push(node),
                                    None => roots.push(node),
                                }
                            } else {
                                stack.push((nm, kind, vec![], vec![]));
                            }
                        }
                        "TRACK" if in_playlists => {
                            if let Some(top) = stack.last_mut() {
                                if let Some(k) = attrs(e).get("Key") {
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
                    "TRACK" if in_collection => {
                        if let Some(t) = cur.take() {
                            tracks.push(t);
                        }
                    }
                    "NODE" if in_playlists => {
                        if let Some((nm, kind, children, entries)) = stack.pop() {
                            let node =
                                if kind == 1 { XmlNode::List(nm, entries) } else { XmlNode::Folder(nm, children) };
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

        let mut report = RekordboxImport::default();
        let mut by_rb_id: HashMap<String, TrackId> = HashMap::new();
        let mut by_location: HashMap<String, TrackId> = HashMap::new();
        let tx = self.begin()?;
        for t in &tracks {
            let Some(loc) = t.a.get("Location") else { continue };
            let path = location_to_path(loc);
            let id = if path.exists() {
                match self.import_file(&path)? {
                    crate::scan::Imported::Added(i)
                    | crate::scan::Imported::Updated(i)
                    | crate::scan::Imported::Moved(i)
                    | crate::scan::Imported::Unchanged(i) => i,
                }
            } else if let Some(existing) = self.track_by_path(&path)? {
                existing.id
            } else {
                let s = |k: &str| t.a.get(k).cloned().filter(|v| !v.is_empty());
                let tags = mixit_io::TrackTags {
                    title: s("Name"),
                    artist: s("Artist"),
                    album: s("Album"),
                    genre: s("Genre"),
                    label: s("Label"),
                    remixer: s("Remixer"),
                    comment: s("Comments"),
                    year: num(&t.a, "Year").map(|y| y as u32).filter(|y| *y > 0),
                    bpm: num(&t.a, "AverageBpm").filter(|b| *b > 0.0),
                    key: s("Tonality"),
                    duration_s: num(&t.a, "TotalTime").unwrap_or(0.0),
                    sample_rate: num(&t.a, "SampleRate").map(|v| v as u32),
                    bitrate_kbps: num(&t.a, "BitRate").map(|v| v as u32),
                    ..Default::default()
                };
                let id = self.insert_track(&NewTrack { path: path.clone(), tags, ..Default::default() })?;
                self.set_missing(id, true)?;
                report.missing.push(path.clone());
                id
            };
            report.tracks += 1;
            if let Some(rb) = t.a.get("TrackID") {
                by_rb_id.insert(rb.clone(), id);
            }
            by_location.insert(loc.clone(), id);
            // Ratings, comments and tag BPM/key when MixIt has nothing better.
            let tr = self.track(id)?;
            if let Some(v) = num(&t.a, "Rating") {
                if tr.rating == 0 {
                    self.connection().execute(
                        "UPDATE tracks SET rating = ? WHERE id = ?",
                        rusqlite::params![rating_from_rb(v), id],
                    )?;
                }
            }
            if tr.tag_key.is_none() {
                if let Some(k) = t.a.get("Tonality").filter(|k| Key::parse(k).is_some()) {
                    self.connection()
                        .execute("UPDATE tracks SET tag_key = ? WHERE id = ?", rusqlite::params![k, id])?;
                }
            }
            if tr.tag_bpm.is_none() {
                if let Some(b) = num(&t.a, "AverageBpm").filter(|b| *b > 0.0) {
                    self.connection()
                        .execute("UPDATE tracks SET tag_bpm = ? WHERE id = ?", rusqlite::params![b, id])?;
                }
            }
            let sr = tr.sample_rate.unwrap_or(44_100);
            if !t.tempos.is_empty()
                && self
                    .connection()
                    .query_row("SELECT COUNT(*) FROM grids WHERE track_id = ?", [id], |r| r.get::<_, i64>(0))?
                    == 0
            {
                if let Some(g) = grid_from_tempos(&t.tempos, sr) {
                    self.save_grid(id, &g)?;
                    report.grids += 1;
                }
            }
            if !t.marks.is_empty() && self.cues(id)?.is_empty() {
                let mut cues = Vec::new();
                for m in &t.marks {
                    let Some(start) = num(m, "Start") else { continue };
                    let n = num(m, "Num").unwrap_or(-1.0) as i64;
                    let end = num(m, "End").filter(|e| *e > start && m.get("Type").map(|s| s.as_str()) == Some("4"));
                    let color = match (num(m, "Red"), num(m, "Green"), num(m, "Blue")) {
                        (Some(r), Some(g), Some(b)) => Some(((r as u32) << 16) | ((g as u32) << 8) | b as u32),
                        _ => None,
                    };
                    cues.push(Cue {
                        kind: if n >= 0 { CueKind::Hot } else { CueKind::Memory },
                        slot: (n >= 0).then_some(n.min(15) as u8),
                        seconds: start,
                        loop_seconds: end.map(|e| e - start),
                        color,
                        label: m.get("Name").cloned().unwrap_or_default(),
                    });
                }
                // The first memory cue is the main cue in Rekordbox's convention.
                if let Some(c) = cues.iter_mut().find(|c| c.kind == CueKind::Memory && c.loop_seconds.is_none()) {
                    c.kind = CueKind::Main;
                }
                report.cues += cues.len();
                self.set_cues(id, &cues)?;
            }
        }
        // Playlists (skip the ROOT wrapper).
        fn add(
            lib: &Library,
            nodes: &[XmlNode],
            parent: Option<i64>,
            ids: &HashMap<String, TrackId>,
            rep: &mut RekordboxImport,
        ) -> Result<()> {
            for n in nodes {
                match n {
                    XmlNode::Folder(name, children) => {
                        if parent.is_none() && name == "ROOT" {
                            add(lib, children, None, ids, rep)?;
                        } else {
                            let id = lib.create_playlist(name, PlaylistKind::Folder, parent, None)?;
                            add(lib, children, Some(id), ids, rep)?;
                        }
                    }
                    XmlNode::List(name, entries) => {
                        let id = lib.create_playlist(name, PlaylistKind::List, parent, None)?;
                        let tracks: Vec<TrackId> = entries.iter().filter_map(|k| ids.get(k).copied()).collect();
                        lib.set_playlist_tracks(id, &tracks)?;
                        rep.playlists += 1;
                    }
                }
            }
            Ok(())
        }
        let mut ids = by_rb_id;
        ids.extend(by_location);
        add(self, &roots, None, &ids, &mut report)?;
        tx.commit()?;
        Ok(report)
    }

    /// Writes the given tracks (all when `None`) and every playlist as Rekordbox XML.
    pub fn export_rekordbox_xml(&self, tracks: Option<&[TrackId]>, out: &Path) -> Result<()> {
        let all: Vec<TrackId> = match tracks {
            Some(t) => t.to_vec(),
            None => self.all_tracks()?.iter().map(|t| t.id).collect(),
        };
        let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DJ_PLAYLISTS Version=\"1.0.0\">\n");
        x.push_str(&format!(
            "  <PRODUCT Name=\"MixIt\" Version=\"{}\" Company=\"MixIt\"/>\n",
            env!("CARGO_PKG_VERSION")
        ));
        x.push_str(&format!("  <COLLECTION Entries=\"{}\">\n", all.len()));
        for &id in &all {
            let t = self.track(id)?;
            let key = t.best_key().map(|k| k.standard_name()).unwrap_or_default();
            x.push_str(&format!(
                "    <TRACK TrackID=\"{}\" Name=\"{}\" Artist=\"{}\" Album=\"{}\" Genre=\"{}\" Label=\"{}\" Remixer=\"{}\" \
                 Comments=\"{}\" Year=\"{}\" TotalTime=\"{}\" AverageBpm=\"{:.2}\" Tonality=\"{}\" Rating=\"{}\" \
                 PlayCount=\"{}\" SampleRate=\"{}\" BitRate=\"{}\" Size=\"{}\" Location=\"{}\">\n",
                id,
                esc(&t.display_title()),
                esc(&t.artist),
                esc(&t.album),
                esc(&t.genre),
                esc(&t.label),
                esc(&t.remixer),
                esc(&t.comment),
                t.year.unwrap_or(0),
                t.duration.round() as i64,
                t.best_bpm().unwrap_or(0.0),
                esc(&key),
                t.rating as u32 * 51,
                t.play_count,
                t.sample_rate.unwrap_or(44_100),
                t.bitrate_kbps.unwrap_or(0),
                t.file_size,
                esc(&path_to_location(&t.path)),
            ));
            if let Some(g) = self.grid(id)? {
                let sr = g.sample_rate as f64;
                let write = |x: &mut String, frame: f64, bpm: f64, beat: f64| {
                    let bat = (beat.round() as i64).rem_euclid(g.beats_per_bar as i64) + 1;
                    x.push_str(&format!(
                        "      <TEMPO Inizio=\"{:.3}\" Bpm=\"{:.2}\" Metro=\"{}/4\" Battito=\"{}\"/>\n",
                        frame / sr,
                        bpm,
                        g.beats_per_bar,
                        bat
                    ));
                };
                if g.is_constant() {
                    let b = g.beat_at(0.0).ceil();
                    write(&mut x, g.frame_at(b), g.bpm, b);
                } else {
                    for w in g.anchors.windows(2) {
                        let bpm = 60.0 * sr * (w[1].beat - w[0].beat) / (w[1].frame - w[0].frame);
                        write(&mut x, w[0].frame, bpm, w[0].beat);
                    }
                }
            }
            for c in self.cues(id)? {
                let num = match c.kind {
                    CueKind::Hot => c.slot.unwrap_or(0) as i64,
                    _ => -1,
                };
                let (ty, end) = match c.loop_seconds {
                    Some(l) => ("4", format!(" End=\"{:.3}\"", c.seconds + l)),
                    None => ("0", String::new()),
                };
                let color = c
                    .color
                    .map(|v| format!(" Red=\"{}\" Green=\"{}\" Blue=\"{}\"", (v >> 16) & 255, (v >> 8) & 255, v & 255))
                    .unwrap_or_default();
                x.push_str(&format!(
                    "      <POSITION_MARK Name=\"{}\" Type=\"{ty}\" Start=\"{:.3}\"{end} Num=\"{num}\"{color}/>\n",
                    esc(&c.label),
                    c.seconds
                ));
            }
            x.push_str("    </TRACK>\n");
        }
        x.push_str("  </COLLECTION>\n  <PLAYLISTS>\n");
        let lists = self.playlists()?;
        fn node(
            lib: &Library,
            lists: &[crate::Playlist],
            parent: Option<i64>,
            depth: usize,
            x: &mut String,
        ) -> Result<()> {
            for p in lists.iter().filter(|p| p.parent == parent) {
                let pad = "  ".repeat(depth);
                match p.kind {
                    PlaylistKind::Folder => {
                        let n = lists.iter().filter(|c| c.parent == Some(p.id)).count();
                        x.push_str(&format!("{pad}<NODE Type=\"0\" Name=\"{}\" Count=\"{n}\">\n", esc(&p.name)));
                        node(lib, lists, Some(p.id), depth + 1, x)?;
                        x.push_str(&format!("{pad}</NODE>\n"));
                    }
                    _ => {
                        let tracks = lib.playlist_tracks(p.id)?;
                        x.push_str(&format!(
                            "{pad}<NODE Name=\"{}\" Type=\"1\" KeyType=\"0\" Entries=\"{}\">\n",
                            esc(&p.name),
                            tracks.len()
                        ));
                        for t in tracks {
                            x.push_str(&format!("{pad}  <TRACK Key=\"{t}\"/>\n"));
                        }
                        x.push_str(&format!("{pad}</NODE>\n"));
                    }
                }
            }
            Ok(())
        }
        let top = lists.iter().filter(|p| p.parent.is_none()).count();
        x.push_str(&format!("    <NODE Type=\"0\" Name=\"ROOT\" Count=\"{top}\">\n"));
        node(self, &lists, None, 3, &mut x)?;
        x.push_str("    </NODE>\n  </PLAYLISTS>\n</DJ_PLAYLISTS>\n");
        std::fs::write(out, x)?;
        Ok(())
    }
}
