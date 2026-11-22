use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use mixit_core::{Key, Mode};
use mixit_generator::{Style, TrackSpec, generate};
use mixit_io::{TrackTags, WavDepth, write_wav};
use mixit_library::jobs::JobOptions;
use mixit_library::suggest::SuggestOptions;
use mixit_library::*;

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let p = std::env::temp_dir().join(format!("mixit-lib-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn add(lib: &Library, title: &str, artist: &str, genre: &str, bpm: f64, key: &str, energy: u8) -> i64 {
    let id = lib
        .insert_track(&NewTrack {
            path: PathBuf::from(format!("/music/{artist} - {title}.mp3")),
            tags: TrackTags {
                title: Some(title.into()),
                artist: Some(artist.into()),
                genre: Some(genre.into()),
                duration_s: 300.0,
                ..Default::default()
            },
            ..Default::default()
        })
        .unwrap();
    lib.edit_track(
        id,
        &TrackEdit {
            bpm: Some(Some(bpm)),
            key: Some(Key::parse(key)),
            energy: Some(Some(energy)),
            ..Default::default()
        },
    )
    .unwrap();
    id
}

fn sample_library() -> (Library, Vec<i64>) {
    let lib = Library::open_in_memory().unwrap();
    let ids = vec![
        add(&lib, "Midnight Drive", "Nova", "Deep House", 122.0, "8A", 5),
        add(&lib, "Solar Wind", "Kairo", "Techno", 130.0, "5A", 8),
        add(&lib, "Déjà Vu", "Nova", "Deep House", 124.0, "9A", 6),
        add(&lib, "Breakbeat Science", "Amen Crew", "Drum & Bass", 174.0, "8A", 9),
        add(&lib, "Late Bloom", "Iris", "House", 126.0, "3B", 6),
    ];
    (lib, ids)
}

fn titles(ts: &[Track]) -> Vec<String> {
    ts.iter().map(|t| t.title.clone()).collect()
}

#[test]
fn search_language() {
    let (lib, _) = sample_library();
    assert_eq!(titles(&lib.search("nova", None).unwrap()), ["Déjà Vu", "Midnight Drive"]);
    // Accents are ignored and prefixes match.
    assert_eq!(titles(&lib.search("deja", None).unwrap()), ["Déjà Vu"]);
    assert_eq!(titles(&lib.search("midn", None).unwrap()), ["Midnight Drive"]);
    assert_eq!(titles(&lib.search("\"solar wind\"", None).unwrap()), ["Solar Wind"]);
    assert_eq!(lib.search("bpm:120-125", None).unwrap().len(), 2);
    assert_eq!(titles(&lib.search("bpm:>170", None).unwrap()), ["Breakbeat Science"]);
    // ~87 includes double time (174).
    assert!(titles(&lib.search("bpm:~87", None).unwrap()).contains(&"Breakbeat Science".to_string()));
    assert_eq!(lib.search("key:8A", None).unwrap().len(), 2);
    // 8A's neighbours: 7A, 9A, 8B.
    assert_eq!(lib.search("key:~8A", None).unwrap().len(), 3);
    assert_eq!(titles(&lib.search("energy:8+ sort:-energy", None).unwrap()), ["Breakbeat Science", "Solar Wind"]);
    assert_eq!(lib.search("genre:house -nova", None).unwrap().len(), 1);
    assert_eq!(lib.search("played:never", None).unwrap().len(), 5);
    assert_eq!(titles(&lib.search("sort:bpm", Some(2)).unwrap()), ["Midnight Drive", "Déjà Vu"]);
    // Camelot order: 3B before 5A before 8A …
    assert_eq!(lib.search("sort:key", None).unwrap()[0].title, "Late Bloom");
}

#[test]
fn playlists_smart_lists_and_tags() {
    let (lib, ids) = sample_library();
    let folder = lib.create_playlist("Gigs", PlaylistKind::Folder, None, None).unwrap();
    let set = lib.create_playlist("Friday", PlaylistKind::List, Some(folder), None).unwrap();
    lib.add_to_playlist(set, &[ids[0], ids[2], ids[4]]).unwrap();
    lib.add_to_playlist(set, &[ids[1]]).unwrap();
    assert_eq!(lib.playlist_tracks(set).unwrap(), vec![ids[0], ids[2], ids[4], ids[1]]);
    lib.reorder_playlist(set, &[3], 0).unwrap();
    assert_eq!(lib.playlist_tracks(set).unwrap(), vec![ids[1], ids[0], ids[2], ids[4]]);
    lib.remove_from_playlist(set, &[0]).unwrap();
    assert_eq!(lib.playlist_tracks(set).unwrap(), vec![ids[0], ids[2], ids[4]]);

    let smart = lib.create_playlist("Warm-up", PlaylistKind::Smart, None, Some("bpm:<125 sort:bpm")).unwrap();
    assert_eq!(lib.playlist_tracks(smart).unwrap(), vec![ids[0], ids[2]]);

    let peak = lib.tag("Peak time", "vibe").unwrap();
    assert_eq!(lib.tag("peak time", "vibe").unwrap(), peak, "tags are case-insensitive");
    lib.tag_tracks(peak, &[ids[1], ids[3]], true).unwrap();
    assert_eq!(lib.search("tag:\"peak time\"", None).unwrap().len(), 2);
    lib.tag_tracks(peak, &[ids[1]], false).unwrap();
    assert_eq!(lib.track_tags(ids[3]).unwrap()[0].name, "Peak time");
    assert_eq!(lib.search("tag:\"peak time\"", None).unwrap().len(), 1);

    lib.delete_playlist(folder).unwrap();
    assert!(lib.playlists().unwrap().iter().all(|p| p.id != set), "children go with their folder");
}

#[test]
fn your_own_tags_rename_merge_and_delete() {
    let (lib, ids) = sample_library();
    let vocal = lib.tag_by_name(" Vocal ", "Vocals", &[ids[0], ids[2]], true).unwrap();
    let warm = lib.tag_by_name("warm-up", "", &[ids[0]], true).unwrap();
    lib.tag_by_name("Warmup", "", &[ids[1]], true).unwrap();
    assert!(lib.tag_by_name("  ", "", &[ids[1]], true).is_err(), "a tag needs a name");
    let counts = lib.tag_counts().unwrap();
    let count = |n: &str| counts.iter().find(|(t, _)| t.name == n).map(|x| x.1);
    assert_eq!(count("Vocal"), Some(2));
    assert_eq!(count("warm-up"), Some(1));
    assert_eq!(
        lib.tags_of(&[ids[0], ids[1], ids[4]]).unwrap(),
        vec![(ids[0], vec!["warm-up".to_string(), "Vocal".to_string()]), (ids[1], vec!["Warmup".to_string()]),]
    );

    // Renaming onto an existing tag merges them: every track keeps a tag, none twice.
    let warmup = lib.tags().unwrap().into_iter().find(|t| t.name == "Warmup").unwrap().id;
    lib.tag_by_name("Warmup", "", &[ids[0]], true).unwrap();
    assert_eq!(lib.rename_tag(warmup, "WARM-UP").unwrap(), warm);
    assert_eq!(lib.search("tag:warm-up", None).unwrap().len(), 2);
    assert!(lib.tags().unwrap().iter().all(|t| t.name != "Warmup"));
    // A plain rename.
    assert_eq!(lib.rename_tag(warm, "Opener").unwrap(), warm);
    assert_eq!(lib.search("tag:opener -tag:vocal", None).unwrap().len(), 1);

    lib.set_tag_info(vocal, "Voice", Some(0xff8800)).unwrap();
    let t = lib.tags().unwrap().into_iter().find(|t| t.id == vocal).unwrap();
    assert_eq!((t.category.as_str(), t.color), ("Voice", Some(0xff8800)));

    lib.tag_by_name("Vocal", "", &[ids[0]], false).unwrap();
    assert_eq!(lib.search("tag:vocal", None).unwrap().len(), 1);
    lib.delete_tag(vocal).unwrap();
    assert!(lib.search("tag:vocal", None).unwrap().is_empty());
    assert!(lib.track_tags(ids[2]).unwrap().is_empty());
}

#[test]
fn history_and_suggestions() {
    let (lib, ids) = sample_library();
    let s = lib.start_session("Friday").unwrap();
    lib.log_play(s, ids[0], Some(0)).unwrap();
    let t = lib.track(ids[0]).unwrap();
    assert_eq!(t.play_count, 1);
    assert!(t.last_played.is_some());
    assert!(lib.session_tracklist(s).unwrap().contains("Nova – Midnight Drive"));
    assert_eq!(lib.search("played:<1d", None).unwrap().len(), 1);

    let opts = SuggestOptions { exclude: lib.session_track_ids(s).unwrap(), ..Default::default() };
    let next = lib.suggest_next(ids[0], &opts).unwrap();
    // From 122 BPM 8A: Déjà Vu (124, 9A) is the natural follow-up.
    assert_eq!(next[0].id, ids[2]);
    assert!(next.iter().all(|n| n.id != ids[1]), "130 BPM is out of range from 122");
    lib.end_session(s).unwrap();
}

#[test]
fn edits_cues_grids_and_maintenance() {
    let (lib, ids) = sample_library();
    lib.edit_track(ids[0], &TrackEdit { rating: Some(4), comment: Some("great opener".into()), ..Default::default() })
        .unwrap();
    assert_eq!(lib.track(ids[0]).unwrap().rating, 4);
    assert_eq!(titles(&lib.search("opener", None).unwrap()), ["Midnight Drive"], "comments are searchable");

    let cues = vec![
        Cue { kind: CueKind::Main, slot: None, seconds: 0.5, loop_seconds: None, color: None, label: String::new() },
        Cue {
            kind: CueKind::Hot,
            slot: Some(0),
            seconds: 31.0,
            loop_seconds: Some(7.8),
            color: Some(0xFF0000),
            label: "Drop".into(),
        },
    ];
    lib.set_cues(ids[0], &cues).unwrap();
    assert_eq!(lib.cues(ids[0]).unwrap(), cues);

    let mut g = mixit_core::Beatgrid::constant(44_100, 122.0, 1_000.0);
    g.locked = true;
    lib.save_grid(ids[0], &g).unwrap();
    assert_eq!(lib.grid(ids[0]).unwrap(), Some(g));
    assert!(lib.track(ids[0]).unwrap().grid_locked);

    assert_eq!(lib.relocate_prefix(Path::new("/music"), Path::new("/Volumes/USB/music")).unwrap(), 5);
    assert!(lib.track(ids[0]).unwrap().path.starts_with("/Volumes/USB/music"));
    let st = lib.stats().unwrap();
    assert_eq!(st.tracks, 5);
    assert_eq!(st.pending, 5);
    lib.remove_tracks(&[ids[4]]).unwrap();
    assert_eq!(lib.track_count().unwrap(), 4);
    assert!(lib.track(ids[4]).is_err());
}

fn write_track(dir: &Path, name: &str, style: Style, bpm: f64, key: Key) -> PathBuf {
    let mut spec = TrackSpec::short(style, bpm, key);
    spec.sections.truncate(3);
    let g = generate(&spec);
    let p = dir.join(name);
    write_wav(&p, &g.audio, 2, g.sample_rate, WavDepth::Pcm16).unwrap();
    p
}

#[test]
fn scan_analyse_move_and_exchange() {
    let tmp = TempDir::new("scan");
    let music = tmp.0.join("Music");
    std::fs::create_dir_all(music.join("sub")).unwrap();
    let a = write_track(&music, "one.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let b = write_track(&music.join("sub"), "two.wav", Style::Techno, 128.0, Key::new(4, Mode::Minor));
    std::fs::write(music.join("notes.txt"), "not audio").unwrap();

    let lib = Library::open(&tmp.0.join("library.db")).unwrap();
    lib.add_folder(&music).unwrap();
    let r = lib.rescan_all(|_, _| {}).unwrap();
    assert_eq!(r.added.len(), 2, "{r:?}");
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let again = lib.scan_folder(&music, |_, _| {}).unwrap();
    assert_eq!(again.unchanged, 2);

    // Analysis.
    let cancel = AtomicBool::new(false);
    let opts = JobOptions { threads: 2, ..Default::default() };
    let sum = lib.analyze_pending(&opts, &cancel, |_, _, _| {}).unwrap();
    assert_eq!(sum.analysed, 2);
    assert!(lib.pending_analysis(10).unwrap().is_empty());
    let ta = lib.track_by_path(&a).unwrap().unwrap();
    assert!((ta.bpm.unwrap() - 124.0).abs() < 0.05);
    assert_eq!(ta.key, Some(Key::new(9, Mode::Minor)));
    let an = lib.analysis(ta.id).unwrap().unwrap();
    assert!(an.waveform.is_some(), "waveform survives storage");
    assert_eq!(lib.grid(ta.id).unwrap().unwrap(), an.grid);
    let cues = lib.auto_cues(ta.id, 8).unwrap();
    assert!(cues.iter().any(|c| c.kind == CueKind::Main));
    assert!(cues.iter().any(|c| c.kind == CueKind::Hot));
    assert_eq!(lib.search("bpm:124 key:8A", None).unwrap().len(), 1);

    // Move a file: it is recognised by content, keeping its cues and analysis.
    let moved = music.join("renamed.wav");
    std::fs::rename(&b, &moved).unwrap();
    let tb_id = lib.track_by_path(&b).unwrap().unwrap().id;
    let r = lib.scan_folder(&music, |_, _| {}).unwrap();
    assert_eq!(r.moved, vec![tb_id], "{r:?}");
    assert_eq!(lib.track(tb_id).unwrap().path, moved);
    assert_eq!(lib.track(tb_id).unwrap().analysis_state, AnalysisState::Done);

    // Delete a file: flagged missing.
    std::fs::remove_file(&moved).unwrap();
    let r = lib.scan_folder(&music, |_, _| {}).unwrap();
    assert_eq!(r.missing, vec![tb_id]);
    assert!(lib.track(tb_id).unwrap().missing);

    // M3U round trip.
    let list = lib.create_playlist("Set", PlaylistKind::List, None, None).unwrap();
    lib.set_playlist_tracks(list, &[ta.id]).unwrap();
    let m3u = music.join("set.m3u8");
    lib.export_m3u(&lib.playlist_tracks(list).unwrap(), &m3u, true).unwrap();
    let text = std::fs::read_to_string(&m3u).unwrap();
    assert!(text.starts_with("#EXTM3U") && text.contains("\none.wav\n"), "{text}");
    let (ids, missing) = lib.import_m3u(&m3u).unwrap();
    assert_eq!(ids, vec![ta.id]);
    assert!(missing.is_empty());
    lib.export_csv(&[ta.id], &tmp.0.join("tracks.csv")).unwrap();

    // Rekordbox XML round trip into a fresh library.
    let xml = tmp.0.join("rekordbox.xml");
    lib.export_rekordbox_xml(None, &xml).unwrap();
    let other = Library::open_in_memory().unwrap();
    let rep = other.import_rekordbox_xml(&xml).unwrap();
    assert_eq!(rep.tracks, 2);
    assert_eq!(rep.missing.len(), 1, "the deleted file comes back as missing");
    assert_eq!(rep.playlists, 1);
    let ta2 = other.track_by_path(&a).unwrap().unwrap();
    assert_eq!(ta2.best_key(), Some(Key::new(9, Mode::Minor)));
    let g1 = lib.grid(ta.id).unwrap().unwrap();
    let g2 = other.grid(ta2.id).unwrap().unwrap();
    for beat in [0.0, 16.0, 64.0] {
        let f1 = g1.frame_at(beat);
        let f2 = g2.frame_at(g2.beat_at(f1).round());
        assert!((f1 - f2).abs() < 0.002 * 44_100.0, "beat {beat}: {f1} vs {f2}");
    }
    assert!(g2.is_downbeat(g2.beat_at(g1.frame_at(0.0)).round() as i64), "downbeats survive");
    let c2 = other.cues(ta2.id).unwrap();
    assert_eq!(c2.len(), cues.len());
    assert!(c2.iter().zip(&cues).all(|(x, y)| (x.seconds - y.seconds).abs() < 0.001 && x.kind == y.kind));
}

#[test]
fn rekordbox_locations() {
    use mixit_library::rekordbox::{location_to_path, path_to_location};
    assert_eq!(location_to_path("file://localhost/C:/Music/A%20B.mp3"), PathBuf::from("C:\\Music\\A B.mp3"));
    assert_eq!(
        location_to_path("file://localhost/Users/me/M%C3%BAsica/x.mp3"),
        PathBuf::from("/Users/me/Música/x.mp3")
    );
    let p = Path::new("/Users/me/Música/a b&c.mp3");
    assert_eq!(location_to_path(&path_to_location(p)), p);
}

#[test]
fn merge_duplicates_keeps_everything_on_one_track() {
    let (lib, ids) = sample_library();
    let (keep, dup) = (ids[0], ids[2]);
    lib.edit_track(keep, &TrackEdit { rating: Some(2), ..Default::default() }).unwrap();
    lib.edit_track(dup, &TrackEdit { rating: Some(5), comment: Some("peak time".into()), ..Default::default() })
        .unwrap();
    let cue =
        Cue { kind: CueKind::Hot, slot: Some(0), seconds: 12.0, loop_seconds: None, color: None, label: "In".into() };
    lib.set_cues(dup, std::slice::from_ref(&cue)).unwrap();
    let list = lib.create_playlist("Set", PlaylistKind::List, None, None).unwrap();
    lib.set_playlist_tracks(list, &[ids[1], dup, ids[3]]).unwrap();
    let tag = lib.tag("warm-up", "").unwrap();
    lib.tag_tracks(tag, &[dup], true).unwrap();
    let s = lib.start_session("Friday").unwrap();
    lib.log_play(s, dup, Some(0)).unwrap();

    lib.merge_tracks(keep, &[dup, keep]).unwrap();
    assert!(lib.track(dup).is_err(), "the duplicate is gone");
    let k = lib.track(keep).unwrap();
    assert_eq!(k.rating, 5);
    assert_eq!(k.comment, "peak time");
    assert_eq!(lib.playlist_tracks(list).unwrap(), vec![ids[1], keep, ids[3]], "its place in the playlist is kept");
    assert!(lib.track_tags(keep).unwrap().iter().any(|t| t.name == "warm-up"));
    assert_eq!(lib.cues(keep).unwrap(), vec![cue]);
    assert_eq!(lib.session_track_ids(s).unwrap(), vec![keep]);
    assert_eq!(lib.track_count().unwrap(), 4);
}

#[test]
fn finds_missing_files_in_a_folder() {
    let tmp = TempDir::new("missing");
    let music = tmp.0.join("Music");
    std::fs::create_dir_all(&music).unwrap();
    let a = write_track(&music, "one.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let b = write_track(&music, "two.wav", Style::Techno, 128.0, Key::new(4, Mode::Minor));
    let lib = Library::open(&tmp.0.join("library.db")).unwrap();
    lib.scan_folder(&music, |_, _| {}).unwrap();
    let ta = lib.track_by_path(&a).unwrap().unwrap().id;
    let tb = lib.track_by_path(&b).unwrap().unwrap().id;
    // The folder moves to another drive and one file is renamed on the way.
    let usb = tmp.0.join("USB").join("Sets");
    std::fs::create_dir_all(&usb).unwrap();
    std::fs::rename(&a, usb.join("one.wav")).unwrap();
    std::fs::rename(&b, usb.join("Two (final).wav")).unwrap();
    assert_eq!(lib.missing_tracks().unwrap().len(), 2);
    let mut found = lib.find_missing_in(&tmp.0.join("USB")).unwrap();
    found.sort();
    let mut want = vec![(ta, usb.join("one.wav")), (tb, usb.join("Two (final).wav"))];
    want.sort();
    assert_eq!(found, want);
    assert!(lib.missing_tracks().unwrap().is_empty());
    assert!(!lib.track(tb).unwrap().missing);
    assert!(lib.find_missing_in(&tmp.0).unwrap().is_empty());
}

#[test]
fn writes_library_details_into_the_files() {
    let tmp = TempDir::new("write-tags");
    let music = tmp.0.join("Music");
    std::fs::create_dir_all(&music).unwrap();
    let a = write_track(&music, "one.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let lib = Library::open(&tmp.0.join("library.db")).unwrap();
    lib.scan_folder(&music, |_, _| {}).unwrap();
    let id = lib.track_by_path(&a).unwrap().unwrap().id;
    let edit = TrackEdit {
        title: Some("Sunrise".into()),
        artist: Some("Ann".into()),
        genre: Some("Deep House".into()),
        label: Some("Own Records".into()),
        year: Some(Some(2023)),
        bpm: Some(Some(124.0)),
        key: Some(Some(Key::new(9, Mode::Minor))),
        ..Default::default()
    };
    lib.edit_track(id, &edit).unwrap();
    let before = lib.track(id).unwrap().hash;
    lib.write_file_tags(id, mixit_core::key::KeyNotation::Camelot).unwrap();
    let tags = mixit_io::read_tags(&a).unwrap();
    assert_eq!(tags.title.as_deref(), Some("Sunrise"));
    assert_eq!(tags.artist.as_deref(), Some("Ann"));
    assert_eq!(tags.genre.as_deref(), Some("Deep House"));
    assert_eq!(tags.label.as_deref(), Some("Own Records"));
    assert_eq!(tags.year, Some(2023));
    assert_eq!(tags.key.as_deref(), Some("8A"));
    assert!(tags.bpm.is_some_and(|b| (b - 124.0).abs() < 0.01));
    // The new file is recorded, so a rescan leaves it (and the edits) alone.
    assert_ne!(lib.track(id).unwrap().hash, before);
    let r = lib.scan_folder(&music, |_, _| {}).unwrap();
    assert_eq!((r.unchanged, r.updated.len()), (1, 0));
    assert_eq!(lib.track(id).unwrap().title, "Sunrise");
}

#[test]
fn backs_up_and_restores_the_whole_library() {
    use mixit_library::backup::{self, BackupKind};
    let dir = TempDir::new("backup");
    let db = dir.0.join("library.db");
    let backups = dir.0.join("backups");
    let mut lib = Library::open(&db).unwrap();
    let a = add(&lib, "Midnight Drive", "Nova", "Deep House", 122.0, "8A", 5);
    let b = add(&lib, "Solar Wind", "Kairo", "Techno", 130.0, "5A", 8);
    let set = lib.create_playlist("Friday", PlaylistKind::List, None, None).unwrap();
    lib.add_to_playlist(set, &[b, a]).unwrap();
    lib.tag_by_name("Vocal", "", &[a], true).unwrap();

    // The daily backup: made once, then not again the same day.
    let first = lib.auto_backup(&backups).unwrap().expect("first backup");
    assert!(lib.auto_backup(&backups).unwrap().is_none());
    assert_eq!(backup::check(&first).unwrap(), 2);

    // Things go wrong after the backup.
    lib.delete_playlist(set).unwrap();
    lib.delete_tag(lib.tags().unwrap()[0].id).unwrap();
    add(&lib, "Stray", "Someone", "Pop", 100.0, "1A", 3);
    // A background job's connection is open while restoring.
    let other = Library::open(&db).unwrap();
    assert_eq!(other.search("", None).unwrap().len(), 3);

    let safety = lib.restore_from(&first, &backups).unwrap();
    assert_eq!(lib.search("", None).unwrap().len(), 2);
    assert_eq!(lib.playlist_tracks(set).unwrap(), vec![b, a]);
    assert_eq!(lib.search("tag:vocal", None).unwrap().len(), 1);
    assert_eq!(other.search("", None).unwrap().len(), 2, "other connections see the restored library");
    // The library as it was before the restore is kept, so a restore can be undone.
    assert_eq!(backup::check(&safety).unwrap(), 3);
    let list = backup::list(&backups);
    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|x| x.kind == BackupKind::BeforeRestore && x.tracks == Some(3)));
    assert!(list.iter().any(|x| x.kind == BackupKind::Auto && x.tracks == Some(2)));
    // Still a working library after the restore.
    add(&lib, "After", "Someone", "Pop", 100.0, "1A", 3);
    drop(lib);
    assert_eq!(Library::open(&db).unwrap().search("", None).unwrap().len(), 3);

    // A file that is not a library is refused and changes nothing.
    let junk = dir.0.join("junk.mixitlib");
    std::fs::write(&junk, b"not a database at all, just some bytes").unwrap();
    let mut lib = Library::open(&db).unwrap();
    assert!(lib.restore_from(&junk, &backups).is_err());
    assert_eq!(lib.search("", None).unwrap().len(), 3);

    // Only the newest automatic backups are kept; hand-made ones stay.
    for i in 0..12 {
        std::fs::copy(&first, backups.join(format!("auto-2020-01-{:02}-0000.mixitlib", i + 1))).unwrap();
    }
    let manual = lib.backup_into(&backups, BackupKind::Manual).unwrap();
    backup::prune(&backups, backup::KEEP_AUTO);
    let list = backup::list(&backups);
    assert_eq!(list.iter().filter(|x| x.kind == BackupKind::Auto).count(), backup::KEEP_AUTO);
    assert!(list.iter().any(|x| x.path == manual));
}

#[test]
fn past_sets_are_listed_renamed_and_forgotten() {
    let (lib, ids) = sample_library();
    let empty = lib.start_session("Opened and closed").unwrap();
    let friday = lib.start_session("Friday").unwrap();
    for &t in &ids[..3] {
        lib.log_play(friday, t, Some(0)).unwrap();
    }
    let saturday = lib.start_session("Saturday").unwrap();
    lib.log_play(saturday, ids[3], Some(1)).unwrap();
    let s = lib.sessions().unwrap();
    // Only sessions that played something, newest first.
    assert_eq!(s.iter().map(|x| x.id).collect::<Vec<_>>(), vec![saturday, friday]);
    assert!(s.iter().all(|x| x.id != empty));
    assert_eq!(s[1].tracks, 3);
    assert!(s[1].first_played <= s[1].last_played);
    lib.rename_session(friday, "  Friday at the bar ").unwrap();
    assert_eq!(lib.sessions().unwrap()[1].name, "Friday at the bar");
    lib.delete_session(friday).unwrap();
    assert_eq!(lib.sessions().unwrap().len(), 1);
    assert!(lib.session_history(friday).unwrap().is_empty());
    assert_eq!(lib.track(ids[0]).unwrap().play_count, 1, "play counts stay");
}

/// A local folder as Traktor names it: the volume ("C:" on Windows, else none) and the
/// directory ("/:home/:dj/:Music/:").
fn traktor_dir(p: &Path) -> (String, String) {
    let mut volume = String::new();
    let mut s = String::from("/:");
    for c in p.components() {
        match c {
            std::path::Component::Prefix(pre) => volume = pre.as_os_str().to_string_lossy().into_owned(),
            std::path::Component::Normal(n) => {
                s.push_str(&n.to_string_lossy());
                s.push_str("/:");
            }
            _ => {}
        }
    }
    (volume, s)
}

#[test]
fn imports_a_traktor_collection() {
    let tmp = TempDir::new("traktor");
    let music = tmp.0.join("Music");
    std::fs::create_dir_all(&music).unwrap();
    write_track(&music, "one.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let (vol, dir) = traktor_dir(&music);
    let key_one = format!("{vol}{dir}one.wav");
    let key_gone = format!("{vol}{dir}gone.mp3");
    let nml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<COLLECTION ENTRIES="2">
<ENTRY MODIFIED_DATE="2024/5/1" TITLE="One &amp; Only" ARTIST="Nova">
<LOCATION DIR="{dir}" FILE="one.wav" VOLUME="{vol}" VOLUMEID=""></LOCATION>
<ALBUM TITLE="Night Drives"></ALBUM>
<INFO BITRATE="1411000" GENRE="Deep House" LABEL="Moon" COMMENT="warm-up opener" PLAYTIME="20" RANKING="204"></INFO>
<TEMPO BPM="124.000000" BPM_QUALITY="100.000000"></TEMPO>
<MUSICAL_KEY VALUE="21"></MUSICAL_KEY>
<CUE_V2 NAME="AutoGrid" DISPL_ORDER="0" TYPE="4" START="250.000000" LEN="0.000000" REPEATS="-1" HOTCUE="0"></CUE_V2>
<CUE_V2 NAME="Drop" DISPL_ORDER="0" TYPE="0" START="7990.000000" LEN="0.000000" REPEATS="-1" HOTCUE="1"></CUE_V2>
<CUE_V2 NAME="n.n." DISPL_ORDER="0" TYPE="5" START="2185.000000" LEN="3870.000000" REPEATS="-1" HOTCUE="2"></CUE_V2>
<CUE_V2 NAME="Start" DISPL_ORDER="0" TYPE="3" START="250.000000" LEN="0.000000" REPEATS="-1" HOTCUE="-1"></CUE_V2>
</ENTRY>
<ENTRY TITLE="Gone" ARTIST="Kairo">
<LOCATION DIR="{dir}" FILE="gone.mp3" VOLUME="{vol}" VOLUMEID=""></LOCATION>
<INFO GENRE="Techno" PLAYTIME="300"></INFO>
<TEMPO BPM="130.000000"></TEMPO>
<MUSICAL_KEY VALUE="4"></MUSICAL_KEY>
</ENTRY>
</COLLECTION>
<PLAYLISTS>
<NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="2">
<NODE TYPE="FOLDER" NAME="Gigs"><SUBNODES COUNT="1">
<NODE TYPE="PLAYLIST" NAME="Friday"><PLAYLIST ENTRIES="2" TYPE="LIST" UUID="x">
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="{key_gone}"></PRIMARYKEY></ENTRY>
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="{key_one}"></PRIMARYKEY></ENTRY>
</PLAYLIST></NODE>
</SUBNODES></NODE>
<NODE TYPE="SMARTLIST" NAME="Recent"><SMARTLIST UUID="y"><SEARCH_EXPRESSION VERSION="1" QUERY="$IMPORTDATE &gt; 2024"></SEARCH_EXPRESSION></SMARTLIST></NODE>
</SUBNODES></NODE>
</PLAYLISTS>
</NML>"#
    );
    let path = tmp.0.join("collection.nml");
    std::fs::write(&path, nml).unwrap();

    let lib = Library::open_in_memory().unwrap();
    let rep = lib.import_traktor_nml(&path).unwrap();
    assert_eq!(rep.tracks, 2);
    assert_eq!(rep.missing.len(), 1, "{rep:?}");
    assert_eq!(rep.playlists, 1, "the smart list is left out");
    assert_eq!(rep.grids, 1);

    let one = lib.track_by_path(&music.join("one.wav")).unwrap().unwrap();
    assert_eq!(one.title, "One & Only");
    assert_eq!(one.album, "Night Drives");
    assert_eq!(one.genre, "Deep House");
    assert_eq!(one.label, "Moon");
    assert_eq!(one.comment, "warm-up opener");
    assert_eq!(one.rating, 4);
    assert_eq!(one.best_key(), Some(Key::new(9, Mode::Minor)));
    let g = lib.grid(one.id).unwrap().unwrap();
    assert!((g.bpm_at(0.0) - 124.0).abs() < 1e-6);
    assert!((g.frame_at(0.0) - 0.25 * 44_100.0).abs() < 1.0, "the grid starts at the marker");

    let cues = lib.cues(one.id).unwrap();
    assert_eq!(cues.len(), 3, "{cues:?}");
    let drop = cues.iter().find(|c| c.label == "Drop").unwrap();
    assert_eq!((drop.kind, drop.slot), (CueKind::Hot, Some(1)));
    assert!((drop.seconds - 7.99).abs() < 1e-9);
    let lp = cues.iter().find(|c| c.slot == Some(2)).unwrap();
    assert_eq!(lp.label, "", "Traktor's placeholder name is dropped");
    assert!((lp.loop_seconds.unwrap() - 3.87).abs() < 1e-9);
    assert!(cues.iter().any(|c| c.kind == CueKind::Main && (c.seconds - 0.25).abs() < 1e-9));

    let gone = lib.track_by_path(&music.join("gone.mp3")).unwrap().unwrap();
    assert!(gone.missing);
    assert_eq!(gone.best_key(), Some(Key::new(4, Mode::Major)), "Traktor key 4 is E major");

    let pls = lib.playlists().unwrap();
    let gigs = pls.iter().find(|p| p.name == "Gigs").unwrap();
    assert_eq!(gigs.kind, PlaylistKind::Folder);
    let fri = pls.iter().find(|p| p.name == "Friday").unwrap();
    assert_eq!(fri.parent, Some(gigs.id));
    let ids = lib.playlist_tracks(fri.id).unwrap();
    assert_eq!(ids, vec![gone.id, one.id], "in Traktor's order");

    // Importing again changes nothing that was already set.
    let again = lib.import_traktor_nml(&path).unwrap();
    assert_eq!(again.grids, 0);
    assert_eq!(again.cues, 0);
    assert_eq!(lib.cues(one.id).unwrap().len(), 3);
    assert_eq!(lib.playlists().unwrap().len(), 2, "the folder and list are refreshed, not copied");

    // Out to Traktor and back into a fresh library: nothing is lost on the way.
    let out = tmp.0.join("export.nml");
    lib.export_traktor_nml(None, &out).unwrap();
    let other = Library::open_in_memory().unwrap();
    let back = other.import_traktor_nml(&out).unwrap();
    assert_eq!((back.tracks, back.playlists, back.grids, back.cues), (2, 1, 1, 3), "{back:?}");
    let one2 = other.track_by_path(&music.join("one.wav")).unwrap().unwrap();
    assert_eq!((one2.title.as_str(), one2.album.as_str(), one2.rating), ("One & Only", "Night Drives", 4));
    assert_eq!(one2.best_key(), one.best_key());
    let g2 = other.grid(one2.id).unwrap().unwrap();
    assert!((g2.bpm - g.bpm).abs() < 1e-6 && (g2.frame_at(0.0) - g.frame_at(0.0)).abs() < 1.0);
    let mut c1 = lib.cues(one.id).unwrap();
    let mut c2 = other.cues(one2.id).unwrap();
    c1.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
    c2.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
    for (a, b) in c1.iter().zip(&c2) {
        assert_eq!((a.kind, a.slot, &a.label), (b.kind, b.slot, &b.label));
        assert!((a.seconds - b.seconds).abs() < 1e-6);
        assert_eq!(a.loop_seconds.map(|l| (l * 1e6).round()), b.loop_seconds.map(|l| (l * 1e6).round()));
    }
    let fri2 = other.playlists().unwrap().into_iter().find(|p| p.name == "Friday").unwrap();
    assert!(fri2.parent.is_some(), "still inside its folder");
    assert_eq!(other.playlist_tracks(fri2.id).unwrap().len(), 2);
}

#[test]
fn imports_a_serato_library_and_writes_cues_for_serato() {
    use mixit_io::serato::*;
    use mixit_library::serato::{Field, serato_rel, serato_root, write_fields};
    let tmp = TempDir::new("serato");
    let music = tmp.0.join("Music");
    let sdir = music.join("_Serato_");
    std::fs::create_dir_all(sdir.join("Subcrates")).unwrap();
    let one = write_track(&music, "one.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let gone = music.join("gone.mp3");
    // Serato saved a hot cue, a loop and a grid into the file.
    write_serato(
        &one,
        &SeratoData {
            markers: Some(SeratoMarkers {
                cues: vec![SeratoCue { index: 2, ms: 7_990, color: 0x00CC00, name: "Drop".into() }],
                loops: vec![SeratoLoop {
                    index: 0,
                    start_ms: 2_185,
                    end_ms: 6_055,
                    locked: false,
                    name: String::new(),
                }],
                color: Some(0xFF99FF),
                bpm_lock: false,
            }),
            grid: Some(vec![SeratoGridMarker { seconds: 0.25, bpm: 124.0 }]),
        },
    )
    .unwrap();
    let root = serato_root(&sdir);
    let root = root.as_path();
    let t = |n: &str, v: &str| Field::Text(n.into(), v.into());
    let db = write_fields(&[
        t("vrsn", "2.0/Serato Scratch LIVE Database"),
        Field::List(
            "otrk".into(),
            vec![
                t("ttyp", "wav"),
                t("pfil", &serato_rel(root, &one)),
                t("tsng", "One"),
                t("tart", "Nova"),
                t("tgen", "Deep House"),
                t("tbpm", "124.00"),
                t("tkey", "Am"),
            ],
        ),
        Field::List(
            "otrk".into(),
            vec![
                t("ttyp", "mp3"),
                t("pfil", &serato_rel(root, &gone)),
                t("tsng", "Gone"),
                t("tart", "Kairo"),
                t("tkey", "E"),
            ],
        ),
    ]);
    std::fs::write(sdir.join("database V2"), db).unwrap();
    let krate = |tracks: &[&Path]| {
        let mut f = vec![t("vrsn", "1.0/Serato ScratchLive Crate")];
        for p in tracks {
            f.push(Field::List("otrk".into(), vec![t("ptrk", &serato_rel(root, p))]));
        }
        write_fields(&f)
    };
    std::fs::write(sdir.join("Subcrates").join("Gigs.crate"), krate(&[&one])).unwrap();
    std::fs::write(sdir.join("Subcrates").join("Gigs%%Friday.crate"), krate(&[&gone, &one])).unwrap();
    std::fs::write(sdir.join("Subcrates").join("Warm up.crate"), krate(&[&one])).unwrap();

    let lib = Library::open_in_memory().unwrap();
    // The folder that holds _Serato_ works as well as _Serato_ itself.
    let rep = lib.import_serato(&music).unwrap();
    assert_eq!((rep.tracks, rep.playlists, rep.grids, rep.cues, rep.missing.len()), (2, 3, 1, 2, 1), "{rep:?}");
    let a = lib.track_by_path(&one).unwrap().unwrap();
    assert_eq!((a.title.as_str(), a.artist.as_str(), a.genre.as_str()), ("One", "Nova", "Deep House"));
    assert_eq!(a.best_key(), Some(Key::new(9, Mode::Minor)));
    assert_eq!(a.color, Some(0xFF99FF));
    let g = lib.grid(a.id).unwrap().unwrap();
    assert!((g.bpm - 124.0).abs() < 1e-3 && (g.frame_at(0.0) - 0.25 * 44_100.0).abs() < 1.0);
    let cues = lib.cues(a.id).unwrap();
    let drop = cues.iter().find(|c| c.kind == CueKind::Hot).unwrap();
    assert_eq!((drop.slot, drop.label.as_str(), drop.color), (Some(2), "Drop", Some(0x00CC00)));
    let lp = cues.iter().find(|c| c.loop_seconds.is_some()).unwrap();
    assert!((lp.seconds - 2.185).abs() < 1e-9 && (lp.loop_seconds.unwrap() - 3.87).abs() < 1e-9);
    let b = lib.track_by_path(&gone).unwrap().unwrap();
    assert!(b.missing);
    assert_eq!(b.best_key(), Some(Key::new(4, Mode::Major)));

    let pls = lib.playlists().unwrap();
    let folder = pls.iter().find(|p| p.name == "Gigs" && p.kind == PlaylistKind::Folder).unwrap();
    let own = pls.iter().find(|p| p.name == "Gigs" && p.kind == PlaylistKind::List).unwrap();
    assert_eq!(own.parent, Some(folder.id), "a parent crate's own tracks sit inside its folder");
    let fri = pls.iter().find(|p| p.name == "Friday").unwrap();
    assert_eq!(fri.parent, Some(folder.id));
    assert_eq!(lib.playlist_tracks(fri.id).unwrap(), vec![b.id, a.id]);
    assert!(pls.iter().any(|p| p.name == "Warm up" && p.parent.is_none()));

    // Importing again copies nothing.
    let again = lib.import_serato(&sdir).unwrap();
    assert_eq!((again.cues, again.grids), (0, 0));
    assert_eq!(lib.playlists().unwrap().len(), pls.len());

    // Cues made in MixIt go into the file for Serato, and come back from it.
    let mut mine = cues.clone();
    mine.push(Cue {
        kind: CueKind::Hot,
        slot: Some(5),
        seconds: 12.5,
        loop_seconds: None,
        color: None,
        label: "Break".into(),
    });
    lib.set_cues(a.id, &mine).unwrap();
    let (written, failed) = lib.write_serato(&[a.id, b.id]).unwrap();
    assert_eq!(written, 1);
    assert_eq!(failed.len(), 1, "the missing file is reported");
    let data = read_serato(&one).unwrap();
    let m = data.markers.unwrap();
    assert_eq!(m.cues.len(), 2);
    assert!(m.cues.iter().any(|c| c.index == 5
        && c.ms == 12_500
        && c.name == "Break"
        && c.color == mixit_library::serato::SERATO_COLORS[5]));
    assert_eq!(m.loops.len(), 1);
    assert!((data.grid.unwrap()[0].seconds - 0.25).abs() < 1e-5);
    assert_eq!(lib.track(a.id).unwrap().title, "One", "the library keeps its details");
}

#[test]
fn imports_a_virtualdj_library() {
    let tmp = TempDir::new("vdj");
    let music = tmp.0.join("Music");
    let vdj = tmp.0.join("VirtualDJ");
    std::fs::create_dir_all(&music).unwrap();
    std::fs::create_dir_all(vdj.join("Playlists").join("Gigs")).unwrap();
    std::fs::create_dir_all(vdj.join("MyLists")).unwrap();
    let one = write_track(&music, "one.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let gone = music.join("gone.mp3");
    let (p1, p2) = (one.to_string_lossy(), gone.to_string_lossy());
    let spb = 60.0 / 124.0;
    let db = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<VirtualDJ_Database Version="8.5">
 <Song FilePath="{p1}" FileSize="1000">
  <Tags Author="Nova" Title="One &amp; Only" Genre="Deep House" Album="Night Drives" Label="Moon" Year="2023" Key="Am" Stars="4" Flag="1" />
  <Infos SongLength="20.0" FirstSeen="1700000000" PlayCount="3" />
  <Comment>warm-up opener</Comment>
  <Scan Version="801" Flag="32768" Volume="1.1" Bpm="{spb:.6}" AltBpm="0.968" Key="Am" />
  <Poi Pos="0.250000" Type="beatgrid" />
  <Poi Name="Drop" Pos="7.990000" Num="2" Color="4278242304" />
  <Poi Name="Cue 1" Pos="0.250000" Num="1" />
  <Poi Name="Groove" Pos="2.185000" Size="8" Type="loop" />
  <Poi Pos="1.0" Type="automix" Point="realStart" />
  <Poi Name="Breakdown" Pos="12.5" Type="remix" />
 </Song>
 <Song FilePath="{p2}" FileSize="2000">
  <Tags Author="Kairo" Title="Gone" Bpm="0.461538" Key="E" />
 </Song>
 <Song FilePath="netsearch://dz123">
  <Tags Author="Online" Title="Stream" />
 </Song>
</VirtualDJ_Database>
"#
    );
    std::fs::write(vdj.join("database.xml"), db).unwrap();
    std::fs::write(
        vdj.join("Playlists").join("Gigs").join("Friday.m3u"),
        format!("#EXTM3U\n#EXTVDJ:<artist>Kairo</artist>\n{p2}\n{p1}\n"),
    )
    .unwrap();
    std::fs::write(vdj.join("MyLists").join("Warm up.vdjfolder"), format!(r#"<?xml version="1.0" encoding="UTF-8"?><VirtualFolder noDuplicates="no"><song path="{p1}" idx="0" /></VirtualFolder>"#)).unwrap();
    std::fs::write(vdj.join("MyLists").join("Fast.vdjfolder"), r#"<FilterFolder filter="bpm &gt; 130" />"#).unwrap();

    let lib = Library::open_in_memory().unwrap();
    // The folder above VirtualDJ works as well as VirtualDJ itself.
    let rep = lib.import_virtualdj(&tmp.0).unwrap();
    assert_eq!((rep.tracks, rep.playlists, rep.grids, rep.cues, rep.missing.len()), (2, 2, 1, 4, 1), "{rep:?}");
    let a = lib.track_by_path(&one).unwrap().unwrap();
    assert_eq!(
        (a.title.as_str(), a.artist.as_str(), a.album.as_str(), a.label.as_str()),
        ("One & Only", "Nova", "Night Drives", "Moon")
    );
    assert_eq!((a.rating, a.comment.as_str()), (4, "warm-up opener"));
    assert_eq!(a.best_key(), Some(Key::new(9, Mode::Minor)));
    let g = lib.grid(a.id).unwrap().unwrap();
    assert!((g.bpm - 124.0).abs() < 1e-3 && (g.frame_at(0.0) - 0.25 * 44_100.0).abs() < 1.0);
    let cues = lib.cues(a.id).unwrap();
    let drop = cues.iter().find(|c| c.label == "Drop").unwrap();
    assert_eq!(
        (drop.kind, drop.slot, drop.color),
        (CueKind::Hot, Some(1), Some(0x00CC00)),
        "pads count from 1 in VirtualDJ"
    );
    assert!(cues.iter().any(|c| c.slot == Some(0) && c.label.is_empty()), "the default name is dropped");
    let lp = cues.iter().find(|c| c.label == "Groove").unwrap();
    assert!((lp.loop_seconds.unwrap() - 8.0 * 60.0 / 124.0).abs() < 1e-3, "loop sizes are in beats");
    assert!(cues.iter().any(|c| c.label == "Breakdown" && c.kind == CueKind::Memory));
    let b = lib.track_by_path(&gone).unwrap().unwrap();
    assert!(b.missing);
    assert!(b.best_bpm().is_some_and(|x| (x - 130.0).abs() < 0.01), "{:?}", b.best_bpm());

    let pls = lib.playlists().unwrap();
    let gigs = pls.iter().find(|p| p.name == "Gigs").unwrap();
    assert_eq!(gigs.kind, PlaylistKind::Folder);
    let fri = pls.iter().find(|p| p.name == "Friday").unwrap();
    assert_eq!(fri.parent, Some(gigs.id));
    assert_eq!(lib.playlist_tracks(fri.id).unwrap(), vec![b.id, a.id]);
    assert!(pls.iter().any(|p| p.name == "Warm up"));
    assert!(!pls.iter().any(|p| p.name == "Fast"), "filter folders are left out");

    let again = lib.import_virtualdj(&vdj).unwrap();
    assert_eq!((again.cues, again.grids), (0, 0));
    assert_eq!(lib.playlists().unwrap().len(), pls.len());
}

#[test]
fn copies_a_playlist_to_a_usb_stick() {
    use mixit_library::m3u::safe_file_name;
    use std::sync::atomic::AtomicBool;
    let tmp = TempDir::new("copy");
    let music = tmp.0.join("Music");
    std::fs::create_dir_all(music.join("a")).unwrap();
    std::fs::create_dir_all(music.join("b")).unwrap();
    let one = write_track(&music.join("a"), "track.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    let two = write_track(&music.join("b"), "track.wav", Style::Techno, 128.0, Key::new(4, Mode::Minor));
    let lib = Library::open_in_memory().unwrap();
    let ida = lib.import_file(&one).unwrap();
    let idb = lib.import_file(&two).unwrap();
    let id = |i: scan::Imported| match i {
        scan::Imported::Added(i)
        | scan::Imported::Updated(i)
        | scan::Imported::Moved(i)
        | scan::Imported::Unchanged(i) => i,
    };
    let (a, b) = (id(ida), id(idb));
    lib.edit_track(
        a,
        &TrackEdit { title: Some("Night: Drive?".into()), artist: Some("Nova".into()), ..Default::default() },
    )
    .unwrap();
    let gone = lib.insert_track(&NewTrack { path: music.join("gone.mp3"), ..Default::default() }).unwrap();
    lib.set_missing(gone, true).unwrap();

    let usb = tmp.0.join("USB");
    let stop = AtomicBool::new(false);
    let mut seen = 0;
    // Same file names from two folders: the second gets "(2)".
    let r = lib.copy_files(&[a, b, gone], &usb, "Friday / Late", false, &stop, |_, _, _| seen += 1).unwrap();
    assert_eq!((r.copied, r.kept, r.failed.len(), r.cancelled), (2, 0, 1, false), "{r:?}");
    assert!(seen >= 3);
    assert_eq!(r.folder, usb.join("Friday _ Late"));
    assert!(r.folder.join("track.wav").is_file() && r.folder.join("track (2).wav").is_file());
    let m3u = std::fs::read_to_string(&r.playlist).unwrap();
    assert!(m3u.contains("Nova - Night: Drive?\ntrack.wav\n") && m3u.contains("\ntrack (2).wav\n"), "{m3u}");
    // The copied playlist reads back as the same tracks.
    let (ids, missing) = lib.import_m3u(&r.playlist).unwrap();
    assert_eq!(ids.len(), 2);
    assert!(missing.is_empty());

    // Numbered names in playlist order; a second copy keeps what is already there.
    let n = lib.copy_files(&[b, a], &usb, "Numbered", true, &stop, |_, _, _| {}).unwrap();
    assert!(
        n.folder.join("01 track.wav").is_file()
            || n.folder.join(format!("01 {}.wav", lib.track(b).unwrap().display_title())).is_file()
    );
    assert!(
        n.folder.join("02 Nova - Night_ Drive_.wav").is_file(),
        "{:?}",
        std::fs::read_dir(&n.folder).unwrap().flatten().map(|e| e.file_name()).collect::<Vec<_>>()
    );
    let again = lib.copy_files(&[b, a], &usb, "Numbered", true, &stop, |_, _, _| {}).unwrap();
    assert_eq!((again.copied, again.kept), (0, 2));

    assert_eq!(safe_file_name("CON"), "_CON");
    assert_eq!(safe_file_name("a/b\\c:d. "), "a_b_c_d");
}

#[test]
fn playlists_move_between_folders() {
    let lib = Library::open_in_memory().unwrap();
    let gigs = lib.create_playlist("Gigs", PlaylistKind::Folder, None, None).unwrap();
    let old = lib.create_playlist("Old", PlaylistKind::Folder, Some(gigs), None).unwrap();
    let a = lib.create_playlist("A", PlaylistKind::List, None, None).unwrap();
    let b = lib.create_playlist("B", PlaylistKind::List, Some(gigs), None).unwrap();
    lib.move_playlist(a, Some(gigs), 0).unwrap();
    let names = |parent: Option<i64>| -> Vec<String> {
        let mut v: Vec<_> = lib.playlists().unwrap().into_iter().filter(|p| p.parent == parent).collect();
        v.sort_by_key(|p| p.position);
        v.into_iter().map(|p| p.name).collect()
    };
    assert_eq!(names(Some(gigs)), ["A", "Old", "B"]);
    lib.move_playlist(a, Some(gigs), 99).unwrap();
    assert_eq!(names(Some(gigs)), ["Old", "B", "A"]);
    lib.move_playlist(b, None, 0).unwrap();
    assert_eq!(names(None), ["B", "Gigs"]);
    assert!(lib.move_playlist(gigs, Some(old), 0).is_err(), "not inside itself");
    assert!(lib.move_playlist(gigs, Some(gigs), 0).is_err());
    assert!(lib.move_playlist(a, Some(b), 0).is_err(), "only folders hold playlists");
}

#[test]
fn finds_tracks_that_sound_alike() {
    let tmp = TempDir::new("sounds");
    let music = tmp.0.join("Music");
    std::fs::create_dir_all(&music).unwrap();
    let house = write_track(&music, "house.wav", Style::House, 124.0, Key::new(9, Mode::Minor));
    write_track(&music, "house2.wav", Style::House, 126.0, Key::new(2, Mode::Major));
    write_track(&music, "hiphop.wav", Style::HipHop, 90.0, Key::new(9, Mode::Minor));
    write_track(&music, "dnb.wav", Style::DrumAndBass, 172.0, Key::new(9, Mode::Minor));

    let lib = Library::open(&tmp.0.join("library.db")).unwrap();
    lib.add_folder(&music).unwrap();
    lib.rescan_all(|_, _| {}).unwrap();
    let cancel = AtomicBool::new(false);
    lib.analyze_pending(&JobOptions { threads: 2, ..Default::default() }, &cancel, |_, _, _| {}).unwrap();
    assert_eq!(lib.sound_profiles().unwrap().len(), 4, "every analysed track has a sound profile");

    let h = lib.track_by_path(&house).unwrap().unwrap().id;
    let alike = lib.sounds_like(h, 10).unwrap();
    assert_eq!(alike.len(), 3);
    let first = lib.track(alike[0].0).unwrap();
    assert!(first.path.ends_with("house2.wav"), "closest to a house track is the other house track: {alike:?}");
    assert!(alike[0].1 > alike[2].1);
    assert!(alike.iter().all(|(_, s)| (0.0..=1.0).contains(s)));

    // Suggestions take the sound into account too.
    let s = lib.suggest_next(h, &SuggestOptions { tempo_tolerance_pct: 50.0, ..Default::default() }).unwrap();
    let h2 = s.iter().find(|x| x.id == first.id).unwrap();
    assert!(h2.reasons.iter().any(|r| matches!(r, mixit_library::suggest::Reason::SoundsAlike(_))), "{:?}", h2.reasons);

    // A track that was never analysed has no matches yet.
    let none = lib.sounds_like(9_999, 5).unwrap();
    assert!(none.is_empty());
}

#[test]
fn suggestions_remember_what_you_played_next() {
    let lib = Library::open_in_memory().unwrap();
    let a = add(&lib, "Opener", "A", "House", 124.0, "8A", 5);
    let b = add(&lib, "Follow", "B", "House", 124.0, "8A", 5);
    let c = add(&lib, "Other", "C", "House", 124.0, "8A", 5);
    // Two past sets played Follow right after Opener; Other came after Follow.
    for name in ["Friday", "Saturday"] {
        let s = lib.start_session(name).unwrap();
        for t in [a, b, c] {
            lib.log_play(s, t, Some(0)).unwrap();
        }
        lib.end_session(s).unwrap();
    }
    let after = lib.played_after(a).unwrap();
    assert_eq!(after.get(&b), Some(&2));
    assert_eq!(after.get(&c), None, "only the very next track counts");

    let s = lib.suggest_next(a, &SuggestOptions::default()).unwrap();
    assert_eq!(s[0].id, b, "the transition you already played ranks first: {s:?}");
    assert!(s[0].reasons.contains(&mixit_library::suggest::Reason::MixedBefore(2)));
    assert!(!s[1].reasons.iter().any(|r| matches!(r, mixit_library::suggest::Reason::MixedBefore(_))));
}

#[test]
fn builds_a_set_from_a_search() {
    use mixit_library::setbuild::{BuildOptions, SetShape};
    let lib = Library::open_in_memory().unwrap();
    let keys = ["8A", "9A", "8B", "7A", "9B", "10A"];
    let mut house = Vec::new();
    for i in 0..24 {
        house.push(add(
            &lib,
            &format!("House {i}"),
            &format!("Artist {}", i % 5),
            "House",
            122.0 + (i % 5) as f64,
            keys[i % 6],
            3 + (i % 6) as u8,
        ));
    }
    let techno = add(&lib, "Techno", "Other", "Techno", 124.0, "8A", 6);

    let ids = lib
        .build_set("genre:house", None, &BuildOptions { minutes: 40.0, shape: SetShape::Build, ..Default::default() })
        .unwrap();
    // 300 s tracks, 80 % heard: 10 tracks fill 40 minutes.
    assert_eq!(ids.len(), 10, "{ids:?}");
    assert!(!ids.contains(&techno), "only tracks the search finds");
    assert!(ids.iter().all(|id| house.contains(id)));

    // A seed opens the set even from outside the search.
    let ids = lib
        .build_set("genre:house", None, &BuildOptions { minutes: 20.0, seed: Some(techno), ..Default::default() })
        .unwrap();
    assert_eq!(ids[0], techno);

    // Within a playlist.
    let list = lib.create_playlist("Crate", PlaylistKind::List, None, None).unwrap();
    lib.set_playlist_tracks(list, &house[..6]).unwrap();
    let ids = lib.build_set("", Some(list), &BuildOptions { minutes: 120.0, ..Default::default() }).unwrap();
    assert!(!ids.is_empty() && ids.len() <= 6);
    assert!(ids.iter().all(|id| house[..6].contains(id)));
}
