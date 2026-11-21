//! The commands the UI calls (`invoke("name", {...})`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use mixit_core::{DeckId, Key};
use mixit_engine::actions::{ActionError, ActionInput};
use mixit_engine::{
    Command, CueKind as EngineCue, DeckCommand, DeckTrack, HotCue, PreviewCommand, PreviewRoute, TrackAudio,
};
use mixit_library::suggest::{EnergyDirection, SuggestOptions};
use mixit_library::{Cue, CueKind, Library, PlaylistKind, TrackEdit};
use mixit_project::MixProject;
use mixit_project::automix::{AutomixOptions, TempoPolicy};
use mixit_project::transition::TransitionKind;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::{Audio, DECKS};
use crate::dto::*;
use crate::sampler::{PadInfo, PadPatch, PadSource};
use crate::state::{AppState, LoadedDeck, Recording, Settings};

type R<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn deck_id(deck: u8) -> R<DeckId> {
    if (deck as usize) < DECKS { Ok(DeckId(deck)) } else { Err(format!("no deck {deck}")) }
}

// ------------------------------------------------------------------------- app

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: &'static str,
    pub db_path: String,
    pub recordings_dir: String,
    pub projects_dir: String,
    pub audio: AudioStatus,
    pub settings: Settings,
    pub registry: Vec<mixit_core::actions::ActionSpec>,
    pub transitions: Vec<TransitionInfo>,
    pub fx_types: Vec<&'static str>,
    pub decks: Vec<Option<DeckInfo>>,
    pub kit: Vec<crate::sampler::KitSoundDto>,
    pub pads: Vec<crate::sampler::PadInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionInfo {
    pub id: String,
    pub name: &'static str,
    pub explain: &'static str,
    pub beats: f64,
}

fn transition_id(t: TransitionKind) -> String {
    format!("{t:?}").chars().enumerate().map(|(i, c)| if i == 0 { c.to_ascii_lowercase() } else { c }).collect()
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        db_path: state.paths.db.to_string_lossy().into_owned(),
        recordings_dir: state.paths.recordings.to_string_lossy().into_owned(),
        projects_dir: state.paths.projects.to_string_lossy().into_owned(),
        audio: state.audio.lock().status.clone(),
        settings: state.settings.lock().clone(),
        registry: mixit_core::actions::registry(DECKS, crate::sampler::PADS),
        transitions: TransitionKind::ALL
            .iter()
            .map(|&t| TransitionInfo {
                id: transition_id(t),
                name: t.name(),
                explain: t.explain(),
                beats: t.default_beats(),
            })
            .collect(),
        fx_types: mixit_core::actions::FX_TYPES.to_vec(),
        decks: state.decks.lock().iter().map(|d| d.as_ref().map(|d| d.info.clone())).collect(),
        kit: crate::sampler::kit_list(),
        pads: state.pads.lock().clone(),
    }
}

/// Runs a registry action. App-level actions the engine does not handle (key sync and
/// grid edits) are done here; `app.*` actions are the UI's and are accepted silently.
#[tauri::command]
pub fn action(app: AppHandle, state: State<'_, AppState>, id: String, input: ActionInput) -> R<()> {
    let res = state.audio.lock().dispatcher.dispatch(&id, input);
    match res {
        Ok(cmds) => {
            let mut a = state.audio.lock();
            for c in cmds {
                a.send(c);
            }
            Ok(())
        }
        Err(ActionError::NotEngine(_)) => {
            if !matches!(input, ActionInput::Press) {
                return Ok(());
            }
            let parts: Vec<&str> = id.split('.').collect();
            match parts.as_slice() {
                ["deck", d, "key_sync"] => key_sync(&state, deck_letter(d)?),
                ["deck", d, "grid", op] => grid_edit(&app, &state, deck_letter(d)?, op),
                _ => Ok(()),
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

/// A channel's (`channel` 0..3) or the master's (`None`) studio strip settings.
#[tauri::command]
pub fn studio_get(state: State<'_, AppState>, channel: Option<u8>) -> R<mixit_engine::view::StudioDto> {
    let a = state.audio.lock();
    Ok(mixit_engine::view::studio_dto(&a.dispatcher.studio(channel.map(usize::from))))
}

/// Replaces a channel's or the master's studio strip settings (detailed editor, presets).
#[tauri::command]
pub fn studio_set(state: State<'_, AppState>, channel: Option<u8>, settings: mixit_engine::view::StudioDto) -> R<()> {
    let s = mixit_engine::view::studio_settings(&settings);
    let mut a = state.audio.lock();
    let c = a.dispatcher.set_studio(channel.map(usize::from), s);
    a.send(c);
    Ok(())
}

/// Chooses what the spectrum analyser shows: "off", "master" or a channel number.
#[tauri::command]
pub fn scope_set(state: State<'_, AppState>, source: String) -> R<()> {
    use mixit_engine::ScopeSource;
    let src = match source.as_str() {
        "off" => ScopeSource::Off,
        "master" => ScopeSource::Master,
        n => ScopeSource::Channel(n.parse::<usize>().map_err(|_| "bad scope source")?.min(DECKS - 1)),
    };
    let mut a = state.audio.lock();
    a.scope = src;
    a.send(Command::Mixer(mixit_engine::MixerCommand::SetScope(src)));
    Ok(())
}

fn deck_letter(d: &str) -> R<usize> {
    let c = d.chars().next().ok_or("bad deck")?;
    let i = (c as u8).wrapping_sub(b'A') as usize;
    if i < DECKS { Ok(i) } else { Err(format!("no deck {d}")) }
}

/// Shifts this deck's key to the nearest one compatible with the master (or the other
/// playing deck).
fn key_sync(state: &AppState, deck: usize) -> R<()> {
    let tele = *state.audio.lock().ctl.telemetry();
    let decks = state.decks.lock();
    let mine = decks[deck].as_ref().and_then(|d| d.info.detail.key.as_ref()).map(|k| Key::from_index(k.index));
    let other = (0..DECKS)
        .filter(|&i| i != deck && tele.decks[i].loaded)
        .max_by_key(|&i| (tele.decks[i].master, tele.decks[i].playing))
        .and_then(|i| {
            let k = decks[i].as_ref()?.info.detail.key.as_ref()?;
            Some(Key::from_index(k.index).transposed(tele.decks[i].key_shift.round() as i32))
        });
    let (Some(mine), Some(target)) = (mine, other) else { return Err("both decks need an analysed key".into()) };
    let shift = mine.best_shift_to(target, 6).unwrap_or(0);
    drop(decks);
    let mut a = state.audio.lock();
    a.send(Command::Deck(DeckId(deck as u8), DeckCommand::SetKeylock(true)));
    a.send(Command::Deck(DeckId(deck as u8), DeckCommand::SetKeyShift(shift as f32)));
    Ok(())
}

fn grid_edit(app: &AppHandle, state: &AppState, deck: usize, op: &str) -> R<()> {
    let tele = *state.audio.lock().ctl.telemetry();
    let pos_frames = tele.decks[deck].position;
    let (track_id, grid) = {
        let mut decks = state.decks.lock();
        let d = decks[deck].as_mut().ok_or("no track on this deck")?;
        let engine_sr = d.sample_rate as f64;
        let g = &mut d.grid;
        if g.locked {
            return Err("The beat grid is locked. Unlock it in the track editor first.".into());
        }
        let gsr = g.sample_rate as f64;
        let at = pos_frames / engine_sr * gsr;
        match op {
            "set_downbeat" => g.set_downbeat(at),
            "halve" => g.scale_tempo(0.5).map_err(|e| format!("{e:?}"))?,
            "double" => g.scale_tempo(2.0).map_err(|e| format!("{e:?}"))?,
            "nudge_back" => g.nudge(-0.005 * gsr),
            "nudge_fwd" => g.nudge(0.005 * gsr),
            _ => return Err(format!("unknown grid edit {op}")),
        }
        (d.track_id, g.clone())
    };
    state.library.lock().save_grid(track_id, &grid).map_err(err)?;
    let sr = state.audio.lock().sample_rate;
    state.audio.lock().send(Command::Deck(DeckId(deck as u8), DeckCommand::SetGrid(Arc::new(grid.resampled(sr)))));
    // Refresh the deck view (beat lines, BPM).
    let info = refresh_detail(state, deck)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

/// Edits the beat grid of the track on a deck and saves it to the library.
#[tauri::command]
pub fn grid_set(app: AppHandle, state: State<'_, AppState>, deck: u8, edit: mixit_core::GridEdit) -> R<()> {
    let deck = deck as usize;
    let (track_id, grid) = {
        let mut decks = state.decks.lock();
        let d = decks.get_mut(deck).and_then(|d| d.as_mut()).ok_or("no track on this deck")?;
        d.grid.apply_edit(&edit).map_err(|e| e.to_string())?;
        (d.track_id, d.grid.clone())
    };
    state.library.lock().save_grid(track_id, &grid).map_err(err)?;
    let sr = state.audio.lock().sample_rate;
    state.audio.lock().send(Command::Deck(DeckId(deck as u8), DeckCommand::SetGrid(Arc::new(grid.resampled(sr)))));
    let info = refresh_detail(&state, deck)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

/// Adds or replaces a memory cue (a named marker, not on a pad) at `seconds`.
#[tauri::command]
pub fn set_memory_cue(
    app: AppHandle,
    state: State<'_, AppState>,
    deck: u8,
    seconds: f64,
    label: String,
    color: Option<u32>,
) -> R<()> {
    save_cue(&state, deck, |cues| {
        cues.retain(|c| !(c.kind == CueKind::Memory && (c.seconds - seconds).abs() < 0.01));
        cues.push(Cue { kind: CueKind::Memory, slot: None, seconds, loop_seconds: None, color, label });
    })?;
    let info = refresh_detail(&state, deck as usize)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

#[tauri::command]
pub fn delete_memory_cue(app: AppHandle, state: State<'_, AppState>, deck: u8, seconds: f64) -> R<()> {
    save_cue(&state, deck, |cues| cues.retain(|c| !(c.kind == CueKind::Memory && (c.seconds - seconds).abs() < 0.01)))?;
    let info = refresh_detail(&state, deck as usize)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

fn refresh_detail(state: &AppState, deck: usize) -> R<DeckInfo> {
    let mut decks = state.decks.lock();
    let d = decks[deck].as_mut().ok_or("no track")?;
    let lib = state.library.lock();
    let t = lib.track(d.track_id).map_err(err)?;
    let a = lib.analysis(d.track_id).map_err(err)?;
    let cues = lib.cues(d.track_id).map_err(err)?;
    d.info.detail = TrackDetail::new(&t, a.as_ref(), Some(&d.grid), &cues);
    Ok(d.info.clone())
}

// ------------------------------------------------------------------------- decks

/// Loads a library track onto a deck (decoding happens off the UI thread).
#[tauri::command]
pub async fn load_track(app: AppHandle, deck: u8, track_id: i64) -> R<DeckInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let info = load_track_blocking(&state, deck, track_id, None)?;
        let _ = app.emit("deck-loaded", &info);
        Ok(info)
    })
    .await
    .map_err(err)?
}

pub fn load_track_blocking(state: &AppState, deck: u8, track_id: i64, start_at: Option<f64>) -> R<DeckInfo> {
    let id = deck_id(deck)?;
    let (track, analysis, grid, cues) = {
        let lib = state.library.lock();
        let t = lib.track(track_id).map_err(err)?;
        let a = lib.analysis(track_id).map_err(err)?;
        let g = lib.grid(track_id).map_err(err)?;
        let c = lib.cues(track_id).map_err(err)?;
        (t, a, g, c)
    };
    if !track.path.is_file() {
        return Err(format!("file not found: {}", track.path.display()));
    }
    let sr = state.audio.lock().sample_rate;
    let cache = mixit_io::DecodeCache::new(&state.paths.cache).ok();
    let loaded = mixit_io::load_track(&track.path, sr, cache.as_ref()).map_err(err)?;
    // Unanalysed tracks get a quick analysis now so the deck can sync and show beats.
    let (analysis, grid) = match (analysis, grid) {
        (Some(a), g) => {
            let g = g.unwrap_or_else(|| a.grid.clone());
            (Some(a), g)
        }
        (None, _) => {
            let a = mixit_analysis::analyze(&loaded.data, sr, &mixit_analysis::AnalysisOptions::default());
            let lib = state.library.lock();
            let _ = lib.save_analysis(track_id, &a);
            let g = a.grid.clone();
            (Some(a), g)
        }
    };
    let track = state.library.lock().track(track_id).map_err(err)?;
    let srf = sr as f64;
    let mut dt = DeckTrack::new(Arc::new(TrackAudio::new(sr, loaded.data)), Arc::new(grid.resampled(sr)));
    dt.auto_gain_db = track.auto_gain_db.unwrap_or(0.0) as f32;
    let main = cues.iter().find(|c| c.kind == CueKind::Main).map(|c| c.seconds).or_else(|| {
        analysis
            .as_ref()
            .and_then(|a| a.cues.iter().find(|c| c.role == mixit_analysis::CueRole::Load).map(|c| c.seconds))
    });
    dt.cue = main.unwrap_or(0.0) * srf;
    for c in cues.iter().filter(|c| c.kind == CueKind::Hot) {
        if let Some(slot) = c.slot.filter(|s| (*s as usize) < mixit_engine::HOT_CUES) {
            dt.hot_cues[slot as usize] = Some(HotCue {
                frame: c.seconds * srf,
                kind: match c.loop_seconds {
                    Some(l) if l > 0.0 => EngineCue::Loop { length: l * srf },
                    _ => EngineCue::Point,
                },
                color: c.color.unwrap_or(0x3B82F6),
            });
        }
    }
    let token = state.token();
    dt.token = token;
    let detail = TrackDetail::new(&track, analysis.as_ref(), Some(&grid), &cues);
    let info = DeckInfo { deck, token, detail, sample_rate: sr };
    {
        let mut a = state.audio.lock();
        a.send(Command::Deck(id, DeckCommand::Load(Box::new(dt))));
        let seek = start_at.unwrap_or(main.unwrap_or(0.0));
        a.send(Command::Deck(id, DeckCommand::Seek(seek * srf)));
    }
    state.decks.lock()[deck as usize] =
        Some(LoadedDeck { info: info.clone(), track_id, grid, sample_rate: sr, played: 0.0, logged: false });
    Ok(info)
}

#[tauri::command]
pub fn seek(state: State<'_, AppState>, deck: u8, seconds: f64) -> R<()> {
    let id = deck_id(deck)?;
    let mut a = state.audio.lock();
    let sr = a.sample_rate as f64;
    a.send(Command::Deck(id, DeckCommand::Seek(seconds.max(0.0) * sr)));
    Ok(())
}

/// Scratch / jog: `velocity` is playback speed while touching (1 = normal).
#[tauri::command]
pub fn scratch(state: State<'_, AppState>, deck: u8, phase: String, velocity: f64) -> R<()> {
    let id = deck_id(deck)?;
    let c = match phase.as_str() {
        "start" => DeckCommand::ScratchStart,
        "move" => DeckCommand::ScratchVelocity(velocity),
        _ => DeckCommand::ScratchEnd,
    };
    state.audio.lock().send(Command::Deck(id, c));
    Ok(())
}

fn save_cue(state: &AppState, deck: u8, f: impl FnOnce(&mut Vec<Cue>)) -> R<()> {
    let track_id = state.decks.lock()[deck as usize].as_ref().map(|d| d.track_id).ok_or("no track")?;
    let lib = state.library.lock();
    let mut cues = lib.cues(track_id).map_err(err)?;
    f(&mut cues);
    lib.set_cues(track_id, &cues).map_err(err)
}

/// Sets hot cue `slot` (0-based) at `seconds` (a loop cue when `loopSeconds` is set) and
/// saves it to the library.
#[tauri::command]
pub fn set_hot_cue(
    app: AppHandle,
    state: State<'_, AppState>,
    deck: u8,
    slot: u8,
    seconds: f64,
    loop_seconds: Option<f64>,
    color: Option<u32>,
    label: Option<String>,
) -> R<()> {
    let id = deck_id(deck)?;
    let color = color.unwrap_or(0x3B82F6);
    {
        let mut a = state.audio.lock();
        let sr = a.sample_rate as f64;
        let kind = match loop_seconds {
            Some(l) if l > 0.0 => EngineCue::Loop { length: l * sr },
            _ => EngineCue::Point,
        };
        a.send(Command::Deck(id, DeckCommand::SetHotCue { index: slot, frame: Some(seconds * sr), kind, color }));
    }
    save_cue(&state, deck, |cues| {
        cues.retain(|c| !(c.kind == CueKind::Hot && c.slot == Some(slot)));
        cues.push(Cue {
            kind: CueKind::Hot,
            slot: Some(slot),
            seconds,
            loop_seconds,
            color: Some(color),
            label: label.unwrap_or_default(),
        });
    })?;
    let info = refresh_detail(&state, deck as usize)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

#[tauri::command]
pub fn delete_hot_cue(app: AppHandle, state: State<'_, AppState>, deck: u8, slot: u8) -> R<()> {
    let id = deck_id(deck)?;
    state.audio.lock().send(Command::Deck(id, DeckCommand::DeleteHotCue(slot)));
    save_cue(&state, deck, |cues| cues.retain(|c| !(c.kind == CueKind::Hot && c.slot == Some(slot))))?;
    let info = refresh_detail(&state, deck as usize)?;
    let _ = app.emit("deck-loaded", &info);
    Ok(())
}

/// Moves the main cue point (and remembers it for the next load).
#[tauri::command]
pub fn set_main_cue(state: State<'_, AppState>, deck: u8, seconds: f64) -> R<()> {
    let id = deck_id(deck)?;
    {
        let mut a = state.audio.lock();
        let sr = a.sample_rate as f64;
        a.send(Command::Deck(id, DeckCommand::SetCuePoint(seconds * sr)));
    }
    save_cue(&state, deck, |cues| {
        cues.retain(|c| c.kind != CueKind::Main);
        cues.push(Cue {
            kind: CueKind::Main,
            slot: None,
            seconds,
            loop_seconds: None,
            color: None,
            label: "Cue".into(),
        });
    })
}

/// Sets a loop from seconds (for loops dragged on the waveform).
#[tauri::command]
pub fn set_loop(state: State<'_, AppState>, deck: u8, start: f64, end: f64, active: bool) -> R<()> {
    let id = deck_id(deck)?;
    let mut a = state.audio.lock();
    let sr = a.sample_rate as f64;
    a.send(Command::Deck(id, DeckCommand::SetLoop { start: start * sr, end: end * sr, active }));
    Ok(())
}

/// The waveform for drawing: `[u32 sample rate][u32 frames per column]` then 5 bytes per
/// column (peak, rms, low, mid, high), little endian.
#[tauri::command]
pub fn waveform(state: State<'_, AppState>, track_id: i64) -> R<tauri::ipc::Response> {
    let a = state.library.lock().analysis(track_id).map_err(err)?.ok_or("not analysed")?;
    let w = a.waveform.ok_or("no waveform")?;
    let mut out = Vec::with_capacity(8 + w.levels[0].columns.len() * 5);
    out.extend_from_slice(&w.sample_rate.to_le_bytes());
    out.extend_from_slice(&(w.levels[0].frames_per_column as u32).to_le_bytes());
    out.extend_from_slice(&w.base_bytes());
    Ok(tauri::ipc::Response::new(out))
}

// ------------------------------------------------------------------------- library

#[tauri::command]
pub fn library_search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> R<Vec<TrackRow>> {
    let t = state.library.lock().search(&query, Some(limit.unwrap_or(5000))).map_err(err)?;
    Ok(t.iter().map(TrackRow::from).collect())
}

#[tauri::command]
pub fn library_stats(state: State<'_, AppState>) -> R<mixit_library::LibraryStats> {
    state.library.lock().stats().map_err(err)
}

#[tauri::command]
pub fn library_folders(state: State<'_, AppState>) -> R<Vec<String>> {
    Ok(state.library.lock().folders().map_err(err)?.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

#[tauri::command]
pub fn library_remove_folder(state: State<'_, AppState>, path: String) -> R<()> {
    state.library.lock().remove_folder(Path::new(&path)).map_err(err)
}

fn emit_job(app: &AppHandle, p: JobProgress) {
    let _ = app.emit("job", &p);
}

/// Runs a library job on its own thread and connection.
fn spawn_library_job(
    app: AppHandle,
    kind: &'static str,
    work: impl FnOnce(&AppHandle, &Library, &dyn Fn(usize, usize, String)) -> R<String> + Send + 'static,
) -> R<()> {
    let state = app.state::<AppState>();
    if state.job_running.swap(true, Ordering::SeqCst) {
        return Err("another library job is running".into());
    }
    state.job_cancel.store(false, Ordering::SeqCst);
    let lib = state.job_library()?;
    std::thread::Builder::new()
        .name(format!("mixit-job-{kind}"))
        .spawn(move || {
            let progress = |done: usize, total: usize, message: String| {
                emit_job(&app, JobProgress { kind, done, total, message, finished: false, error: None });
            };
            let r = work(&app, &lib, &progress);
            let (message, error) = match r {
                Ok(m) => (m, None),
                Err(e) => (String::new(), Some(e)),
            };
            emit_job(&app, JobProgress { kind, done: 0, total: 0, message, finished: true, error });
            let _ = app.emit("library-changed", ());
            app.state::<AppState>().job_running.store(false, Ordering::SeqCst);
        })
        .map_err(err)?;
    Ok(())
}

fn analyse_all(app: &AppHandle, lib: &Library, progress: &dyn Fn(usize, usize, String)) -> R<String> {
    let state = app.state::<AppState>();
    let opts = mixit_library::jobs::JobOptions { cache_dir: Some(state.paths.cache.clone()), ..Default::default() };
    let mut last_emit = std::time::Instant::now();
    let s = lib
        .analyze_pending(&opts, &state.job_cancel, |done, total, _| {
            progress(done, total, format!("Analysing {done} of {total}"));
            if last_emit.elapsed().as_secs_f32() > 2.0 {
                let _ = app.emit("library-changed", ());
                last_emit = std::time::Instant::now();
            }
        })
        .map_err(err)?;
    Ok(format!(
        "Analysed {} tracks{}",
        s.analysed,
        if s.failed > 0 { format!(", {} failed", s.failed) } else { String::new() }
    ))
}

/// Adds folders or files to the library, then analyses what is new.
#[tauri::command]
pub fn library_add(app: AppHandle, paths: Vec<String>) -> R<()> {
    spawn_library_job(app, "scan", move |app, lib, progress| {
        let mut added = 0;
        let mut errors = 0;
        for p in &paths {
            let p = PathBuf::from(p);
            if p.is_dir() {
                lib.add_folder(&p).map_err(err)?;
                let r = lib
                    .scan_folder(&p, |i, f| {
                        progress(i, 0, format!("Scanning {}", f.file_name().unwrap_or_default().to_string_lossy()))
                    })
                    .map_err(err)?;
                added += r.added.len() + r.moved.len();
                errors += r.errors.len();
            } else if mixit_io::is_audio_file(&p) {
                match lib.import_file(&p) {
                    Ok(_) => added += 1,
                    Err(_) => errors += 1,
                }
            }
        }
        let _ = app.emit("library-changed", ());
        let a = analyse_all(app, lib, progress)?;
        Ok(format!(
            "Added {added} tracks{}. {a}",
            if errors > 0 { format!(" ({errors} unreadable)") } else { String::new() }
        ))
    })
}

/// Adds one audio file to the library now and returns it (dropped on a deck, for
/// example). It is analysed when it is first loaded.
#[tauri::command]
pub fn library_import(app: AppHandle, state: State<'_, AppState>, path: String) -> R<TrackRow> {
    let p = PathBuf::from(&path);
    if !mixit_io::is_audio_file(&p) {
        return Err(format!(
            "{} is not a music file MixIt can read",
            p.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    let lib = state.library.lock();
    let id = match lib.import_file(&p).map_err(err)? {
        mixit_library::scan::Imported::Added(id)
        | mixit_library::scan::Imported::Updated(id)
        | mixit_library::scan::Imported::Moved(id)
        | mixit_library::scan::Imported::Unchanged(id) => id,
    };
    let t = lib.track(id).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(TrackRow::from(&t))
}

/// Generates the practice tracks the guide's labs use (once) and adds them to the
/// library, analysed.
#[tauri::command]
pub fn practice_add(app: AppHandle) -> R<()> {
    let dir = app.state::<AppState>().paths.practice.clone();
    spawn_library_job(app, "scan", move |app, lib, progress| {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let list = mixit_generator::practice::PRACTICE;
        let mut added = 0;
        for (i, p) in list.iter().enumerate() {
            if app.state::<AppState>().job_cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            progress(i, list.len(), format!("Making {}", p.title));
            let path = dir.join(format!("{}.wav", p.title));
            if !path.is_file() {
                let g = mixit_generator::generate(&p.spec(44_100));
                mixit_io::write_wav(&path, &g.audio, 2, g.sample_rate, mixit_io::WavDepth::Pcm16).map_err(err)?;
            }
            if lib.track_by_path(&path).map_err(err)?.is_none() {
                lib.import_file(&path).map_err(err)?;
                added += 1;
            }
        }
        let _ = app.emit("library-changed", ());
        let a = analyse_all(app, lib, progress)?;
        Ok(format!("Added {added} practice tracks. {a}"))
    })
}

#[tauri::command]
pub fn library_rescan(app: AppHandle) -> R<()> {
    spawn_library_job(app, "scan", |app, lib, progress| {
        let r = lib
            .rescan_all(|i, f| {
                progress(i, 0, format!("Checking {}", f.file_name().unwrap_or_default().to_string_lossy()))
            })
            .map_err(err)?;
        let a = analyse_all(app, lib, progress)?;
        Ok(format!("{} updated, {} moved, {} missing. {a}", r.updated.len(), r.moved.len(), r.missing.len()))
    })
}

#[tauri::command]
pub fn library_analyze(app: AppHandle) -> R<()> {
    spawn_library_job(app, "analyze", analyse_all)
}

#[tauri::command]
pub fn job_cancel(state: State<'_, AppState>) {
    state.job_cancel.store(true, Ordering::SeqCst);
    state.render_cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn track_detail(state: State<'_, AppState>, id: i64) -> R<TrackDetail> {
    let lib = state.library.lock();
    let t = lib.track(id).map_err(err)?;
    let a = lib.analysis(id).map_err(err)?;
    let g = lib.grid(id).map_err(err)?;
    let c = lib.cues(id).map_err(err)?;
    Ok(TrackDetail::new(&t, a.as_ref(), g.as_ref(), &c))
}

#[tauri::command]
pub fn track_edit(app: AppHandle, state: State<'_, AppState>, id: i64, edit: TrackEdit) -> R<TrackRow> {
    let lib = state.library.lock();
    lib.edit_track(id, &edit).map_err(err)?;
    let row = TrackRow::from(&lib.track(id).map_err(err)?);
    let _ = app.emit("library-changed", ());
    Ok(row)
}

/// Applies the same edit to several tracks (only the fields given change).
#[tauri::command]
pub fn tracks_edit(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, edit: TrackEdit) -> R<()> {
    {
        let lib = state.library.lock();
        for id in &ids {
            lib.edit_track(*id, &edit).map_err(err)?;
        }
    }
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[derive(Serialize)]
pub struct WriteTagsResult {
    pub written: usize,
    /// (track id, why) for files that could not be written.
    pub failed: Vec<(i64, String)>,
}

/// Writes the library's details into the tracks' files. `notation` is how the key is
/// written: "camelot" (8A), "openKey" (1m) or "standard" (Am).
#[tauri::command]
pub async fn library_write_tags(app: AppHandle, ids: Vec<i64>, notation: String) -> R<WriteTagsResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let n = match notation.as_str() {
            "openKey" => mixit_core::key::KeyNotation::OpenKey,
            "standard" => mixit_core::key::KeyNotation::Standard,
            _ => mixit_core::key::KeyNotation::Camelot,
        };
        let mut out = WriteTagsResult { written: 0, failed: vec![] };
        for id in ids {
            // One track at a time, so the library stays usable while files are written.
            match state.library.lock().write_file_tags(id, n) {
                Ok(()) => out.written += 1,
                Err(e) => out.failed.push((id, e.to_string())),
            }
        }
        let _ = app.emit("library-changed", ());
        Ok(out)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn tracks_remove(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> R<()> {
    state.library.lock().remove_tracks(&ids).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

/// Tracks whose files cannot be found.
#[tauri::command]
pub fn library_missing(state: State<'_, AppState>) -> R<Vec<TrackRow>> {
    Ok(state.library.lock().missing_tracks().map_err(err)?.iter().map(TrackRow::from).collect())
}

/// Looks through a folder for missing tracks' files. Returns how many were found.
#[tauri::command]
pub async fn library_find_missing(app: AppHandle, folder: String) -> R<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let found = state.library.lock().find_missing_in(Path::new(&folder)).map_err(err)?;
        let _ = app.emit("library-changed", ());
        Ok(found.len())
    })
    .await
    .map_err(err)?
}

/// Points one track at a file the user picked.
#[tauri::command]
pub fn library_relocate(app: AppHandle, state: State<'_, AppState>, id: i64, path: String) -> R<TrackRow> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let lib = state.library.lock();
    lib.relocate(id, &p).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(TrackRow::from(&lib.track(id).map_err(err)?))
}

/// Groups of tracks with the same audio.
#[tauri::command]
pub fn library_duplicates(state: State<'_, AppState>) -> R<Vec<Vec<TrackRow>>> {
    let lib = state.library.lock();
    let groups = lib.duplicates().map_err(err)?;
    Ok(groups
        .iter()
        .map(|g| g.iter().filter_map(|&id| lib.track(id).ok()).map(|t| TrackRow::from(&t)).collect())
        .collect())
}

/// Folds duplicates into the one to keep (playlists, tags, history and cues move over).
#[tauri::command]
pub fn library_merge(app: AppHandle, state: State<'_, AppState>, keep: i64, others: Vec<i64>) -> R<()> {
    state.library.lock().merge_tracks(keep, &others).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

// ------------------------------------------------------------------ preview player

/// Puts a library track in the preview player and starts it at `seconds`. Returns the
/// track's length. A newer request made while this one decodes wins.
#[tauri::command]
pub async fn preview_load(app: AppHandle, track_id: i64, seconds: f64) -> R<f64> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let token = state.token();
        *state.preview.lock() = Some((token, track_id));
        let path = state.library.lock().track(track_id).map_err(err)?.path;
        if !path.is_file() {
            return Err(format!("file not found: {}", path.display()));
        }
        let sr = state.audio.lock().sample_rate;
        let cache = mixit_io::DecodeCache::new(&state.paths.cache).ok();
        let loaded = mixit_io::load_track(&path, sr, cache.as_ref()).map_err(err)?;
        let audio = Arc::new(TrackAudio::new(sr, loaded.data));
        let len = audio.seconds();
        if state.preview.lock().is_none_or(|(t, _)| t != token) {
            return Ok(len);
        }
        let mut a = state.audio.lock();
        let start = seconds.clamp(0.0, len) * sr as f64;
        a.send(Command::Preview(PreviewCommand::Load(audio, start)));
        a.send(Command::Preview(PreviewCommand::Play(true)));
        Ok(len)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn preview_play(state: State<'_, AppState>, on: bool) -> R<()> {
    state.audio.lock().send(Command::Preview(PreviewCommand::Play(on)));
    Ok(())
}

#[tauri::command]
pub fn preview_seek(state: State<'_, AppState>, seconds: f64) -> R<()> {
    let mut a = state.audio.lock();
    let sr = a.sample_rate as f64;
    a.send(Command::Preview(PreviewCommand::Seek(seconds.max(0.0) * sr)));
    Ok(())
}

/// Preview volume (0..2, linear) and where it is heard ("headphones" or "speakers").
#[tauri::command]
pub fn preview_settings(state: State<'_, AppState>, gain: f32, route: String) -> R<()> {
    let mut a = state.audio.lock();
    a.send(Command::Preview(PreviewCommand::SetGain(gain)));
    let r = if route == "speakers" { PreviewRoute::Speakers } else { PreviewRoute::Headphones };
    a.send(Command::Preview(PreviewCommand::SetRoute(r)));
    Ok(())
}

#[tauri::command]
pub fn preview_close(state: State<'_, AppState>) -> R<()> {
    *state.preview.lock() = None;
    state.audio.lock().send(Command::Preview(PreviewCommand::Unload));
    Ok(())
}

fn energy_dir(s: &str) -> EnergyDirection {
    match s {
        "up" => EnergyDirection::Up,
        "down" => EnergyDirection::Down,
        _ => EnergyDirection::Steady,
    }
}

/// What to play after `trackId`. Tracks already played this session and tracks on decks
/// are left out.
#[tauri::command]
pub fn suggest_next(
    state: State<'_, AppState>,
    track_id: i64,
    energy: Option<String>,
    limit: Option<usize>,
    tolerance: Option<f64>,
) -> R<Vec<SuggestionRow>> {
    let mut exclude: Vec<i64> = state.decks.lock().iter().flatten().map(|d| d.track_id).collect();
    let session = *state.session.lock();
    let lib = state.library.lock();
    if let Some(s) = session {
        exclude.extend(lib.session_track_ids(s).map_err(err)?);
    }
    let opts = SuggestOptions {
        energy: energy_dir(energy.as_deref().unwrap_or("steady")),
        limit: limit.unwrap_or(30),
        tempo_tolerance_pct: tolerance.unwrap_or(6.0),
        exclude,
        ..Default::default()
    };
    let list = lib.suggest_next(track_id, &opts).map_err(err)?;
    Ok(list.iter().filter_map(|s| lib.track(s.id).ok().map(|t| SuggestionRow::new(s, &t))).collect())
}

// ------------------------------------------------------------------------- playlists

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDto {
    pub id: i64,
    pub parent: Option<i64>,
    pub name: String,
    /// "folder" | "list" | "smart"
    pub kind: &'static str,
    pub query: Option<String>,
    pub count: usize,
    pub duration: f64,
}

#[tauri::command]
pub fn playlists(state: State<'_, AppState>) -> R<Vec<PlaylistDto>> {
    let lib = state.library.lock();
    let all = lib.playlists().map_err(err)?;
    Ok(all
        .into_iter()
        .map(|p| {
            let ids = lib.playlist_tracks(p.id).unwrap_or_default();
            let duration = ids.iter().filter_map(|&id| lib.track(id).ok()).map(|t| t.duration).sum();
            PlaylistDto {
                id: p.id,
                parent: p.parent,
                name: p.name,
                kind: match p.kind {
                    PlaylistKind::Folder => "folder",
                    PlaylistKind::List => "list",
                    PlaylistKind::Smart => "smart",
                },
                query: p.query,
                count: ids.len(),
                duration,
            }
        })
        .collect())
}

#[tauri::command]
pub fn playlist_tracks(state: State<'_, AppState>, id: i64) -> R<Vec<TrackRow>> {
    let lib = state.library.lock();
    let ids = lib.playlist_tracks(id).map_err(err)?;
    Ok(ids.into_iter().filter_map(|i| lib.track(i).ok()).map(|t| TrackRow::from(&t)).collect())
}

#[tauri::command]
pub fn playlist_create(
    state: State<'_, AppState>,
    name: String,
    kind: String,
    parent: Option<i64>,
    query: Option<String>,
    tracks: Option<Vec<i64>>,
) -> R<i64> {
    let kind = match kind.as_str() {
        "folder" => PlaylistKind::Folder,
        "smart" => PlaylistKind::Smart,
        _ => PlaylistKind::List,
    };
    let lib = state.library.lock();
    let id = lib.create_playlist(&name, kind, parent, query.as_deref()).map_err(err)?;
    if let Some(t) = tracks.filter(|t| !t.is_empty()) {
        lib.add_to_playlist(id, &t).map_err(err)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn playlist_rename(state: State<'_, AppState>, id: i64, name: String) -> R<()> {
    state.library.lock().rename_playlist(id, &name).map_err(err)
}

#[tauri::command]
pub fn playlist_set_query(state: State<'_, AppState>, id: i64, query: String) -> R<()> {
    state.library.lock().set_smart_query(id, &query).map_err(err)
}

#[tauri::command]
pub fn playlist_delete(state: State<'_, AppState>, id: i64) -> R<()> {
    state.library.lock().delete_playlist(id).map_err(err)
}

#[tauri::command]
pub fn playlist_add(state: State<'_, AppState>, id: i64, tracks: Vec<i64>) -> R<()> {
    state.library.lock().add_to_playlist(id, &tracks).map_err(err)
}

#[tauri::command]
pub fn playlist_remove(state: State<'_, AppState>, id: i64, indices: Vec<usize>) -> R<()> {
    state.library.lock().remove_from_playlist(id, &indices).map_err(err)
}

#[tauri::command]
pub fn playlist_reorder(state: State<'_, AppState>, id: i64, from: Vec<usize>, to: usize) -> R<()> {
    state.library.lock().reorder_playlist(id, &from, to).map_err(err)
}

/// Reorders a playlist into the smoothest tempo, key and energy path.
#[tauri::command]
pub fn playlist_order_set(state: State<'_, AppState>, id: i64, energy: Option<String>, start: Option<i64>) -> R<()> {
    let lib = state.library.lock();
    let ids = lib.playlist_tracks(id).map_err(err)?;
    let order = lib.order_set(&ids, start, energy_dir(energy.as_deref().unwrap_or("up"))).map_err(err)?;
    lib.set_playlist_tracks(id, &order).map_err(err)
}

#[tauri::command]
pub fn history(state: State<'_, AppState>) -> R<Vec<mixit_library::HistoryEntry>> {
    let Some(s) = *state.session.lock() else { return Ok(vec![]) };
    state.library.lock().session_history(s).map_err(err)
}

#[tauri::command]
pub fn history_tracklist(state: State<'_, AppState>) -> R<String> {
    let Some(s) = *state.session.lock() else { return Ok(String::new()) };
    state.library.lock().session_tracklist(s).map_err(err)
}

// ------------------------------------------------------------------------- audio and settings

#[tauri::command]
pub fn audio_devices() -> Vec<mixit_host::DeviceInfo> {
    mixit_host::list_outputs()
}

#[tauri::command]
pub fn input_devices() -> Vec<mixit_host::DeviceInfo> {
    mixit_host::input::list_inputs()
}

/// What the mic channel is connected to, or why it is not.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicState {
    pub status: Option<crate::dto::MicStatus>,
    pub error: Option<String>,
    pub lost: bool,
}

#[tauri::command]
pub fn mic_status(state: State<'_, AppState>) -> MicState {
    let a = state.audio.lock();
    MicState { status: a.mic_status(), error: state.mic_error.lock().clone(), lost: a.mic_lost() }
}

/// Starts recording the mic channel (after its gain, low cut, gate and EQ).
#[tauri::command]
pub fn mic_record_start(state: State<'_, AppState>) -> R<String> {
    let mut rec = state.mic_recording.lock();
    if rec.is_some() {
        return Err("already recording the mic".into());
    }
    if state.audio.lock().mic_status().is_none() {
        return Err("turn the mic on first".into());
    }
    let dir = state.paths.recordings.join("Mic");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let name = format!("Mic {}.wav", crate::state::chrono_like_now().replace(':', "-"));
    let path = dir.join(name);
    let sr = state.audio.lock().sample_rate;
    let writer = mixit_host::recorder::StreamingWav::create(&path, sr, true).map_err(err)?;
    *rec = Some(crate::state::MicRecording { writer });
    state.audio.lock().send(Command::Mic(mixit_engine::MicCommand::Capture(true)));
    Ok(path.to_string_lossy().into_owned())
}

/// Stops the mic recording and returns the file. With `trim`, the silence before and
/// after is cut (for a pad sound).
#[tauri::command]
pub fn mic_record_stop(state: State<'_, AppState>, trim: bool) -> R<crate::dto::MicTake> {
    state.audio.lock().send(Command::Mic(mixit_engine::MicCommand::Capture(false)));
    std::thread::sleep(std::time::Duration::from_millis(60));
    let rec = state.mic_recording.lock().take().ok_or("not recording the mic")?;
    let mut w = rec.writer;
    let mut buf = Vec::new();
    state.audio.lock().ctl.drain_capture(&mut buf);
    w.write(&buf).map_err(err)?;
    let path = w.finish().map_err(err)?;
    let mut seconds = 0.0;
    if let Ok(d) = mixit_io::decode_file(&path) {
        seconds = d.frames() as f64 / d.sample_rate as f64;
        // Trim takes up to five minutes (pads); longer ones are kept as they are.
        if trim && seconds <= 300.0 {
            let t = mixit_dsp::util::trim_silence(&d.data, d.sample_rate, -48.0);
            if t.is_empty() {
                let _ = std::fs::remove_file(&path);
                return Err("the recording was silent: check the mic gain and meter".into());
            }
            seconds = t.len() as f64 / 2.0 / d.sample_rate as f64;
            mixit_io::write_wav(&path, &t, 2, d.sample_rate, mixit_io::WavDepth::Float32).map_err(err)?;
        }
    }
    Ok(crate::dto::MicTake { path: path.to_string_lossy().into_owned(), seconds })
}

#[tauri::command]
pub fn audio_status(state: State<'_, AppState>) -> AudioStatus {
    let a = state.audio.lock();
    let mut s = a.status.clone();
    s.buffer_frames = s.buffer_frames.or(Some(a.stats.snapshot().buffer_frames));
    s
}

/// Restarts the engine on new device settings and reloads the decks where they were.
fn restart_audio(app: &AppHandle) -> R<AudioStatus> {
    let state = app.state::<AppState>();
    let cfg = state.settings.lock().host_config();
    let tele = *state.audio.lock().ctl.telemetry();
    let reload: Vec<(u8, i64, f64)> = state
        .decks
        .lock()
        .iter()
        .enumerate()
        .filter_map(|(i, d)| d.as_ref().map(|d| (i as u8, d.track_id, tele.decks[i].position / d.sample_rate as f64)))
        .collect();
    {
        let mut a = state.audio.lock();
        a.stop();
        *a = Audio::start(&cfg);
    }
    state.apply_mixer_settings();
    state.apply_mic_settings();
    crate::sampler::load_all(&state);
    for (deck, track, pos) in reload {
        if let Ok(info) = load_track_blocking(&state, deck, track, Some(pos)) {
            let _ = app.emit("deck-loaded", &info);
        }
    }
    let s = state.audio.lock().status.clone();
    let _ = app.emit("audio-status", &s);
    Ok(s)
}

#[tauri::command]
pub fn settings_set(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> R<Settings> {
    let old = state.settings.lock().clone();
    settings.save(&state.library.lock())?;
    *state.settings.lock() = settings.clone();
    let audio_changed = old.device != settings.device
        || old.buffer_frames != settings.buffer_frames
        || old.sample_rate != settings.sample_rate
        || old.cue_channel != settings.cue_channel;
    let mic_changed = old.mic_enabled != settings.mic_enabled
        || old.mic_device != settings.mic_device
        || old.mic_channel != settings.mic_channel
        || old.mic_stereo != settings.mic_stereo;
    if audio_changed {
        restart_audio(&app)?;
    } else {
        state.apply_mixer_settings();
        if mic_changed {
            state.apply_mic_settings();
        }
    }
    Ok(settings)
}

#[tauri::command]
pub fn record_start(state: State<'_, AppState>) -> R<String> {
    let mut rec = state.recording.lock();
    if rec.is_some() {
        return Err("already recording".into());
    }
    std::fs::create_dir_all(&state.paths.recordings).map_err(err)?;
    let name = format!("MixIt {}.wav", crate::state::chrono_like_now().replace(':', "-"));
    let path = state.paths.recordings.join(name);
    let (sr, float) = (state.audio.lock().sample_rate, state.settings.lock().record_float);
    let writer = mixit_host::recorder::StreamingWav::create(&path, sr, float).map_err(err)?;
    *rec = Some(Recording { writer, started: std::time::Instant::now() });
    state.audio.lock().send(Command::Global(mixit_engine::GlobalCommand::SetRecording(true)));
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn record_stop(state: State<'_, AppState>) -> R<String> {
    state.audio.lock().send(Command::Global(mixit_engine::GlobalCommand::SetRecording(false)));
    // Let the telemetry thread drain what is left.
    std::thread::sleep(std::time::Duration::from_millis(120));
    let rec = state.recording.lock().take().ok_or("not recording")?;
    let mut w = rec.writer;
    let mut buf = Vec::new();
    state.audio.lock().ctl.drain_recorder(&mut buf);
    w.write(&buf).map_err(err)?;
    let p = w.finish().map_err(err)?;
    Ok(p.to_string_lossy().into_owned())
}

/// Writes a tracklist or CUE sheet (only `.cue`, `.txt` and `.m3u8` files).
#[tauri::command]
pub fn save_text(path: String, text: String) -> R<()> {
    let p = PathBuf::from(&path);
    let ext = p.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !["cue", "txt", "m3u8"].contains(&ext.as_str()) {
        return Err(format!("not a text file MixIt writes: {path}"));
    }
    std::fs::write(&p, text).map_err(|e| format!("{path}: {e}"))
}

// ------------------------------------------------------------------------- mix projects

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomixRequest {
    pub transition: String,
    /// "first" | "follow" | a BPM
    pub tempo: String,
    pub overlap: f64,
    pub harmonic: bool,
    pub reorder: bool,
    pub energy: String,
    pub name: String,
}

impl Default for AutomixRequest {
    fn default() -> Self {
        AutomixRequest {
            transition: "bassSwap".into(),
            tempo: "first".into(),
            overlap: 32.0,
            harmonic: true,
            reorder: false,
            energy: "up".into(),
            name: "Automix".into(),
        }
    }
}

#[tauri::command]
pub fn automix(state: State<'_, AppState>, tracks: Vec<i64>, options: AutomixRequest) -> R<MixProject> {
    if tracks.len() < 2 {
        return Err("pick at least two tracks".into());
    }
    let lib = state.library.lock();
    let ids =
        if options.reorder { lib.order_set(&tracks, None, energy_dir(&options.energy)).map_err(err)? } else { tracks };
    let plans = lib.plan_tracks(&ids).map_err(err)?;
    let transition = TransitionKind::ALL
        .into_iter()
        .find(|t| transition_id(*t) == options.transition)
        .unwrap_or(TransitionKind::BassSwap);
    let tempo = match options.tempo.as_str() {
        "first" => TempoPolicy::FirstTrack,
        "follow" => TempoPolicy::Follow,
        s => TempoPolicy::Fixed(s.parse().map_err(|_| "tempo must be first, follow or a BPM")?),
    };
    let o = AutomixOptions {
        transition,
        max_overlap: options.overlap.max(4.0),
        min_overlap: (options.overlap / 2.0).clamp(4.0, 16.0),
        tempo,
        harmonic: options.harmonic,
        ..Default::default()
    };
    mixit_project::automix::automix(&options.name, &plans, &o).map_err(|e| format!("{e:?}"))
}

fn project_from_value(v: serde_json::Value) -> R<MixProject> {
    MixProject::from_json(&v.to_string()).map_err(err)
}

#[tauri::command]
pub fn project_save(path: String, project: serde_json::Value) -> R<()> {
    let p = project_from_value(project)?;
    std::fs::write(&path, p.to_json()).map_err(err)
}

#[tauri::command]
pub fn project_open(path: String) -> R<MixProject> {
    let s = std::fs::read_to_string(&path).map_err(err)?;
    MixProject::from_json(&s).map_err(err)
}

#[tauri::command]
pub fn project_check(project: serde_json::Value) -> R<Vec<String>> {
    let p = project_from_value(project)?;
    Ok(p.check().iter().map(|i| format!("{i:?}")).collect())
}

/// Renders a project to samples, reporting progress as "render" jobs. Runs on the
/// calling thread.
fn render_samples(app: &AppHandle, p: &MixProject, label: &str) -> R<(Vec<f32>, u32)> {
    app.state::<AppState>().render_cancel.store(false, Ordering::SeqCst);
    render_with(app, p, label, &mixit_host::project::RenderOptions::default())
}

fn render_with(
    app: &AppHandle,
    p: &MixProject,
    label: &str,
    opts: &mixit_host::project::RenderOptions,
) -> R<(Vec<f32>, u32)> {
    let state = app.state::<AppState>();
    let lib = state.job_library()?;
    let mut r = mixit_cli::resolve::Resolver::new(
        opts.sample_rate,
        Some(&lib),
        mixit_io::DecodeCache::new(state.paths.cache.clone()).ok(),
    );
    let mut last = 0.0f32;
    let cancel = state.render_cancel.clone();
    let res = mixit_host::project::render_project(
        p,
        opts,
        |c| r.resolve(c),
        &cancel,
        |f| {
            if f - last > 0.01 {
                last = f;
                emit_job(
                    app,
                    JobProgress {
                        kind: "render",
                        done: (f * 1000.0) as usize,
                        total: 1000,
                        message: format!("{label} {:.0} %", f * 100.0),
                        finished: false,
                        error: None,
                    },
                );
            }
        },
    );
    res.map(|a| (a, opts.sample_rate)).map_err(|e| r.last_error.clone().unwrap_or_else(|| e.to_string()))
}

/// Bounces a project to `path` in the background ("job" events with kind "render").
#[tauri::command]
/// With `target_lufs` the finished mix is turned up or down to that loudness (never past
/// −1 dB peak).
pub fn project_render(
    app: AppHandle,
    project: serde_json::Value,
    path: String,
    format: Option<String>,
    target_lufs: Option<f64>,
) -> R<()> {
    let p = project_from_value(project)?;
    let out = PathBuf::from(&path);
    let fmt = mixit_cli::ops::format_for(&out, format.as_deref()).map_err(err)?;
    std::thread::Builder::new()
        .name("mixit-render".into())
        .spawn(move || {
            let done = render_samples(&app, &p, "Rendering").and_then(|(mut audio, sr)| {
                let note = match target_lufs {
                    Some(t) => {
                        let fix = mixit_engine::arrangement::normalize_loudness(&mut audio, sr, t, -1.0);
                        if fix.peak_limited {
                            format!(
                                " (at {:.1} LUFS: louder would clip; turn up the glue or limiter to get closer to {t})",
                                fix.measured_lufs + fix.gain_db
                            )
                        } else {
                            format!(" (at {t} LUFS)")
                        }
                    }
                    None => String::new(),
                };
                mixit_cli::ops::write_audio(&out, &audio, sr, fmt)
                    .map(|_| format!("Saved {}{note}", out.display()))
                    .map_err(|e| e.to_string())
            });
            let (message, error) = match done {
                Ok(m) => (m, None),
                Err(e) => (String::new(), Some(e)),
            };
            emit_job(&app, JobProgress { kind: "render", done: 1000, total: 1000, message, finished: true, error });
        })
        .map_err(err)?;
    Ok(())
}

/// Bounces each lane of a project to its own file in `folder` ("<name> - Deck A.flac"),
/// all the same length so they line up in another program. Stems skip the master strip
/// and limiter, so added together they make the mix.
#[tauri::command]
pub fn project_render_stems(
    app: AppHandle,
    project: serde_json::Value,
    folder: String,
    format: Option<String>,
) -> R<()> {
    let p = project_from_value(project)?;
    let lanes = p.used_lanes();
    if lanes.is_empty() {
        return Err("the project has no clips".into());
    }
    let ext = if format.as_deref() == Some("wav") { "wav" } else { "flac" };
    let dir = PathBuf::from(&folder);
    std::thread::Builder::new()
        .name("mixit-stems".into())
        .spawn(move || {
            let state = app.state::<AppState>();
            state.render_cancel.store(false, Ordering::SeqCst);
            let base = mixit_host::project::RenderOptions::default();
            let opts = mixit_host::project::RenderOptions {
                limiter: false,
                length_seconds: Some(p.length_seconds() + base.tail),
                ..base
            };
            let safe: String =
                p.name.chars().map(|c| if c.is_alphanumeric() || " -_".contains(c) { c } else { '_' }).collect();
            let mut written = Vec::new();
            let mut error = None;
            for lane in &lanes {
                let mut stem = p.lane_only(*lane);
                stem.master_strip = None;
                let letter = (b'A' + lane) as char;
                let out = dir.join(format!("{} - Deck {letter}.{ext}", safe.trim()));
                let fmt = match mixit_cli::ops::format_for(&out, None) {
                    Ok(f) => f,
                    Err(e) => {
                        error = Some(e.to_string());
                        break;
                    }
                };
                match render_with(&app, &stem, &format!("Stem {letter}"), &opts).and_then(|(audio, sr)| {
                    mixit_cli::ops::write_audio(&out, &audio, sr, fmt).map_err(|e| e.to_string())
                }) {
                    Ok(()) => written.push(out),
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            let message = format!(
                "Saved {} stem{} in {}",
                written.len(),
                if written.len() == 1 { "" } else { "s" },
                dir.display()
            );
            emit_job(&app, JobProgress { kind: "render", done: 1000, total: 1000, message, finished: true, error });
        })
        .map_err(err)?;
    Ok(())
}

/// Renders the beats [from_beat, to_beat) of a project and returns it as a 16-bit WAV,
/// so the arrange view can play a passage without bouncing the whole mix.
#[tauri::command]
pub async fn project_preview(
    app: AppHandle,
    project: serde_json::Value,
    from_beat: f64,
    to_beat: f64,
) -> R<tauri::ipc::Response> {
    let p = project_from_value(project)?.excerpt(from_beat, to_beat);
    tauri::async_runtime::spawn_blocking(move || {
        let res = render_samples(&app, &p, "Preparing preview");
        let finish = |error: Option<String>| {
            emit_job(
                &app,
                JobProgress { kind: "render", done: 1000, total: 1000, message: String::new(), finished: true, error },
            )
        };
        let (audio, sr) = match res {
            Ok(x) => x,
            Err(e) => {
                finish(Some(e.clone()));
                return Err(e);
            }
        };
        let dir = app.state::<AppState>().paths.cache.clone();
        std::fs::create_dir_all(&dir).map_err(err)?;
        let path = dir.join("preview.wav");
        mixit_cli::ops::write_audio(&path, &audio, sr, mixit_cli::ops::parse_format("wav16").map_err(err)?)
            .map_err(err)?;
        let bytes = std::fs::read(&path).map_err(err)?;
        finish(None);
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(err)?
}

// ------------------------------------------------------------------------- exchange

#[tauri::command]
pub fn import_rekordbox(app: AppHandle, path: String) -> R<()> {
    spawn_library_job(app, "import", move |app, lib, progress| {
        progress(0, 0, "Reading Rekordbox collection".into());
        let r = lib.import_rekordbox_xml(Path::new(&path)).map_err(err)?;
        let a = analyse_all(app, lib, progress)?;
        Ok(format!(
            "Imported {} tracks, {} playlists, {} cues ({} files not found). {a}",
            r.tracks,
            r.playlists,
            r.cues,
            r.missing.len()
        ))
    })
}

#[tauri::command]
pub fn export_rekordbox(state: State<'_, AppState>, path: String, playlist: Option<i64>) -> R<()> {
    let lib = state.library.lock();
    let ids = match playlist {
        Some(p) => Some(lib.playlist_tracks(p).map_err(err)?),
        None => None,
    };
    lib.export_rekordbox_xml(ids.as_deref(), Path::new(&path)).map_err(err)
}

#[tauri::command]
pub fn export_playlist(state: State<'_, AppState>, playlist: i64, path: String) -> R<()> {
    let lib = state.library.lock();
    let ids = lib.playlist_tracks(playlist).map_err(err)?;
    let p = Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("csv")) {
        lib.export_csv(&ids, p).map_err(err)
    } else {
        lib.export_m3u(&ids, p, false).map_err(err)
    }
}

#[tauri::command]
pub fn import_m3u(state: State<'_, AppState>, path: String) -> R<i64> {
    let lib = state.library.lock();
    let (ids, _missing) = lib.import_m3u(Path::new(&path)).map_err(err)?;
    let name = Path::new(&path).file_stem().unwrap_or_default().to_string_lossy().into_owned();
    let id = lib.create_playlist(&name, PlaylistKind::List, None, None).map_err(err)?;
    lib.add_to_playlist(id, &ids).map_err(err)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_ids_are_camel_case() {
        assert_eq!(transition_id(TransitionKind::BassSwap), "bassSwap");
        assert_eq!(transition_id(TransitionKind::Cut), "cut");
    }
}

// --------------------------------------------------------------------- sampler

#[tauri::command]
pub async fn sampler_load(app: AppHandle, pad: usize, source: PadSource) -> R<PadInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let info = crate::sampler::load(&state, pad, source, false)?;
        crate::sampler::save(&state);
        Ok(info)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn sampler_clear(state: State<'_, AppState>, pad: usize) -> R<PadInfo> {
    let info = crate::sampler::clear(&state, pad)?;
    crate::sampler::save(&state);
    Ok(info)
}

#[tauri::command]
pub fn sampler_set(state: State<'_, AppState>, pad: usize, patch: PadPatch) -> R<PadInfo> {
    let info = crate::sampler::patch(&state, pad, patch)?;
    crate::sampler::save(&state);
    Ok(info)
}

/// Puts the built-in kit back on every pad.
#[tauri::command]
pub async fn sampler_reset(app: AppHandle) -> R<Vec<PadInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        for p in crate::sampler::default_pads() {
            crate::sampler::load(&state, p.pad, p.source, false)?;
        }
        crate::sampler::save(&state);
        Ok(state.pads.lock().clone())
    })
    .await
    .map_err(err)?
}

/// Puts the step sequencer's patterns and settings on the engine.
#[tauri::command]
pub fn sampler_sequence(state: State<'_, AppState>, sequencer: mixit_engine::view::SequencerDto) {
    let mut a = state.audio.lock();
    for c in mixit_engine::view::sequencer_commands(&sequencer, crate::sampler::PADS) {
        a.send(Command::Sampler(c));
    }
}

#[tauri::command]
pub fn sampler_stop_all(state: State<'_, AppState>) {
    state.audio.lock().send(Command::Sampler(mixit_engine::SamplerCommand::StopAll));
}
