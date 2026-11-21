//! The sampler pads as the app knows them: what each pad holds and its settings, saved in
//! the library's settings table and loaded into the engine at start-up and after an audio
//! restart. Pads can hold a sound from the built-in kit, an audio file, or a slice of a
//! library track (a captured loop).

use std::path::Path;
use std::sync::Arc;

use mixit_engine::{Command, PadMode, SamplerCommand, TrackAudio};
use mixit_generator::kit::{KIT, kit_sound, kit_sound_info};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

pub const PADS: usize = 8;

/// Where a pad's sound comes from.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum PadSource {
    #[default]
    Empty,
    Kit {
        id: String,
    },
    File {
        path: String,
    },
    /// `seconds` of a library track from `start` (seconds), or all of it.
    Track {
        track_id: i64,
        start: Option<f64>,
        seconds: Option<f64>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PadInfo {
    pub pad: usize,
    pub name: String,
    pub source: PadSource,
    /// Length of the loaded sound (0 until loaded).
    pub seconds: f64,
    /// Tempo of the sound, so looped pads can follow the master tempo.
    pub bpm: Option<f64>,
    /// 0 one-shot, 1 gate, 2 loop.
    pub mode: usize,
    pub gain_db: f32,
    pub pan: f32,
    pub sync: bool,
    pub quantized: bool,
    pub color: u32,
    /// Set when the sound could not be loaded (file moved, decode failed).
    pub error: Option<String>,
}

impl Default for PadInfo {
    fn default() -> Self {
        PadInfo {
            pad: 0,
            name: String::new(),
            source: PadSource::Empty,
            seconds: 0.0,
            bpm: None,
            mode: 0,
            gain_db: 0.0,
            pan: 0.0,
            sync: true,
            quantized: false,
            color: 0x52525B,
            error: None,
        }
    }
}

impl PadInfo {
    fn kit(pad: usize, id: &str) -> PadInfo {
        let k = kit_sound_info(id).expect("kit id");
        PadInfo {
            pad,
            name: k.name.into(),
            source: PadSource::Kit { id: id.into() },
            bpm: k.bpm,
            mode: k.mode,
            color: k.color,
            ..Default::default()
        }
    }
}

/// Changes to a pad's settings; absent fields stay as they are.
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PadPatch {
    pub name: Option<String>,
    pub mode: Option<usize>,
    pub gain_db: Option<f32>,
    pub pan: Option<f32>,
    pub sync: Option<bool>,
    pub quantized: Option<bool>,
    pub color: Option<u32>,
    /// `Some(0.0)` clears the tempo.
    pub bpm: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KitSoundDto {
    pub id: &'static str,
    pub name: &'static str,
    pub bpm: Option<f64>,
    pub mode: usize,
    pub color: u32,
}

pub fn kit_list() -> Vec<KitSoundDto> {
    KIT.iter().map(|k| KitSoundDto { id: k.id, name: k.name, bpm: k.bpm, mode: k.mode, color: k.color }).collect()
}

/// The pads a new install starts with.
pub fn default_pads() -> Vec<PadInfo> {
    ["air_horn", "siren", "riser", "impact", "kick", "clap", "laser", "drum_loop"]
        .iter()
        .enumerate()
        .map(|(i, id)| PadInfo::kit(i, id))
        .collect()
}

pub fn load_saved(lib: &mixit_library::Library) -> Vec<PadInfo> {
    let mut pads: Vec<PadInfo> =
        lib.setting("sampler").ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(default_pads);
    pads.resize_with(PADS, Default::default);
    for (i, p) in pads.iter_mut().enumerate() {
        p.pad = i;
    }
    pads
}

pub fn save(state: &AppState) {
    let pads = state.pads.lock().clone();
    if let Ok(s) = serde_json::to_string(&pads) {
        let _ = state.library.lock().set_setting("sampler", &s);
    }
}

fn mode(m: usize) -> PadMode {
    [PadMode::OneShot, PadMode::Gate, PadMode::Loop][m.min(2)]
}

/// Decodes a pad's sound at the engine's sample rate. Returns interleaved stereo, the
/// display name for new sounds and the tempo if known.
pub fn decode(state: &AppState, src: &PadSource, sr: u32) -> Result<(Vec<f32>, String, Option<f64>), String> {
    match src {
        PadSource::Empty => Err("empty pad".into()),
        PadSource::Kit { id } => {
            let k = kit_sound_info(id).ok_or_else(|| format!("no kit sound {id}"))?;
            Ok((kit_sound(id, sr).unwrap_or_default(), k.name.into(), k.bpm))
        }
        PadSource::File { path } => {
            let p = Path::new(path);
            let cache = mixit_io::DecodeCache::new(&state.paths.cache).ok();
            let t = mixit_io::load_track(p, sr, cache.as_ref()).map_err(|e| e.to_string())?;
            let name = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            // Long files are probably loops or tracks: estimate a tempo so sync works.
            let secs = t.frames() as f64 / sr as f64;
            let bpm = (secs > 4.0).then(|| analyse_bpm(&t.data, sr)).flatten();
            Ok((t.data, name, bpm))
        }
        PadSource::Track { track_id, start, seconds } => {
            let (track, bpm) = {
                let lib = state.library.lock();
                let t = lib.track(*track_id).map_err(|e| e.to_string())?;
                let bpm = t.bpm.or(lib.analysis(*track_id).ok().flatten().map(|a| a.bpm));
                (t, bpm)
            };
            let cache = mixit_io::DecodeCache::new(&state.paths.cache).ok();
            let t = mixit_io::load_track(&track.path, sr, cache.as_ref()).map_err(|e| e.to_string())?;
            let frames = t.frames();
            let a = ((start.unwrap_or(0.0).max(0.0) * sr as f64) as usize).min(frames);
            let b = seconds.map(|s| a + (s.max(0.0) * sr as f64).round() as usize).unwrap_or(frames).min(frames);
            if b <= a {
                return Err("the slice is empty".into());
            }
            let name = if start.is_some() { format!("{} (loop)", track.title) } else { track.title.clone() };
            Ok((t.data[a * 2..b * 2].to_vec(), name, bpm))
        }
    }
}

fn analyse_bpm(data: &[f32], sr: u32) -> Option<f64> {
    let a = mixit_analysis::analyze(data, sr, &mixit_analysis::AnalysisOptions::default());
    (a.bpm > 40.0).then_some(a.bpm)
}

/// Sends a pad's settings (not its audio) to the engine.
fn send_settings(state: &AppState, p: &PadInfo) {
    let mut a = state.audio.lock();
    a.send(Command::Sampler(SamplerCommand::SetMode(p.pad, mode(p.mode))));
    a.send(Command::Sampler(SamplerCommand::SetGainDb(p.pad, p.gain_db)));
    a.send(Command::Sampler(SamplerCommand::SetPan(p.pad, p.pan)));
    a.send(Command::Sampler(SamplerCommand::SetSync(p.pad, p.sync)));
    a.send(Command::Sampler(SamplerCommand::SetQuantized(p.pad, p.quantized)));
}

/// Loads `src` onto `pad`. With `keep_settings`, only the audio changes (start-up and
/// audio restarts); otherwise the pad takes the new sound's name, tempo and defaults.
pub fn load(state: &AppState, pad: usize, src: PadSource, keep_settings: bool) -> Result<PadInfo, String> {
    if pad >= PADS {
        return Err(format!("no pad {}", pad + 1));
    }
    let sr = state.audio.lock().sample_rate;
    if src == PadSource::Empty {
        return clear(state, pad);
    }
    let decoded = decode(state, &src, sr);
    let mut pads = state.pads.lock();
    let p = &mut pads[pad];
    match decoded {
        Ok((data, name, bpm)) => {
            if !keep_settings {
                let old = p.clone();
                *p = match &src {
                    PadSource::Kit { id } => PadInfo::kit(pad, id),
                    _ => PadInfo { pad, name, bpm, color: old.color, ..Default::default() },
                };
                if let PadSource::Track { start: Some(_), .. } = src {
                    p.mode = 2;
                }
                p.gain_db = old.gain_db;
            }
            p.source = src;
            p.seconds = data.len() as f64 / 2.0 / sr as f64;
            p.error = None;
            let info = p.clone();
            drop(pads);
            let audio = Arc::new(TrackAudio::new(sr, data));
            state.audio.lock().send(Command::Sampler(SamplerCommand::Load { pad, audio, bpm: info.bpm }));
            send_settings(state, &info);
            Ok(info)
        }
        Err(e) => {
            if keep_settings {
                p.error = Some(e.clone());
            }
            Err(e)
        }
    }
}

pub fn clear(state: &AppState, pad: usize) -> Result<PadInfo, String> {
    let info = {
        let mut pads = state.pads.lock();
        let p = pads.get_mut(pad).ok_or_else(|| format!("no pad {}", pad + 1))?;
        *p = PadInfo { pad, ..Default::default() };
        p.clone()
    };
    state.audio.lock().send(Command::Sampler(SamplerCommand::Unload(pad)));
    Ok(info)
}

pub fn patch(state: &AppState, pad: usize, patch: PadPatch) -> Result<PadInfo, String> {
    let (info, bpm_changed) = {
        let mut pads = state.pads.lock();
        let p = pads.get_mut(pad).ok_or_else(|| format!("no pad {}", pad + 1))?;
        if let Some(v) = patch.name {
            p.name = v;
        }
        if let Some(v) = patch.mode {
            p.mode = v.min(2);
        }
        if let Some(v) = patch.gain_db {
            p.gain_db = v.clamp(-60.0, 12.0);
        }
        if let Some(v) = patch.pan {
            p.pan = v.clamp(-1.0, 1.0);
        }
        if let Some(v) = patch.sync {
            p.sync = v;
        }
        if let Some(v) = patch.quantized {
            p.quantized = v;
        }
        if let Some(v) = patch.color {
            p.color = v & 0xFF_FFFF;
        }
        let bpm_changed = patch.bpm.is_some();
        if let Some(v) = patch.bpm {
            p.bpm = (v > 0.0).then_some(v.clamp(40.0, 300.0));
        }
        (p.clone(), bpm_changed)
    };
    if bpm_changed && info.source != PadSource::Empty {
        // The tempo travels with the audio, so reload it.
        return load(state, pad, info.source.clone(), true);
    }
    send_settings(state, &info);
    Ok(info)
}

/// Loads every pad's sound into the engine (start-up, audio restart).
pub fn load_all(state: &AppState) {
    let pads = state.pads.lock().clone();
    for p in pads {
        if p.source != PadSource::Empty {
            let _ = load(state, p.pad, p.source.clone(), true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_kit_sounds() {
        let pads = default_pads();
        assert_eq!(pads.len(), PADS);
        for (i, p) in pads.iter().enumerate() {
            assert_eq!(p.pad, i);
            assert!(matches!(p.source, PadSource::Kit { .. }));
            assert!(!p.name.is_empty());
        }
        assert_eq!(pads[7].mode, 2, "the drum loop loops");
    }

    #[test]
    fn source_json_shape() {
        let s = serde_json::to_string(&PadSource::Track { track_id: 3, start: Some(1.5), seconds: None }).unwrap();
        assert_eq!(s, r#"{"type":"track","trackId":3,"start":1.5,"seconds":null}"#);
        let k: PadSource = serde_json::from_str(r#"{"type":"kit","id":"clap"}"#).unwrap();
        assert_eq!(k, PadSource::Kit { id: "clap".into() });
    }
}
