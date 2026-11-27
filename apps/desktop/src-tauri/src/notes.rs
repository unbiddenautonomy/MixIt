//! Sound to notes: the note listener (Basic Pitch, downloaded once, 230 KB) hears which
//! notes a pad's sound plays, so the sequencer can play them back on any pad (the UI
//! turns the notes into steps and pitches).

use serde::Serialize;
use tauri::AppHandle;

/// A note heard: when (s), how long (s), which key (MIDI number) and how clearly (0–1).
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteDto {
    pub start: f64,
    pub length: f64,
    pub pitch: u8,
    pub strength: f32,
}

/// What a pad's sound was heard to play.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PadNotes {
    pub notes: Vec<NoteDto>,
    /// The sound's length (s) and tempo, if known (a loop's).
    pub seconds: f64,
    pub bpm: Option<f64>,
}

#[tauri::command]
pub async fn pad_notes(app: AppHandle, pad: usize) -> Result<PadNotes, String> {
    tauri::async_runtime::spawn_blocking(move || hear_pad(&app, pad)).await.map_err(|e| e.to_string())?
}

#[cfg(feature = "sound-to-notes")]
fn hear_pad(app: &AppHandle, pad: usize) -> Result<PadNotes, String> {
    use mixit_ml::models::{BASIC_PITCH, ModelStore};
    use mixit_ml::notes::{BasicPitch, RATE, hear};
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    if !state.settings.lock().sound_to_notes {
        return Err("Sound to notes is off in Settings".into());
    }
    let src = state.pads.lock().get(pad).map(|p| p.source.clone()).ok_or_else(|| format!("no pad {}", pad + 1))?;
    let (audio, _, bpm) = crate::sampler::decode(&state, &src, RATE)?;
    let store = ModelStore::new(&state.paths.models);
    store.fetch(&BASIC_PITCH, |_| true).map_err(|e| format!("Could not get the note listener: {e}"))?;
    let mut model = BasicPitch::load(&store.path(&BASIC_PITCH)).map_err(|e| e.to_string())?;
    let notes = hear(&mut model, RATE, &audio, |_| true).map_err(|e| e.to_string())?;
    Ok(PadNotes {
        notes: notes
            .into_iter()
            .map(|n| NoteDto { start: n.start, length: n.length, pitch: n.pitch, strength: n.strength })
            .collect(),
        seconds: audio.len() as f64 / 2.0 / RATE as f64,
        bpm,
    })
}

#[cfg(not(feature = "sound-to-notes"))]
fn hear_pad(_app: &AppHandle, _pad: usize) -> Result<PadNotes, String> {
    Err("This copy of MixIt was built without sound to notes".into())
}
