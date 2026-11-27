//! Make a track: ACE-Step 1.5 (MIT code and weights) makes a new track from a
//! description, on the person's own computer. It is a Python program, so it runs as a
//! helper server beside MixIt instead of inside it:
//!
//! * **Setting it up** (`make_install`, only when the person presses Set up): a copy of
//!   ACE-Step at a pinned commit goes into the models folder, and `uv` (Astral's Python
//!   manager, which the person installs once) fetches its Python and libraries there.
//!   The first track then downloads the models (several GB).
//! * **Making a track** (`make_track`): MixIt starts the helper if it isn't running
//!   (`uv run acestep-api` on 127.0.0.1), asks it for a track over its local HTTP API,
//!   waits, saves the WAV in the music folder's "Made" folder and adds it to the
//!   library. The helper stops when MixIt quits.
//!
//! Nothing leaves the computer except the one-time downloads.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mixit_host::platform::Os;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::dto::{JobProgress, TrackRow};
use crate::state::AppState;

type R<T> = Result<T, String>;

const REPO: &str = "https://github.com/ace-step/ACE-Step-1.5";
/// The ACE-Step commit set up (tested against its API).
pub const COMMIT: &str = "ca1e85fe9430179831e6bc6be790c332190a3866";
const PORT: u16 = 8001;
/// Longest wait for the helper to start (the first start downloads the models).
const START_TIMEOUT: Duration = Duration::from_secs(45 * 60);
/// Longest wait for one track.
const MAKE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

static CANCEL: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
static SERVER: Mutex<Option<Child>> = Mutex::new(None);
/// The helper's last lines, to say what it is doing or why it stopped.
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Where Make a track stands, for its dialog.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MakeStatus {
    /// The setting is on.
    pub enabled: bool,
    /// ACE-Step is set up in `folder`.
    pub installed: bool,
    pub folder: String,
    /// The helper is answering.
    pub running: bool,
    /// `uv` was found (needed to set it up and start it).
    pub uv: bool,
    /// The line that installs `uv`, for a terminal.
    pub uv_install: String,
    pub busy: bool,
}

/// What to make.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MakeRequest {
    /// The sound in words ("warm deep house with a rolling bassline and soft pads").
    pub description: String,
    /// Words to sing; empty makes an instrumental.
    pub lyrics: String,
    pub bpm: Option<u32>,
    /// "A minor", "C major"…
    pub key: Option<String>,
    pub seconds: f64,
    /// The file and track name (from the description when empty).
    pub name: String,
}

fn folder(state: &AppState) -> PathBuf {
    state
        .settings
        .lock()
        .make_track_folder
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| state.paths.models.join("ace-step"))
}

fn installed(dir: &Path) -> bool {
    dir.join("pyproject.toml").is_file() && dir.join(".venv").is_dir()
}

fn base() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// The helper's `data`, or its error.
fn api(resp: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> R<serde_json::Value> {
    let mut resp = resp.map_err(|e| format!("the track maker didn't answer: {e}"))?;
    let text = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| format!("the track maker said: {text}"))?;
    if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
        return Err(format!("the track maker said: {e}"));
    }
    Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

fn running() -> bool {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(2))).build().into();
    api(agent.get(&format!("{}/health", base())).call())
        .is_ok_and(|d| d.get("status").and_then(|s| s.as_str()) == Some("ok"))
}

fn has_uv(dir: &Path) -> bool {
    let cwd = if dir.is_dir() { dir.to_path_buf() } else { std::env::temp_dir() };
    crate::update::run_in_shell(&cwd, "uv --version", &AtomicBool::new(false), |_| {}).is_ok()
}

#[tauri::command]
pub async fn make_status(app: AppHandle) -> R<MakeStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let dir = folder(&state);
        Ok(MakeStatus {
            enabled: state.settings.lock().make_track,
            installed: installed(&dir),
            folder: dir.to_string_lossy().into_owned(),
            running: running(),
            uv: has_uv(&dir),
            uv_install: Os::current().uv_install_line().into(),
            busy: BUSY.load(Ordering::SeqCst),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn emit(app: &AppHandle, done: usize, total: usize, message: impl Into<String>) {
    let _ = app
        .emit("job", JobProgress { kind: "make", done, total, message: message.into(), finished: false, error: None });
}

fn finish(app: &AppHandle, result: R<String>) {
    BUSY.store(false, Ordering::SeqCst);
    let (message, error) = match result {
        Ok(m) => (m, None),
        Err(e) if e == crate::update::STOPPED => (String::new(), Some("Stopped".into())),
        Err(e) => (String::new(), Some(e)),
    };
    let _ = app.emit("job", JobProgress { kind: "make", done: 1, total: 1, message, finished: true, error });
}

fn start_job(app: AppHandle, work: impl FnOnce(&AppHandle) -> R<String> + Send + 'static) -> R<()> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("the track maker is already busy".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("mixit-make".into())
        .spawn(move || {
            let r = work(&app);
            finish(&app, r);
        })
        .map_err(|e| {
            BUSY.store(false, Ordering::SeqCst);
            e.to_string()
        })?;
    Ok(())
}

/// Sets ACE-Step up in its folder (a copy at [`COMMIT`], then `uv sync`).
#[tauri::command]
pub fn make_install(app: AppHandle) -> R<()> {
    let state = app.state::<AppState>();
    let dir = folder(&state);
    start_job(app, move |app| {
        if !has_uv(dir.parent().unwrap_or(&dir)) {
            return Err(format!(
                "MixIt needs uv to set up the track maker. Paste this into a terminal, then press Set up again:\n{}",
                Os::current().uv_install_line()
            ));
        }
        let parent = dir.parent().ok_or("no folder for the track maker")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let show = |l: &str| emit(app, 0, 0, format!("Setting up: {}", l.chars().take(120).collect::<String>()));
        if !dir.join(".git").is_dir() {
            emit(app, 0, 0, "Getting the track maker's code");
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "ace-step".into());
            crate::update::run_in_shell(parent, &format!("git clone --quiet {REPO} \"{name}\""), &CANCEL, show)?;
        } else {
            crate::update::run_in_shell(&dir, "git fetch --quiet origin", &CANCEL, show)?;
        }
        crate::update::run_in_shell(
            &dir,
            &format!("git -c advice.detachedHead=false checkout --quiet {COMMIT}"),
            &CANCEL,
            show,
        )?;
        emit(app, 0, 0, "Getting Python and the libraries it needs (a few GB, only once)");
        crate::update::run_in_shell(&dir, "uv sync", &CANCEL, show)?;
        Ok("The track maker is set up. The first track also downloads its models (several GB), so it takes a while."
            .into())
    })
}

/// Starts the helper (if it isn't answering already) and waits until it answers.
fn ensure_running(app: &AppHandle, dir: &Path) -> R<()> {
    if running() {
        return Ok(());
    }
    {
        let mut server = SERVER.lock();
        let alive = server.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none());
        if !alive {
            LOG.lock().clear();
            let os = Os::current();
            let (shell, args) = os.login_shell();
            let mut cmd = Command::new(shell);
            cmd.args(args)
                .arg(format!("exec uv run acestep-api --host 127.0.0.1 --port {PORT}"))
                .current_dir(dir)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            for (k, v) in os.ace_step_env(std::env::consts::ARCH == "aarch64") {
                cmd.env(k, v);
            }
            let mut child = cmd.spawn().map_err(|e| format!("couldn't start the track maker: {e}"))?;
            for out in [
                child.stdout.take().map(|o| Box::new(o) as Box<dyn std::io::Read + Send>),
                child.stderr.take().map(|e| Box::new(e) as Box<dyn std::io::Read + Send>),
            ]
            .into_iter()
            .flatten()
            {
                std::thread::spawn(move || {
                    for l in BufReader::new(out).lines().map_while(Result::ok) {
                        let mut log = LOG.lock();
                        log.push(l);
                        if log.len() > 40 {
                            log.remove(0);
                        }
                    }
                });
            }
            *server = Some(child);
        }
    }
    let t0 = Instant::now();
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(crate::update::STOPPED.into());
        }
        if running() {
            return Ok(());
        }
        if let Some(c) = SERVER.lock().as_mut()
            && let Ok(Some(status)) = c.try_wait()
        {
            let log = LOG.lock();
            let tail: Vec<&str> = log.iter().rev().take(6).rev().map(String::as_str).collect();
            return Err(format!("the track maker stopped ({status}):\n{}", tail.join("\n")));
        }
        if t0.elapsed() > START_TIMEOUT {
            return Err("the track maker took too long to start".into());
        }
        let last = LOG.lock().last().cloned().unwrap_or_default();
        emit(
            app,
            0,
            0,
            format!(
                "Starting the track maker ({} s; the first time it downloads its models){}",
                t0.elapsed().as_secs(),
                if last.is_empty() {
                    String::new()
                } else {
                    format!(": {}", last.chars().take(100).collect::<String>())
                }
            ),
        );
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// The body ACE-Step's `release_task` takes for a request.
pub fn task_body(r: &MakeRequest) -> serde_json::Value {
    let mut body = serde_json::json!({
        "prompt": r.description.trim(),
        "lyrics": if r.lyrics.trim().is_empty() { "[Instrumental]".to_string() } else { r.lyrics.trim().to_string() },
        "audio_duration": r.seconds.clamp(10.0, 600.0),
        "audio_format": "wav",
        "batch_size": 1,
        "time_signature": "4",
    });
    if let Some(b) = r.bpm.filter(|b| (30..=300).contains(b)) {
        body["bpm"] = b.into();
    }
    if let Some(k) = r.key.as_ref().filter(|k| !k.trim().is_empty()) {
        body["key_scale"] = k.trim().into();
    }
    body
}

/// The track's name: the one asked for, else the description's first words.
pub fn track_name(r: &MakeRequest) -> String {
    let n = r.name.trim();
    if !n.is_empty() {
        return n.to_string();
    }
    let words: Vec<&str> = r.description.split_whitespace().take(6).collect();
    let mut s = if words.is_empty() { "New track".to_string() } else { words.join(" ") };
    if let Some(c) = s.get(..1) {
        s = c.to_uppercase() + &s[1..];
    }
    s
}

/// Asks the helper at `base` for a track, checks every `every` until it is made
/// (telling `waited` the seconds so far) and saves it at `path`.
pub fn fetch_track(
    base: &str,
    request: &MakeRequest,
    path: &Path,
    every: Duration,
    mut waited: impl FnMut(u64),
) -> R<()> {
    let id = api(ureq::post(&format!("{base}/release_task")).send_json(task_body(request)))?
        .get("task_id")
        .and_then(|t| t.as_str())
        .map(str::to_owned)
        .ok_or("the track maker didn't take the request")?;
    let t0 = Instant::now();
    let file = loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(crate::update::STOPPED.into());
        }
        if t0.elapsed() > MAKE_TIMEOUT {
            return Err("the track took too long to make".into());
        }
        std::thread::sleep(every);
        let data =
            api(ureq::post(&format!("{base}/query_result")).send_json(serde_json::json!({ "task_id_list": [id] })))?;
        let task = data.get(0).cloned().unwrap_or_default();
        match task.get("status").and_then(|s| s.as_i64()) {
            Some(1) => {
                // `result` is a list of made tracks, as JSON text.
                let result: serde_json::Value = task
                    .get("result")
                    .and_then(|r| r.as_str())
                    .and_then(|r| serde_json::from_str(r).ok())
                    .unwrap_or_default();
                break result
                    .get(0)
                    .and_then(|r| r.get("file"))
                    .and_then(|f| f.as_str())
                    .map(str::to_owned)
                    .ok_or("the track maker made nothing")?;
            }
            Some(2) => return Err("the track maker couldn't make it".into()),
            _ => waited(t0.elapsed().as_secs()),
        }
    };
    let url = if file.starts_with("http") { file } else { format!("{base}{file}") };
    let mut resp = ureq::get(&url).call().map_err(|e| format!("couldn't fetch the track: {e}"))?;
    let mut out = std::fs::File::create(path).map_err(|e| e.to_string())?;
    std::io::copy(&mut resp.body_mut().as_reader(), &mut out).map_err(|e| e.to_string())?;
    Ok(())
}

/// Makes a track and adds it to the library; the "make" job's message says which.
#[tauri::command]
pub fn make_track(app: AppHandle, request: MakeRequest) -> R<()> {
    let state = app.state::<AppState>();
    if !state.settings.lock().make_track {
        return Err("Make a track is off in Settings".into());
    }
    let dir = folder(&state);
    if !installed(&dir) {
        return Err("Set up the track maker first".into());
    }
    if request.description.trim().is_empty() {
        return Err("Describe the track to make".into());
    }
    start_job(app, move |app| {
        ensure_running(app, &dir)?;
        emit(app, 0, 0, "Making the track");
        let state = app.state::<AppState>();
        std::fs::create_dir_all(&state.paths.made).map_err(|e| e.to_string())?;
        let name = track_name(&request);
        let mut path = state.paths.made.join(format!("{}.wav", mixit_library::m3u::safe_file_name(&name)));
        let mut n = 2;
        while path.exists() {
            path = state.paths.made.join(format!("{} {n}.wav", mixit_library::m3u::safe_file_name(&name)));
            n += 1;
        }
        fetch_track(&base(), &request, &path, Duration::from_secs(2), |secs| {
            emit(app, 0, 0, format!("Making the track ({secs} s)"))
        })?;
        let row: TrackRow = {
            let lib = state.library.lock();
            let id = match lib.import_file(&path).map_err(|e| e.to_string())? {
                mixit_library::scan::Imported::Added(id)
                | mixit_library::scan::Imported::Updated(id)
                | mixit_library::scan::Imported::Moved(id)
                | mixit_library::scan::Imported::Unchanged(id) => id,
            };
            let edit = mixit_library::TrackEdit {
                title: Some(name.clone()),
                comment: Some(format!("Made with MixIt from: {}", request.description.trim())),
                ..Default::default()
            };
            let _ = lib.edit_track(id, &edit);
            TrackRow::from(&lib.track(id).map_err(|e| e.to_string())?)
        };
        let _ = app.emit("library-changed", ());
        Ok(serde_json::json!({ "trackId": row.id, "path": path.to_string_lossy() }).to_string())
    })
}

#[tauri::command]
pub fn make_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Stops the helper if MixIt started it (when MixIt quits).
pub fn stop_server() {
    if let Some(mut c) = SERVER.lock().take() {
        let (prog, args) = Os::current().stop_process(c.id());
        let _ = Command::new(prog).args(args).status();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(3) {
            if c.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = c.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for ACE-Step's API: takes the task, says "running" once, then done,
    /// and serves the file. Returns the requests it saw.
    fn fake_ace_step() -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let h = std::thread::spawn(move || {
            let mut seen = Vec::new();
            let mut polls = 0;
            for stream in l.incoming().take(4) {
                let mut s = stream.unwrap();
                let mut buf = vec![0u8; 65_536];
                let mut got = 0;
                // Read the head, then the body by its length.
                loop {
                    got += s.read(&mut buf[got..]).unwrap();
                    let text = String::from_utf8_lossy(&buf[..got]).to_string();
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if got >= i + 4 + len {
                            break;
                        }
                    }
                }
                let req = String::from_utf8_lossy(&buf[..got]).to_string();
                let line = req.lines().next().unwrap().to_string();
                let (ctype, body): (&str, Vec<u8>) = if line.starts_with("POST /release_task") {
                    (
                        "application/json",
                        br#"{"data":{"task_id":"t1","status":"queued"},"code":200,"error":null}"#.to_vec(),
                    )
                } else if line.starts_with("POST /query_result") {
                    polls += 1;
                    let data = if polls == 1 {
                        r#"[{"task_id":"t1","status":0}]"#.to_string()
                    } else {
                        r#"[{"task_id":"t1","status":1,"result":"[{\"file\": \"/v1/audio?path=%2Ftmp%2Fa.wav\", \"status\": 1}]"}]"#.to_string()
                    };
                    ("application/json", format!(r#"{{"data":{data},"code":200,"error":null}}"#).into_bytes())
                } else {
                    ("audio/wav", b"RIFF-fake-wav".to_vec())
                };
                write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                s.write_all(&body).unwrap();
                seen.push(req);
            }
            seen
        });
        (base, h)
    }

    #[test]
    fn a_track_is_asked_for_waited_on_and_saved() {
        let (base, server) = fake_ace_step();
        let dir = std::env::temp_dir().join(format!("mixit-make-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Sunrise.wav");
        let r =
            MakeRequest { description: "sunrise house".into(), bpm: Some(120), seconds: 30.0, ..Default::default() };
        let mut waits = 0;
        fetch_track(&base, &r, &path, Duration::from_millis(10), |_| waits += 1).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"RIFF-fake-wav");
        assert_eq!(waits, 1);
        let seen = server.join().unwrap();
        let body =
            |req: &str| -> serde_json::Value { serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap() };
        assert_eq!(body(&seen[0])["prompt"], "sunrise house");
        assert_eq!(body(&seen[0])["bpm"], 120);
        assert_eq!(body(&seen[1])["task_id_list"][0], "t1");
        assert!(seen[3].starts_with("GET /v1/audio?path=%2Ftmp%2Fa.wav"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_request_becomes_ace_step_s_task() {
        let r = MakeRequest {
            description: "  warm deep house with a rolling bassline ".into(),
            bpm: Some(122),
            key: Some("A minor".into()),
            seconds: 5.0,
            ..Default::default()
        };
        let b = task_body(&r);
        assert_eq!(b["prompt"], "warm deep house with a rolling bassline");
        assert_eq!(b["lyrics"], "[Instrumental]");
        assert_eq!(b["bpm"], 122);
        assert_eq!(b["key_scale"], "A minor");
        assert_eq!(b["audio_duration"], 10.0);
        assert_eq!(b["audio_format"], "wav");
        assert!(task_body(&MakeRequest { bpm: Some(500), ..Default::default() }).get("bpm").is_none());
        assert_eq!(track_name(&r), "Warm deep house with a rolling");
        assert_eq!(track_name(&MakeRequest { name: "Sunrise".into(), ..r }), "Sunrise");
        assert_eq!(track_name(&MakeRequest::default()), "New track");
    }
}
