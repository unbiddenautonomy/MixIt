//! The beat helper: after analysis, a trained beat tracker (Beat This!) listens to the
//! tracks whose grid the analysis wasn't sure of. Where it hears the beats or bars
//! somewhere else, the library keeps its grid, and the deck offers it: use it, or keep
//! the one there is. Nothing changes on its own.
//!
//! Everything here is optional: without the `beat-helper` feature, or with the setting
//! off, nothing is downloaded or heard, and the analysis's grid is all there is.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;
use mixit_library::Library;

type R<T> = Result<T, String>;

/// Grids the analysis is less sure of than this get a second opinion.
pub const UNSURE: f32 = 0.6;
/// The helper's own grid must fit its beats at least this well to be offered.
const SURE_ENOUGH: f32 = 0.8;

/// The helper's grid, as the deck offers it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSuggestion {
    /// What it hears differently, in plain words ("a different tempo").
    pub why: String,
    pub bpm: f64,
    pub beats_per_bar: u32,
}

/// The helper's grid for a track, if one is waiting to be used or dismissed.
pub fn suggestion(lib: &Library, track: i64) -> Option<GridSuggestion> {
    let (g, why) = lib.grid_suggestion(track).ok()??;
    Some(GridSuggestion { why, bpm: g.bpm, beats_per_bar: g.beats_per_bar })
}

#[cfg(feature = "beat-helper")]
mod imp {
    use std::sync::atomic::Ordering;

    use mixit_analysis::heard::{grid_from_beats, grids_differ, renumber_near};
    use mixit_ml::beats::{BeatThis, MODEL_ID, RATE, hear};
    use mixit_ml::models::{BEAT_THIS, ModelStore};
    use tauri::Manager;

    use super::*;

    pub fn help_all(app: &AppHandle, lib: &Library, progress: &dyn Fn(usize, usize, String)) -> R<String> {
        let state = app.state::<AppState>();
        if !state.settings.lock().beat_helper {
            return Ok(String::new());
        }
        let todo = lib.unsure_grids(MODEL_ID, UNSURE).map_err(|e| e.to_string())?;
        if todo.is_empty() {
            return Ok(String::new());
        }
        let store = ModelStore::new(&state.paths.models);
        let mb = BEAT_THIS.bytes / 1_000_000;
        store
            .fetch(&BEAT_THIS, |p| {
                progress(
                    (p as f64 * mb as f64) as usize,
                    mb as usize,
                    format!("Getting the beat helper ({mb} MB, only the first time)"),
                );
                !state.job_cancel.load(Ordering::Relaxed)
            })
            .map_err(|e| e.to_string())?;
        let mut model = BeatThis::load(&store.path(&BEAT_THIS)).map_err(|e| e.to_string())?;
        let cache = mixit_io::DecodeCache::new(&state.paths.cache).ok();
        let (mut offered, mut failed) = (0, 0);
        for (i, t) in todo.iter().enumerate() {
            if state.job_cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            progress(i, todo.len(), format!("Checking the beat of {} of {}", i + 1, todo.len()));
            let Ok(Some(own)) = lib.analysis(t.id) else { continue };
            let heard = mixit_io::load_track(&t.path, RATE, cache.as_ref()).map_err(|e| e.to_string()).and_then(|a| {
                hear(&mut model, a.sample_rate, &a.data, |_| !state.job_cancel.load(Ordering::Relaxed))
                    .map_err(|e| e.to_string())
            });
            let Ok(h) = heard else {
                failed += 1;
                continue;
            };
            let found = grid_from_beats(&h.beats, &h.downbeats, own.grid.sample_rate, true, own.grid.phrase_bars)
                .filter(|g| g.confidence >= SURE_ENOUGH)
                .and_then(|mut g| {
                    renumber_near(&mut g, own.grid.frame_at(0.0));
                    let why = grids_differ(&own.grid, &g, own.audible)?;
                    Some((g, why))
                });
            if lib.save_grid_suggestion(t.id, MODEL_ID, found.as_ref().map(|(g, w)| (g, *w))).is_ok() && found.is_some()
            {
                offered += 1;
            }
        }
        Ok(match (offered, failed) {
            (0, 0) => String::new(),
            (n, 0) => format!("The beat helper has another grid for {n} {}", if n == 1 { "track" } else { "tracks" }),
            (n, f) => format!("The beat helper has another grid for {n} tracks ({f} couldn't be heard)"),
        })
    }
}

#[cfg(not(feature = "beat-helper"))]
mod imp {
    use super::*;

    pub fn help_all(_app: &AppHandle, _lib: &Library, _progress: &dyn Fn(usize, usize, String)) -> R<String> {
        Ok(String::new())
    }
}

/// Lets the beat helper check the tracks the analysis wasn't sure of (downloading it the
/// first time). Runs inside a library job; returns what it did, empty when nothing.
pub fn help_all(app: &AppHandle, lib: &Library, progress: &dyn Fn(usize, usize, String)) -> R<String> {
    imp::help_all(app, lib, progress)
}

/// Uses the beat helper's grid for the track on a deck (`use_it`), or keeps the one
/// there is; either way it isn't offered again.
#[tauri::command]
pub fn grid_suggestion_use(app: AppHandle, state: State<'_, AppState>, deck: u8, use_it: bool) -> R<()> {
    let deck = deck as usize;
    let track =
        state.decks.lock().get(deck).and_then(|d| d.as_ref()).map(|d| d.track_id).ok_or("no track on this deck")?;
    let found = state.library.lock().grid_suggestion(track).map_err(|e| e.to_string())?;
    if let (true, Some((grid, _))) = (use_it, found) {
        crate::commands::replace_grid(&state, deck, grid)?;
    }
    state.library.lock().dismiss_grid_suggestion(track).map_err(|e| e.to_string())?;
    let info = crate::commands::refresh_detail(&state, deck)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

/// Drops the person's grid edits on a deck's track: the analysis's grid again.
#[tauri::command]
pub fn grid_reset(app: AppHandle, state: State<'_, AppState>, deck: u8) -> R<()> {
    let deck = deck as usize;
    let track =
        state.decks.lock().get(deck).and_then(|d| d.as_ref()).map(|d| d.track_id).ok_or("no track on this deck")?;
    let analysed = {
        let lib = state.library.lock();
        lib.reset_grid(track).map_err(|e| e.to_string())?;
        lib.grid(track).map_err(|e| e.to_string())?.ok_or("this track has no analysed grid")?
    };
    crate::commands::replace_grid_unsaved(&state, deck, analysed)?;
    let info = crate::commands::refresh_detail(&state, deck)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}
