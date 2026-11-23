//! Shared app state behind the Tauri commands.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use mixit_core::Beatgrid;
use mixit_host::HostConfig;
use mixit_host::recorder::StreamingWav;
use mixit_library::Library;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::audio::{Audio, DECKS};
use crate::dto::DeckInfo;

pub struct Paths {
    pub db: PathBuf,
    pub cache: PathBuf,
    pub recordings: PathBuf,
    pub projects: PathBuf,
    /// Generated practice tracks for the guide's labs.
    pub practice: PathBuf,
    /// Library backups (daily automatic ones and those made by hand).
    pub backups: PathBuf,
}

impl Paths {
    pub fn default_paths() -> Paths {
        // Each system's folders come from one table, tested for all three.
        let d = mixit_host::platform::AppDirs::system();
        Paths {
            db: d.db,
            cache: d.cache,
            recordings: d.music.join("Recordings"),
            projects: d.music.join("Mixes"),
            practice: d.music.join("Practice"),
            backups: d.backups,
        }
    }
}

/// A track on a deck, as the control side knows it.
pub struct LoadedDeck {
    pub info: DeckInfo,
    pub track_id: i64,
    pub grid: Beatgrid,
    /// Engine sample rate the deck track was loaded at.
    pub sample_rate: u32,
    /// Seconds this deck has played since it was loaded (for history).
    pub played: f64,
    pub logged: bool,
}

pub struct Recording {
    pub writer: StreamingWav,
    pub started: std::time::Instant,
}

/// A mic recording in progress.
pub struct MicRecording {
    pub writer: StreamingWav,
}

/// User preferences kept in the library's settings table.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub device: Option<String>,
    pub buffer_frames: u32,
    pub sample_rate: Option<u32>,
    pub cue_channel: Option<u16>,
    /// "camelot" | "openKey" | "standard"
    pub key_notation: String,
    /// "easy" | "pro"
    pub view_mode: String,
    pub theme: String,
    pub decks: u8,
    pub explain: bool,
    pub coach: bool,
    pub record_float: bool,
    pub auto_gain: bool,
    pub limiter: bool,
    pub tempo_range: f64,
    /// Opens the input device for the mic channel at start (off until the person asks:
    /// opening a mic shows the system's recording indicator).
    pub mic_enabled: bool,
    /// Input device id; `None` = the system's default input.
    pub mic_device: Option<String>,
    pub mic_channel: u16,
    pub mic_stereo: bool,
    /// Raising a channel fader from the bottom starts its deck; closing it stops the
    /// deck and goes back to the cue point.
    pub fader_start: bool,
    /// Loops the end of the only track playing so the music never stops.
    pub safety_loop: bool,
    /// A text file that gets the track now playing, for streaming software to show.
    pub now_playing_file: Option<String>,
    /// The line written there, with {artist} {title} {album} {genre} {label} {bpm} {key}.
    pub now_playing_format: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            device: None,
            buffer_frames: mixit_host::platform::Os::current().profile().buffer_frames,
            sample_rate: None,
            cue_channel: None,
            key_notation: "camelot".into(),
            view_mode: "easy".into(),
            theme: "dark".into(),
            decks: 2,
            explain: false,
            coach: true,
            record_float: false,
            auto_gain: true,
            limiter: true,
            tempo_range: 0.08,
            mic_enabled: false,
            mic_device: None,
            mic_channel: 0,
            mic_stereo: false,
            fader_start: false,
            safety_loop: true,
            now_playing_file: None,
            now_playing_format: crate::nowplaying::DEFAULT_FORMAT.into(),
        }
    }
}

impl Settings {
    pub fn load(lib: &Library) -> Settings {
        lib.setting("app").ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn save(&self, lib: &Library) -> Result<(), String> {
        lib.set_setting("app", &serde_json::to_string(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    pub fn input_config(&self) -> mixit_host::input::InputConfig {
        mixit_host::input::InputConfig {
            device: self.mic_device.clone(),
            channel: self.mic_channel,
            stereo: self.mic_stereo,
            buffer_frames: Some(self.buffer_frames.clamp(32, 4096)),
        }
    }

    pub fn host_config(&self) -> HostConfig {
        HostConfig {
            device: self.device.clone(),
            sample_rate: self.sample_rate,
            buffer_frames: Some(self.buffer_frames.clamp(32, 4096)),
            master_channel: 0,
            cue_channel: self.cue_channel,
        }
    }
}

pub struct AppState {
    pub paths: Paths,
    pub audio: Mutex<Audio>,
    pub library: Mutex<Library>,
    pub decks: Mutex<Vec<Option<LoadedDeck>>>,
    pub settings: Mutex<Settings>,
    pub recording: Mutex<Option<Recording>>,
    pub mic_recording: Mutex<Option<MicRecording>>,
    /// Why the mic could not be opened, for the UI.
    pub mic_error: Mutex<Option<String>>,
    pub session: Mutex<Option<i64>>,
    /// Set while a library job (scan, analysis) runs; setting `cancel` stops it.
    pub job_running: Arc<AtomicBool>,
    pub job_cancel: Arc<AtomicBool>,
    pub render_cancel: Arc<AtomicBool>,
    pub next_token: Mutex<u64>,
    pub pads: Mutex<Vec<crate::sampler::PadInfo>>,
    /// The latest preview request: (token, track id).
    pub preview: Mutex<Option<(u64, i64)>>,
}

impl AppState {
    pub fn new(paths: Paths) -> Result<AppState, String> {
        if let Some(dir) = paths.db.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let library = Library::open(&paths.db).map_err(|e| format!("library {}: {e}", paths.db.display()))?;
        let settings = Settings::load(&library);
        let pads = crate::sampler::load_saved(&library);
        let audio = Audio::start(&settings.host_config());
        let state = AppState {
            paths,
            audio: Mutex::new(audio),
            library: Mutex::new(library),
            decks: Mutex::new((0..DECKS).map(|_| None).collect()),
            settings: Mutex::new(settings),
            recording: Mutex::new(None),
            mic_recording: Mutex::new(None),
            mic_error: Mutex::new(None),
            session: Mutex::new(None),
            job_running: Arc::new(AtomicBool::new(false)),
            job_cancel: Arc::new(AtomicBool::new(false)),
            render_cancel: Arc::new(AtomicBool::new(false)),
            preview: Mutex::new(None),
            next_token: Mutex::new(1),
            pads: Mutex::new(pads),
        };
        state.apply_mixer_settings();
        state.apply_mic_settings();
        Ok(state)
    }

    pub fn apply_mixer_settings(&self) {
        let s = self.settings.lock().clone();
        let mut a = self.audio.lock();
        use mixit_engine::{Command, DeckCommand, MixerCommand};
        a.send(Command::Mixer(MixerCommand::SetAutoGain(s.auto_gain)));
        a.send(Command::Mixer(MixerCommand::SetLimiter(s.limiter)));
        for d in 0..DECKS {
            a.send(Command::Deck(mixit_core::DeckId(d as u8), DeckCommand::SetTempoRange(s.tempo_range)));
        }
    }

    /// Opens or closes the input device as the settings say.
    pub fn apply_mic_settings(&self) {
        let s = self.settings.lock().clone();
        let mut a = self.audio.lock();
        let err = if s.mic_enabled {
            a.open_mic(&s.input_config()).err()
        } else {
            a.close_mic();
            None
        };
        *self.mic_error.lock() = err;
    }

    /// A second connection for background jobs (SQLite WAL allows concurrent readers and
    /// one writer), so the UI's library calls are not blocked by a long scan.
    pub fn job_library(&self) -> Result<Library, String> {
        Library::open(&self.paths.db).map_err(|e| e.to_string())
    }

    pub fn token(&self) -> u64 {
        let mut t = self.next_token.lock();
        *t += 1;
        *t
    }

    pub fn session(&self) -> Option<i64> {
        let mut s = self.session.lock();
        if s.is_none() {
            let name = format!("Session {}", chrono_like_now());
            *s = self.library.lock().start_session(&name).ok();
        }
        *s
    }

    pub fn is_job_running(&self) -> bool {
        self.job_running.load(Ordering::Relaxed)
    }
}

/// "2026-11-21 14:05" in UTC without pulling in a date crate.
pub fn chrono_like_now() -> String {
    let secs =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, rem / 60 % 60)
}

#[cfg(test)]
mod tests {
    #[test]
    fn date_format() {
        let s = super::chrono_like_now();
        assert_eq!(s.len(), 16);
        assert!(s.starts_with("20"));
    }
}
