//! Serato's cue points, loops and beat grids, which Serato DJ keeps inside the music
//! files themselves: `GEOB` frames named "Serato Markers2" and "Serato BeatGrid" in
//! ID3v2 tags (MP3, WAV, AIFF), or base64 Vorbis comments (`SERATO_MARKERS_V2`,
//! `SERATO_BEATGRID`) in FLAC and Ogg files.
//!
//! Markers2 is base64 text holding a list of named entries ("CUE", "LOOP", "COLOR",
//! "BPMLOCK"); positions are whole milliseconds. BeatGrid is a list of markers, each a
//! position in seconds with the number of beats to the next marker, the last one with
//! the tempo. The first marker sits on a downbeat.

use std::path::Path;

use crate::{IoError, Result};

/// A hot cue as Serato stores it.
#[derive(Clone, Debug, PartialEq)]
pub struct SeratoCue {
    /// Pad 0..8.
    pub index: u8,
    pub ms: u32,
    /// 0xRRGGBB.
    pub color: u32,
    pub name: String,
}

/// A saved loop.
#[derive(Clone, Debug, PartialEq)]
pub struct SeratoLoop {
    pub index: u8,
    pub start_ms: u32,
    pub end_ms: u32,
    pub locked: bool,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeratoMarkers {
    pub cues: Vec<SeratoCue>,
    pub loops: Vec<SeratoLoop>,
    /// The track colour (0xRRGGBB).
    pub color: Option<u32>,
    pub bpm_lock: bool,
}

/// One beat-grid marker: where it is, and the tempo up to the next one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SeratoGridMarker {
    pub seconds: f64,
    pub bpm: f64,
}

/// What Serato left in a file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeratoData {
    pub markers: Option<SeratoMarkers>,
    pub grid: Option<Vec<SeratoGridMarker>>,
}

impl SeratoData {
    pub fn is_empty(&self) -> bool {
        self.markers.as_ref().is_none_or(|m| m.cues.is_empty() && m.loops.is_empty())
            && self.grid.as_ref().is_none_or(|g| g.is_empty())
    }
}

// ------------------------------------------------------------------------ base64

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64 without padding checks: Serato breaks lines, drops padding and pads with zeros.
pub fn base64_decode(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in text {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | 0 => break,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Base64 with padding, broken into lines of `wrap` characters (0 for one line).
pub fn base64_encode(data: &[u8], wrap: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 4 / 3 + 4);
    for ch in data.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= ch.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize]);
            } else {
                out.push(b'=');
            }
        }
    }
    if wrap == 0 {
        return out;
    }
    let mut w = Vec::with_capacity(out.len() + out.len() / wrap + 1);
    for (i, line) in out.chunks(wrap).enumerate() {
        if i > 0 {
            w.push(b'\n');
        }
        w.extend_from_slice(line);
    }
    w
}

// ------------------------------------------------------------------- Markers2

fn cstr(b: &[u8]) -> (String, usize) {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    (String::from_utf8_lossy(&b[..end]).into_owned(), (end + 1).min(b.len()))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// Reads the body of a "Serato Markers2" object (`01 01` then base64 text).
pub fn parse_markers2(data: &[u8]) -> Option<SeratoMarkers> {
    let text = data.strip_prefix(&[1, 1])?;
    let raw = base64_decode(text);
    let mut b = raw.strip_prefix(&[1, 1])?;
    let mut m = SeratoMarkers::default();
    while !b.is_empty() && b[0] != 0 {
        let (name, n) = cstr(b);
        let len = be32(b, n)? as usize;
        let body = b.get(n + 4..n + 4 + len)?;
        b = &b[n + 4 + len..];
        match name.as_str() {
            "CUE" if body.len() >= 13 => m.cues.push(SeratoCue {
                index: body[1],
                ms: be32(body, 2)?,
                color: u32::from_be_bytes([0, body[7], body[8], body[9]]),
                name: cstr(&body[12..]).0,
            }),
            "LOOP" if body.len() >= 21 => m.loops.push(SeratoLoop {
                index: body[1],
                start_ms: be32(body, 2)?,
                end_ms: be32(body, 6)?,
                locked: body[19] != 0,
                name: cstr(&body[20..]).0,
            }),
            // White is Serato's "no colour".
            "COLOR" if body.len() >= 4 => {
                m.color = Some(u32::from_be_bytes([0, body[1], body[2], body[3]])).filter(|c| *c != 0xFF_FFFF)
            }
            "BPMLOCK" if !body.is_empty() => m.bpm_lock = body[0] != 0,
            _ => {}
        }
    }
    Some(m)
}

/// Writes a "Serato Markers2" body that Serato reads back.
pub fn encode_markers2(m: &SeratoMarkers) -> Vec<u8> {
    let mut raw = vec![1u8, 1];
    let mut entry = |name: &str, body: &[u8]| {
        raw.extend_from_slice(name.as_bytes());
        raw.push(0);
        raw.extend_from_slice(&(body.len() as u32).to_be_bytes());
        raw.extend_from_slice(body);
    };
    let c = m.color.unwrap_or(0xFF_FFFF);
    entry("COLOR", &[0, (c >> 16) as u8, (c >> 8) as u8, c as u8]);
    for q in &m.cues {
        let mut b = vec![0, q.index];
        b.extend_from_slice(&q.ms.to_be_bytes());
        b.extend_from_slice(&[0, (q.color >> 16) as u8, (q.color >> 8) as u8, q.color as u8, 0, 0]);
        b.extend_from_slice(q.name.as_bytes());
        b.push(0);
        entry("CUE", &b);
    }
    for l in &m.loops {
        let mut b = vec![0, l.index];
        b.extend_from_slice(&l.start_ms.to_be_bytes());
        b.extend_from_slice(&l.end_ms.to_be_bytes());
        b.extend_from_slice(&[0xff, 0xff, 0xff, 0xff, 0x00, 0x27, 0xaa, 0xe1, 0, l.locked as u8]);
        b.extend_from_slice(l.name.as_bytes());
        b.push(0);
        entry("LOOP", &b);
    }
    entry("BPMLOCK", &[m.bpm_lock as u8]);
    raw.push(0);
    let mut out = vec![1u8, 1];
    out.extend(base64_encode(&raw, 72));
    // Serato leaves room to grow; at least one zero ends the text.
    out.resize(out.len().max(470), 0);
    out.push(0);
    out
}

// ------------------------------------------------------------------- BeatGrid

/// Reads the body of a "Serato BeatGrid" object.
pub fn parse_beatgrid(data: &[u8]) -> Option<Vec<SeratoGridMarker>> {
    let b = data.strip_prefix(&[1, 0])?;
    let n = be32(b, 0)? as usize;
    if n == 0 || n > 100_000 {
        return None;
    }
    let mut raw = Vec::with_capacity(n);
    for i in 0..n {
        let at = 4 + i * 8;
        let pos = f32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?) as f64;
        let tail = b.get(at + 4..at + 8)?;
        raw.push((pos, tail));
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (pos, tail) = raw[i];
        let bpm = if i + 1 == n {
            f32::from_be_bytes(tail.try_into().ok()?) as f64
        } else {
            let beats = u32::from_be_bytes(tail.try_into().ok()?) as f64;
            let next = raw[i + 1].0;
            if next <= pos || beats <= 0.0 {
                continue;
            }
            beats * 60.0 / (next - pos)
        };
        if pos.is_finite() && bpm.is_finite() && bpm > 0.0 {
            out.push(SeratoGridMarker { seconds: pos, bpm });
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Writes a "Serato BeatGrid" body. Each marker but the last counts whole beats to the
/// next one.
pub fn encode_beatgrid(markers: &[SeratoGridMarker]) -> Vec<u8> {
    let mut b = vec![1u8, 0];
    b.extend_from_slice(&(markers.len() as u32).to_be_bytes());
    for (i, m) in markers.iter().enumerate() {
        b.extend_from_slice(&(m.seconds as f32).to_be_bytes());
        match markers.get(i + 1) {
            Some(n) => {
                b.extend_from_slice(&(((n.seconds - m.seconds) * m.bpm / 60.0).round().max(1.0) as u32).to_be_bytes())
            }
            None => b.extend_from_slice(&(m.bpm as f32).to_be_bytes()),
        }
    }
    b.push(0);
    b
}

// ------------------------------------------------------------------------ files

const MARKERS2: &str = "Serato Markers2";
const BEATGRID: &str = "Serato BeatGrid";
const MIME: &str = "application/octet-stream";

fn kind(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp3") => "mp3",
        Some("wav" | "wave") => "wav",
        Some("aif" | "aiff") => "aiff",
        Some("flac") => "flac",
        Some("ogg" | "oga") => "ogg",
        _ => "",
    }
}

fn bad<E: std::fmt::Display>(e: E) -> IoError {
    IoError::Unsupported(e.to_string())
}

fn open(path: &Path) -> Result<std::fs::File> {
    std::fs::File::open(path).map_err(|e| IoError::Open { path: path.to_path_buf(), source: e })
}

fn read_vorbis(path: &Path) -> Result<Option<lofty::ogg::tag::VorbisComments>> {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile;
    let mut f = open(path)?;
    let opts = ParseOptions::new().read_properties(false);
    Ok(match kind(path) {
        "flac" => lofty::flac::FlacFile::read_from(&mut f, opts).map_err(bad)?.vorbis_comments().cloned(),
        "ogg" => Some(lofty::ogg::VorbisFile::read_from(&mut f, opts).map_err(bad)?.vorbis_comments().clone()),
        _ => None,
    })
}

fn read_id3(path: &Path) -> Result<Option<lofty::id3::v2::Id3v2Tag>> {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile;
    let mut f = open(path)?;
    let opts = ParseOptions::new().read_properties(false);
    Ok(match kind(path) {
        "mp3" => lofty::mpeg::MpegFile::read_from(&mut f, opts).map_err(bad)?.id3v2().cloned(),
        "wav" => lofty::iff::wav::WavFile::read_from(&mut f, opts).map_err(bad)?.id3v2().cloned(),
        "aiff" => lofty::iff::aiff::AiffFile::read_from(&mut f, opts).map_err(bad)?.id3v2().cloned(),
        _ => None,
    })
}

fn geob(tag: &lofty::id3::v2::Id3v2Tag, name: &str) -> Option<Vec<u8>> {
    use lofty::id3::v2::{Frame, FrameFlags, GeneralEncapsulatedObject};
    tag.into_iter().find_map(|f| match f {
        Frame::Binary(b) if f.id_str() == "GEOB" => GeneralEncapsulatedObject::parse(&b.data, FrameFlags::default())
            .ok()
            .filter(|g| g.descriptor.as_deref() == Some(name))
            .map(|g| g.data),
        _ => None,
    })
}

/// A Vorbis comment value: base64 of the mime type, the name and the body.
fn vorbis_body(value: &str, name: &str) -> Option<Vec<u8>> {
    let raw = base64_decode(value.as_bytes());
    let head = format!("{MIME}\0\0{name}\0");
    raw.strip_prefix(head.as_bytes()).map(<[u8]>::to_vec)
}

fn vorbis_value(body: &[u8], name: &str) -> String {
    let mut raw = format!("{MIME}\0\0{name}\0").into_bytes();
    raw.extend_from_slice(body);
    String::from_utf8(base64_encode(&raw, 0)).unwrap_or_default()
}

/// Reads Serato's cues, loops and beat grid from a file. Files Serato never touched (or
/// formats it does not tag this way) give an empty result.
pub fn read_serato(path: &Path) -> Result<SeratoData> {
    let mut out = SeratoData::default();
    match kind(path) {
        "mp3" | "wav" | "aiff" => {
            if let Some(tag) = read_id3(path)? {
                out.markers = geob(&tag, MARKERS2).and_then(|d| parse_markers2(&d));
                out.grid = geob(&tag, BEATGRID).and_then(|d| parse_beatgrid(&d));
            }
        }
        "flac" | "ogg" => {
            if let Some(tag) = read_vorbis(path)? {
                let get = |key: &str| tag.get(key).map(str::to_string);
                out.markers =
                    get("SERATO_MARKERS_V2").and_then(|v| vorbis_body(&v, MARKERS2)).and_then(|d| parse_markers2(&d));
                out.grid =
                    get("SERATO_BEATGRID").and_then(|v| vorbis_body(&v, BEATGRID)).and_then(|d| parse_beatgrid(&d));
            }
        }
        _ => {}
    }
    Ok(out)
}

/// Writes cues, loops and a beat grid into a file the way Serato keeps them, replacing
/// any Serato markers there. Other tags and the audio are left alone.
pub fn write_serato(path: &Path, data: &SeratoData) -> Result<()> {
    use lofty::config::WriteOptions;
    use lofty::tag::TagExt;
    match kind(path) {
        "mp3" | "wav" | "aiff" => {
            use lofty::TextEncoding;
            use lofty::id3::v2::{BinaryFrame, Frame, FrameFlags, FrameId, GeneralEncapsulatedObject, Id3v2Tag};
            let old = read_id3(path)?.unwrap_or_else(Id3v2Tag::new);
            // Keep every frame except Serato's own objects, then add the new ones.
            let mut tag = Id3v2Tag::new();
            for f in old {
                let ours = match &f {
                    Frame::Binary(b) if f.id_str() == "GEOB" => {
                        GeneralEncapsulatedObject::parse(&b.data, FrameFlags::default())
                            .ok()
                            .is_some_and(|g| matches!(g.descriptor.as_deref(), Some(MARKERS2 | BEATGRID)))
                    }
                    _ => false,
                };
                if !ours {
                    tag.insert(f);
                }
            }
            let mut add = |name: &str, body: Vec<u8>| -> Result<()> {
                let g = GeneralEncapsulatedObject::new(
                    TextEncoding::Latin1,
                    Some(MIME.into()),
                    Some(String::new()),
                    Some(name.into()),
                    body,
                );
                let bytes = g.as_bytes(WriteOptions::default()).map_err(bad)?;
                tag.insert(Frame::Binary(BinaryFrame::new(FrameId::Valid("GEOB".into()), bytes)));
                Ok(())
            };
            if let Some(m) = &data.markers {
                add(MARKERS2, encode_markers2(m))?;
            }
            if let Some(g) = data.grid.as_ref().filter(|g| !g.is_empty()) {
                add(BEATGRID, encode_beatgrid(g))?;
            }
            tag.save_to_path(path, WriteOptions::default()).map_err(bad)?;
        }
        "flac" | "ogg" => {
            let mut tag = read_vorbis(path)?.unwrap_or_default();
            for (key, name, body) in [
                ("SERATO_MARKERS_V2", MARKERS2, data.markers.as_ref().map(encode_markers2)),
                ("SERATO_BEATGRID", BEATGRID, data.grid.as_ref().filter(|g| !g.is_empty()).map(|g| encode_beatgrid(g))),
            ] {
                let _ = tag.remove(key).count();
                if let Some(b) = body {
                    tag.insert(key.to_string(), vorbis_value(&b, name));
                }
            }
            tag.save_to_path(path, WriteOptions::default()).map_err(bad)?;
        }
        _ => return Err(bad("Serato keeps cues only in MP3, WAV, AIFF, FLAC and Ogg files")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        for n in 0..20 {
            let d: Vec<u8> = (0..n as u8).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(base64_decode(&base64_encode(&d, 7)), d);
        }
        assert_eq!(base64_encode(b"Man", 0), b"TWFu");
        assert_eq!(base64_decode(b"TWE"), b"Ma", "padding may be missing");
    }

    #[test]
    fn markers_and_grids_round_trip() {
        let m = SeratoMarkers {
            cues: vec![
                SeratoCue { index: 0, ms: 250, color: 0xCC0000, name: "Intro".into() },
                SeratoCue { index: 3, ms: 61_934, color: 0x00CC00, name: String::new() },
            ],
            loops: vec![SeratoLoop {
                index: 0,
                start_ms: 30_000,
                end_ms: 37_742,
                locked: false,
                name: "Groove".into(),
            }],
            color: Some(0x99FF99),
            bpm_lock: true,
        };
        assert_eq!(parse_markers2(&encode_markers2(&m)), Some(m));
        let g = vec![
            SeratoGridMarker { seconds: 0.1, bpm: 124.0 },
            SeratoGridMarker { seconds: 0.1 + 64.0 * 60.0 / 124.0, bpm: 126.0 },
        ];
        let back = parse_beatgrid(&encode_beatgrid(&g)).unwrap();
        assert_eq!(back.len(), 2);
        for (a, b) in g.iter().zip(&back) {
            assert!((a.seconds - b.seconds).abs() < 1e-5 && (a.bpm - b.bpm).abs() < 1e-3, "{a:?} {b:?}");
        }
    }
}
