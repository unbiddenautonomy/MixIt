//! Serato DJ libraries: the `_Serato_` folder holds `database V2` (every track with its
//! details) and `Subcrates/*.crate` (crates, nested with `%%` in the file name). Cues,
//! loops and beat grids live in the music files ([`mixit_io::serato`]).
//!
//! Both files are a list of fields: a four-letter name, a big-endian length, the value.
//! The first letter says what the value is: `o` a nested list, `t` and `p` UTF-16BE
//! text, `u` a 32-bit number, `s` a 16-bit number, `b` a flag. Paths are relative to the
//! root of the drive that holds the `_Serato_` folder.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use mixit_core::{Beatgrid, GridAnchor, Key};
use mixit_io::serato::{SeratoCue, SeratoData, SeratoGridMarker, SeratoLoop, SeratoMarkers, read_serato};

use crate::rekordbox::RekordboxImport;
use crate::{Cue, CueKind, Library, LibraryError, PlaylistKind, Result, TrackId};

/// What an import brought in (the same report as for Rekordbox).
pub type ImportReport = RekordboxImport;

/// One field of a Serato file.
#[derive(Clone, Debug, PartialEq)]
pub enum Field {
    List(String, Vec<Field>),
    Text(String, String),
    Number(String, u32),
    Flag(String, bool),
    Other(String, Vec<u8>),
}

impl Field {
    pub fn name(&self) -> &str {
        match self {
            Field::List(n, _) | Field::Text(n, _) | Field::Number(n, _) | Field::Flag(n, _) | Field::Other(n, _) => n,
        }
    }
}

fn utf16be(b: &[u8]) -> String {
    let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units).trim_end_matches('\0').to_string()
}

/// Reads Serato's field list.
pub fn parse_fields(mut b: &[u8]) -> Vec<Field> {
    let mut out = Vec::new();
    while b.len() >= 8 {
        let name = String::from_utf8_lossy(&b[..4]).into_owned();
        let len = u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as usize;
        let Some(v) = b.get(8..8 + len) else { break };
        b = &b[8 + len..];
        let f = match name.as_bytes()[0] {
            b'o' => Field::List(name, parse_fields(v)),
            b't' | b'p' => Field::Text(name, utf16be(v)),
            _ if name == "vrsn" => Field::Text(name, utf16be(v)),
            b'u' if len == 4 => Field::Number(name, u32::from_be_bytes([v[0], v[1], v[2], v[3]])),
            b's' if len == 2 => Field::Number(name, u16::from_be_bytes([v[0], v[1]]) as u32),
            b'b' if len == 1 => Field::Flag(name, v[0] != 0),
            _ => Field::Other(name, v.to_vec()),
        };
        out.push(f);
    }
    out
}

/// Writes Serato's field list.
pub fn write_fields(fields: &[Field]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in fields {
        let v: Vec<u8> = match f {
            Field::List(_, kids) => write_fields(kids),
            Field::Text(_, s) => s.encode_utf16().flat_map(u16::to_be_bytes).collect(),
            Field::Number(n, v) if n.starts_with('s') => (*v as u16).to_be_bytes().to_vec(),
            Field::Number(_, v) => v.to_be_bytes().to_vec(),
            Field::Flag(_, v) => vec![*v as u8],
            Field::Other(_, v) => v.clone(),
        };
        let mut name = f.name().as_bytes().to_vec();
        name.resize(4, b' ');
        out.extend_from_slice(&name[..4]);
        out.extend_from_slice(&(v.len() as u32).to_be_bytes());
        out.extend(v);
    }
    out
}

fn text<'a>(fields: &'a [Field], name: &str) -> Option<&'a str> {
    fields.iter().find_map(|f| match f {
        Field::Text(n, v) if n == name && !v.trim().is_empty() => Some(v.as_str()),
        _ => None,
    })
}

/// The root of the drive that holds a `_Serato_` folder, which its paths start from.
pub fn serato_root(serato_dir: &Path) -> PathBuf {
    let s = serato_dir.to_string_lossy();
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return PathBuf::from(format!("{}\\", &s[..2]));
    }
    if let Some(r) = s.strip_prefix("/Volumes/") {
        if let Some(v) = r.split('/').next().filter(|v| !v.is_empty()) {
            return Path::new("/Volumes").join(v);
        }
    }
    PathBuf::from("/")
}

/// A Serato path (relative to the drive root, with `/`) as a local path.
pub fn serato_path(root: &Path, p: &str) -> PathBuf {
    let rel = p.trim_start_matches('/');
    if p.starts_with('/') && root == Path::new("/") {
        return PathBuf::from(p);
    }
    let windows = root.to_string_lossy().ends_with('\\');
    let mut s = root.to_string_lossy().into_owned();
    for (i, part) in rel.split('/').filter(|x| !x.is_empty()).enumerate() {
        if i > 0 || !(s.ends_with('/') || s.ends_with('\\')) {
            s.push(if windows { '\\' } else { '/' });
        }
        s.push_str(part);
    }
    PathBuf::from(s)
}

/// The path Serato writes for a local file: relative to the drive root, with `/`.
pub fn serato_rel(root: &Path, path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let r = root.to_string_lossy().replace('\\', "/");
    let r = r.trim_end_matches('/');
    s.strip_prefix(r).unwrap_or(&s).trim_start_matches('/').to_string()
}

/// The `_Serato_` folder for a folder someone picked: itself, or the one inside it.
pub fn find_serato_dir(dir: &Path) -> Option<PathBuf> {
    let looks = |d: &Path| d.join("database V2").is_file() || d.join("Subcrates").is_dir();
    if looks(dir) {
        return Some(dir.to_path_buf());
    }
    let inner = dir.join("_Serato_");
    looks(&inner).then_some(inner)
}

/// A Serato beat grid as a MixIt grid (the first marker is a downbeat).
pub fn grid_from_serato(markers: &[SeratoGridMarker], sample_rate: u32) -> Option<Beatgrid> {
    let first = markers.first()?;
    let sr = sample_rate as f64;
    let mut g = Beatgrid::constant(sample_rate, first.bpm, first.seconds * sr);
    if markers.len() > 1 {
        let mut beat = 0.0;
        let mut anchors = vec![GridAnchor { frame: first.seconds * sr, beat: 0.0 }];
        for w in markers.windows(2) {
            beat += ((w[1].seconds - w[0].seconds) * w[0].bpm / 60.0).round().max(1.0);
            anchors.push(GridAnchor { frame: w[1].seconds * sr, beat });
        }
        // The last tempo runs to the end of the track.
        let last = markers[markers.len() - 1];
        let extra = 4096.0;
        anchors.push(GridAnchor { frame: (last.seconds + extra * 60.0 / last.bpm) * sr, beat: beat + extra });
        g.anchors = anchors;
    }
    g.confidence = 1.0;
    Some(g)
}

/// A MixIt grid as Serato markers: one marker on the first downbeat for a steady tempo,
/// else one at each tempo change.
pub fn grid_to_serato(g: &Beatgrid) -> Vec<SeratoGridMarker> {
    let sr = g.sample_rate as f64;
    let mut beat = g.beat_at(0.0).ceil() as i64;
    while !g.is_downbeat(beat) {
        beat += 1;
    }
    if g.is_constant() {
        return vec![SeratoGridMarker { seconds: g.frame_at(beat as f64) / sr, bpm: g.bpm }];
    }
    let mut out = Vec::new();
    for w in g.anchors.windows(2) {
        if w[0].beat + 1e-9 < beat as f64 && w[1].beat <= beat as f64 {
            continue;
        }
        let bpm = 60.0 * sr * (w[1].beat - w[0].beat) / (w[1].frame - w[0].frame);
        let b = w[0].beat.max(beat as f64);
        out.push(SeratoGridMarker { seconds: g.frame_at(b) / sr, bpm });
    }
    out
}

struct Crate {
    parts: Vec<String>,
    tracks: Vec<String>,
}

fn crate_name(file_stem: &str) -> Vec<String> {
    file_stem.split("%%").map(str::to_string).collect()
}

impl Library {
    /// Imports a Serato library from its `_Serato_` folder (or the folder holding it):
    /// every track with its details, crates as playlists in folders, and the cues, loops
    /// and beat grids Serato saved into the files. Cues and grids only fill tracks that
    /// have none, and files that are not on this computer come in as missing.
    pub fn import_serato(&self, dir: &Path) -> Result<ImportReport> {
        let sdir = find_serato_dir(dir).ok_or_else(|| {
            LibraryError::Invalid("this folder has no Serato library (look for the _Serato_ folder)".into())
        })?;
        let root = serato_root(&sdir);

        // The database: details per path.
        let mut details: Vec<(String, Vec<Field>)> = Vec::new();
        if let Ok(bytes) = std::fs::read(sdir.join("database V2")) {
            for f in parse_fields(&bytes) {
                if let Field::List(n, kids) = f {
                    if n == "otrk" {
                        if let Some(p) = text(&kids, "pfil") {
                            details.push((p.to_string(), kids.clone()));
                        }
                    }
                }
            }
        }
        // Crates.
        let mut crates: Vec<Crate> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(sdir.join("Subcrates")) {
            let mut files: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("crate")))
                .collect();
            files.sort();
            for f in files {
                let Ok(bytes) = std::fs::read(&f) else { continue };
                let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
                let tracks = parse_fields(&bytes)
                    .into_iter()
                    .filter_map(|x| match x {
                        Field::List(n, kids) if n == "otrk" => text(&kids, "ptrk").map(str::to_string),
                        _ => None,
                    })
                    .collect();
                crates.push(Crate { parts: crate_name(&stem), tracks });
            }
        }

        let mut report = ImportReport::default();
        let mut ids: HashMap<String, TrackId> = HashMap::new();
        let tx = self.begin()?;
        let in_db: HashSet<String> = details.iter().map(|(p, _)| p.clone()).collect();
        let crate_only: Vec<(String, Vec<Field>)> = crates
            .iter()
            .flat_map(|c| c.tracks.iter())
            .filter(|p| !in_db.contains(*p))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|p| (p.clone(), Vec::new()))
            .collect();
        for (rel, f) in details.iter().chain(crate_only.iter()) {
            if ids.contains_key(rel) {
                continue;
            }
            let path = serato_path(&root, rel);
            let s = |k: &str| text(f, k).map(str::to_string);
            let bpm = s("tbpm").and_then(|v| v.trim().parse::<f64>().ok()).filter(|b| (20.0..=400.0).contains(b));
            let key = s("tkey").and_then(|k| Key::parse(&k));
            let tags = mixit_io::TrackTags {
                title: s("tsng"),
                artist: s("tart"),
                album: s("talb"),
                genre: s("tgen"),
                label: s("tlbl"),
                remixer: s("trmx"),
                comment: s("tcom"),
                bpm,
                key: key.map(|k| k.to_string()),
                year: s("ttyr").and_then(|y| y.trim().parse().ok()),
                ..Default::default()
            };
            let id = self.track_for_import(&path, tags, &mut report.missing)?;
            report.tracks += 1;
            ids.insert(rel.clone(), id);

            let tr = self.track(id)?;
            if tr.tag_key.is_none() {
                if let Some(k) = key {
                    self.connection()
                        .execute("UPDATE tracks SET tag_key = ? WHERE id = ?", rusqlite::params![k.to_string(), id])?;
                }
            }
            if tr.tag_bpm.is_none() {
                if let Some(b) = bpm {
                    self.connection()
                        .execute("UPDATE tracks SET tag_bpm = ? WHERE id = ?", rusqlite::params![b, id])?;
                }
            }
            if !path.exists() {
                continue;
            }
            let Ok(data) = read_serato(&path) else { continue };
            if let Some(m) = &data.markers {
                if tr.color.is_none() {
                    if let Some(c) = m.color {
                        self.connection()
                            .execute("UPDATE tracks SET color = ? WHERE id = ?", rusqlite::params![c, id])?;
                    }
                }
                if self.cues(id)?.is_empty() && !(m.cues.is_empty() && m.loops.is_empty()) {
                    let cues = cues_from_serato(m);
                    report.cues += cues.len();
                    self.set_cues(id, &cues)?;
                }
            }
            if let Some(g) = data.grid.as_deref().and_then(|g| grid_from_serato(g, tr.sample_rate.unwrap_or(44_100))) {
                if self.grid(id)?.is_none() {
                    self.save_grid(id, &g)?;
                    report.grids += 1;
                }
            }
        }

        // Crates as playlists. A crate with crates inside becomes a folder; its own tracks
        // go in a list of the same name at the top of that folder.
        let parents: HashSet<Vec<String>> =
            crates.iter().flat_map(|c| (1..c.parts.len()).map(|n| c.parts[..n].to_vec())).collect();
        let mut folders: BTreeMap<Vec<String>, i64> = BTreeMap::new();
        let mut folder = |lib: &Library, parts: &[String]| -> Result<Option<i64>> {
            let mut parent = None;
            for n in 1..=parts.len() {
                let key = parts[..n].to_vec();
                let id = match folders.get(&key) {
                    Some(id) => *id,
                    None => {
                        let id = lib.playlist_for_import(&parts[n - 1], PlaylistKind::Folder, parent)?;
                        folders.insert(key, id);
                        id
                    }
                };
                parent = Some(id);
            }
            Ok(parent)
        };
        for c in &crates {
            let is_parent = parents.contains(&c.parts);
            if is_parent && c.tracks.is_empty() {
                folder(self, &c.parts)?;
                continue;
            }
            let parent = if is_parent { folder(self, &c.parts)? } else { folder(self, &c.parts[..c.parts.len() - 1])? };
            let name = c.parts.last().cloned().unwrap_or_default();
            let id = self.playlist_for_import(&name, PlaylistKind::List, parent)?;
            let tracks: Vec<TrackId> = c.tracks.iter().filter_map(|p| ids.get(p).copied()).collect();
            self.set_playlist_tracks(id, &tracks)?;
            report.playlists += 1;
        }
        tx.commit()?;
        Ok(report)
    }

    /// What Serato should find in a track's file: its hot cues (Serato has 8 pads),
    /// saved loops, colour and beat grid.
    pub fn serato_data(&self, id: TrackId) -> Result<SeratoData> {
        let t = self.track(id)?;
        let mut m = SeratoMarkers { color: t.color, ..Default::default() };
        let mut loop_index = 0u8;
        for c in self.cues(id)? {
            let ms = (c.seconds * 1000.0).round().max(0.0) as u32;
            match (c.kind, c.loop_seconds) {
                (_, Some(len)) => {
                    if loop_index < 8 {
                        m.loops.push(SeratoLoop {
                            index: loop_index,
                            start_ms: ms,
                            end_ms: ((c.seconds + len) * 1000.0).round() as u32,
                            locked: false,
                            name: c.label.clone(),
                        });
                        loop_index += 1;
                    }
                }
                (CueKind::Hot, None) => {
                    if let Some(slot) = c.slot.filter(|s| *s < 8) {
                        m.cues.push(SeratoCue {
                            index: slot,
                            ms,
                            color: c.color.unwrap_or(SERATO_COLORS[slot as usize]),
                            name: c.label.clone(),
                        });
                    }
                }
                _ => {}
            }
        }
        let grid = self.grid(id)?.map(|g| grid_to_serato(&g)).filter(|g| !g.is_empty());
        Ok(SeratoData { markers: Some(m), grid })
    }

    /// Writes a track's cues, loops and beat grid into its file so Serato DJ shows
    /// them. The file's new size, time and hash are recorded so a rescan does not read
    /// it again.
    pub fn write_serato_file(&self, id: TrackId) -> Result<()> {
        let t = self.track(id)?;
        if t.missing || !t.path.exists() {
            return Err(LibraryError::Invalid(format!("{}: the file is missing", t.display_title())));
        }
        mixit_io::serato::write_serato(&t.path, &self.serato_data(id)?)?;
        let (size, mtime) = crate::scan::file_info(&t.path)?;
        let hash = mixit_io::hash_file(&t.path)?.to_hex();
        self.set_file_info(id, size, mtime, Some(&hash))
    }

    /// [`write_serato_file`](Self::write_serato_file) for many tracks: how many were
    /// written, and why the others were not.
    pub fn write_serato(&self, ids: &[TrackId]) -> Result<(usize, Vec<(TrackId, String)>)> {
        let mut written = 0;
        let mut failed = Vec::new();
        for &id in ids {
            match self.write_serato_file(id) {
                Ok(()) => written += 1,
                Err(e) => failed.push((id, e.to_string())),
            }
        }
        Ok((written, failed))
    }
}

/// Serato's default pad colours, by pad.
pub const SERATO_COLORS: [u32; 8] = [0xCC0000, 0xCC4400, 0x0000CC, 0xCCCC00, 0x00CC00, 0xCC8800, 0xCC00CC, 0x00CCCC];

fn cues_from_serato(m: &SeratoMarkers) -> Vec<Cue> {
    let mut cues: Vec<Cue> = m
        .cues
        .iter()
        .map(|c| Cue {
            kind: CueKind::Hot,
            slot: Some(c.index.min(15)),
            seconds: c.ms as f64 / 1000.0,
            loop_seconds: None,
            color: Some(c.color),
            label: c.name.clone(),
        })
        .collect();
    for l in &m.loops {
        if l.end_ms > l.start_ms {
            cues.push(Cue {
                kind: CueKind::Memory,
                slot: None,
                seconds: l.start_ms as f64 / 1000.0,
                loop_seconds: Some((l.end_ms - l.start_ms) as f64 / 1000.0),
                color: None,
                label: l.name.clone(),
            });
        }
    }
    cues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_and_paths() {
        assert_eq!(serato_root(Path::new("C:\\Users\\dj\\Music\\_Serato_")), PathBuf::from("C:\\"));
        assert_eq!(serato_root(Path::new("/Volumes/USB/_Serato_")), PathBuf::from("/Volumes/USB"));
        assert_eq!(serato_root(Path::new("/Users/dj/Music/_Serato_")), PathBuf::from("/"));
        assert_eq!(
            serato_path(Path::new("C:\\"), "Users/dj/Music/a b.mp3"),
            PathBuf::from("C:\\Users\\dj\\Music\\a b.mp3")
        );
        assert_eq!(serato_path(Path::new("/Volumes/USB"), "Music/x.mp3"), PathBuf::from("/Volumes/USB/Music/x.mp3"));
        assert_eq!(serato_path(Path::new("/"), "Users/dj/x.mp3"), PathBuf::from("/Users/dj/x.mp3"));
        assert_eq!(serato_rel(Path::new("C:\\"), Path::new("C:\\Users\\dj\\a.mp3")), "Users/dj/a.mp3");
        assert_eq!(serato_rel(Path::new("/"), Path::new("/home/dj/a.mp3")), "home/dj/a.mp3");
    }

    #[test]
    fn fields_round_trip() {
        let f = vec![
            Field::Text("vrsn".into(), "1.0/Serato ScratchLive Crate".into()),
            Field::List(
                "otrk".into(),
                vec![
                    Field::Text("ptrk".into(), "Music/Déjà vu.mp3".into()),
                    Field::Flag("bmis".into(), false),
                    Field::Number("uadd".into(), 1_700_000_000),
                ],
            ),
        ];
        assert_eq!(parse_fields(&write_fields(&f)), f);
    }

    #[test]
    fn grids_both_ways() {
        let g = grid_from_serato(&[SeratoGridMarker { seconds: 0.5, bpm: 120.0 }], 44_100).unwrap();
        assert!((g.frame_at(0.0) - 22_050.0).abs() < 1e-6);
        let back = grid_to_serato(&g);
        assert_eq!(back.len(), 1);
        assert!((back[0].seconds - 0.5).abs() < 1e-9 && (back[0].bpm - 120.0).abs() < 1e-9);
        let warped = grid_from_serato(
            &[SeratoGridMarker { seconds: 0.0, bpm: 120.0 }, SeratoGridMarker { seconds: 32.0, bpm: 126.0 }],
            44_100,
        )
        .unwrap();
        assert!((warped.beat_at(32.0 * 44_100.0) - 64.0).abs() < 1e-6);
        assert!((warped.bpm_at(40.0 * 44_100.0) - 126.0).abs() < 1e-6);
        let m = grid_to_serato(&warped);
        assert!(
            (m[0].bpm - 120.0).abs() < 1e-6 && (m[1].seconds - 32.0).abs() < 1e-6 && (m[1].bpm - 126.0).abs() < 1e-6,
            "{m:?}"
        );
    }
}
