//! Reading tags and audio properties with lofty (ID3v2, MP4, Vorbis comments, APE, RIFF).

use std::path::Path;

use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};

use crate::{IoError, Result};

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TrackTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub comment: Option<String>,
    pub label: Option<String>,
    pub remixer: Option<String>,
    pub track_number: Option<u32>,
    /// BPM written by another app (used only as a hint; MixIt analyses its own).
    pub bpm: Option<f64>,
    /// Key as written in the tag (Camelot, Open Key or standard notation).
    pub key: Option<String>,
    pub duration_s: f64,
    pub sample_rate: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    pub channels: Option<u8>,
    pub bit_depth: Option<u8>,
    pub has_artwork: bool,
}

/// Reads tags and properties. Files with no tags still return their properties.
pub fn read_tags(path: &Path) -> Result<TrackTags> {
    let tagged = lofty::read_from_path(path).map_err(|e| IoError::Unsupported(e.to_string()))?;
    let props = tagged.properties();
    let mut t = TrackTags {
        duration_s: props.duration().as_secs_f64(),
        sample_rate: props.sample_rate(),
        bitrate_kbps: props.audio_bitrate(),
        channels: props.channels(),
        bit_depth: props.bit_depth(),
        ..Default::default()
    };
    // ID3v2 first: in WAV and AIFF it carries more than the RIFF or AIFF text chunks.
    let id3 = tagged.tag(lofty::tag::TagType::Id3v2).filter(|t| t.item_count() > 0);
    if let Some(tag) = id3.or_else(|| tagged.primary_tag()).or_else(|| tagged.first_tag()) {
        let s = |k: ItemKey| tag.get_string(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        t.title = tag.title().map(|v| v.to_string());
        t.artist = tag.artist().map(|v| v.to_string());
        t.album = tag.album().map(|v| v.to_string());
        t.genre = tag.genre().map(|v| v.to_string());
        t.comment = tag.comment().map(|v| v.to_string());
        t.track_number = tag.track();
        t.album_artist = s(ItemKey::AlbumArtist);
        t.label = s(ItemKey::Label).or_else(|| s(ItemKey::Publisher));
        t.remixer = s(ItemKey::Remixer);
        t.key = s(ItemKey::InitialKey);
        t.year = s(ItemKey::Year).or_else(|| s(ItemKey::RecordingDate)).and_then(|y| y.get(..4)?.parse().ok());
        t.bpm = s(ItemKey::Bpm)
            .or_else(|| s(ItemKey::IntegerBpm))
            .and_then(|b| b.replace(',', ".").parse::<f64>().ok())
            .filter(|b| (20.0..=400.0).contains(b));
        t.has_artwork = !tag.pictures().is_empty();
    }
    Ok(t)
}

/// The front cover (or first picture), with its MIME type.
pub fn read_artwork(path: &Path) -> Option<(Vec<u8>, String)> {
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pics = tag.pictures();
    let pic = pics.iter().find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront).or_else(|| pics.first())?;
    let mime = pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into());
    Some((pic.data().to_vec(), mime))
}

/// Tags to write: only the fields that are `Some` change; an empty string removes one.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TagUpdate {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub label: Option<String>,
    pub year: Option<u32>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
}

/// Writes tags into the file, in its main tag format (ID3v2 for MP3, AIFF and WAV,
/// Vorbis comments for FLAC and Ogg, MP4 atoms for M4A). Other tags in the file stay.
pub fn write_tags(path: &Path, u: &TagUpdate) -> Result<()> {
    use lofty::config::WriteOptions;
    use lofty::file::FileType;
    use lofty::tag::{Tag, TagType};

    let mut tagged = lofty::read_from_path(path).map_err(|e| IoError::Unsupported(e.to_string()))?;
    // WAV and AIFF get ID3v2 (what DJ software reads there; RIFF INFO has no BPM, key or label).
    let target = match tagged.file_type() {
        FileType::Wav | FileType::Aiff | FileType::Mpeg => TagType::Id3v2,
        _ => tagged.primary_tag_type(),
    };
    if tagged.tag(target).is_none() {
        tagged.insert_tag(Tag::new(target));
    }
    let tag = tagged.tag_mut(target).ok_or_else(|| IoError::Unsupported("this file cannot hold tags".into()))?;
    let text = |tag: &mut Tag, key: ItemKey, v: &str| {
        if v.trim().is_empty() {
            tag.remove_key(key);
        } else {
            tag.insert_text(key, v.trim().to_string());
        }
    };
    if let Some(v) = &u.title {
        text(tag, ItemKey::TrackTitle, v);
    }
    if let Some(v) = &u.artist {
        text(tag, ItemKey::TrackArtist, v);
    }
    if let Some(v) = &u.album {
        text(tag, ItemKey::AlbumTitle, v);
    }
    if let Some(v) = &u.genre {
        text(tag, ItemKey::Genre, v);
    }
    if let Some(v) = &u.comment {
        text(tag, ItemKey::Comment, v);
    }
    if let Some(v) = &u.label {
        text(tag, ItemKey::Label, v);
    }
    if let Some(y) = u.year {
        text(tag, ItemKey::RecordingDate, &y.to_string());
    }
    if let Some(b) = u.bpm.filter(|b| (20.0..=400.0).contains(b)) {
        // Whole BPMs in the common field, the exact value where the format has one.
        text(tag, ItemKey::IntegerBpm, &format!("{}", b.round() as u32));
        text(tag, ItemKey::Bpm, &format!("{:.2}", b));
    }
    if let Some(k) = &u.key {
        text(tag, ItemKey::InitialKey, k);
    }
    tagged.save_to_path(path, WriteOptions::default()).map_err(|e| IoError::Unsupported(e.to_string()))?;
    Ok(())
}
