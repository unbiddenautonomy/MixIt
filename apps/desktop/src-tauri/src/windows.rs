//! Extra windows: a part of the main screen (the library or the tools panel) opened on
//! another screen. Each is the same UI loaded with `?part=<name>`; it talks to the same
//! engine and hears the same events, and the main window keeps track of where each part
//! is (see `src/lib/screens.ts`). Closing a part's window puts the part back in the main
//! window; closing the main window quits the app.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};

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

/// Tells the main window when a part's window goes away, and quits with the main window.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    let app = window.app_handle();
    if let Some(part) = part_of(window.label()) {
        let _ = app.emit("part-closed", part);
    } else if window.label() == "main" {
        app.exit(0);
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
}
