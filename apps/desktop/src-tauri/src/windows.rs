//! Extra windows: a part of the main screen (the library or the tools panel) opened on
//! another screen. Each is the same UI loaded with `?part=<name>`; it talks to the same
//! engine and hears the same events, and the main window keeps track of where each part
//! is (see `src/lib/screens.ts`). Closing a part's window puts the part back in the main
//! window; closing the main window quits the app.
//!
//! The new layout (Settings > Display > New layout) has windows of its own instead: each
//! is the same UI loaded with `?win=<id>` ("w2", "w3"...), drawn from the layout the main
//! window sends it. The main window opens, moves and closes them (`win_open`, `win_close`)
//! to match the layout, and hears when the person moves or closes one (`win-moved`,
//! `win-closed`), so the layout follows.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent,
};

/// The parts that can have a window of their own, with the window's title.
pub const PARTS: &[(&str, &str)] = &[("library", "MixIt · Library"), ("tools", "MixIt · Tools")];

const PREFIX: &str = "part-";

/// The window label of a part.
pub fn label(part: &str) -> String {
    format!("{PREFIX}{part}")
}

/// The part a window shows, if it is a part window.
pub fn part_of(label: &str) -> Option<&str> {
    label.strip_prefix(PREFIX).filter(|p| PARTS.iter().any(|(q, _)| q == p))
}

/// A screen's area in physical pixels, as the UI reads it from the system.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
}

/// Opens (or moves) a part's window onto a screen and fills that screen with it.
#[tauri::command]
pub fn part_open(app: AppHandle, part: String, screen: ScreenRect) -> Result<(), String> {
    let title =
        PARTS.iter().find(|(p, _)| *p == part).map(|(_, t)| *t).ok_or_else(|| format!("no part called {part}"))?;
    let label = label(&part);
    let win = match app.get_webview_window(&label) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?part={part}").into()))
            .title(title)
            .inner_size(1100.0, 720.0)
            .min_inner_size(480.0, 360.0)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    // Move it onto the screen first (a maximised window would not move), then fill it.
    let _ = win.unmaximize();
    win.set_position(PhysicalPosition::new(screen.x + 40, screen.y + 40)).map_err(|e| e.to_string())?;
    let _ = win.maximize();
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

/// Closes a part's window (the part goes back into the main window).
#[tauri::command]
pub fn part_close(app: AppHandle, part: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label(&part)) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ------------------------------------------------------------------ the new layout's windows

const WIN_PREFIX: &str = "win-";

/// The window label of a layout window.
pub fn win_label(id: &str) -> String {
    format!("{WIN_PREFIX}{id}")
}

/// A layout window's id ("w2"...): `w` and up to three digits, nothing else.
fn valid_win(id: &str) -> bool {
    id.strip_prefix('w').is_some_and(|n| (1..=3).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The layout window a label belongs to, if it is one.
pub fn win_of(label: &str) -> Option<&str> {
    label.strip_prefix(WIN_PREFIX).filter(|id| valid_win(id))
}

/// Where a layout window goes, in physical pixels on the desktop.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct WinPlace {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// Filling its screen (maximised), full screen, or exactly this rectangle.
    pub fill: WinFill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WinFill {
    Max,
    Full,
    Rect,
}

/// Where a layout window is now, sent to the main window when the person moves it.
#[derive(Debug, Clone, Serialize)]
pub struct WinReport {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// Opens a layout window, or moves one that is open, to where the layout says. "main"
/// moves the main window (onto the screen the layout puts the decks on); it is never created here.
#[tauri::command]
pub fn win_open(app: AppHandle, id: String, title: String, place: WinPlace) -> Result<(), String> {
    let main = id == "main";
    if !main && !valid_win(&id) {
        return Err(format!("no window called {id}"));
    }
    let title: String = title.chars().take(120).collect();
    let label = if main { id.clone() } else { win_label(&id) };
    let (win, fresh) = match app.get_webview_window(&label) {
        Some(w) => (w, false),
        None if main => return Err("the main window is closed".into()),
        None => (
            WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?win={id}").into()))
                .title(&title)
                .inner_size(1100.0, 720.0)
                .min_inner_size(480.0, 320.0)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?,
            true,
        ),
    };
    if !main {
        let _ = win.set_title(&title);
    }
    // A full-screen or maximised window doesn't move (macOS ignores it), so step out first.
    if win.is_fullscreen().unwrap_or(false) {
        let _ = win.set_fullscreen(false);
    }
    let _ = win.unmaximize();
    let (w, h) = (place.w.max(480), place.h.max(320));
    match place.fill {
        WinFill::Rect => {
            win.set_size(PhysicalSize::new(w, h)).map_err(|e| e.to_string())?;
            win.set_position(PhysicalPosition::new(place.x, place.y)).map_err(|e| e.to_string())?;
        }
        WinFill::Max | WinFill::Full => {
            // Inside the screen first, so the system maximises it on that screen.
            win.set_position(PhysicalPosition::new(place.x + 40, place.y + 40)).map_err(|e| e.to_string())?;
            let _ = win.maximize();
        }
    }
    if place.fill == WinFill::Full {
        let _ = win.set_fullscreen(true);
    }
    if fresh {
        win.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Renames a layout window (what it holds changed) without moving it.
#[tauri::command]
pub fn win_title(app: AppHandle, id: String, title: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&win_label(&id)) {
        let title: String = title.chars().take(120).collect();
        w.set_title(&title).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Closes a layout window (the layout has already sent its parts elsewhere).
#[tauri::command]
pub fn win_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&win_label(&id)) {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The layout windows open now, by id: after the main window reloads it adopts these.
#[tauri::command]
pub fn win_list(app: AppHandle) -> Vec<String> {
    let mut ids: Vec<String> = app.webview_windows().keys().filter_map(|l| win_of(l).map(str::to_owned)).collect();
    ids.sort();
    ids
}

/// A window says whether it shows anything live; one that doesn't gets the engine's state less often.
#[tauri::command]
pub fn telemetry_rate(window: Window, state: tauri::State<'_, crate::state::AppState>, slow: bool) {
    let mut list = state.telemetry_slow.lock();
    let label = window.label().to_owned();
    list.retain(|l| *l != label);
    if slow {
        list.push(label);
    }
}

fn report(window: &Window, id: &str) -> Option<WinReport> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(WinReport {
        id: id.to_owned(),
        x: pos.x,
        y: pos.y,
        w: size.width,
        h: size.height,
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    })
}

/// Tells the main window when a part's or a layout window goes away or moves, and quits with the main window.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::Destroyed => {
            if let Some(state) = app.try_state::<crate::state::AppState>() {
                state.telemetry_slow.lock().retain(|l| l != window.label());
            }
            if let Some(part) = part_of(window.label()) {
                let _ = app.emit("part-closed", part);
            } else if let Some(id) = win_of(window.label()) {
                let _ = app.emit_to("main", "win-closed", id);
            } else if window.label() == "main" {
                app.exit(0);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let id = if window.label() == "main" { Some("main") } else { win_of(window.label()) };
            if let Some(r) = id.and_then(|id| report(window, id)) {
                let _ = app.emit_to("main", "win-moved", &r);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_round_trip() {
        for (p, _) in PARTS {
            assert_eq!(part_of(&label(p)), Some(*p));
        }
        assert_eq!(part_of("main"), None);
        assert_eq!(part_of("part-nothing"), None);
    }

    #[test]
    fn layout_window_labels() {
        for id in ["w2", "w3", "w12", "w999"] {
            assert_eq!(win_of(&win_label(id)), Some(id));
        }
        for bad in ["win-main", "win-w", "win-w1234", "win-x2", "win-w2/../x", "win-w2 ", "w2", "part-library"] {
            assert_eq!(win_of(bad), None, "{bad}");
        }
    }
}
