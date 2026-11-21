//! Drives the real `mixit` binary through a whole workflow.

use std::path::{Path, PathBuf};
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_mixit"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mixit-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn run(args: &[&str], db: &Path) -> String {
    let out = bin().args(args).env("MIXIT_DB", db).output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(out.status.success(), "mixit {args:?} failed:\n{stdout}\n{}", String::from_utf8_lossy(&out.stderr));
    stdout
}

fn json(args: &[&str], db: &Path) -> serde_json::Value {
    let mut a = vec!["--json", "-q"];
    a.extend_from_slice(args);
    serde_json::from_str(&run(&a, db)).unwrap()
}

#[test]
fn whole_workflow() {
    let d = tmp("flow");
    let db = d.join("lib.db");
    let music = d.join("music");
    let p = |s: &str| d.join(s).to_string_lossy().into_owned();
    let m = |s: &str| music.join(s).to_string_lossy().into_owned();
    for (f, bpm, key, seed) in
        [("one.wav", "124", "8A", "3"), ("two.wav", "126", "9A", "5"), ("three.wav", "123", "7A", "8")]
    {
        run(&["-q", "generate", "-o", &m(f), "--short", "--bpm", bpm, "--key", key, "--seed", seed], &db);
    }

    // Analysis, as JSON.
    let a = json(&["analyze", &m("one.wav")], &db);
    let bpm = a[0]["analysis"]["bpm"].as_f64().unwrap();
    assert!((bpm - 124.0).abs() < 0.05, "{bpm}");

    // Library: scan + analyse, search, suggest.
    run(&["-q", "lib", "scan", &music.to_string_lossy()], &db);
    let stats = json(&["lib", "stats"], &db);
    assert_eq!(stats["tracks"], 3);
    assert_eq!(stats["analysed"], 3);
    let found = json(&["lib", "search", "bpm:123-125"], &db);
    assert_eq!(found.as_array().unwrap().len(), 2);
    let one =
        found.as_array().unwrap().iter().find(|t| t["bpm"].as_f64().unwrap() > 123.5).unwrap()["id"].as_i64().unwrap();
    let sugg = json(&["lib", "suggest", &one.to_string()], &db);
    assert_eq!(sugg.as_array().unwrap().len(), 2);

    // Playlist, harmonic order, automix and render from the library.
    run(&["lib", "playlist-create", "Set", "--tracks", "1,2,3"], &db);
    run(&["lib", "playlist-order", "Set"], &db);
    run(&["-q", "lib", "automix", "Set", "-o", &p("set.json"), "--overlap", "16", "--render", &p("set.wav")], &db);
    let project = json(&["project", &p("set.json")], &db);
    assert_eq!(project["project"]["clips"].as_array().unwrap().len(), 3);
    let mix = json(&["analyze", &p("set.wav")], &db);
    let mix_bpm = mix[0]["analysis"]["bpm"].as_f64().unwrap();
    let first_bpm = project["project"]["clips"][0]["track"]["bpm"].as_f64().unwrap();
    assert!((mix_bpm - first_bpm).abs() < 0.1, "mix at {mix_bpm}, opener at {first_bpm}");

    // Files straight to a mix, without the library.
    run(&["-q", "automix", &m("one.wav"), &m("two.wav"), "-o", &p("files.json"), "--transition", "cut"], &db);
    run(&["-q", "render", &p("files.json"), "-o", &p("files.flac")], &db);
    assert!(std::fs::metadata(p("files.flac")).unwrap().len() > 100_000);

    // Stretch to a tempo, and exchange formats.
    let s = json(&["stretch", &m("one.wav"), "-o", &p("fast.wav"), "--bpm", "130"], &db);
    assert!((s["speed"].as_f64().unwrap() - 130.0 / 124.0).abs() < 0.002);
    let fast = json(&["analyze", &p("fast.wav")], &db);
    assert!((fast[0]["analysis"]["bpm"].as_f64().unwrap() - 130.0).abs() < 0.1);
    run(&["lib", "export-rekordbox", &p("rb.xml")], &db);
    run(&["lib", "export", "Set", &p("set.m3u")], &db);
    assert!(std::fs::read_to_string(p("set.m3u")).unwrap().contains("one.wav"));
    let key = json(&["key", "8A"], &db);
    assert_eq!(key["compatible"].as_array().unwrap().len(), 3);

    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn errors_are_reported() {
    let d = tmp("err");
    let out = bin().args(["analyze", "/no/such/file.wav"]).env("MIXIT_DB", d.join("x.db")).output().unwrap();
    assert!(!out.status.success());
    let out = bin().args(["key", "H#"]).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not a key"));
    let _ = std::fs::remove_dir_all(&d);
}
