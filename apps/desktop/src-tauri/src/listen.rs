//! Search by sound: the trained listener (CLAP) hears each track once, after analysis,
//! and the library keeps what it heard. A description typed into the search is read by
//! the listener's describer and matched against that. Both models are downloaded once,
//! the first time they are needed, and the describer stays loaded after its first use.
//!
//! Everything here is optional: without the `sound-search` feature, or with the setting
//! off, nothing is downloaded or heard, "sounds like" uses the analysis's own profile and
//! searching by description says why it can't.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::SoundMatch;
use crate::dto::TrackRow;
use crate::state::AppState;
use mixit_library::Library;

type R<T> = Result<T, String>;

/// Where search by sound stands, for the library.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSearchStatus {
    /// This build can search by sound and the setting is on.
    pub available: bool,
    /// Tracks the listener has heard.
    pub heard: usize,
    /// Tracks whose files are there.
    pub total: usize,
}

#[cfg(feature = "sound-search")]
mod imp {
    use std::sync::atomic::Ordering;

    use mixit_ml::models::{CLAP_AUDIO, CLAP_TEXT, CLAP_TOKENIZER, ModelInfo, ModelStore};
    use mixit_ml::sound::{Clap, MODEL_ID, RATE, embed_track};
    use tauri::Manager;

    use super::*;

    fn fetch_all(state: &AppState, progress: &dyn Fn(usize, usize, String)) -> R<()> {
        let store = ModelStore::new(&state.paths.models);
        let parts: [&ModelInfo; 3] = [&CLAP_AUDIO, &CLAP_TEXT, &CLAP_TOKENIZER];
        let total: u64 = parts.iter().map(|m| m.bytes).sum();
        let mut before = 0u64;
        for m in parts {
            store
                .fetch(m, |p| {
                    let got = before + (p as f64 * m.bytes as f64) as u64;
                    progress(
                        (got / 1_000_000) as usize,
                        (total / 1_000_000) as usize,
                        format!("Getting the sound listener ({} MB, only the first time)", total / 1_000_000),
                    );
                    !state.job_cancel.load(Ordering::Relaxed)
                })
                .map_err(|e| e.to_string())?;
            before += m.bytes;
        }
        Ok(())
    }

    pub fn listen_all(app: &AppHandle, lib: &Library, progress: &dyn Fn(usize, usize, String)) -> R<String> {
        let state = app.state::<AppState>();
        if !state.settings.lock().sound_search {
            return Ok(String::new());
        }
        let todo = lib.unheard(MODEL_ID).map_err(|e| e.to_string())?;
        if todo.is_empty() {
            return Ok(String::new());
        }
        fetch_all(&state, progress)?;
        let store = ModelStore::new(&state.paths.models);
        let mut clap = Clap::load(&store.path(&CLAP_AUDIO), None).map_err(|e| e.to_string())?;
        let cache = mixit_io::DecodeCache::new(&state.paths.cache).ok();
        let (mut heard, mut failed) = (0, 0);
        for (i, t) in todo.iter().enumerate() {
            if state.job_cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            progress(i, todo.len(), format!("Listening to {} of {}", i + 1, todo.len()));
            let done = mixit_io::load_track(&t.path, RATE, cache.as_ref())
                .map_err(|e| e.to_string())
                .and_then(|a| embed_track(&mut clap, a.sample_rate, &a.data).map_err(|e| e.to_string()))
                .and_then(|v| lib.save_embedding(t.id, MODEL_ID, &v).map_err(|e| e.to_string()));
            match done {
                Ok(()) => heard += 1,
                Err(_) => failed += 1,
            }
        }
        Ok(format!(
            "Listened to {heard} tracks{}",
            if failed > 0 { format!(" ({failed} couldn't be heard)") } else { String::new() }
        ))
    }

    pub fn describe(state: &AppState, text: &str) -> R<Vec<f32>> {
        let store = ModelStore::new(&state.paths.models);
        let mut slot = state.describer.lock();
        if slot.is_none() {
            let (Some(audio), Some(model), Some(words)) =
                (store.get(&CLAP_AUDIO), store.get(&CLAP_TEXT), store.get(&CLAP_TOKENIZER))
            else {
                return Err(
                    "MixIt hasn't listened to your tracks yet. Analyse them first: it listens right after.".into()
                );
            };
            *slot = Some(Clap::load(&audio, Some((&model, &words))).map_err(|e| e.to_string())?);
        }
        slot.as_mut().expect("loaded above").embed_text(text).map_err(|e| e.to_string())
    }

    pub const MODEL: &str = MODEL_ID;
}

#[cfg(not(feature = "sound-search"))]
mod imp {
    use super::*;

    pub fn listen_all(_app: &AppHandle, _lib: &Library, _progress: &dyn Fn(usize, usize, String)) -> R<String> {
        Ok(String::new())
    }

    pub fn describe(_state: &AppState, _text: &str) -> R<Vec<f32>> {
        Err("This build of MixIt can't search by sound.".into())
    }

    pub const MODEL: &str = "clap-ms-q8";
}

/// Lets the listener hear every track it hasn't yet (downloading it the first time).
/// Runs inside a library job; returns what it did, empty when there was nothing to do.
pub fn listen_all(app: &AppHandle, lib: &Library, progress: &dyn Fn(usize, usize, String)) -> R<String> {
    imp::listen_all(app, lib, progress)
}

/// Starts listening to the tracks not heard yet, as a library job.
#[tauri::command]
pub fn sound_listen(app: AppHandle) -> R<()> {
    crate::commands::spawn_library_job(app, "listen", |app, lib, progress| {
        let m = listen_all(app, lib, progress)?;
        Ok(if m.is_empty() { "Every track has been listened to".into() } else { m })
    })
}

/// Tracks that sound like a description ("dark rolling bass, big room"), best first.
#[tauri::command(async)]
pub fn sound_search(state: State<'_, AppState>, text: String, limit: Option<usize>) -> R<Vec<SoundMatch>> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(vec![]);
    }
    if !state.settings.lock().sound_search {
        return Err("Search by sound is turned off in Settings.".into());
    }
    let words = imp::describe(&state, text)?;
    let lib = state.library.lock();
    let found = lib.sounds_described(imp::MODEL, &words, limit.unwrap_or(60)).map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .filter_map(|(id, score)| lib.track(id).ok().map(|t| SoundMatch { track: TrackRow::from(&t), score }))
        .collect())
}

#[tauri::command]
pub fn sound_search_status(state: State<'_, AppState>) -> R<SoundSearchStatus> {
    let available = cfg!(feature = "sound-search") && state.settings.lock().sound_search;
    let lib = state.library.lock();
    let heard = lib.embeddings(imp::MODEL).map_err(|e| e.to_string())?.len();
    let total = lib.unheard(imp::MODEL).map_err(|e| e.to_string())?.len() + heard;
    Ok(SoundSearchStatus { available, heard, total })
}
