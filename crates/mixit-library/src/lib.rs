//! The music library.
//!
//! A single SQLite file holds the catalogue: tracks with their tags and analysis, user
//! edits (beatgrids, cue points), playlists and folders, smart playlists (saved
//! searches), free-form tags, play history and watched folders. Full-text search uses
//! FTS5. The [`query`] module defines the search language; [`suggest`] ranks what to
//! play next; [`scan`] imports folders; [`jobs`] runs analysis in parallel; [`m3u`]
//! and [`rekordbox`] exchange playlists and collections with other software.

pub mod backup;
pub mod jobs;
pub mod m3u;
pub mod plan;
pub mod query;
pub mod rekordbox;
pub mod scan;
mod schema;
pub mod serato;
pub mod setbuild;
pub mod suggest;
pub mod traktor;
pub mod virtualdj;

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use mixit_analysis::{Analysis, Waveform};
use mixit_core::{Beatgrid, ContentHash, Key, TrackId};
use rusqlite::{Connection, OptionalExtension, Row, params, types::Value};
use serde::{Deserialize, Serialize};

pub use schema::SCHEMA_VERSION;

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] mixit_io::IoError),
    #[error("file: {0}")]
    File(#[from] std::io::Error),
    #[error("data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("xml: {0}")]
    Xml(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, LibraryError>;

pub fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnalysisState {
    Pending = 0,
    Done = 1,
    Failed = 2,
}

impl AnalysisState {
    fn from_i64(v: i64) -> AnalysisState {
        match v {
            1 => AnalysisState::Done,
            2 => AnalysisState::Failed,
            _ => AnalysisState::Pending,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub path: PathBuf,
    pub hash: Option<String>,
    pub file_size: u64,
    pub file_mtime: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub label: String,
    pub remixer: String,
    pub comment: String,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    pub duration: f64,
    pub sample_rate: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub channels: Option<u8>,
    pub has_artwork: bool,
    /// BPM and key written in the file's tags (by other software).
    pub tag_bpm: Option<f64>,
    pub tag_key: Option<String>,
    /// From MixIt's analysis.
    pub bpm: Option<f64>,
    pub key: Option<Key>,
    pub energy: Option<u8>,
    pub lufs: Option<f64>,
    pub auto_gain_db: Option<f64>,
    pub analysis_version: u32,
    pub analysis_state: AnalysisState,
    pub analysis_error: Option<String>,
    pub rating: u8,
    pub color: Option<u32>,
    pub play_count: u32,
    pub last_played: Option<i64>,
    pub added_at: i64,
    pub missing: bool,
    pub grid_locked: bool,
}

impl Track {
    /// Title for display, falling back to the file name.
    pub fn display_title(&self) -> String {
        if !self.title.is_empty() {
            return self.title.clone();
        }
        self.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
    }

    /// Best known tempo (analysis first, then tags).
    pub fn best_bpm(&self) -> Option<f64> {
        self.bpm.or(self.tag_bpm)
    }

    /// Best known key (analysis first, then tags).
    pub fn best_key(&self) -> Option<Key> {
        self.key.or_else(|| self.tag_key.as_deref().and_then(Key::parse))
    }

    pub fn candidate(&self) -> suggest::Candidate {
        suggest::Candidate {
            id: self.id,
            bpm: self.best_bpm(),
            key: self.best_key(),
            energy: self.energy,
            genre: self.genre.clone(),
            rating: self.rating,
            sound: vec![],
        }
    }
}

fn sound_to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn sound_from_bytes(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

const TRACK_COLS: &str = "t.id, t.path, t.hash, t.file_size, t.file_mtime, t.title, t.artist, t.album, \
    t.album_artist, t.genre, t.label, t.remixer, t.comment, t.year, t.track_number, t.duration, t.sample_rate, \
    t.bitrate_kbps, t.channels, t.has_artwork, t.tag_bpm, t.tag_key, t.bpm, t.key_index, t.energy, t.lufs, \
    t.auto_gain_db, t.analysis_version, t.analysis_state, t.analysis_error, t.rating, t.color, t.play_count, \
    t.last_played, t.added_at, t.missing, t.grid_locked";

fn track_from_row(r: &Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: r.get(0)?,
        path: PathBuf::from(r.get::<_, String>(1)?),
        hash: r.get(2)?,
        file_size: r.get::<_, i64>(3)? as u64,
        file_mtime: r.get(4)?,
        title: r.get(5)?,
        artist: r.get(6)?,
        album: r.get(7)?,
        album_artist: r.get(8)?,
        genre: r.get(9)?,
        label: r.get(10)?,
        remixer: r.get(11)?,
        comment: r.get(12)?,
        year: r.get(13)?,
        track_number: r.get(14)?,
        duration: r.get(15)?,
        sample_rate: r.get(16)?,
        bitrate_kbps: r.get(17)?,
        channels: r.get(18)?,
        has_artwork: r.get::<_, i64>(19)? != 0,
        tag_bpm: r.get(20)?,
        tag_key: r.get(21)?,
        bpm: r.get(22)?,
        key: r.get::<_, Option<i64>>(23)?.map(|i| Key::from_index(i as usize)),
        energy: r.get(24)?,
        lufs: r.get(25)?,
        auto_gain_db: r.get(26)?,
        analysis_version: r.get(27)?,
        analysis_state: AnalysisState::from_i64(r.get(28)?),
        analysis_error: r.get(29)?,
        rating: r.get(30)?,
        color: r.get(31)?,
        play_count: r.get(32)?,
        last_played: r.get(33)?,
        added_at: r.get(34)?,
        missing: r.get::<_, i64>(35)? != 0,
        grid_locked: r.get::<_, i64>(36)? != 0,
    })
}

/// Fields the user can edit on a track. `None` leaves a field unchanged.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub label: Option<String>,
    pub remixer: Option<String>,
    pub comment: Option<String>,
    pub year: Option<Option<u32>>,
    pub rating: Option<u8>,
    pub color: Option<Option<u32>>,
    /// Overrides the analysed key (the user knows better).
    pub key: Option<Option<Key>>,
    pub bpm: Option<Option<f64>>,
    pub energy: Option<Option<u8>>,
}

/// Metadata for inserting a track.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewTrack {
    pub path: PathBuf,
    pub hash: Option<ContentHash>,
    pub file_size: u64,
    pub file_mtime: i64,
    pub tags: mixit_io::TrackTags,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CueKind {
    /// Hot cue in a numbered slot (pads 1–16).
    Hot,
    /// Memory cue (unnumbered markers, like CDJ memory points).
    Memory,
    /// The main cue point (where the track starts when loaded).
    Main,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cue {
    pub kind: CueKind,
    /// Hot cue slot 0–15.
    pub slot: Option<u8>,
    pub seconds: f64,
    /// Loop length for loop cues.
    pub loop_seconds: Option<f64>,
    pub color: Option<u32>,
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlaylistKind {
    Folder = 0,
    List = 1,
    /// A saved search, evaluated live.
    Smart = 2,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Playlist {
    pub id: i64,
    pub parent: Option<i64>,
    pub name: String,
    pub kind: PlaylistKind,
    pub query: Option<String>,
    pub position: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub color: Option<u32>,
}

/// A DJ session (one run of the app) that played at least one track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: i64,
    pub name: String,
    pub started_at: i64,
    /// Tracks played.
    pub tracks: i64,
    pub first_played: i64,
    pub last_played: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub track_id: Option<TrackId>,
    pub played_at: i64,
    pub deck: Option<u8>,
    pub title: String,
    pub artist: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LibraryStats {
    pub tracks: u64,
    pub analysed: u64,
    pub pending: u64,
    pub failed: u64,
    pub missing: u64,
    pub playlists: u64,
    pub total_seconds: f64,
}

pub struct Library {
    conn: Connection,
    path: Option<PathBuf>,
}

/// A nestable transaction (SQLite savepoint); rolls back unless committed.
pub struct Tx<'a> {
    conn: &'a Connection,
    done: bool,
}

impl Tx<'_> {
    pub fn commit(mut self) -> Result<()> {
        self.conn.execute_batch("RELEASE mixit_tx")?;
        self.done = true;
        Ok(())
    }
}

impl Drop for Tx<'_> {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.conn.execute_batch("ROLLBACK TO mixit_tx; RELEASE mixit_tx");
        }
    }
}

fn key_order(k: Key) -> i64 {
    let (n, l) = k.camelot();
    (n as i64 - 1) * 2 + if l == 'B' { 1 } else { 0 }
}

impl Library {
    pub fn open(path: &Path) -> Result<Library> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut conn = Connection::open(path)?;
        schema::migrate(&mut conn)?;
        Ok(Library { conn, path: Some(path.to_path_buf()) })
    }

    pub fn open_in_memory() -> Result<Library> {
        let mut conn = Connection::open_in_memory()?;
        schema::migrate(&mut conn)?;
        Ok(Library { conn, path: None })
    }

    /// Starts a transaction; transactions nest.
    pub fn begin(&self) -> Result<Tx<'_>> {
        self.conn.execute_batch("SAVEPOINT mixit_tx")?;
        Ok(Tx { conn: &self.conn, done: false })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Direct access for advanced queries and tests.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    // ---------------------------------------------------------------- tracks

    pub fn insert_track(&self, t: &NewTrack) -> Result<TrackId> {
        let g = &t.tags;
        let s = |o: &Option<String>| o.clone().unwrap_or_default();
        self.conn.execute(
            "INSERT INTO tracks (path, hash, file_size, file_mtime, title, artist, album, album_artist, genre, label,
                remixer, comment, year, track_number, duration, sample_rate, bitrate_kbps, channels, has_artwork,
                tag_bpm, tag_key, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            params![
                t.path.to_string_lossy(),
                t.hash.map(|h| h.to_hex()),
                t.file_size as i64,
                t.file_mtime,
                s(&g.title),
                s(&g.artist),
                s(&g.album),
                s(&g.album_artist),
                s(&g.genre),
                s(&g.label),
                s(&g.remixer),
                s(&g.comment),
                g.year,
                g.track_number,
                g.duration_s,
                g.sample_rate,
                g.bitrate_kbps,
                g.channels,
                g.has_artwork as i64,
                g.bpm,
                g.key,
                now(),
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Refreshes file metadata and tags after the file changed on disk (keeps the
    /// user's edits, cues and history; analysis is redone if the audio changed).
    pub fn refresh_track(&self, id: TrackId, t: &NewTrack) -> Result<()> {
        let g = &t.tags;
        let s = |o: &Option<String>| o.clone().unwrap_or_default();
        let old_hash: Option<String> =
            self.conn.query_row("SELECT hash FROM tracks WHERE id = ?", [id], |r| r.get(0))?;
        let new_hash = t.hash.map(|h| h.to_hex());
        self.conn.execute(
            "UPDATE tracks SET path = ?2, hash = ?3, file_size = ?4, file_mtime = ?5, title = ?6, artist = ?7,
                album = ?8, album_artist = ?9, genre = ?10, label = ?11, remixer = ?12, comment = ?13, year = ?14,
                track_number = ?15, duration = ?16, sample_rate = ?17, bitrate_kbps = ?18, channels = ?19,
                has_artwork = ?20, tag_bpm = ?21, tag_key = ?22, missing = 0
             WHERE id = ?1",
            params![
                id,
                t.path.to_string_lossy(),
                new_hash,
                t.file_size as i64,
                t.file_mtime,
                s(&g.title),
                s(&g.artist),
                s(&g.album),
                s(&g.album_artist),
                s(&g.genre),
                s(&g.label),
                s(&g.remixer),
                s(&g.comment),
                g.year,
                g.track_number,
                g.duration_s,
                g.sample_rate,
                g.bitrate_kbps,
                g.channels,
                g.has_artwork as i64,
                g.bpm,
                g.key,
            ],
        )?;
        if old_hash != new_hash {
            self.conn.execute("UPDATE tracks SET analysis_state = 0 WHERE id = ?", [id])?;
        }
        Ok(())
    }

    pub fn track(&self, id: TrackId) -> Result<Track> {
        self.conn
            .query_row(&format!("SELECT {TRACK_COLS} FROM tracks t WHERE t.id = ?"), [id], track_from_row)
            .optional()?
            .ok_or_else(|| LibraryError::NotFound(format!("track {id}")))
    }

    pub fn track_by_path(&self, path: &Path) -> Result<Option<Track>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {TRACK_COLS} FROM tracks t WHERE t.path = ?"),
                [path.to_string_lossy()],
                track_from_row,
            )
            .optional()?)
    }

    pub fn tracks_by_hash(&self, hash: &str) -> Result<Vec<Track>> {
        let mut st = self.conn.prepare(&format!("SELECT {TRACK_COLS} FROM tracks t WHERE t.hash = ? ORDER BY t.id"))?;
        let rows = st.query_map([hash], track_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn all_tracks(&self) -> Result<Vec<Track>> {
        let mut st = self.conn.prepare(&format!("SELECT {TRACK_COLS} FROM tracks t ORDER BY t.id"))?;
        let rows = st.query_map([], track_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn track_count(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn edit_track(&self, id: TrackId, e: &TrackEdit) -> Result<()> {
        let mut sets: Vec<String> = Vec::new();
        let mut vals: Vec<Value> = Vec::new();
        let mut text = |col: &str, v: &Option<String>| {
            if let Some(v) = v {
                sets.push(format!("{col} = ?"));
                vals.push(Value::Text(v.clone()));
            }
        };
        text("title", &e.title);
        text("artist", &e.artist);
        text("album", &e.album);
        text("genre", &e.genre);
        text("label", &e.label);
        text("remixer", &e.remixer);
        text("comment", &e.comment);
        let opt_int = |v: Option<i64>| v.map(Value::Integer).unwrap_or(Value::Null);
        if let Some(y) = e.year {
            sets.push("year = ?".into());
            vals.push(opt_int(y.map(|v| v as i64)));
        }
        if let Some(r) = e.rating {
            sets.push("rating = ?".into());
            vals.push(Value::Integer(r.min(5) as i64));
        }
        if let Some(c) = e.color {
            sets.push("color = ?".into());
            vals.push(opt_int(c.map(|v| v as i64)));
        }
        if let Some(k) = e.key {
            sets.push("key_index = ?".into());
            vals.push(opt_int(k.map(|k| k.index() as i64)));
            sets.push("key_order = ?".into());
            vals.push(opt_int(k.map(key_order)));
        }
        if let Some(b) = e.bpm {
            sets.push("bpm = ?".into());
            vals.push(b.map(Value::Real).unwrap_or(Value::Null));
        }
        if let Some(en) = e.energy {
            sets.push("energy = ?".into());
            vals.push(opt_int(en.map(|v| v.clamp(1, 10) as i64)));
        }
        if sets.is_empty() {
            return Ok(());
        }
        vals.push(Value::Integer(id));
        let sql = format!("UPDATE tracks SET {} WHERE id = ?", sets.join(", "));
        let n = self.conn.execute(&sql, rusqlite::params_from_iter(vals))?;
        if n == 0 {
            return Err(LibraryError::NotFound(format!("track {id}")));
        }
        Ok(())
    }

    /// Removes tracks from the library (never touches the files).
    pub fn remove_tracks(&self, ids: &[TrackId]) -> Result<()> {
        let tx = self.begin()?;
        for id in ids {
            self.conn.execute("DELETE FROM tracks WHERE id = ?", [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_missing(&self, id: TrackId, missing: bool) -> Result<()> {
        self.conn.execute("UPDATE tracks SET missing = ? WHERE id = ?", params![missing as i64, id])?;
        Ok(())
    }

    /// Records a file's new size, time and hash after MixIt changed it (wrote its tags),
    /// so the next scan sees it as unchanged instead of reading it again.
    pub fn set_file_info(&self, id: TrackId, size: u64, mtime: i64, hash: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE tracks SET file_size = ?2, file_mtime = ?3, hash = COALESCE(?4, hash) WHERE id = ?1",
            params![id, size as i64, mtime, hash],
        )?;
        Ok(())
    }

    /// Points a track at a new file (relocating a moved or renamed file).
    pub fn relocate(&self, id: TrackId, path: &Path) -> Result<()> {
        self.conn
            .execute("UPDATE tracks SET path = ?, missing = 0 WHERE id = ?", params![path.to_string_lossy(), id])?;
        Ok(())
    }

    /// Rewrites a path prefix for every track (a music folder moved to another drive).
    pub fn relocate_prefix(&self, from: &Path, to: &Path) -> Result<usize> {
        let (f, t) = (from.to_string_lossy().into_owned(), to.to_string_lossy().into_owned());
        let n = self.conn.execute(
            "UPDATE tracks SET path = ?2 || substr(path, length(?1) + 1), missing = 0 WHERE substr(path, 1, length(?1)) = ?1",
            params![f, t],
        )?;
        Ok(n)
    }

    /// Groups of tracks with identical audio content.
    pub fn duplicates(&self) -> Result<Vec<Vec<TrackId>>> {
        let mut st = self.conn.prepare(
            "SELECT group_concat(id) FROM tracks WHERE hash IS NOT NULL GROUP BY hash HAVING COUNT(*) > 1 ORDER BY MIN(id)",
        )?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?.split(',').filter_map(|s| s.parse().ok()).collect());
        }
        Ok(out)
    }

    /// Folds duplicate tracks into one: the others' playlist places, tags, play history
    /// and (when `keep` has none) cues move to `keep`, which also takes the highest
    /// rating, the summed play count and any colour or comment it lacks. The others are
    /// then removed from the library (their files are left alone).
    pub fn merge_tracks(&self, keep: TrackId, others: &[TrackId]) -> Result<()> {
        let others: Vec<TrackId> = others.iter().copied().filter(|&o| o != keep).collect();
        if others.is_empty() {
            return Ok(());
        }
        let kept = self.track(keep)?;
        let olds = others.iter().map(|&o| self.track(o)).collect::<Result<Vec<_>>>()?;
        let mut kept_cues = self.cues(keep)?;
        let tx = self.begin()?;
        for o in &olds {
            self.conn.execute("UPDATE playlist_entries SET track_id = ?1 WHERE track_id = ?2", params![keep, o.id])?;
            self.conn.execute(
                "INSERT OR IGNORE INTO track_tags (track_id, tag_id) SELECT ?1, tag_id FROM track_tags WHERE track_id = ?2",
                params![keep, o.id],
            )?;
            self.conn.execute("UPDATE history SET track_id = ?1 WHERE track_id = ?2", params![keep, o.id])?;
            if kept_cues.is_empty() {
                let cues = self.cues(o.id)?;
                if !cues.is_empty() {
                    self.set_cues(keep, &cues)?;
                    kept_cues = cues;
                }
            }
        }
        let rating = olds.iter().map(|t| t.rating).chain([kept.rating]).max().unwrap_or(0);
        let plays: u32 = olds.iter().map(|t| t.play_count).sum::<u32>() + kept.play_count;
        let last = olds.iter().filter_map(|t| t.last_played).chain(kept.last_played).max();
        let color = kept.color.or_else(|| olds.iter().find_map(|t| t.color));
        let comment = if kept.comment.is_empty() {
            olds.iter().map(|t| t.comment.clone()).find(|c| !c.is_empty()).unwrap_or_default()
        } else {
            kept.comment.clone()
        };
        self.conn.execute(
            "UPDATE tracks SET rating = ?2, play_count = ?3, last_played = ?4, color = ?5, comment = ?6 WHERE id = ?1",
            params![keep, rating, plays, last, color, comment],
        )?;
        for o in &olds {
            self.conn.execute("DELETE FROM tracks WHERE id = ?", [o.id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Tracks whose files are gone (flagged by a scan, or not there now).
    pub fn missing_tracks(&self) -> Result<Vec<Track>> {
        Ok(self.all_tracks()?.into_iter().filter(|t| t.missing || !t.path.exists()).collect())
    }

    // ---------------------------------------------------------------- search

    /// Runs a search in the [`query`] language.
    pub fn search(&self, q: &str, limit: Option<usize>) -> Result<Vec<Track>> {
        self.search_query(&query::parse(q), limit)
    }

    pub fn search_query(&self, q: &query::Query, limit: Option<usize>) -> Result<Vec<Track>> {
        let (wh, params, order) = query::to_sql(q, now());
        let lim = limit.map(|l| format!(" LIMIT {l}")).unwrap_or_default();
        let sql = format!("SELECT {TRACK_COLS} FROM tracks t WHERE {wh} ORDER BY {order}{lim}");
        let mut st = self.conn.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(params), track_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Ranks library tracks to follow `current` (see [`suggest`]).
    pub fn suggest_next(&self, current: TrackId, opts: &suggest::SuggestOptions) -> Result<Vec<suggest::Suggestion>> {
        let mut opts = opts.clone();
        if opts.played_after.is_empty() {
            opts.played_after = self.played_after(current)?;
        }
        let opts = &opts;
        let sounds = self.standard_sounds()?;
        let with_sound = |t: &Track| {
            let mut c = t.candidate();
            c.sound = sounds.get(&t.id).cloned().unwrap_or_default();
            c
        };
        let cur = with_sound(&self.track(current)?);
        let pool: Vec<suggest::Candidate> = self.search("missing:no", None)?.iter().map(with_sound).collect();
        Ok(suggest::suggest(&cur, &pool, opts))
    }

    /// Builds a set from the tracks a search finds (empty: the whole library), within a
    /// playlist when `within` is given, to fill `opts.minutes` along `opts.shape` (see
    /// [`setbuild`]). Only tracks with a known tempo whose files are there take part.
    /// Returns track ids in playing order.
    pub fn build_set(&self, query: &str, within: Option<i64>, opts: &setbuild::BuildOptions) -> Result<Vec<TrackId>> {
        let sounds = self.standard_sounds()?;
        let mut tracks = self.search(&format!("{query} missing:no"), None)?;
        if let Some(list) = within {
            let keep: std::collections::HashSet<TrackId> = self.playlist_tracks(list)?.into_iter().collect();
            tracks.retain(|t| keep.contains(&t.id));
        }
        if let Some(seed) = opts.seed.filter(|s| !tracks.iter().any(|t| t.id == *s)) {
            // The opener may come from outside the search.
            tracks.push(self.track(seed)?);
        }
        let pool: Vec<setbuild::PoolTrack> = tracks
            .iter()
            .filter(|t| t.best_bpm().is_some() && t.duration > 0.0)
            .map(|t| {
                let mut c = t.candidate();
                c.sound = sounds.get(&t.id).cloned().unwrap_or_default();
                setbuild::PoolTrack { candidate: c, duration: t.duration, artist: t.artist.clone() }
            })
            .collect();
        Ok(setbuild::build_set(&pool, opts).into_iter().map(|i| pool[i].candidate.id).collect())
    }

    // ---------------------------------------------------------------- sounds like

    /// Every stored sound profile (tracks whose files are there).
    pub fn sound_profiles(&self) -> Result<Vec<(TrackId, Vec<f32>)>> {
        let mut st = self.conn.prepare("SELECT id, sound FROM tracks WHERE sound IS NOT NULL AND missing = 0")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, TrackId>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, bytes) = row?;
            let v = sound_from_bytes(&bytes);
            if v.len() == mixit_analysis::timbre::PROFILE_LEN {
                out.push((id, v));
            }
        }
        Ok(out)
    }

    /// Profiles in standard units over the whole library, ready to compare.
    fn standard_sounds(&self) -> Result<std::collections::HashMap<TrackId, Vec<f32>>> {
        let all = self.sound_profiles()?;
        let n = mixit_analysis::timbre::Normaliser::fit(all.iter().map(|(_, v)| v.as_slice()));
        Ok(all.into_iter().map(|(id, v)| (id, n.apply(&v))).collect())
    }

    /// Tracks that sound most like `id` (instruments, production, groove), best first,
    /// with their similarity 0..1. Empty when `id` has no profile yet (not analysed).
    pub fn sounds_like(&self, id: TrackId, limit: usize) -> Result<Vec<(TrackId, f64)>> {
        let sounds = self.standard_sounds()?;
        let Some(me) = sounds.get(&id) else { return Ok(vec![]) };
        let mut out: Vec<(TrackId, f64)> = sounds
            .iter()
            .filter(|(other, _)| **other != id)
            .filter_map(|(other, v)| mixit_analysis::timbre::similarity(me, v).map(|s| (*other, s)))
            .collect();
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        out.truncate(limit);
        Ok(out)
    }

    // ---------------------------------------------------------------- analysis

    /// Stores an analysis and copies its headline values into the track row. A grid the
    /// user locked is kept (only the rest of the analysis is replaced).
    pub fn save_analysis(&self, id: TrackId, a: &Analysis) -> Result<()> {
        let mut stored = a.clone();
        let wave = stored.waveform.take();
        let data = serde_json::to_string(&stored)?;
        let tx = self.begin()?;
        self.conn.execute(
            "INSERT OR REPLACE INTO analyses (track_id, version, data, waveform, waveform_sr) VALUES (?, ?, ?, ?, ?)",
            params![id, a.version, data, wave.as_ref().map(|w| w.base_bytes()), wave.as_ref().map(|w| w.sample_rate)],
        )?;
        let key = a.key.as_ref().map(|k| k.key);
        self.conn.execute(
            "UPDATE tracks SET bpm = ?2, key_index = ?3, key_order = ?4, energy = ?5, lufs = ?6, auto_gain_db = ?7,
                analysis_version = ?8, analysis_state = 1, analysis_error = NULL,
                duration = CASE WHEN duration > 0 THEN duration ELSE ?9 END, sound = ?10
             WHERE id = ?1",
            params![
                id,
                a.bpm,
                key.map(|k| k.index() as i64),
                key.map(key_order),
                a.energy,
                a.loudness.integrated_lufs,
                a.loudness.auto_gain_db,
                a.version,
                a.duration,
                (!a.sound.is_empty()).then(|| sound_to_bytes(&a.sound)),
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn mark_analysis_failed(&self, id: TrackId, error: &str) -> Result<()> {
        self.conn
            .execute("UPDATE tracks SET analysis_state = 2, analysis_error = ? WHERE id = ?", params![error, id])?;
        Ok(())
    }

    /// The stored analysis with its waveform, or `None` if not analysed.
    pub fn analysis(&self, id: TrackId) -> Result<Option<Analysis>> {
        let row: Option<(String, Option<Vec<u8>>, Option<u32>)> = self
            .conn
            .query_row("SELECT data, waveform, waveform_sr FROM analyses WHERE track_id = ?", [id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let Some((data, wave, sr)) = row else { return Ok(None) };
        let mut a: Analysis = serde_json::from_str(&data)?;
        if let (Some(w), Some(sr)) = (wave, sr) {
            a.waveform = Some(Waveform::from_base_bytes(sr, &w));
        }
        Ok(Some(a))
    }

    /// Tracks that need (re-)analysis: never analysed, or analysed by an older version.
    pub fn pending_analysis(&self, limit: usize) -> Result<Vec<Track>> {
        let mut st = self.conn.prepare(&format!(
            "SELECT {TRACK_COLS} FROM tracks t WHERE t.missing = 0 AND
               (t.analysis_state = 0 OR (t.analysis_state = 1 AND t.analysis_version < ?))
             ORDER BY t.added_at DESC, t.id LIMIT ?"
        ))?;
        let rows = st.query_map(params![mixit_analysis::ANALYSIS_VERSION, limit as i64], track_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The grid to use: the user's edited grid if any, else the analysed one.
    pub fn grid(&self, id: TrackId) -> Result<Option<Beatgrid>> {
        let edited: Option<String> =
            self.conn.query_row("SELECT data FROM grids WHERE track_id = ?", [id], |r| r.get(0)).optional()?;
        if let Some(g) = edited {
            return Ok(Some(serde_json::from_str(&g)?));
        }
        Ok(self.analysis(id)?.map(|a| a.grid))
    }

    /// Saves a user-edited grid; `locked` protects it from re-analysis.
    pub fn save_grid(&self, id: TrackId, grid: &Beatgrid) -> Result<()> {
        let data = serde_json::to_string(grid)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO grids (track_id, data, edited_at) VALUES (?, ?, ?)",
            params![id, data, now()],
        )?;
        self.conn.execute(
            "UPDATE tracks SET grid_locked = ?, bpm = ? WHERE id = ?",
            params![grid.locked as i64, grid.bpm, id],
        )?;
        Ok(())
    }

    /// Drops the user's grid edits (back to the analysed grid).
    pub fn reset_grid(&self, id: TrackId) -> Result<()> {
        self.conn.execute("DELETE FROM grids WHERE track_id = ?", [id])?;
        self.conn.execute(
            "UPDATE tracks SET grid_locked = 0, bpm = (SELECT json_extract(data, '$.bpm') FROM analyses WHERE track_id = ?1) WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------------- cues

    pub fn cues(&self, id: TrackId) -> Result<Vec<Cue>> {
        let mut st = self.conn.prepare(
            "SELECT kind, slot, seconds, loop_seconds, color, label FROM cues WHERE track_id = ? ORDER BY kind, slot, seconds",
        )?;
        let rows = st.query_map([id], |r| {
            let kind = match r.get::<_, i64>(0)? {
                0 => CueKind::Main,
                1 => CueKind::Hot,
                _ => CueKind::Memory,
            };
            Ok(Cue {
                kind,
                slot: r.get(1)?,
                seconds: r.get(2)?,
                loop_seconds: r.get(3)?,
                color: r.get(4)?,
                label: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Replaces all cues of a track.
    pub fn set_cues(&self, id: TrackId, cues: &[Cue]) -> Result<()> {
        let tx = self.begin()?;
        self.conn.execute("DELETE FROM cues WHERE track_id = ?", [id])?;
        for c in cues {
            let kind = match c.kind {
                CueKind::Main => 0,
                CueKind::Hot => 1,
                CueKind::Memory => 2,
            };
            self.conn.execute(
                "INSERT INTO cues (track_id, kind, slot, seconds, loop_seconds, color, label) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![id, kind, c.slot, c.seconds, c.loop_seconds, c.color, c.label],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Fills empty hot cue slots from the analysis' cue suggestions (first-time load).
    pub fn auto_cues(&self, id: TrackId, max: usize) -> Result<Vec<Cue>> {
        let mut cues = self.cues(id)?;
        if cues.iter().any(|c| c.kind == CueKind::Hot) {
            return Ok(cues);
        }
        let Some(a) = self.analysis(id)? else { return Ok(cues) };
        for (slot, s) in a.cues.iter().take(max.min(16)).enumerate() {
            if s.role == mixit_analysis::CueRole::Load && !cues.iter().any(|c| c.kind == CueKind::Main) {
                cues.push(Cue {
                    kind: CueKind::Main,
                    slot: None,
                    seconds: s.seconds,
                    loop_seconds: None,
                    color: None,
                    label: String::new(),
                });
            }
            let loop_seconds = s.loop_beats.map(|b| b * 60.0 / a.bpm);
            cues.push(Cue {
                kind: CueKind::Hot,
                slot: Some(slot as u8),
                seconds: s.seconds,
                loop_seconds,
                color: Some(s.color),
                label: s.label.clone(),
            });
        }
        self.set_cues(id, &cues)?;
        Ok(cues)
    }

    // ---------------------------------------------------------------- playlists

    pub fn create_playlist(
        &self,
        name: &str,
        kind: PlaylistKind,
        parent: Option<i64>,
        query: Option<&str>,
    ) -> Result<i64> {
        let pos: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlists WHERE parent_id IS ?",
            [parent],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO playlists (parent_id, name, kind, query, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![parent, name, kind as i64, query, pos, now()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn playlists(&self) -> Result<Vec<Playlist>> {
        let mut st = self
            .conn
            .prepare("SELECT id, parent_id, name, kind, query, position FROM playlists ORDER BY parent_id, position")?;
        let rows = st.query_map([], |r| {
            let kind = match r.get::<_, i64>(3)? {
                0 => PlaylistKind::Folder,
                2 => PlaylistKind::Smart,
                _ => PlaylistKind::List,
            };
            Ok(Playlist {
                id: r.get(0)?,
                parent: r.get(1)?,
                name: r.get(2)?,
                kind,
                query: r.get(4)?,
                position: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn playlist(&self, id: i64) -> Result<Playlist> {
        self.playlists()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| LibraryError::NotFound(format!("playlist {id}")))
    }

    pub fn rename_playlist(&self, id: i64, name: &str) -> Result<()> {
        self.conn.execute("UPDATE playlists SET name = ? WHERE id = ?", params![name, id])?;
        Ok(())
    }

    pub fn set_smart_query(&self, id: i64, query: &str) -> Result<()> {
        self.conn.execute("UPDATE playlists SET query = ? WHERE id = ?", params![query, id])?;
        Ok(())
    }

    /// Moves a playlist or folder into a folder (or to the top with `None`), at
    /// `position` among what is there (past the end puts it last). A folder cannot go
    /// inside itself, and only folders hold playlists.
    pub fn move_playlist(&self, id: i64, parent: Option<i64>, position: i64) -> Result<()> {
        let all = self.playlists()?;
        if let Some(p) = parent {
            let target =
                all.iter().find(|x| x.id == p).ok_or_else(|| LibraryError::Invalid("no such folder".into()))?;
            if target.kind != PlaylistKind::Folder {
                return Err(LibraryError::Invalid("playlists go into folders, not into other playlists".into()));
            }
            // Walk up from the target: meeting `id` means it would go inside itself.
            let mut at = Some(p);
            while let Some(a) = at {
                if a == id {
                    return Err(LibraryError::Invalid("a folder cannot go inside itself".into()));
                }
                at = all.iter().find(|x| x.id == a).and_then(|x| x.parent);
            }
        }
        let mut siblings: Vec<i64> = all.iter().filter(|x| x.parent == parent && x.id != id).map(|x| x.id).collect();
        let at = (position.max(0) as usize).min(siblings.len());
        siblings.insert(at, id);
        let tx = self.begin()?;
        self.conn.execute("UPDATE playlists SET parent_id = ? WHERE id = ?", params![parent, id])?;
        for (i, sid) in siblings.iter().enumerate() {
            self.conn.execute("UPDATE playlists SET position = ? WHERE id = ?", params![i as i64, sid])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_playlist(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM playlists WHERE id = ?", [id])?;
        Ok(())
    }

    /// Track ids of a list in order (smart playlists are evaluated).
    pub fn playlist_tracks(&self, id: i64) -> Result<Vec<TrackId>> {
        let p = self.playlist(id)?;
        match p.kind {
            PlaylistKind::Smart => {
                Ok(self.search(p.query.as_deref().unwrap_or(""), None)?.iter().map(|t| t.id).collect())
            }
            PlaylistKind::Folder => Ok(vec![]),
            PlaylistKind::List => {
                let mut st = self
                    .conn
                    .prepare("SELECT track_id FROM playlist_entries WHERE playlist_id = ? ORDER BY position")?;
                let rows = st.query_map([id], |r| r.get(0))?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            }
        }
    }

    /// Replaces the contents of a list.
    pub fn set_playlist_tracks(&self, id: i64, tracks: &[TrackId]) -> Result<()> {
        let tx = self.begin()?;
        self.conn.execute("DELETE FROM playlist_entries WHERE playlist_id = ?", [id])?;
        for (i, t) in tracks.iter().enumerate() {
            self.conn.execute(
                "INSERT INTO playlist_entries (playlist_id, position, track_id) VALUES (?, ?, ?)",
                params![id, i as i64, t],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn add_to_playlist(&self, id: i64, tracks: &[TrackId]) -> Result<()> {
        let mut all = self.playlist_tracks(id)?;
        all.extend_from_slice(tracks);
        self.set_playlist_tracks(id, &all)
    }

    /// Moves entries `from` (indices) to before index `to`.
    pub fn reorder_playlist(&self, id: i64, from: &[usize], to: usize) -> Result<()> {
        let all = self.playlist_tracks(id)?;
        let moving: Vec<TrackId> = from.iter().filter_map(|&i| all.get(i).copied()).collect();
        let mut rest: Vec<(usize, TrackId)> =
            all.iter().copied().enumerate().filter(|(i, _)| !from.contains(i)).collect();
        let insert_at = rest.iter().position(|(i, _)| *i >= to).unwrap_or(rest.len());
        let tail = rest.split_off(insert_at);
        let mut out: Vec<TrackId> = rest.into_iter().map(|x| x.1).collect();
        out.extend(moving);
        out.extend(tail.into_iter().map(|x| x.1));
        self.set_playlist_tracks(id, &out)
    }

    pub fn remove_from_playlist(&self, id: i64, indices: &[usize]) -> Result<()> {
        let all = self.playlist_tracks(id)?;
        let kept: Vec<TrackId> =
            all.into_iter().enumerate().filter(|(i, _)| !indices.contains(i)).map(|x| x.1).collect();
        self.set_playlist_tracks(id, &kept)
    }

    // ---------------------------------------------------------------- tags

    pub fn tag(&self, name: &str, category: &str) -> Result<i64> {
        self.conn.execute("INSERT OR IGNORE INTO tags (name, category) VALUES (?, ?)", params![name, category])?;
        Ok(self.conn.query_row("SELECT id FROM tags WHERE name = ? COLLATE NOCASE", [name], |r| r.get(0))?)
    }

    pub fn tags(&self) -> Result<Vec<Tag>> {
        let mut st = self.conn.prepare("SELECT id, name, category, color FROM tags ORDER BY category, name")?;
        let rows =
            st.query_map([], |r| Ok(Tag { id: r.get(0)?, name: r.get(1)?, category: r.get(2)?, color: r.get(3)? }))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn tag_tracks(&self, tag: i64, tracks: &[TrackId], on: bool) -> Result<()> {
        let tx = self.begin()?;
        for t in tracks {
            if on {
                self.conn
                    .execute("INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)", params![t, tag])?;
            } else {
                self.conn.execute("DELETE FROM track_tags WHERE track_id = ? AND tag_id = ?", params![t, tag])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Every tag with how many tracks carry it, by category and then name.
    pub fn tag_counts(&self) -> Result<Vec<(Tag, i64)>> {
        let mut st = self.conn.prepare(
            "SELECT g.id, g.name, g.category, g.color, COUNT(tt.track_id) FROM tags g
             LEFT JOIN track_tags tt ON tt.tag_id = g.id GROUP BY g.id ORDER BY g.category, g.name COLLATE NOCASE",
        )?;
        let rows = st.query_map([], |r| {
            Ok((Tag { id: r.get(0)?, name: r.get(1)?, category: r.get(2)?, color: r.get(3)? }, r.get(4)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The tag names of each of `tracks` (tracks without tags are left out).
    pub fn tags_of(&self, tracks: &[TrackId]) -> Result<Vec<(TrackId, Vec<String>)>> {
        let mut st = self.conn.prepare_cached(
            "SELECT g.name FROM tags g JOIN track_tags tt ON tt.tag_id = g.id
             WHERE tt.track_id = ? ORDER BY g.category, g.name COLLATE NOCASE",
        )?;
        let mut out = Vec::new();
        for &t in tracks {
            let names: Vec<String> = st.query_map([t], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            if !names.is_empty() {
                out.push((t, names));
            }
        }
        Ok(out)
    }

    /// Puts the tag called `name` on `tracks` (creating it, in `category`, if it is new) or
    /// takes it off. Returns the tag's id.
    pub fn tag_by_name(&self, name: &str, category: &str, tracks: &[TrackId], on: bool) -> Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Err(LibraryError::Invalid("a tag needs a name".into()));
        }
        let id = self.tag(name, category)?;
        self.tag_tracks(id, tracks, on)?;
        Ok(id)
    }

    /// Renames a tag. Renaming it to a tag that already exists merges the two. Returns the
    /// id of the tag that remains.
    pub fn rename_tag(&self, id: i64, name: &str) -> Result<i64> {
        let name = name.trim();
        if name.is_empty() {
            return Err(LibraryError::Invalid("a tag needs a name".into()));
        }
        let other: Option<i64> = self
            .conn
            .query_row("SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?", params![name, id], |r| r.get(0))
            .optional()?;
        let tx = self.begin()?;
        let kept = match other {
            Some(o) => {
                self.conn.execute(
                    "INSERT OR IGNORE INTO track_tags (track_id, tag_id) SELECT track_id, ?1 FROM track_tags WHERE tag_id = ?2",
                    params![o, id],
                )?;
                self.conn.execute("DELETE FROM tags WHERE id = ?", [id])?;
                o
            }
            None => {
                self.conn.execute("UPDATE tags SET name = ? WHERE id = ?", params![name, id])?;
                id
            }
        };
        tx.commit()?;
        Ok(kept)
    }

    /// Files a tag under a category ("Vibe", "Vocals", ...; empty for none) and colours it.
    pub fn set_tag_info(&self, id: i64, category: &str, color: Option<u32>) -> Result<()> {
        self.conn
            .execute("UPDATE tags SET category = ?, color = ? WHERE id = ?", params![category.trim(), color, id])?;
        Ok(())
    }

    /// Deletes a tag and takes it off every track.
    pub fn delete_tag(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM track_tags WHERE tag_id = ?", [id])?;
        self.conn.execute("DELETE FROM tags WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn track_tags(&self, track: TrackId) -> Result<Vec<Tag>> {
        let mut st = self.conn.prepare(
            "SELECT g.id, g.name, g.category, g.color FROM tags g JOIN track_tags tt ON tt.tag_id = g.id
             WHERE tt.track_id = ? ORDER BY g.category, g.name",
        )?;
        let rows = st.query_map([track], |r| {
            Ok(Tag { id: r.get(0)?, name: r.get(1)?, category: r.get(2)?, color: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---------------------------------------------------------------- history

    pub fn start_session(&self, name: &str) -> Result<i64> {
        self.conn.execute("INSERT INTO history_sessions (name, started_at) VALUES (?, ?)", params![name, now()])?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn end_session(&self, session: i64) -> Result<()> {
        self.conn.execute("UPDATE history_sessions SET ended_at = ? WHERE id = ?", params![now(), session])?;
        Ok(())
    }

    /// Records that a track was played (counts towards play count and "last played").
    pub fn log_play(&self, session: i64, track: TrackId, deck: Option<u8>) -> Result<()> {
        let t = self.track(track)?;
        let at = now();
        self.conn.execute(
            "INSERT INTO history (session_id, track_id, played_at, deck, title, artist) VALUES (?, ?, ?, ?, ?, ?)",
            params![session, track, at, deck, t.display_title(), t.artist],
        )?;
        self.conn.execute(
            "UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?",
            params![at, track],
        )?;
        Ok(())
    }

    pub fn session_history(&self, session: i64) -> Result<Vec<HistoryEntry>> {
        let mut st = self.conn.prepare(
            "SELECT track_id, played_at, deck, title, artist FROM history WHERE session_id = ? ORDER BY played_at, id",
        )?;
        let rows = st.query_map([session], |r| {
            Ok(HistoryEntry {
                track_id: r.get(0)?,
                played_at: r.get(1)?,
                deck: r.get(2)?,
                title: r.get(3)?,
                artist: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Sessions that played something, newest first.
    pub fn sessions(&self) -> Result<Vec<SessionInfo>> {
        let mut st = self.conn.prepare(
            "SELECT s.id, s.name, s.started_at, COUNT(h.id), MIN(h.played_at), MAX(h.played_at)
             FROM history_sessions s JOIN history h ON h.session_id = s.id
             GROUP BY s.id ORDER BY MAX(h.played_at) DESC, s.id DESC",
        )?;
        let rows = st.query_map([], |r| {
            Ok(SessionInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                started_at: r.get(2)?,
                tracks: r.get(3)?,
                first_played: r.get(4)?,
                last_played: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn rename_session(&self, session: i64, name: &str) -> Result<()> {
        self.conn.execute("UPDATE history_sessions SET name = ? WHERE id = ?", params![name.trim(), session])?;
        Ok(())
    }

    /// Forgets a session's history. Play counts and "last played" stay as they are.
    pub fn delete_session(&self, session: i64) -> Result<()> {
        let tx = self.begin()?;
        self.conn.execute("DELETE FROM history WHERE session_id = ?", [session])?;
        self.conn.execute("DELETE FROM history_sessions WHERE id = ?", [session])?;
        tx.commit()?;
        Ok(())
    }

    /// Tracks played in a session (to exclude from suggestions).
    /// How many times each track was played right after `track` across all past sets.
    pub fn played_after(&self, track: TrackId) -> Result<std::collections::HashMap<TrackId, u32>> {
        let mut st = self.conn.prepare(
            "SELECT track_id, COUNT(*) FROM (
                SELECT track_id, LAG(track_id) OVER (PARTITION BY session_id ORDER BY played_at, id) AS prev
                FROM history
             ) WHERE prev = ?1 AND track_id IS NOT NULL AND track_id != prev GROUP BY track_id",
        )?;
        let rows = st.query_map([track], |r| Ok((r.get::<_, TrackId>(0)?, r.get::<_, i64>(1)? as u32)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn session_track_ids(&self, session: i64) -> Result<Vec<TrackId>> {
        Ok(self.session_history(session)?.into_iter().filter_map(|h| h.track_id).collect())
    }

    /// A tracklist ("01. Artist – Title") for sharing a set.
    pub fn session_tracklist(&self, session: i64) -> Result<String> {
        let h = self.session_history(session)?;
        let start = h.first().map(|e| e.played_at).unwrap_or(0);
        Ok(h.iter()
            .enumerate()
            .map(|(i, e)| {
                let m = (e.played_at - start) / 60;
                let who = if e.artist.is_empty() { String::new() } else { format!("{} – ", e.artist) };
                format!("{:02}. [{:02}:{:02}] {who}{}\n", i + 1, m / 60, m % 60, e.title)
            })
            .collect())
    }

    // ---------------------------------------------------------------- folders and settings

    pub fn add_folder(&self, path: &Path) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)",
            params![path.to_string_lossy(), now()],
        )?;
        Ok(())
    }

    pub fn remove_folder(&self, path: &Path) -> Result<()> {
        self.conn.execute("DELETE FROM folders WHERE path = ?", [path.to_string_lossy()])?;
        Ok(())
    }

    pub fn folders(&self) -> Result<Vec<PathBuf>> {
        let mut st = self.conn.prepare("SELECT path FROM folders ORDER BY path")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.map(|r| r.map(PathBuf::from)).collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn mark_folder_scanned(&self, path: &Path) -> Result<()> {
        self.conn.execute("UPDATE folders SET last_scan = ? WHERE path = ?", params![now(), path.to_string_lossy()])?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", params![key, value])?;
        Ok(())
    }

    pub fn stats(&self) -> Result<LibraryStats> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*), SUM(analysis_state = 1), SUM(analysis_state = 0), SUM(analysis_state = 2), SUM(missing),
                (SELECT COUNT(*) FROM playlists WHERE kind <> 0), COALESCE(SUM(duration), 0) FROM tracks",
            [],
            |r| {
                Ok(LibraryStats {
                    tracks: r.get::<_, i64>(0)? as u64,
                    analysed: r.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64,
                    pending: r.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                    failed: r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
                    missing: r.get::<_, Option<i64>>(4)?.unwrap_or(0) as u64,
                    playlists: r.get::<_, i64>(5)? as u64,
                    total_seconds: r.get(6)?,
                })
            },
        )?)
    }
}
