//! Turns action IDs from the registry ([`mixit_core::actions`]) into engine commands.
//!
//! The UI, keyboard shortcuts, the command palette, automation and (later) MIDI all go
//! through [`ActionDispatcher::dispatch`], so a control behaves the same however it is
//! reached. The dispatcher keeps the little control-side state the registry implies
//! (selected loop and beat-jump sizes, quantize size, toggle mirrors). Actions that are
//! not engine actions (`app.*`, grid edits, key sync) come back as [`ActionError::NotEngine`]
//! for the app to handle.

use mixit_core::actions::{ECHO_TIMES, KEYPAD_RANGES, ROLL_SIZES, SLICE_SIZES, TEMPO_RANGES};
use mixit_core::{DeckId, Quantize};
use mixit_dsp::curves::{CrossfaderCurve, FaderCurve};
use mixit_dsp::djeq::EqMode;
use mixit_dsp::dynamics::CompressorSettings;
use mixit_dsp::fx::{self, FxKind};
use mixit_dsp::studio::StudioSettings;
use serde::{Deserialize, Serialize};

use crate::commands::{
    Command, DeckCommand, FxCommand, FxTarget, GlobalCommand, MixerCommand, PadMode, SamplerCommand, XfAssign,
};
use crate::input::MicCommand;
use crate::mixer::ReturnParam;

/// What happened to the control.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ActionInput {
    /// Button down (triggers fire here; toggles flip).
    Press,
    /// Button up (momentary controls end here).
    Release,
    /// A continuous value in the action's range, or 0/1 for a toggle.
    Value(f64),
    /// Explicit on/off for a toggle.
    Set(bool),
    /// Index into a choice's options.
    Choice(usize),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActionError {
    Unknown(String),
    /// A valid action the app handles itself (views, undo, grid edits, key sync…).
    NotEngine(String),
    BadInput(String),
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActionError::Unknown(id) => write!(f, "unknown action {id}"),
            ActionError::NotEngine(id) => write!(f, "{id} is handled by the app"),
            ActionError::BadInput(id) => write!(f, "wrong kind of input for {id}"),
        }
    }
}

impl std::error::Error for ActionError {}

pub const LOOP_SIZES: [f64; 11] = [1.0 / 32.0, 1.0 / 16.0, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0];
pub const JUMP_SIZES: [f64; 6] = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0];
pub const FX_BEATS: [f32; 10] = [0.0625, 0.125, 0.25, 0.5, 0.75, 1.0, 2.0, 4.0, 8.0, 16.0];
pub const QUANTIZE_SIZES: [Quantize; 6] = [
    Quantize::Beats(0.125),
    Quantize::Beats(0.25),
    Quantize::Beats(0.5),
    Quantize::Beat,
    Quantize::Bar,
    Quantize::Phrase,
];

/// How far a nudge button bends the tempo (fraction of the bend range).
const NUDGE: f64 = 0.5;

#[derive(Clone, Copy, Debug, Default)]
struct DeckState {
    loop_size: usize,
    jump_size: usize,
    slice_size: usize,
    /// Hot cue the key pads play (0-based) and the range of keys they cover.
    keypad_cue: u8,
    keypad_range: usize,
    sync: bool,
    keylock: bool,
    loop_on: bool,
    slip: bool,
    reverse: bool,
}

/// Control-side state for dispatching actions.
pub struct ActionDispatcher {
    sample_rate: f32,
    decks: Vec<DeckState>,
    quantize: bool,
    quantize_size: usize,
    toggles: std::collections::HashMap<String, bool>,
    /// Studio strip settings per channel, then the master's (last).
    studio: Vec<StudioSettings>,
    /// Ducking per channel: source deck and amount (0 … 1).
    duck: Vec<(Option<usize>, f32)>,
}

/// Deepest ducking at amount 1 (dB).
pub const DUCK_MAX_DB: f32 = 24.0;
/// Saturation drive at warmth 1 (dB).
pub const WARMTH_MAX_DB: f32 = 24.0;

fn deck_index(letter: &str) -> Option<usize> {
    let c = letter.chars().next()?;
    (letter.len() == 1 && c.is_ascii_uppercase()).then(|| (c as u8 - b'A') as usize)
}

impl ActionDispatcher {
    pub fn new(sample_rate: u32, decks: usize) -> ActionDispatcher {
        let d = DeckState { loop_size: 7, jump_size: 2, slice_size: 1, keypad_range: 1, ..Default::default() }; // 4-beat loops, 4-beat jumps
        ActionDispatcher {
            sample_rate: sample_rate as f32,
            decks: vec![d; decks.max(1)],
            quantize: true,
            quantize_size: 3,
            toggles: [("mic.talkover", true), ("mic.low_cut", true), ("mic.mono", true)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            studio: vec![StudioSettings::default(); decks.max(1) + 1],
            duck: vec![(None, 0.0); decks.max(1)],
        }
    }

    /// A channel's (or, with `None`, the master's) studio settings as last sent.
    pub fn studio(&self, ch: Option<usize>) -> StudioSettings {
        let i = ch.unwrap_or(self.studio.len() - 1).min(self.studio.len() - 1);
        self.studio[i]
    }

    /// Replaces a channel's (or the master's) studio settings, for the detailed editor
    /// and presets, and returns the command that applies them.
    pub fn set_studio(&mut self, ch: Option<usize>, s: StudioSettings) -> Command {
        let i = ch.unwrap_or(self.studio.len() - 1).min(self.studio.len() - 1);
        self.studio[i] = s;
        let target = (i < self.decks.len()).then_some(DeckId(i as u8));
        Command::Mixer(MixerCommand::SetStudio(target, Box::new(s)))
    }

    fn edit_studio(&mut self, ch: Option<usize>, f: impl FnOnce(&mut StudioSettings)) -> Vec<Command> {
        let mut s = self.studio(ch);
        f(&mut s);
        vec![self.set_studio(ch, s)]
    }

    /// Selected loop length of a deck in beats.
    pub fn loop_beats(&self, deck: usize) -> f64 {
        self.decks.get(deck).map(|d| LOOP_SIZES[d.loop_size]).unwrap_or(4.0)
    }

    pub fn jump_beats(&self, deck: usize) -> f64 {
        self.decks.get(deck).map(|d| JUMP_SIZES[d.jump_size]).unwrap_or(4.0)
    }

    /// Tells the dispatcher what the engine reports, so toggles flip from the truth.
    pub fn observe_deck(&mut self, deck: usize, sync: bool, keylock: bool, loop_on: bool) {
        if let Some(d) = self.decks.get_mut(deck) {
            d.sync = sync;
            d.keylock = keylock;
            d.loop_on = loop_on;
        }
    }

    fn toggle(current: bool, input: ActionInput, id: &str) -> Result<Option<bool>, ActionError> {
        Ok(match input {
            ActionInput::Press => Some(!current),
            ActionInput::Release => None,
            ActionInput::Set(b) => Some(b),
            ActionInput::Value(v) => Some(v > 0.5),
            ActionInput::Choice(_) => return Err(ActionError::BadInput(id.into())),
        })
    }

    fn generic_toggle(&mut self, id: &str, input: ActionInput) -> Result<Option<bool>, ActionError> {
        let cur = self.toggles.get(id).copied().unwrap_or(false);
        let v = Self::toggle(cur, input, id)?;
        if let Some(v) = v {
            self.toggles.insert(id.to_string(), v);
        }
        Ok(v)
    }

    fn value(input: ActionInput, id: &str) -> Result<Option<f64>, ActionError> {
        match input {
            ActionInput::Value(v) if v.is_finite() => Ok(Some(v)),
            ActionInput::Release => Ok(None),
            _ => Err(ActionError::BadInput(id.into())),
        }
    }

    fn choice(input: ActionInput, n: usize, id: &str) -> Result<Option<usize>, ActionError> {
        match input {
            ActionInput::Choice(i) if i < n => Ok(Some(i)),
            ActionInput::Value(v) if v >= 0.0 && (v as usize) < n => Ok(Some(v as usize)),
            ActionInput::Release => Ok(None),
            _ => Err(ActionError::BadInput(id.into())),
        }
    }

    /// The engine commands for an action. An empty list means nothing to do (a release
    /// of a trigger, for example).
    pub fn dispatch(&mut self, id: &str, input: ActionInput) -> Result<Vec<Command>, ActionError> {
        let parts: Vec<&str> = id.split('.').collect();
        let unknown = || ActionError::Unknown(id.to_string());
        match parts.as_slice() {
            ["deck", d, rest @ ..] => {
                let i = deck_index(d).filter(|&i| i < self.decks.len()).ok_or_else(unknown)?;
                self.deck(i, id, rest, input)
            }
            ["mixer", d, rest @ ..] if deck_index(d).is_some() => {
                let i = deck_index(d).filter(|&i| i < self.decks.len()).ok_or_else(unknown)?;
                self.strip(i, id, rest, input)
            }
            ["mixer", rest @ ..] => self.mixer(id, rest, input),
            ["fx", "master", slot, control] => {
                let slot: usize = slot.parse().ok().filter(|s| (1..=3).contains(s)).ok_or_else(unknown)?;
                self.fx(FxTarget::Master, slot - 1, id, control, input)
            }
            ["fx", d, slot, control] => {
                let i = deck_index(d).filter(|&i| i < self.decks.len()).ok_or_else(unknown)?;
                let slot: usize = slot.parse().ok().filter(|s| (1..=3).contains(s)).ok_or_else(unknown)?;
                self.fx(FxTarget::Deck(DeckId(i as u8)), slot - 1, id, control, input)
            }
            ["sampler", "stop_all"] => Ok(match input {
                ActionInput::Press => vec![Command::Sampler(SamplerCommand::StopAll)],
                _ => vec![],
            }),
            ["sampler", "volume"] => Ok(Self::value(input, id)?
                .map(|v| vec![Command::Sampler(SamplerCommand::SetVolume(v as f32))])
                .unwrap_or_default()),
            ["sampler", "pad", n, rest @ ..] => {
                let pad: usize = n.parse::<usize>().ok().filter(|&p| p >= 1).ok_or_else(unknown)? - 1;
                match rest {
                    [] => Ok(match input {
                        ActionInput::Press => vec![Command::Sampler(SamplerCommand::Down(pad))],
                        ActionInput::Release => vec![Command::Sampler(SamplerCommand::Up(pad))],
                        _ => return Err(ActionError::BadInput(id.into())),
                    }),
                    ["mode"] => Ok(Self::choice(input, 3, id)?
                        .map(|m| {
                            let mode = [PadMode::OneShot, PadMode::Gate, PadMode::Loop][m];
                            vec![Command::Sampler(SamplerCommand::SetMode(pad, mode))]
                        })
                        .unwrap_or_default()),
                    _ => Err(unknown()),
                }
            }
            ["mic", rest @ ..] => self.mic(id, rest, input),
            ["global", rest @ ..] => self.global(id, rest, input),
            ["app", ..] => Err(ActionError::NotEngine(id.to_string())),
            _ => Err(unknown()),
        }
    }

    fn deck(&mut self, i: usize, id: &str, rest: &[&str], input: ActionInput) -> Result<Vec<Command>, ActionError> {
        let deck = DeckId(i as u8);
        let dc = |c: DeckCommand| vec![Command::Deck(deck, c)];
        let press = matches!(input, ActionInput::Press);
        let release = matches!(input, ActionInput::Release);
        let trig = |c: DeckCommand| if press { dc(c) } else { vec![] };
        let st = self.decks[i];
        Ok(match rest {
            ["play"] => trig(DeckCommand::PlayPause),
            ["cue"] => {
                if press {
                    dc(DeckCommand::CueDown)
                } else if release {
                    dc(DeckCommand::CueUp)
                } else {
                    vec![]
                }
            }
            ["sync"] => match Self::toggle(st.sync, input, id)? {
                Some(on) => {
                    self.decks[i].sync = on;
                    dc(DeckCommand::Sync(on))
                }
                None => vec![],
            },
            ["master"] => trig(DeckCommand::BecomeMaster),
            ["keylock"] => match Self::toggle(st.keylock, input, id)? {
                Some(on) => {
                    self.decks[i].keylock = on;
                    dc(DeckCommand::SetKeylock(on))
                }
                None => vec![],
            },
            ["tempo"] => {
                Self::value(input, id)?.map(|v| dc(DeckCommand::SetTempo(v.clamp(-1.0, 1.0)))).unwrap_or_default()
            }
            ["tempo_range"] => Self::choice(input, TEMPO_RANGES.len(), id)?
                .map(|c| dc(DeckCommand::SetTempoRange(TEMPO_RANGES[c].1 as f64)))
                .unwrap_or_default(),
            ["tempo_reset"] => trig(DeckCommand::TempoReset),
            ["nudge_down"] | ["nudge_up"] => {
                let dir = if rest[0] == "nudge_up" { 1.0 } else { -1.0 };
                match input {
                    ActionInput::Press => dc(DeckCommand::Nudge(dir * NUDGE)),
                    ActionInput::Release => dc(DeckCommand::Nudge(0.0)),
                    ActionInput::Value(v) => dc(DeckCommand::Nudge(dir * v.clamp(0.0, 1.0))),
                    _ => return Err(ActionError::BadInput(id.into())),
                }
            }
            ["key_shift"] => Self::value(input, id)?
                .map(|v| dc(DeckCommand::SetKeyShift(v.clamp(-12.0, 12.0) as f32)))
                .unwrap_or_default(),
            ["key_sync"] => return Err(ActionError::NotEngine(id.into())),
            ["hotcue", n] => {
                let n: u8 = n
                    .parse::<u8>()
                    .ok()
                    .filter(|&n| (1..=16).contains(&n))
                    .ok_or_else(|| ActionError::Unknown(id.into()))?
                    - 1;
                if press {
                    self.decks[i].keypad_cue = n;
                    dc(DeckCommand::HotCueDown(n))
                } else if release {
                    dc(DeckCommand::HotCueUp(n))
                } else {
                    vec![]
                }
            }
            ["hotcue", n, "delete"] => {
                let n: u8 = n
                    .parse::<u8>()
                    .ok()
                    .filter(|&n| (1..=16).contains(&n))
                    .ok_or_else(|| ActionError::Unknown(id.into()))?
                    - 1;
                trig(DeckCommand::DeleteHotCue(n))
            }
            ["loop", "auto"] => match Self::toggle(st.loop_on, input, id)? {
                Some(true) => {
                    self.decks[i].loop_on = true;
                    dc(DeckCommand::LoopAuto(LOOP_SIZES[st.loop_size]))
                }
                Some(false) => {
                    self.decks[i].loop_on = false;
                    dc(DeckCommand::LoopExit)
                }
                None => vec![],
            },
            ["keypad", "cue"] => {
                if let Some(c) = Self::choice(input, 8, id)? {
                    self.decks[i].keypad_cue = c as u8;
                }
                vec![]
            }
            ["keypad", "range"] => {
                if let Some(c) = Self::choice(input, KEYPAD_RANGES.len(), id)? {
                    self.decks[i].keypad_range = c;
                }
                vec![]
            }
            ["keypad", n] => {
                let n: i8 = n
                    .parse::<i8>()
                    .ok()
                    .filter(|&n| (1..=8).contains(&n))
                    .ok_or_else(|| ActionError::Unknown(id.into()))?
                    - 1;
                let shift = (KEYPAD_RANGES[st.keypad_range].1 + n) as f32;
                if press {
                    // Key lock keeps the tempo while the key moves.
                    self.decks[i].keylock = true;
                    let mut v = dc(DeckCommand::SetKeylock(true));
                    v.extend(dc(DeckCommand::SetKeyShift(shift)));
                    v.extend(dc(DeckCommand::HotCueDown(st.keypad_cue)));
                    v
                } else if release {
                    dc(DeckCommand::HotCueUp(st.keypad_cue))
                } else {
                    vec![]
                }
            }
            ["slice", "size"] => {
                if let Some(c) = Self::choice(input, SLICE_SIZES.len(), id)? {
                    self.decks[i].slice_size = c;
                }
                vec![]
            }
            ["slice", n] => {
                let n: u8 = n
                    .parse::<u8>()
                    .ok()
                    .filter(|&n| (1..=8).contains(&n))
                    .ok_or_else(|| ActionError::Unknown(id.into()))?
                    - 1;
                if press {
                    dc(DeckCommand::SliceDown { index: n, count: 8, beats: SLICE_SIZES[st.slice_size].1 })
                } else if release {
                    dc(DeckCommand::SliceUp(n))
                } else {
                    vec![]
                }
            }
            ["roll", n] => {
                let n: usize = n
                    .parse::<usize>()
                    .ok()
                    .filter(|&n| (1..=8).contains(&n))
                    .ok_or_else(|| ActionError::Unknown(id.into()))?
                    - 1;
                if press {
                    dc(DeckCommand::LoopRollDown(ROLL_SIZES[n].1))
                } else if release {
                    dc(DeckCommand::LoopRollUp)
                } else {
                    vec![]
                }
            }
            ["loop", "size"] => match Self::choice(input, LOOP_SIZES.len(), id)? {
                Some(c) => {
                    self.decks[i].loop_size = c;
                    // Changing the size of an active loop resizes it.
                    if st.loop_on { dc(DeckCommand::LoopAuto(LOOP_SIZES[c])) } else { vec![] }
                }
                None => vec![],
            },
            ["loop", "halve"] => {
                if press {
                    self.decks[i].loop_size = st.loop_size.saturating_sub(1);
                }
                trig(DeckCommand::LoopHalve)
            }
            ["loop", "double"] => {
                if press {
                    self.decks[i].loop_size = (st.loop_size + 1).min(LOOP_SIZES.len() - 1);
                }
                trig(DeckCommand::LoopDouble)
            }
            ["loop", "in"] => trig(DeckCommand::LoopIn),
            ["loop", "out"] => trig(DeckCommand::LoopOut),
            ["loop", "reloop"] => trig(DeckCommand::Reloop),
            ["let_end"] => {
                self.decks[i].loop_on = false;
                trig(DeckCommand::LoopExit)
            }
            ["loop", "roll"] => {
                if press {
                    dc(DeckCommand::LoopRollDown(LOOP_SIZES[st.loop_size]))
                } else if release {
                    dc(DeckCommand::LoopRollUp)
                } else {
                    vec![]
                }
            }
            ["loop", "move_back"] => trig(DeckCommand::LoopMove(-LOOP_SIZES[st.loop_size])),
            ["loop", "move_fwd"] => trig(DeckCommand::LoopMove(LOOP_SIZES[st.loop_size])),
            ["beatjump", "back"] => trig(DeckCommand::BeatJump(-JUMP_SIZES[st.jump_size])),
            ["beatjump", "fwd"] => trig(DeckCommand::BeatJump(JUMP_SIZES[st.jump_size])),
            ["beatjump", "size"] => {
                if let Some(c) = Self::choice(input, JUMP_SIZES.len(), id)? {
                    self.decks[i].jump_size = c;
                }
                vec![]
            }
            ["slip"] => match Self::toggle(st.slip, input, id)? {
                Some(on) => {
                    self.decks[i].slip = on;
                    dc(DeckCommand::Slip(on))
                }
                None => vec![],
            },
            ["censor"] => {
                if press {
                    dc(DeckCommand::Censor(true))
                } else if release {
                    dc(DeckCommand::Censor(false))
                } else {
                    vec![]
                }
            }
            ["reverse"] => match Self::toggle(st.reverse, input, id)? {
                Some(on) => {
                    self.decks[i].reverse = on;
                    dc(DeckCommand::Reverse(on))
                }
                None => vec![],
            },
            ["brake"] => trig(DeckCommand::Brake(1.2)),
            ["spinup"] => trig(DeckCommand::SpinUp(0.6)),
            ["double"] => trig(DeckCommand::DuplicateFrom(DeckId((i ^ 1) as u8))),
            ["eject"] => trig(DeckCommand::Eject),
            ["grid", ..] => return Err(ActionError::NotEngine(id.into())),
            _ => return Err(ActionError::Unknown(id.into())),
        })
    }

    fn strip(&mut self, i: usize, id: &str, rest: &[&str], input: ActionInput) -> Result<Vec<Command>, ActionError> {
        let deck = DeckId(i as u8);
        let m = |c: MixerCommand| vec![Command::Mixer(c)];
        let band = |b: &str| match b {
            "low" => Some(0),
            "mid" => Some(1),
            "high" => Some(2),
            _ => None,
        };
        Ok(match rest {
            ["trim"] => Self::value(input, id)?.map(|v| m(MixerCommand::SetTrim(deck, v as f32))).unwrap_or_default(),
            ["eq", b] => {
                let b = band(b).ok_or_else(|| ActionError::Unknown(id.into()))?;
                Self::value(input, id)?.map(|v| m(MixerCommand::SetEq(deck, b, v as f32))).unwrap_or_default()
            }
            ["eq", "kill", b] => {
                let b = band(b).ok_or_else(|| ActionError::Unknown(id.into()))?;
                self.generic_toggle(id, input)?.map(|on| m(MixerCommand::SetEqKill(deck, b, on))).unwrap_or_default()
            }
            ["filter"] => {
                Self::value(input, id)?.map(|v| m(MixerCommand::SetFilter(deck, v as f32))).unwrap_or_default()
            }
            ["filter_res"] => {
                Self::value(input, id)?.map(|v| m(MixerCommand::SetFilterResonance(deck, v as f32))).unwrap_or_default()
            }
            ["fader"] => Self::value(input, id)?.map(|v| m(MixerCommand::SetFader(deck, v as f32))).unwrap_or_default(),
            ["cue"] => self.generic_toggle(id, input)?.map(|on| m(MixerCommand::SetCue(deck, on))).unwrap_or_default(),
            ["assign"] => Self::choice(input, 3, id)?
                .map(|c| m(MixerCommand::SetAssign(deck, [XfAssign::A, XfAssign::Thru, XfAssign::B][c])))
                .unwrap_or_default(),
            ["color"] | ["color_type"] => return Err(ActionError::NotEngine(id.into())),
            ["pan"] => Self::value(input, id)?.map(|v| m(MixerCommand::SetPan(deck, v as f32))).unwrap_or_default(),
            ["punch"] => match Self::value(input, id)? {
                Some(v) => self.edit_studio(Some(i), |s| {
                    s.comp_on = v > 0.001;
                    s.comp = CompressorSettings::punch(v as f32);
                }),
                None => vec![],
            },
            ["warmth"] => match Self::value(input, id)? {
                Some(v) => self.edit_studio(Some(i), |s| {
                    s.sat_on = v > 0.001;
                    s.drive_db = WARMTH_MAX_DB * v.clamp(0.0, 1.0) as f32;
                }),
                None => vec![],
            },
            ["width"] => match Self::value(input, id)? {
                Some(v) => self.edit_studio(Some(i), |s| s.width = v.clamp(0.0, 2.0) as f32),
                None => vec![],
            },
            ["gate"] => {
                let cur = self.studio(Some(i)).gate_on;
                match Self::toggle(cur, input, id)? {
                    Some(on) => self.edit_studio(Some(i), |s| s.gate_on = on),
                    None => vec![],
                }
            }
            ["space"] => {
                Self::value(input, id)?.map(|v| m(MixerCommand::SetSend(deck, 0, v as f32))).unwrap_or_default()
            }
            ["echo"] => {
                Self::value(input, id)?.map(|v| m(MixerCommand::SetSend(deck, 1, v as f32))).unwrap_or_default()
            }
            ["duck_source"] => match Self::choice(input, mixit_core::actions::DUCK_SOURCES.len(), id)? {
                Some(c) => {
                    self.duck[i].0 = c.checked_sub(1).filter(|&j| j != i && j < self.decks.len());
                    self.duck_command(i)
                }
                None => vec![],
            },
            ["duck"] => match Self::value(input, id)? {
                Some(v) => {
                    self.duck[i].1 = v.clamp(0.0, 1.0) as f32;
                    self.duck_command(i)
                }
                None => vec![],
            },
            _ => return Err(ActionError::Unknown(id.into())),
        })
    }

    fn duck_command(&self, i: usize) -> Vec<Command> {
        let (src, amount) = self.duck[i];
        vec![Command::Mixer(MixerCommand::SetDuck(DeckId(i as u8), src.map(|j| DeckId(j as u8)), amount * DUCK_MAX_DB))]
    }

    fn mic(&mut self, id: &str, rest: &[&str], input: ActionInput) -> Result<Vec<Command>, ActionError> {
        let m = |c: MicCommand| vec![Command::Mic(c)];
        let val = |f: &dyn Fn(f32) -> MicCommand| -> Result<Vec<Command>, ActionError> {
            Ok(Self::value(input, id)?.map(|v| m(f(v as f32))).unwrap_or_default())
        };
        let band = |b: &str| ["low", "mid", "high"].iter().position(|x| *x == b);
        match rest {
            ["on_air"] => Ok(self.generic_toggle(id, input)?.map(|on| m(MicCommand::SetOnAir(on))).unwrap_or_default()),
            ["cue"] => Ok(self.generic_toggle(id, input)?.map(|on| m(MicCommand::SetCue(on))).unwrap_or_default()),
            ["talkover"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| m(MicCommand::SetTalkover(on))).unwrap_or_default())
            }
            ["low_cut"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| m(MicCommand::SetLowCut(on))).unwrap_or_default())
            }
            ["gate"] => Ok(self.generic_toggle(id, input)?.map(|on| m(MicCommand::SetGate(on))).unwrap_or_default()),
            ["mono"] => Ok(self.generic_toggle(id, input)?.map(|on| m(MicCommand::SetMono(on))).unwrap_or_default()),
            ["level"] => val(&MicCommand::SetLevel),
            ["gain"] => val(&MicCommand::SetGainDb),
            ["talkover_depth"] => val(&MicCommand::SetTalkoverDepth),
            ["eq", b] => {
                let i = band(b).ok_or_else(|| ActionError::Unknown(id.into()))?;
                val(&|v| MicCommand::SetEq(i, v))
            }
            // Recording needs the control side to collect the audio and decide where it goes.
            ["record"] => Err(ActionError::NotEngine(id.into())),
            _ => Err(ActionError::Unknown(id.into())),
        }
    }

    fn mixer(&mut self, id: &str, rest: &[&str], input: ActionInput) -> Result<Vec<Command>, ActionError> {
        let m = |c: MixerCommand| vec![Command::Mixer(c)];
        let val = |f: fn(f32) -> MixerCommand| -> Result<Vec<Command>, ActionError> {
            Ok(Self::value(input, id)?.map(|v| m(f(v as f32))).unwrap_or_default())
        };
        match rest {
            ["crossfader"] => val(MixerCommand::SetCrossfader),
            ["master"] => val(MixerCommand::SetMasterDb),
            ["booth"] => val(MixerCommand::SetBoothDb),
            ["cue_mix"] => val(MixerCommand::SetCueMix),
            ["headphones"] => val(MixerCommand::SetHeadphonesDb),
            ["crossfader_curve"] => Ok(Self::choice(input, 3, id)?
                .map(|c| {
                    let curve =
                        [CrossfaderCurve::SmoothBlend, CrossfaderCurve::ConstantPower, CrossfaderCurve::SharpCut][c];
                    m(MixerCommand::SetCrossfaderCurve(curve))
                })
                .unwrap_or_default()),
            ["fader_curve"] => Ok(Self::choice(input, 3, id)?
                .map(|c| m(MixerCommand::SetFaderCurve([FaderCurve::Linear, FaderCurve::Smooth, FaderCurve::Steep][c])))
                .unwrap_or_default()),
            ["eq_mode"] => Ok(Self::choice(input, 2, id)?
                .map(|c| m(MixerCommand::SetEqMode([EqMode::Classic, EqMode::Isolator][c])))
                .unwrap_or_default()),
            ["crossfader_reverse"] => Ok(self
                .generic_toggle(id, input)?
                .map(|on| m(MixerCommand::SetCrossfaderReverse(on)))
                .unwrap_or_default()),
            ["split_cue"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| m(MixerCommand::SetSplitCue(on))).unwrap_or_default())
            }
            ["auto_gain"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| m(MixerCommand::SetAutoGain(on))).unwrap_or_default())
            }
            ["limiter"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| m(MixerCommand::SetLimiter(on))).unwrap_or_default())
            }
            ["glue"] => Ok(match Self::value(input, id)? {
                Some(v) => self.edit_studio(None, |s| {
                    s.comp_on = v > 0.001;
                    s.comp = CompressorSettings::glue(v as f32);
                }),
                None => vec![],
            }),
            [ret @ ("space" | "echo"), control] => {
                let k = if *ret == "space" { 0 } else { 1 };
                let r = |p: ReturnParam| vec![Command::Mixer(MixerCommand::SetReturn(k, p))];
                match *control {
                    "level" => Ok(Self::value(input, id)?.map(|v| r(ReturnParam::Level(v as f32))).unwrap_or_default()),
                    "size" if k == 0 => {
                        Ok(Self::value(input, id)?.map(|v| r(ReturnParam::Param(0, v as f32))).unwrap_or_default())
                    }
                    "feedback" if k == 1 => {
                        Ok(Self::value(input, id)?.map(|v| r(ReturnParam::Param(0, v as f32))).unwrap_or_default())
                    }
                    "time" if k == 1 => Ok(Self::choice(input, ECHO_TIMES.len(), id)?
                        .map(|c| r(ReturnParam::Beats(ECHO_TIMES[c].1)))
                        .unwrap_or_default()),
                    _ => Err(ActionError::Unknown(id.into())),
                }
            }
            _ => Err(ActionError::Unknown(id.into())),
        }
    }

    fn fx(
        &mut self,
        target: FxTarget,
        slot: usize,
        id: &str,
        control: &str,
        input: ActionInput,
    ) -> Result<Vec<Command>, ActionError> {
        let f = |c: FxCommand| vec![Command::Fx(target, slot, c)];
        Ok(match control {
            "type" => Self::choice(input, FxKind::ALL.len(), id)?
                .map(|c| f(FxCommand::SetEffect(fx::create(FxKind::from_index(c), self.sample_rate))))
                .unwrap_or_default(),
            "on" => self.generic_toggle(id, input)?.map(|on| f(FxCommand::SetOn(on))).unwrap_or_default(),
            "mix" => Self::value(input, id)?.map(|v| f(FxCommand::SetMix(v as f32))).unwrap_or_default(),
            "beats" => Self::choice(input, FX_BEATS.len(), id)?
                .map(|c| f(FxCommand::SetBeats(FX_BEATS[c])))
                .unwrap_or_default(),
            "p1" => Self::value(input, id)?.map(|v| f(FxCommand::SetParam(0, v as f32))).unwrap_or_default(),
            "p2" => Self::value(input, id)?.map(|v| f(FxCommand::SetParam(1, v as f32))).unwrap_or_default(),
            _ => return Err(ActionError::Unknown(id.into())),
        })
    }

    fn global(&mut self, id: &str, rest: &[&str], input: ActionInput) -> Result<Vec<Command>, ActionError> {
        let g = |c: GlobalCommand| vec![Command::Global(c)];
        match rest {
            ["quantize"] => Ok(match Self::toggle(self.quantize, input, id)? {
                Some(on) => {
                    self.quantize = on;
                    g(GlobalCommand::SetQuantize(if on { QUANTIZE_SIZES[self.quantize_size] } else { Quantize::Off }))
                }
                None => vec![],
            }),
            ["quantize_size"] => Ok(match Self::choice(input, QUANTIZE_SIZES.len(), id)? {
                Some(c) => {
                    self.quantize_size = c;
                    if self.quantize { g(GlobalCommand::SetQuantize(QUANTIZE_SIZES[c])) } else { vec![] }
                }
                None => vec![],
            }),
            ["safety_loop"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| g(GlobalCommand::SetSafetyLoop(on))).unwrap_or_default())
            }
            ["record"] => {
                Ok(self.generic_toggle(id, input)?.map(|on| g(GlobalCommand::SetRecording(on))).unwrap_or_default())
            }
            ["master_bpm"] => Ok(Self::value(input, id)?
                .map(|v| g(GlobalCommand::SetClockBpm(v.clamp(40.0, 250.0))))
                .unwrap_or_default()),
            _ => Err(ActionError::Unknown(id.into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::actions::{ActionKind, registry};

    fn input_for(kind: &ActionKind) -> ActionInput {
        match kind {
            ActionKind::Trigger | ActionKind::Momentary | ActionKind::Toggle => ActionInput::Press,
            ActionKind::Continuous { spec } => ActionInput::Value(spec.default as f64),
            ActionKind::Choice { default, .. } => ActionInput::Choice(*default),
        }
    }

    #[test]
    fn every_registry_action_is_dispatched_or_left_to_the_app() {
        let mut d = ActionDispatcher::new(48_000, 4);
        for a in registry(4, 8) {
            match d.dispatch(&a.id, input_for(&a.kind)) {
                Ok(_) => {}
                Err(ActionError::NotEngine(_)) => {
                    assert!(
                        a.id.starts_with("app.")
                            || a.id.contains(".grid.")
                            || a.id.ends_with("key_sync")
                            || a.id.contains(".color")
                            || a.id == "mic.record",
                        "{} should reach the engine",
                        a.id
                    );
                }
                Err(e) => panic!("{}: {e}", a.id),
            }
        }
    }

    #[test]
    fn maps_controls_to_commands() {
        let mut d = ActionDispatcher::new(48_000, 2);
        let c = d.dispatch("deck.B.play", ActionInput::Press).unwrap();
        assert!(matches!(c[..], [Command::Deck(DeckId(1), DeckCommand::PlayPause)]));
        assert!(d.dispatch("deck.B.play", ActionInput::Release).unwrap().is_empty());
        let c = d.dispatch("mixer.A.eq.low", ActionInput::Value(-26.0)).unwrap();
        assert!(matches!(c[..], [Command::Mixer(MixerCommand::SetEq(DeckId(0), 0, v))] if v == -26.0));
        // Toggles flip from the mirrored state.
        let on = d.dispatch("deck.A.sync", ActionInput::Press).unwrap();
        assert!(matches!(on[..], [Command::Deck(_, DeckCommand::Sync(true))]));
        let off = d.dispatch("deck.A.sync", ActionInput::Press).unwrap();
        assert!(matches!(off[..], [Command::Deck(_, DeckCommand::Sync(false))]));
        // Loop size selection feeds auto loops and rolls.
        d.dispatch("deck.A.loop.size", ActionInput::Choice(9)).unwrap();
        let c = d.dispatch("deck.A.loop.auto", ActionInput::Press).unwrap();
        assert!(matches!(c[..], [Command::Deck(_, DeckCommand::LoopAuto(b))] if b == 16.0));
        d.dispatch("deck.A.loop.halve", ActionInput::Press).unwrap();
        assert_eq!(d.loop_beats(0), 8.0);
        let c = d.dispatch("deck.A.beatjump.back", ActionInput::Press).unwrap();
        assert!(matches!(c[..], [Command::Deck(_, DeckCommand::BeatJump(b))] if b == -4.0));
        let c = d.dispatch("fx.B.2.type", ActionInput::Choice(1)).unwrap();
        assert!(matches!(&c[..], [Command::Fx(FxTarget::Deck(DeckId(1)), 1, FxCommand::SetEffect(Some(_)))]));
        assert!(matches!(d.dispatch("deck.E.play", ActionInput::Press), Err(ActionError::Unknown(_))));
        assert!(matches!(d.dispatch("deck.A.tempo", ActionInput::Press), Err(ActionError::BadInput(_))));
        assert!(matches!(d.dispatch("app.palette", ActionInput::Press), Err(ActionError::NotEngine(_))));
    }
}
