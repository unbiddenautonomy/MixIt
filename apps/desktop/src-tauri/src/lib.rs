//! The MixIt desktop app: a Tauri shell around the engine, library and jobs. The UI
//! (React, in `apps/desktop/src`) talks to it through the commands in [`commands`] and
//! listens to the events "telemetry", "deck-loaded", "deck-ended", "job",
//! "library-changed", "history-changed", "audio-status", "error" and "part-closed".
//! Parts of the screen can open in windows of their own on other screens ([`windows`]).

pub mod audio;
pub mod beats;
pub mod commands;
pub mod dto;
pub mod listen;
pub mod nowplaying;
pub mod sampler;
pub mod sound;
pub mod state;
pub mod telemetry;
pub mod update;
pub mod windows;

use tauri::Manager;

pub fn run() {
    let paths = state::Paths::default_paths();
    let state = match state::AppState::new(paths) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("MixIt could not start: {e}");
            std::process::exit(1);
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .on_window_event(windows::on_window_event)
        .setup(|app| {
            telemetry::spawn(app.handle().clone());
            let _ = app.state::<state::AppState>().session();
            // The daily library backup, on its own connection so start-up does not wait.
            let st = app.state::<state::AppState>();
            if let Ok(lib) = st.job_library() {
                let dir = st.paths.backups.clone();
                let _ = std::thread::Builder::new().name("mixit-backup".into()).spawn(move || {
                    if let Err(e) = lib.auto_backup(&dir) {
                        eprintln!("daily library backup failed: {e}");
                    }
                });
            }
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("mixit-pads".into())
                .spawn(move || sampler::load_all(&handle.state::<state::AppState>()))
                .map_err(|e| e.to_string())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::studio_get,
            commands::studio_set,
            commands::scope_set,
            commands::action,
            commands::load_track,
            commands::seek,
            commands::scratch,
            commands::set_hot_cue,
            commands::delete_hot_cue,
            commands::set_main_cue,
            commands::grid_set,
            commands::set_memory_cue,
            commands::delete_memory_cue,
            commands::set_loop,
            commands::waveform,
            commands::library_search,
            commands::library_stats,
            commands::library_folders,
            commands::library_remove_folder,
            commands::library_missing,
            commands::library_find_missing,
            commands::library_relocate,
            commands::library_duplicates,
            commands::library_merge,
            commands::history_sessions,
            commands::history_of,
            commands::history_rename,
            commands::history_delete,
            commands::library_backups,
            commands::library_backup,
            commands::library_restore,
            commands::tags_list,
            commands::tags_of,
            commands::tags_set,
            commands::tag_rename,
            commands::tag_info,
            commands::tag_delete,
            commands::preview_load,
            commands::preview_play,
            commands::preview_seek,
            commands::preview_settings,
            commands::preview_sync,
            commands::preview_close,
            commands::save_text,
            commands::tracks_edit,
            commands::library_write_tags,
            commands::library_write_serato,
            commands::library_add,
            commands::library_import,
            commands::library_rescan,
            commands::practice_add,
            commands::library_analyze,
            commands::job_cancel,
            commands::track_detail,
            commands::track_artwork,
            commands::track_edit,
            commands::tracks_remove,
            commands::suggest_next,
            commands::sounds_like,
            listen::sound_listen,
            beats::grid_suggestion_use,
            beats::grid_reset,
            listen::sound_search,
            listen::sound_search_status,
            update::update_check,
            update::update_install,
            update::update_cancel,
            update::update_restart,
            commands::build_set,
            commands::playlists,
            commands::playlist_tracks,
            commands::playlist_create,
            commands::playlist_rename,
            commands::playlist_set_query,
            commands::playlist_delete,
            commands::playlist_add,
            commands::playlist_remove,
            commands::playlist_reorder,
            commands::playlist_move,
            commands::playlist_set_tracks,
            commands::tracks_copy_files,
            commands::playlist_order_set,
            commands::history,
            commands::history_tracklist,
            commands::audio_devices,
            commands::audio_status,
            commands::input_devices,
            commands::mic_status,
            commands::mic_record_start,
            commands::mic_record_stop,
            commands::settings_set,
            commands::record_start,
            commands::record_stop,
            commands::finish_mix,
            commands::automix,
            commands::project_save,
            commands::project_open,
            commands::project_check,
            commands::project_render,
            commands::project_render_stems,
            sound::sound_open,
            sound::sound_render,
            sound::sound_audio,
            sound::sound_save,
            sound::sound_close,
            commands::project_preview,
            commands::project_preview_play,
            commands::import_rekordbox,
            commands::import_traktor,
            commands::import_serato,
            commands::import_virtualdj,
            commands::export_rekordbox,
            commands::export_traktor,
            commands::export_playlist,
            commands::import_m3u,
            commands::sampler_load,
            commands::sampler_clear,
            commands::sampler_set,
            commands::sampler_reset,
            commands::sampler_stop_all,
            commands::sampler_sequence,
            commands::stems_split,
            commands::stems_cancel,
            windows::part_open,
            windows::part_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MixIt");
}
