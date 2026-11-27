//! Updating MixIt from its own source: while we test, the app is built from a git
//! checkout on the same computer. Update fetches that checkout, pulls the new commits,
//! rebuilds and puts the new app in place of the running one; a restart starts it.
//!
//! Nothing is downloaded but the code itself (no installers, no GitHub build minutes).
//! It needs git, Node and Rust there, the way the person's terminal finds them
//! (`platform::Os::login_shell`). The checkout must have no unsaved changes: Update never
//! overwrites someone's own edits. Replacing the app works on macOS so far; elsewhere
//! Check still says what's new.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mixit_host::platform::Os;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::dto::JobProgress;
use crate::state::AppState;

type R<T> = Result<T, String>;

/// The commit this copy was built from ("" when it wasn't built from a checkout).
pub const BUILT_FROM: &str = env!("MIXIT_COMMIT");
/// The checkout it was built from.
const SOURCE: &str = env!("MIXIT_SOURCE");

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Where Update stands, for Settings.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Update can rebuild and replace this app.
    pub can_install: bool,
    /// Why not, in plain words (also when checking failed).
    pub problem: Option<String>,
    /// The checkout it updates from.
    pub source: String,
    pub branch: String,
    /// Short commit ids: what's running, and the newest on the branch.
    pub current: String,
    pub latest: String,
    /// New commits waiting, newest first (their subjects), at most 20.
    pub changes: Vec<String>,
    pub waiting: usize,
    /// An update is being built right now.
    pub running: bool,
}

/// The checkout to update from: the one in Settings, else the one it was built from.
fn source(app: &AppHandle) -> PathBuf {
    let chosen = app.state::<AppState>().settings.lock().update_source.clone();
    PathBuf::from(chosen.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| SOURCE.to_string()))
}

fn git(dir: &Path, args: &[&str]) -> R<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git didn't run: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn short(c: &str) -> String {
    c.chars().take(7).collect()
}

/// Fetches the checkout and says what's new since this copy was built.
#[tauri::command(async)]
pub fn update_check(app: AppHandle) -> R<UpdateStatus> {
    let os = Os::current();
    let dir = source(&app);
    let mut st = UpdateStatus {
        source: dir.to_string_lossy().into_owned(),
        current: short(BUILT_FROM),
        running: RUNNING.load(Ordering::SeqCst),
        ..Default::default()
    };
    if !dir.join(".git").exists() {
        st.problem = Some(format!(
            "MixIt updates from the folder it was built in, and {} isn't one. Choose the MixIt folder in Settings.",
            st.source
        ));
        return Ok(st);
    }
    st.branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if let Err(e) = git(&dir, &["fetch", "--quiet", "origin", &st.branch]) {
        st.problem = Some(format!("Couldn't reach GitHub to check for changes: {e}"));
        return Ok(st);
    }
    let latest = git(&dir, &["rev-parse", "FETCH_HEAD"])?;
    st.latest = short(&latest);
    let from = if BUILT_FROM.is_empty() { git(&dir, &["rev-parse", "HEAD"])? } else { BUILT_FROM.to_string() };
    st.waiting = git(&dir, &["rev-list", "--count", &format!("{from}..{latest}")])
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    st.changes = git(&dir, &["log", "--no-merges", "--format=%s", "-20", &format!("{from}..{latest}")])
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    st.can_install = os.installed_app(&exe).is_some();
    if !st.can_install && st.problem.is_none() {
        st.problem = Some(if os == Os::MacOs {
            "This copy isn't an installed app (it's running from the build folder), so there's nothing to replace."
                .into()
        } else {
            "Updating in place works on macOS so far. Here, pull and rebuild from the terminal.".into()
        });
    }
    Ok(st)
}

fn emit(app: &AppHandle, done: usize, total: usize, message: impl Into<String>) {
    let _ = app.emit(
        "job",
        JobProgress { kind: "update", done, total, message: message.into(), finished: false, error: None },
    );
}

/// Runs a command line through the login shell in `dir`, passing each line it prints to
/// `line`. Stops it when Update is cancelled.
fn run(dir: &Path, cmd: &str, line: impl FnMut(&str)) -> R<()> {
    run_in_shell(dir, cmd, &CANCEL, line).map_err(|e| if e == STOPPED { "Update stopped".into() } else { e })
}

/// What [`run_in_shell`] returns when `cancel` stopped it.
pub(crate) const STOPPED: &str = "stopped";

/// Runs a command line through the login shell in `dir` (so the tools the person's
/// terminal finds are found), passing each line it prints to `line`, until it ends or
/// `cancel` is set. Fails with the last lines it printed.
pub(crate) fn run_in_shell(dir: &Path, cmd: &str, cancel: &AtomicBool, mut line: impl FnMut(&str)) -> R<()> {
    let (shell, args) = Os::current().login_shell();
    let mut child = Command::new(shell)
        .args(args)
        .arg(cmd)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start {cmd}: {e}"))?;
    // Both outputs, line by line, through one channel (cargo prints its progress on stderr).
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            BufReader::new(out).lines().map_while(Result::ok).for_each(|l| drop(tx.send(l)))
        }));
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            BufReader::new(err).lines().map_while(Result::ok).for_each(|l| drop(tx.send(l)))
        }));
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    loop {
        while let Ok(l) = rx.try_recv() {
            line(&l);
            tail.push(l);
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(STOPPED.into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            for r in readers {
                let _ = r.join();
            }
            for l in rx.try_iter() {
                tail.push(l);
            }
            if status.success() {
                return Ok(());
            }
            let last: Vec<&String> = tail.iter().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
            return Err(format!("{cmd} failed:\n{}", last.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Puts the app at `new` where `old` is, keeping the old one until the new one is in.
/// The built copy is removed afterwards, so the system doesn't list a second MixIt.
fn replace(old: &Path, new: &Path) -> R<()> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let aside = old.with_extension(format!("app.old-{stamp}"));
    std::fs::rename(old, &aside).map_err(|e| format!("Couldn't move the old app aside ({}): {e}", old.display()))?;
    // `ditto` copies a bundle exactly (links, permissions), across disks too.
    let copied = Command::new("ditto").arg(new).arg(old).status();
    if !copied.map(|s| s.success()).unwrap_or(false) {
        let _ = std::fs::remove_dir_all(old);
        let _ = std::fs::rename(&aside, old);
        return Err(format!("Couldn't copy the new app into {}", old.display()));
    }
    let _ = std::fs::remove_dir_all(&aside);
    let _ = std::fs::remove_dir_all(new);
    Ok(())
}

fn install(app: &AppHandle) -> R<String> {
    let os = Os::current();
    let dir = source(app);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = os.installed_app(&exe).ok_or("This copy of MixIt can't replace itself (see Settings, Updates).")?;
    let built = os.built_app(&dir).ok_or("This system can't update in place yet.")?;
    let dirty = git(&dir, &["status", "--porcelain", "--untracked-files=no"])?;
    if !dirty.is_empty() {
        return Err(format!(
            "There are changes in {} that aren't saved to git, so Update won't touch it. Commit or discard them, then update.",
            dir.display()
        ));
    }
    const STEPS: usize = 4;
    emit(app, 0, STEPS, "Getting the new code");
    let before = git(&dir, &["rev-parse", "HEAD"])?;
    git(&dir, &["pull", "--ff-only", "--quiet"]).map_err(|e| format!("Couldn't get the new code: {e}"))?;
    let after = git(&dir, &["rev-parse", "HEAD"])?;
    let ui = dir.join("apps/desktop");
    let lock_changed =
        !git(&dir, &["diff", "--name-only", &before, &after, "--", "apps/desktop/package-lock.json"])?.is_empty();
    if lock_changed || !ui.join("node_modules").exists() {
        emit(app, 1, STEPS, "Getting the app's building blocks (npm)");
        run(&ui, "npm ci --no-audit --no-fund", |_| {})?;
    }
    emit(app, 2, STEPS, "Building MixIt (about 5 to 15 minutes; you can keep using it)");
    let started = Instant::now();
    let mut last = Instant::now();
    let cmd = format!("npm run tauri build -- {}", os.bundle_args().join(" "));
    run(&ui, &cmd, |l| {
        // cargo's "Compiling foo v1.2" lines show it's moving.
        let l = l.trim();
        if last.elapsed() > Duration::from_millis(700)
            && (l.starts_with("Compiling") || l.starts_with("Bundling") || l.starts_with("Finished"))
        {
            last = Instant::now();
            let mins = started.elapsed().as_secs() / 60;
            emit(app, 2, STEPS, format!("Building MixIt ({mins} min so far): {l}"));
        }
    })?;
    if !built.exists() {
        return Err(format!("The build finished but the app isn't at {}", built.display()));
    }
    emit(app, 3, STEPS, "Putting the new MixIt in place");
    replace(&target, &built)?;
    Ok(format!("MixIt is updated to {}. Restart it to use the new version.", short(&after)))
}

/// Pulls, rebuilds and replaces this app, reporting as job "update".
#[tauri::command]
pub fn update_install(app: AppHandle) -> R<()> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("MixIt is already updating".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("mixit-update".into())
        .spawn(move || {
            let r = install(&app);
            let (message, error) = match r {
                Ok(m) => (m, None),
                Err(e) => (String::new(), Some(e)),
            };
            let _ = app.emit("job", JobProgress { kind: "update", done: 0, total: 0, message, finished: true, error });
            RUNNING.store(false, Ordering::SeqCst);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Starts the new app (after `update_install`) in place of this one.
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    app.restart();
}
