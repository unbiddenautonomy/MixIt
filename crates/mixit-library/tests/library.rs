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
