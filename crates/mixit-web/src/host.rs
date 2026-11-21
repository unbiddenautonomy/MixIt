//! The engine host for the browser: the same engine, dispatcher and telemetry view as the
//! desktop app, driven by an AudioWorklet instead of a native audio callback.
//!
//! The worklet calls [`Host::process`] for every render quantum and [`Host::poll`] about
//! 60 times a second; everything else (actions, loading, cues) arrives as small JSON
//! calls through [`Host::call`] between quanta.

use std::sync::Arc;

use mixit_core::{Beatgrid, DeckId, Key};
use mixit_engine::actions::{ActionDispatcher, ActionError, ActionInput};
use mixit_engine::commands::{Command, DeckCommand, GlobalCommand, PadMode, SamplerCommand};
use mixit_engine::view::TelemetryDto;
use mixit_engine::{Controller, CueKind, DeckTrack, Engine, EngineConfig, Event, HOT_CUES, HotCue, TrackAudio};
use mixit_stretch::PhaseVocoder;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::tools::GridView;

pub const DECKS: usize = 4;
pub const PADS: usize = 8;
/// Largest block the worklet may ask for in one call (it uses 128).
pub const MAX_BLOCK: usize = 4_096;

struct Slot {
    grid: Beatgrid,
    key: Option<Key>,
    /// Track length in seconds, for listing a warped grid's beats.
    duration: f64,
}

pub struct Host {
    engine: Engine,
    ctl: Controller,
    dispatcher: ActionDispatcher,
    sr: u32,
    master: Vec<f32>,
    cue: Vec<f32>,
    decks: [Option<Slot>; DECKS],
    next_token: u64,
    ended: Vec<u8>,
}

/// What the page sends with a track: where it starts and its saved cues.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LoadOptions {
    pub grid: Option<Beatgrid>,
    /// Camelot code of the analysed key ("8A"), for Match key.
    pub key: Option<String>,
    pub auto_gain_db: f32,
    /// Main cue (seconds).
    pub cue: f64,
    pub hot_cues: Vec<SavedHotCue>,
    /// Where to put the play head (seconds); defaults to the cue.
    pub start: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedHotCue {
    pub slot: u8,
    pub seconds: f64,
    pub loop_seconds: Option<f64>,
    pub color: Option<u32>,
}

/// Settings for a sampler pad.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadSettings {
    pub mode: usize,
    pub gain_db: f32,
    pub pan: f32,
    pub sync: bool,
    pub quantized: bool,
}

#[derive(Serialize)]
pub struct Poll {
    pub t: TelemetryDto,
    /// Decks that reached the end since the last poll.
    pub ended: Vec<u8>,
}

impl Host {
    /// Allocates the engine, a stretcher per deck and the render buffers.
    pub fn new(sample_rate: u32) -> Host {
        let (engine, mut ctl) = Engine::new(EngineConfig {
            sample_rate,
            decks: DECKS,
            pads: PADS,
            telemetry_rate: 60.0,
            ..Default::default()
        });
        for d in 0..DECKS {
            let _ = ctl.deck(DeckId(d as u8), DeckCommand::SetStretcher(Box::new(PhaseVocoder::new(sample_rate))));
        }
        Host {
            engine,
            ctl,
            dispatcher: ActionDispatcher::new(sample_rate, DECKS),
            sr: sample_rate,
            master: vec![0.0; MAX_BLOCK * 2],
            cue: vec![0.0; MAX_BLOCK * 2],
            decks: Default::default(),
            next_token: 1,
            ended: Vec::with_capacity(DECKS),
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr
    }

    /// Renders `frames` (at most [`MAX_BLOCK`]) and returns interleaved master and cue.
    pub fn process(&mut self, frames: usize) -> (&[f32], &[f32]) {
        let n = frames.min(MAX_BLOCK);
        self.engine.process(&mut self.master[..n * 2], &mut self.cue[..n * 2]);
        (&self.master[..n * 2], &self.cue[..n * 2])
    }

    /// The headphone cue of the last [`Host::process`] call (interleaved).
    pub fn cue_buffer(&self) -> &[f32] {
        &self.cue
    }

    /// Latest engine state for the UI, and decks that ended since the last poll.
    pub fn poll(&mut self) -> Poll {
        self.ctl.collect_trash();
        self.ended.clear();
        for e in self.ctl.events() {
            if let Event::TrackEnded { deck } = e {
                self.ended.push(deck.0);
            }
        }
        let t = *self.ctl.telemetry();
        for d in 0..DECKS {
            let dt = &t.decks[d];
            self.dispatcher.observe_deck(d, dt.sync, dt.keylock, dt.looping.active);
        }
        Poll { t: TelemetryDto::new(&t, DECKS, self.sr, 0.0, 0), ended: self.ended.clone() }
    }

    fn send(&mut self, c: Command) {
        // A full command ring drops the command; the UI state is re-sent on the next change.
        let _ = self.ctl.send(c);
    }

    fn deck_cmd(&mut self, deck: usize, c: DeckCommand) -> Result<(), String> {
        if deck >= DECKS {
            return Err(format!("no deck {deck}"));
        }
        self.send(Command::Deck(DeckId(deck as u8), c));
        Ok(())
    }

    /// Loads interleaved stereo `audio` (at the engine rate) onto a deck. Returns the token
    /// the telemetry will carry for it.
    pub fn load(&mut self, deck: usize, audio: Vec<f32>, opts: LoadOptions) -> Result<u64, String> {
        if deck >= DECKS {
            return Err(format!("no deck {deck}"));
        }
        let sr = self.sr as f64;
        let grid = opts.grid.map(|g| g.resampled(self.sr)).unwrap_or_else(|| Beatgrid::constant(self.sr, 120.0, 0.0));
        let duration = audio.len() as f64 / 2.0 / sr;
        let mut dt = DeckTrack::new(Arc::new(TrackAudio::new(self.sr, audio)), Arc::new(grid.clone()));
        dt.auto_gain_db = opts.auto_gain_db;
        dt.cue = opts.cue * sr;
        for h in &opts.hot_cues {
            if (h.slot as usize) < HOT_CUES {
                dt.hot_cues[h.slot as usize] = Some(HotCue {
                    frame: h.seconds * sr,
                    kind: match h.loop_seconds {
                        Some(l) if l > 0.0 => CueKind::Loop { length: l * sr },
                        _ => CueKind::Point,
                    },
                    color: h.color.unwrap_or(0x3B82F6),
                });
            }
        }
        let token = self.next_token;
        self.next_token += 1;
        dt.token = token;
        let key = opts.key.as_deref().and_then(parse_camelot);
        self.decks[deck] = Some(Slot { grid, key, duration });
        self.deck_cmd(deck, DeckCommand::Load(Box::new(dt)))?;
        self.deck_cmd(deck, DeckCommand::Seek(opts.start.unwrap_or(opts.cue) * sr))?;
        Ok(token)
    }

    /// Loads a sampler pad (`audio` interleaved stereo at the engine rate).
    pub fn load_pad(&mut self, pad: usize, audio: Vec<f32>, bpm: Option<f64>, s: &PadSettings) -> Result<(), String> {
        if pad >= PADS {
            return Err(format!("no pad {pad}"));
        }
        let audio = Arc::new(TrackAudio::new(self.sr, audio));
        self.send(Command::Sampler(SamplerCommand::Load { pad, audio, bpm }));
        self.pad_settings(pad, s);
        Ok(())
    }

    fn pad_settings(&mut self, pad: usize, s: &PadSettings) {
        let mode = match s.mode {
            1 => PadMode::Gate,
            2 => PadMode::Loop,
            _ => PadMode::OneShot,
        };
        self.send(Command::Sampler(SamplerCommand::SetMode(pad, mode)));
        self.send(Command::Sampler(SamplerCommand::SetGainDb(pad, s.gain_db)));
        self.send(Command::Sampler(SamplerCommand::SetPan(pad, s.pan)));
        self.send(Command::Sampler(SamplerCommand::SetSync(pad, s.sync)));
        self.send(Command::Sampler(SamplerCommand::SetQuantized(pad, s.quantized)));
    }

    /// Handles one JSON call from the page. Returns a JSON reply.
    pub fn call(&mut self, msg: &str) -> Result<Value, String> {
        let v: Value = serde_json::from_str(msg).map_err(|e| e.to_string())?;
        let op = v["op"].as_str().ok_or("missing op")?;
        let deck = v["deck"].as_u64().unwrap_or(0) as usize;
        let sr = self.sr as f64;
        let f = |k: &str| v[k].as_f64().unwrap_or(0.0);
        match op {
            "action" => {
                let id = v["id"].as_str().ok_or("missing id")?;
                let input: ActionInput = serde_json::from_value(v["input"].clone()).map_err(|e| e.to_string())?;
                return self.action(id, input);
            }
            "seek" => self.deck_cmd(deck, DeckCommand::Seek(f("seconds").max(0.0) * sr))?,
            "scratch" => {
                let c = match v["phase"].as_str() {
                    Some("start") => DeckCommand::ScratchStart,
                    Some("move") => DeckCommand::ScratchVelocity(f("velocity")),
                    _ => DeckCommand::ScratchEnd,
                };
                self.deck_cmd(deck, c)?
            }
            "hotCue" => {
                let kind = match v["loopSeconds"].as_f64() {
                    Some(l) if l > 0.0 => CueKind::Loop { length: l * sr },
                    _ => CueKind::Point,
                };
                let color = v["color"].as_u64().unwrap_or(0x3B82F6) as u32;
                let index = v["slot"].as_u64().unwrap_or(0) as u8;
                self.deck_cmd(deck, DeckCommand::SetHotCue { index, frame: Some(f("seconds") * sr), kind, color })?
            }
            "deleteHotCue" => self.deck_cmd(deck, DeckCommand::DeleteHotCue(v["slot"].as_u64().unwrap_or(0) as u8))?,
            "mainCue" => self.deck_cmd(deck, DeckCommand::SetCuePoint(f("seconds") * sr))?,
            "loop" => self.deck_cmd(
                deck,
                DeckCommand::SetLoop {
                    start: f("start") * sr,
                    end: f("end") * sr,
                    active: v["active"].as_bool().unwrap_or(true),
                },
            )?,
            "eject" => {
                self.decks.get_mut(deck).ok_or("no deck")?.take();
                self.deck_cmd(deck, DeckCommand::Eject)?
            }
            "gridSet" => {
                let edit: mixit_core::GridEdit =
                    serde_json::from_value(v["edit"].clone()).map_err(|e| e.to_string())?;
                let slot = self.decks.get_mut(deck).and_then(|s| s.as_mut()).ok_or("no track on this deck")?;
                slot.grid.apply_edit(&edit).map_err(|e| e.to_string())?;
                let view = GridView::new(&slot.grid, slot.duration);
                self.deck_cmd(deck, DeckCommand::SetGrid(Arc::new(view.grid.clone())))?;
                return Ok(json!(view));
            }
            "padSettings" => {
                let pad = v["pad"].as_u64().unwrap_or(0) as usize;
                let s: PadSettings = serde_json::from_value(v["settings"].clone()).map_err(|e| e.to_string())?;
                if pad < PADS {
                    self.pad_settings(pad, &s);
                }
            }
            "padClear" => {
                let pad = v["pad"].as_u64().unwrap_or(0) as usize;
                self.send(Command::Sampler(SamplerCommand::Unload(pad)));
            }
            "record" => self.send(Command::Global(GlobalCommand::SetRecording(v["on"].as_bool().unwrap_or(false)))),
            _ => return Err(format!("unknown call {op}")),
        }
        Ok(Value::Null)
    }

    /// Runs a registry action. App-level deck actions (Match key, grid edits) are handled
    /// here; a grid edit replies with the new grid (a [`GridView`]) so the page can redraw
    /// beats.
    pub fn action(&mut self, id: &str, input: ActionInput) -> Result<Value, String> {
        match self.dispatcher.dispatch(id, input) {
            Ok(cmds) => {
                for c in cmds {
                    self.send(c);
                }
                Ok(Value::Null)
            }
            Err(ActionError::NotEngine(_)) => {
                if !matches!(input, ActionInput::Press) {
                    return Ok(Value::Null);
                }
                let parts: Vec<&str> = id.split('.').collect();
                match parts.as_slice() {
                    ["deck", d, "key_sync"] => self.key_sync(deck_letter(d)?).map(|s| json!({ "keyShift": s })),
                    ["deck", d, "grid", op] => self.grid_edit(deck_letter(d)?, op).map(|g| json!(g)),
                    _ => Ok(Value::Null),
                }
            }
            Err(e) => Err(e.to_string()),
        }
    }

    fn key_sync(&mut self, deck: usize) -> Result<i32, String> {
        let t = *self.ctl.telemetry();
        let mine = self.decks[deck].as_ref().and_then(|s| s.key).ok_or("this deck has no analysed key")?;
        let target = (0..DECKS)
            .filter(|&i| i != deck && t.decks[i].loaded)
            .max_by_key(|&i| (t.decks[i].master, t.decks[i].playing))
            .and_then(|i| Some(self.decks[i].as_ref()?.key?.transposed(t.decks[i].key_shift.round() as i32)))
            .ok_or("load a track with a key on another deck first")?;
        let shift = mine.best_shift_to(target, 6).unwrap_or(0);
        self.deck_cmd(deck, DeckCommand::SetKeylock(true))?;
        self.deck_cmd(deck, DeckCommand::SetKeyShift(shift as f32))?;
        Ok(shift)
    }

    fn grid_edit(&mut self, deck: usize, op: &str) -> Result<GridView, String> {
        let pos = self.ctl.telemetry().decks[deck].position;
        let slot = self.decks[deck].as_mut().ok_or("no track on this deck")?;
        let g = &mut slot.grid;
        if g.locked {
            return Err("The beat grid is locked. Unlock it in the track editor first.".into());
        }
        let sr = g.sample_rate as f64;
        match op {
            "set_downbeat" => g.set_downbeat(pos),
            "halve" => g.scale_tempo(0.5).map_err(|e| format!("{e:?}"))?,
            "double" => g.scale_tempo(2.0).map_err(|e| format!("{e:?}"))?,
            "nudge_back" => g.nudge(-0.005 * sr),
            "nudge_fwd" => g.nudge(0.005 * sr),
            _ => return Err(format!("unknown grid edit {op}")),
        }
        let view = GridView::new(g, slot.duration);
        self.deck_cmd(deck, DeckCommand::SetGrid(Arc::new(view.grid.clone())))?;
        Ok(view)
    }
}

fn deck_letter(d: &str) -> Result<usize, String> {
    let i = d.bytes().next().ok_or("bad deck")?.wrapping_sub(b'A') as usize;
    if i < DECKS { Ok(i) } else { Err(format!("no deck {d}")) }
}

/// "8A" → the key.
pub fn parse_camelot(s: &str) -> Option<Key> {
    let s = s.trim();
    let letter = s.chars().last()?.to_ascii_uppercase();
    let number: u8 = s[..s.len() - 1].parse().ok()?;
    Key::from_camelot(number, letter)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_dsp::testkit;

    fn tone(seconds: f32, sr: u32) -> Vec<f32> {
        testkit::sine((seconds * sr as f32) as usize, 220.0, sr as f32, 0.4).into_iter().flat_map(|v| [v, v]).collect()
    }

    fn render(h: &mut Host, frames: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut left = frames;
        while left > 0 {
            let n = left.min(128);
            out.extend_from_slice(h.process(n).0);
            left -= n;
        }
        out
    }

    #[test]
    fn plays_a_loaded_track_through_actions() {
        let sr = 48_000;
        let mut h = Host::new(sr);
        let token = h.load(0, tone(4.0, sr), LoadOptions::default()).unwrap();
        assert!(h.call(r#"{"op":"action","id":"deck.A.play","input":{"type":"press"}}"#).is_ok());
        let out = render(&mut h, sr as usize);
        let p = h.poll();
        assert!(p.t.decks[0].playing && p.t.decks[0].token == token);
        assert!((p.t.decks[0].position - 1.0).abs() < 0.05, "{}", p.t.decks[0].position);
        assert!(testkit::rms(&out[sr as usize..]) > 0.1);
        // The channel fader works through the same action ids as the desktop.
        h.call(r#"{"op":"action","id":"mixer.A.fader","input":{"type":"value","value":0.0}}"#).unwrap();
        let quiet = render(&mut h, sr as usize / 2);
        assert!(testkit::rms(&quiet[sr as usize / 2..]) < 1e-3);
    }

    #[test]
    fn key_lock_uses_the_vocoder() {
        let sr = 48_000;
        let mut h = Host::new(sr);
        h.load(0, tone(6.0, sr), LoadOptions::default()).unwrap();
        for c in [
            r#"{"op":"action","id":"deck.A.keylock","input":{"type":"set","value":true}}"#,
            r#"{"op":"action","id":"deck.A.tempo","input":{"type":"value","value":1.0}}"#,
            r#"{"op":"action","id":"deck.A.play","input":{"type":"press"}}"#,
        ] {
            h.call(c).unwrap();
        }
        let out: Vec<f32> = render(&mut h, sr as usize * 2).chunks(2).map(|c| c[0]).collect();
        let tail = &out[sr as usize..];
        assert!(testkit::tone_level(tail, 220.0, sr as f32) > 0.2, "pitch kept");
        assert!(testkit::tone_level(tail, 220.0 * 1.08, sr as f32) < 0.03, "not sped up like vinyl");
    }

    #[test]
    fn grid_edits_and_match_key_reply() {
        let sr = 48_000;
        let mut h = Host::new(sr);
        let grid = Beatgrid::constant(sr, 124.0, 0.0);
        h.load(
            0,
            tone(2.0, sr),
            LoadOptions { grid: Some(grid.clone()), key: Some("8A".into()), ..Default::default() },
        )
        .unwrap();
        h.load(1, tone(2.0, sr), LoadOptions { grid: Some(grid), key: Some("3B".into()), ..Default::default() })
            .unwrap();
        render(&mut h, 256);
        h.poll();
        let r = h.call(r#"{"op":"action","id":"deck.A.grid.double","input":{"type":"press"}}"#).unwrap();
        assert!((r["bpm"].as_f64().unwrap() - 248.0).abs() < 1e-6);
        assert!((r["beatPeriod"].as_f64().unwrap() - 60.0 / 248.0).abs() < 1e-6 && r["grid"].is_object());
        let r = h.call(r#"{"op":"action","id":"deck.B.key_sync","input":{"type":"press"}}"#).unwrap();
        let shift = r["keyShift"].as_i64().unwrap();
        let fits = parse_camelot("3B").unwrap().transposed(shift as i32).camelot_distance(parse_camelot("8A").unwrap());
        assert!(fits <= 1, "shift {shift} leaves distance {fits}");
        let r = h.call(r#"{"op":"gridSet","deck":1,"edit":{"bpm":126,"locked":true}}"#).unwrap();
        assert_eq!(r["bpm"].as_f64(), Some(126.0));
        assert_eq!(r["gridLocked"].as_bool(), Some(true));
        assert!(h.call(r#"{"op":"action","id":"deck.B.grid.halve","input":{"type":"press"}}"#).is_err());
        assert!(h.call(r#"{"op":"gridSet","deck":1,"edit":{"nudgeMs":5}}"#).is_err());
        assert!(h.call(r#"{"op":"nope"}"#).is_err());
    }
}
