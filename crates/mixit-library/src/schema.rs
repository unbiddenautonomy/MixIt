//! Database schema and migrations (tracked with SQLite's `user_version`).

use rusqlite::Connection;

/// Each entry migrates from version `i` to `i + 1`.
const MIGRATIONS: &[&str] = &[
    // 1: initial schema.
    r#"
    CREATE TABLE tracks (
        id              INTEGER PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        hash            TEXT,
        file_size       INTEGER NOT NULL DEFAULT 0,
        file_mtime      INTEGER NOT NULL DEFAULT 0,
        title           TEXT NOT NULL DEFAULT '',
        artist          TEXT NOT NULL DEFAULT '',
        album           TEXT NOT NULL DEFAULT '',
        album_artist    TEXT NOT NULL DEFAULT '',
        genre           TEXT NOT NULL DEFAULT '',
        label           TEXT NOT NULL DEFAULT '',
        remixer         TEXT NOT NULL DEFAULT '',
        comment         TEXT NOT NULL DEFAULT '',
        year            INTEGER,
        track_number    INTEGER,
        duration        REAL NOT NULL DEFAULT 0,
        sample_rate     INTEGER,
        bitrate_kbps    INTEGER,
        channels        INTEGER,
        has_artwork     INTEGER NOT NULL DEFAULT 0,
        tag_bpm         REAL,
        tag_key         TEXT,
        bpm             REAL,
        key_index       INTEGER,
        key_order       INTEGER,
        energy          INTEGER,
        lufs            REAL,
        auto_gain_db    REAL,
        analysis_version INTEGER NOT NULL DEFAULT 0,
        analysis_state  INTEGER NOT NULL DEFAULT 0,
        analysis_error  TEXT,
        rating          INTEGER NOT NULL DEFAULT 0,
        color           INTEGER,
        play_count      INTEGER NOT NULL DEFAULT 0,
        last_played     INTEGER,
        added_at        INTEGER NOT NULL,
        missing         INTEGER NOT NULL DEFAULT 0,
        grid_locked     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX tracks_hash ON tracks(hash);
    CREATE INDEX tracks_bpm ON tracks(bpm);
    CREATE INDEX tracks_key ON tracks(key_index);

    CREATE VIRTUAL TABLE tracks_fts USING fts5(
        title, artist, album, genre, label, remixer, comment, path,
        content='tracks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER tracks_ai AFTER INSERT ON tracks BEGIN
        INSERT INTO tracks_fts(rowid, title, artist, album, genre, label, remixer, comment, path)
        VALUES (new.id, new.title, new.artist, new.album, new.genre, new.label, new.remixer, new.comment, new.path);
    END;
    CREATE TRIGGER tracks_ad AFTER DELETE ON tracks BEGIN
        INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, label, remixer, comment, path)
        VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.label, old.remixer, old.comment, old.path);
    END;
    CREATE TRIGGER tracks_au AFTER UPDATE OF title, artist, album, genre, label, remixer, comment, path ON tracks BEGIN
        INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, label, remixer, comment, path)
        VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.label, old.remixer, old.comment, old.path);
        INSERT INTO tracks_fts(rowid, title, artist, album, genre, label, remixer, comment, path)
        VALUES (new.id, new.title, new.artist, new.album, new.genre, new.label, new.remixer, new.comment, new.path);
    END;

    CREATE TABLE analyses (
        track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        data        TEXT NOT NULL,
        waveform    BLOB,
        waveform_sr INTEGER
    );

    CREATE TABLE grids (
        track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        data        TEXT NOT NULL,
        edited_at   INTEGER NOT NULL
    );

    CREATE TABLE cues (
        id          INTEGER PRIMARY KEY,
        track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        kind        INTEGER NOT NULL,
        slot        INTEGER,
        seconds     REAL NOT NULL,
        loop_seconds REAL,
        color       INTEGER,
        label       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX cues_track ON cues(track_id);

    CREATE TABLE playlists (
        id          INTEGER PRIMARY KEY,
        parent_id   INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        kind        INTEGER NOT NULL,
        query       TEXT,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
    );
    CREATE TABLE playlist_entries (
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        PRIMARY KEY (playlist_id, position)
    );
    CREATE INDEX playlist_entries_track ON playlist_entries(track_id);

    CREATE TABLE tags (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        category    TEXT NOT NULL DEFAULT '',
        color       INTEGER
    );
    CREATE TABLE track_tags (
        track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (track_id, tag_id)
    );

    CREATE TABLE history_sessions (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER
    );
    CREATE TABLE history (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
        track_id    INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
        played_at   INTEGER NOT NULL,
        deck        INTEGER,
        title       TEXT NOT NULL DEFAULT '',
        artist      TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE folders (
        path        TEXT PRIMARY KEY,
        added_at    INTEGER NOT NULL,
        last_scan   INTEGER
    );

    CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL
    );
    "#,
    // 2: sound profiles for "sounds like", as little-endian f32s.
    r#"
    ALTER TABLE tracks ADD COLUMN sound BLOB;
    "#,
    // 3: how much of each track has a voice (percent), for `vocals:` searches.
    r#"
    ALTER TABLE tracks ADD COLUMN vocals INTEGER;
    "#,
    // 4: how each track sounds to a trained listener (CLAP), as little-endian f32s,
    // kept per model so a new model never gets compared with an old one's numbers.
    r#"
    CREATE TABLE sound_embeddings (
        track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        model       TEXT NOT NULL,
        vec         BLOB NOT NULL,
        PRIMARY KEY (track_id, model)
    );
    "#,
    // 5: the beat helper's second opinion on a track's grid: `data` is its grid when it
    // differs from the analysis's (NULL when they agree), until the person uses or
    // dismisses it.
    r#"
    CREATE TABLE grid_suggestions (
        track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        model       TEXT NOT NULL,
        data        TEXT,
        why         TEXT,
        dismissed   INTEGER NOT NULL DEFAULT 0
    );
    "#,
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
