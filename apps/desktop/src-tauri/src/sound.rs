//! The sound editor's side of the backend. A sound (a pad, a mic take, a file or part of
//! a library track) is decoded once and kept here; the page sends its list of edits and
//! gets back a drawing of the result, the audio to listen to, or a saved file. The
//! original is never changed (see `mixit_dsp::edit`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use mixit_engine::view::{EditOpDto, SoundViewDto, edit_ops};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::sampler::PadSource;
use crate::state::AppState;

type R<T> = Result<T, String>;

struct Sound {
    audio: Arc<Vec<f32>>,
    sr: u32,
    opened: u32,
}

/// Sounds open in the editor; the oldest is dropped when more than a few are open.
fn sounds() -> &'static Mutex<HashMap<u32, Sound>> {
    static S: OnceLock<Mutex<HashMap<u32, Sound>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT: AtomicU32 = AtomicU32::new(1);
const KEEP: usize = 3;

fn get(id: u32) -> R<(Arc<Vec<f32>>, u32)> {
    sounds()
        .lock()
        .map_err(|_| "sound store poisoned".to_string())?
        .get(&id)
        .map(|s| (s.audio.clone(), s.sr))
        .ok_or_else(|| "that sound is no longer open: open it again".into())
}

fn edited(id: u32, ops: &[EditOpDto]) -> R<(Vec<f32>, u32)> {
    let (a, sr) = get(id)?;
    Ok((mixit_dsp::edit::apply(&a, sr, &edit_ops(ops)), sr))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundOpened {
    pub id: u32,
    pub name: String,
    pub view: SoundViewDto,
}

/// Opens a sound for editing (any pad source: a kit sound, a file, a library track or a
/// slice of one).
#[tauri::command]
pub async fn sound_open(app: AppHandle, source: PadSource, bins: usize) -> R<SoundOpened> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let sr = state.audio.lock().sample_rate;
        let (audio, name, _) = crate::sampler::decode(&state, &source, sr)?;
        if audio.is_empty() {
            return Err("the sound is empty".into());
        }
        let view = SoundViewDto::new(&audio, sr, bins);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut all = sounds().lock().map_err(|_| "sound store poisoned")?;
        while all.len() >= KEEP {
            let Some(old) = all.iter().min_by_key(|(_, s)| s.opened).map(|(k, _)| *k) else { break };
            all.remove(&old);
        }
        all.insert(id, Sound { audio: Arc::new(audio), sr, opened: id });
        Ok(SoundOpened { id, name, view })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The sound after `ops`, summarised for drawing.
#[tauri::command]
pub async fn sound_render(id: u32, ops: Vec<EditOpDto>, bins: usize) -> R<SoundViewDto> {
    tauri::async_runtime::spawn_blocking(move || {
        let (a, sr) = edited(id, &ops)?;
        Ok(SoundViewDto::new(&a, sr, bins))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The sound after `ops` as a 16-bit WAV, for listening in the editor.
#[tauri::command]
pub async fn sound_audio(id: u32, ops: Vec<EditOpDto>) -> R<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let (a, sr) = edited(id, &ops)?;
        Ok(tauri::ipc::Response::new(wav16(&a, sr)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the edited sound as a new WAV file (32-bit float, nothing lost) in the
/// recordings folder's "Edits" folder and returns its path. The original stays as it was.
#[tauri::command]
pub async fn sound_save(app: AppHandle, id: u32, ops: Vec<EditOpDto>, name: String) -> R<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (a, sr) = edited(id, &ops)?;
        if a.is_empty() {
            return Err("nothing is left of the sound".into());
        }
        let dir = app.state::<AppState>().paths.recordings.join("Edits");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = unique(&dir, &safe_name(&name));
        mixit_io::write_wav(&path, &a, 2, sr, mixit_io::WavDepth::Float32).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sound_close(id: u32) {
    if let Ok(mut all) = sounds().lock() {
        all.remove(&id);
    }
}

fn safe_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || " -_()".contains(c) { c } else { '_' }).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "Edited sound".into() } else { s.chars().take(80).collect() }
}

/// `dir/name.wav`, or `dir/name 2.wav` and so on when taken.
fn unique(dir: &std::path::Path, name: &str) -> PathBuf {
    let mut p = dir.join(format!("{name}.wav"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{name} {n}.wav"));
        n += 1;
    }
    p
}

/// Interleaved stereo as a 16-bit PCM WAV file in memory.
pub fn wav16(a: &[f32], sr: u32) -> Vec<u8> {
    let data = (a.len() * 2) as u32;
    let mut v = Vec::with_capacity(44 + data as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&2u16.to_le_bytes());
    v.extend_from_slice(&sr.to_le_bytes());
    v.extend_from_slice(&(sr * 4).to_le_bytes());
    v.extend_from_slice(&4u16.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data.to_le_bytes());
    for x in a {
        v.extend_from_slice(&((x.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_bytes_decode_back() {
        let a: Vec<f32> = (0..2000).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        let dir = std::env::temp_dir().join(format!("mixit-sound-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.wav");
        std::fs::write(&p, wav16(&a, 48_000)).unwrap();
        let d = mixit_io::decode_file(&p).unwrap();
        assert_eq!(d.sample_rate, 48_000);
        assert_eq!(d.frames(), 1000);
        assert!((d.data[10] - a[10]).abs() < 1e-3);
        assert_eq!(unique(&dir, "t"), dir.join("t 2.wav"));
        assert_eq!(safe_name("a/b:c"), "a_b_c");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
