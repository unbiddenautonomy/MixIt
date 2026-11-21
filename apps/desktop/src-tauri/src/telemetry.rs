//! Streams engine state to the UI (~60 Hz), drains the recorder, logs played tracks.

use std::time::{Duration, Instant};

use mixit_engine::Event;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::DECKS;
use crate::dto::TelemetryDto;
use crate::state::AppState;

/// A deck counts as played (for history) after this long.
const PLAYED_SECONDS: f64 = 30.0;

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new().name("mixit-telemetry".into()).spawn(move || run(app)).expect("spawn telemetry thread");
}

fn run(app: AppHandle) {
    let period = Duration::from_millis(16);
    let mut last = Instant::now();
    let mut buf: Vec<f32> = Vec::with_capacity(48_000);
    let mut mic_buf: Vec<f32> = Vec::with_capacity(48_000);
    let mut scope_buf: Vec<f32> = Vec::with_capacity(16_384);
    let mut spectrum: Option<(u32, mixit_dsp::studio::Spectrum)> = None;
    let mut bands = [0.0f32; mixit_dsp::studio::SPECTRUM_BANDS];
    loop {
        std::thread::sleep(period);
        let now = Instant::now();
        let dt = (now - last).as_secs_f64();
        last = now;
        let state = app.state::<AppState>();
        let recording = state.recording.lock().is_some();
        let mic_recording = state.mic_recording.lock().is_some();
        let (dto, ended, tele) = {
            let mut a = state.audio.lock();
            a.ctl.collect_trash();
            let ended: Vec<u8> = a
                .ctl
                .events()
                .filter_map(|e| match e {
                    Event::TrackEnded { deck } => Some(deck.0),
                    _ => None,
                })
                .collect();
            let t = *a.ctl.telemetry();
            for d in 0..DECKS {
                let dt = &t.decks[d];
                a.dispatcher.observe_deck(d, dt.sync, dt.keylock, dt.looping.active);
            }
            if recording {
                a.ctl.drain_recorder(&mut buf);
            }
            if mic_recording {
                a.ctl.drain_capture(&mut mic_buf);
            }
            let s = a.stats.snapshot();
            let mut dto = TelemetryDto::new(&t, DECKS, a.sample_rate, s.load, s.overruns);
            if a.scope != mixit_engine::ScopeSource::Off {
                scope_buf.clear();
                a.ctl.drain_scope(&mut scope_buf);
                let sr = a.sample_rate;
                if spectrum.as_ref().is_none_or(|(r, _)| *r != sr) {
                    spectrum = Some((sr, mixit_dsp::studio::Spectrum::new(sr as f32)));
                }
                if let Some((_, sp)) = spectrum.as_mut() {
                    sp.push(&scope_buf);
                    sp.bands(&mut bands);
                    dto.spectrum = Some(bands.to_vec());
                }
            } else if spectrum.is_some() {
                spectrum = None;
            }
            (dto, ended, t)
        };
        if recording && !buf.is_empty() {
            if let Some(r) = state.recording.lock().as_mut() {
                if let Err(e) = r.writer.write(&buf) {
                    let _ = app.emit("error", format!("recording: {e}"));
                }
            }
            buf.clear();
        }
        if mic_recording && !mic_buf.is_empty() {
            if let Some(r) = state.mic_recording.lock().as_mut() {
                if let Err(e) = r.writer.write(&mic_buf) {
                    let _ = app.emit("error", format!("mic recording: {e}"));
                }
            }
            mic_buf.clear();
        }
        let _ = app.emit("telemetry", &dto);
        for d in ended {
            let _ = app.emit("deck-ended", d);
        }
        // History: a track counts once it has played for a while.
        let mut to_log = Vec::new();
        {
            let mut decks = state.decks.lock();
            for (i, slot) in decks.iter_mut().enumerate() {
                if let Some(d) = slot {
                    if tele.decks[i].playing && tele.decks[i].token == d.info.token {
                        d.played += dt;
                        if !d.logged && d.played >= PLAYED_SECONDS {
                            d.logged = true;
                            to_log.push((i as u8, d.track_id));
                        }
                    }
                }
            }
        }
        if !to_log.is_empty() {
            if let Some(s) = state.session() {
                let lib = state.library.lock();
                for (deck, id) in to_log {
                    let _ = lib.log_play(s, id, Some(deck));
                }
            }
            let _ = app.emit("history-changed", ());
        }
    }
}
