//! The MixIt desktop app: a Tauri shell around the engine, library and jobs. The UI
//! (React, in `apps/desktop/src`) talks to it through the commands in [`commands`] and
//! listens to the events "telemetry", "deck-loaded", "deck-ended", "job",
//! "library-changed", "history-changed", "audio-status" and "error".

pub mod audio;
pub mod commands;
pub mod dto;
pub mod state;
pub mod telemetry;

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
        .setup(|app| {
            telemetry::spawn(app.handle().clone());
            let _ = app.state::<state::AppState>().session();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::action,
            commands::load_track,
            commands::seek,
            commands::scratch,
            commands::set_hot_cue,
            commands::delete_hot_cue,
            commands::set_main_cue,
            commands::set_loop,
            commands::waveform,
            commands::library_search,
            commands::library_stats,
            commands::library_folders,
            commands::library_remove_folder,
            commands::library_add,
            commands::library_rescan,
            commands::library_analyze,
            commands::job_cancel,
            commands::track_detail,
            commands::track_edit,
            commands::tracks_remove,
            commands::suggest_next,
            commands::playlists,
            commands::playlist_tracks,
            commands::playlist_create,
            commands::playlist_rename,
            commands::playlist_set_query,
            commands::playlist_delete,
            commands::playlist_add,
            commands::playlist_remove,
            commands::playlist_reorder,
            commands::playlist_order_set,
            commands::history,
            commands::history_tracklist,
            commands::audio_devices,
            commands::audio_status,
            commands::settings_set,
            commands::record_start,
            commands::record_stop,
            commands::automix,
            commands::project_save,
            commands::project_open,
            commands::project_check,
            commands::project_render,
            commands::project_preview,
            commands::import_rekordbox,
            commands::export_rekordbox,
            commands::export_playlist,
            commands::import_m3u,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MixIt");
}
