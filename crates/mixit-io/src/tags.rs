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
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        let s = |k: ItemKey| tag.get_string(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        t.title = tag.title().map(|v| v.to_string());
        t.artist = tag.artist().map(|v| v.to_string());
        t.album = tag.album().map(|v| v.to_string());
        t.genre = tag.genre().map(|v| v.to_string());
        t.comment = tag.comment().map(|v| v.to_string());
        t.track_number = tag.track();
        t.album_artist = s(ItemKey::AlbumArtist);
        t.label = s(ItemKey::Label);
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
