//! "Now playing" for live streams: the track that just went on air, written to a text
//! file that streaming software (OBS and the like) shows on screen.

use mixit_library::Track;

/// The default line: "Artist - Title".
pub const DEFAULT_FORMAT: &str = "{artist} - {title}";

/// Fills `format`'s placeholders ({artist} {title} {album} {genre} {label} {bpm} {key})
/// from `t`. A " - " left dangling by an empty artist or title is taken out.
pub fn now_playing_text(format: &str, t: &Track) -> String {
    let format = if format.trim().is_empty() { DEFAULT_FORMAT } else { format };
    let bpm = t.best_bpm().map(|b| format!("{}", (b * 10.0).round() / 10.0)).unwrap_or_default();
    let key = t.best_key().map(|k| k.to_string()).unwrap_or_default();
    let out = format
        .replace("{artist}", t.artist.trim())
        .replace("{title}", t.display_title().trim())
        .replace("{album}", t.album.trim())
        .replace("{genre}", t.genre.trim())
        .replace("{label}", t.label.trim())
        .replace("{bpm}", &bpm)
        .replace("{key}", &key);
    let out = out.trim();
    let out = out.strip_prefix("- ").or_else(|| out.strip_suffix(" -")).unwrap_or(out);
    out.trim().to_string()
}

/// Writes the line (replacing the file, so readers always see one whole line).
pub fn write_now_playing(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("mixit-tmp");
    std::fs::write(&tmp, format!("{text}\n"))?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::Key;
    use mixit_library::{Library, NewTrack, TrackEdit};

    fn track(artist: &str, title: &str) -> Track {
        let lib = Library::open_in_memory().unwrap();
        let id = lib
            .insert_track(&NewTrack {
                path: std::path::PathBuf::from("/music/file.mp3"),
                tags: mixit_io::TrackTags {
                    title: Some(title.into()),
                    artist: Some(artist.into()),
                    album: Some("Night Drives".into()),
                    ..Default::default()
                },
                ..Default::default()
            })
            .unwrap();
        lib.edit_track(id, &TrackEdit { bpm: Some(Some(124.04)), key: Some(Key::parse("8A")), ..Default::default() })
            .unwrap();
        lib.track(id).unwrap()
    }

    #[test]
    fn fills_the_line() {
        let t = track("Nova", "Midnight Drive");
        assert_eq!(now_playing_text(DEFAULT_FORMAT, &t), "Nova - Midnight Drive");
        assert_eq!(
            now_playing_text("♪ {title} by {artist} ({bpm} BPM, {key})", &t),
            "♪ Midnight Drive by Nova (124 BPM, 8A)"
        );
        assert_eq!(now_playing_text("", &t), "Nova - Midnight Drive");
    }

    #[test]
    fn no_dangling_dash() {
        assert_eq!(now_playing_text(DEFAULT_FORMAT, &track("", "Midnight Drive")), "Midnight Drive");
    }

    #[test]
    fn writes_one_line() {
        let dir = std::env::temp_dir().join(format!("mixit-np-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("now-playing.txt");
        write_now_playing(&p, "Nova - Midnight Drive").unwrap();
        write_now_playing(&p, "Kairo - Solar Wind").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "Kairo - Solar Wind\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
