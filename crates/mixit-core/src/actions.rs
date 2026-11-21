//! The action registry: every control in MixIt has a stable ID, a kind, a range and a
//! one-line explanation.
//!
//! Pointer, keyboard, command palette, automation, lab scripts and (later) MIDI all
//! invoke actions by ID, so they can never disagree about what a control does.
//! The guide, coach and labs reference action IDs too, and CI fails when one of them
//! names an ID that is not in this registry (see `docs/engine-rules.md`).
//!
//! ID scheme: `<area>.<target>.<control>[.<n>]`, for example `deck.A.play`,
//! `mixer.B.eq.low`, `fx.A.1.mix`, `sampler.pad.3`, `app.palette`.

use crate::params::{ParamSpec, Taper, Unit};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ActionKind {
    /// Fires once per press.
    Trigger,
    /// Acts while held (press and release both matter).
    Momentary,
    /// On or off.
    Toggle,
    /// A continuous value.
    Continuous { spec: ParamSpec },
    /// One of a fixed list of options.
    Choice { options: Vec<String>, default: usize },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSpec {
    pub id: String,
    pub label: String,
    /// Grouping for the palette and explain mode ("Deck A", "Mixer", "FX A").
    pub group: String,
    pub kind: ActionKind,
    /// Explain-mode text: what it does and when to use it, in plain words.
    pub explain: String,
    /// Shown in the Easy view.
    pub easy: bool,
    /// Default shortcut, with `Mod` meaning Ctrl on Windows and Linux, Cmd on macOS.
    pub shortcut: Option<String>,
    /// Glossary entry to open from explain mode.
    pub glossary: Option<String>,
}

struct B {
    v: Vec<ActionSpec>,
}

impl B {
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        id: impl Into<String>,
        label: impl Into<String>,
        group: impl Into<String>,
        kind: ActionKind,
        explain: impl Into<String>,
        easy: bool,
        shortcut: Option<&str>,
        glossary: Option<&str>,
    ) {
        self.v.push(ActionSpec {
            id: id.into(),
            label: label.into(),
            group: group.into(),
            kind,
            explain: explain.into(),
            easy,
            shortcut: shortcut.map(str::to_string),
            glossary: glossary.map(str::to_string),
        });
    }
}

fn cont(spec: ParamSpec) -> ActionKind {
    ActionKind::Continuous { spec }
}

fn choice(options: &[&str], default: usize) -> ActionKind {
    ActionKind::Choice { options: options.iter().map(|s| s.to_string()).collect(), default }
}

/// Parameter specs shared between the registry and the engine.
pub mod specs {
    use super::*;

    pub const TEMPO: ParamSpec = ParamSpec::new(-1.0, 1.0, 0.0, Unit::None, Taper::Linear).smoothing(20.0);
    pub const KEY_SHIFT: ParamSpec =
        ParamSpec::new(-12.0, 12.0, 0.0, Unit::Semitones, Taper::Linear).smoothing(30.0).step(0.01);
    pub const TRIM: ParamSpec = ParamSpec::new(-12.0, 12.0, 0.0, Unit::Decibels, Taper::Centered).smoothing(20.0);
    pub const EQ_GAIN: ParamSpec = ParamSpec::new(-26.0, 6.0, 0.0, Unit::Decibels, Taper::Centered).smoothing(15.0);
    pub const FILTER: ParamSpec = ParamSpec::new(-1.0, 1.0, 0.0, Unit::None, Taper::Centered).smoothing(15.0);
    pub const RESONANCE: ParamSpec = ParamSpec::new(0.0, 1.0, 0.3, Unit::None, Taper::Linear).smoothing(15.0);
    pub const FADER: ParamSpec = ParamSpec::new(0.0, 1.0, 1.0, Unit::None, Taper::Linear).smoothing(10.0);
    pub const CROSSFADER: ParamSpec = ParamSpec::new(-1.0, 1.0, 0.0, Unit::None, Taper::Centered).smoothing(5.0);
    pub const MASTER_DB: ParamSpec = ParamSpec::new(-120.0, 6.0, 0.0, Unit::Decibels, Taper::Fader).smoothing(20.0);
    pub const UNIT: ParamSpec = ParamSpec::new(0.0, 1.0, 0.5, Unit::None, Taper::Linear).smoothing(15.0);
    pub const MIX: ParamSpec = ParamSpec::new(0.0, 1.0, 0.5, Unit::None, Taper::Linear).smoothing(15.0);
}

pub const TEMPO_RANGES: [(&str, f32); 6] =
    [("±6%", 0.06), ("±8%", 0.08), ("±10%", 0.10), ("±16%", 0.16), ("±50%", 0.50), ("±100%", 1.00)];

pub const CROSSFADER_CURVES: [&str; 3] = ["Smooth blend", "Constant power", "Sharp cut"];
pub const FADER_CURVES: [&str; 3] = ["Linear", "Smooth", "Steep"];
pub const EQ_MODES: [&str; 2] = ["Classic", "Isolator"];
pub const XFADER_ASSIGN: [&str; 3] = ["A", "Thru", "B"];
pub const FX_TYPES: [&str; 18] = [
    "None",
    "Echo",
    "Ping-pong delay",
    "Reverb",
    "Filter LFO",
    "Flanger",
    "Phaser",
    "Chorus",
    "Gater",
    "Slicer",
    "Beat repeat",
    "Bitcrusher",
    "Distortion",
    "Tape stop",
    "Pitch delay",
    "Ring modulator",
    "Noise riser",
    "Dub echo",
];

/// Shortcuts for the first two decks (see Product and UX in the plan).
fn deck_shortcuts(d: usize) -> [Option<&'static str>; 13] {
    match d {
        // play, cue, sync, hc1..4, loop, halve, double, nudge-, nudge+, sync-master
        0 => [
            Some("Z"),
            Some("X"),
            Some("C"),
            Some("1"),
            Some("2"),
            Some("3"),
            Some("4"),
            Some("Q"),
            Some("W"),
            Some("E"),
            Some("A"),
            Some("S"),
            None,
        ],
        1 => [
            Some("M"),
            Some(","),
            Some("."),
            Some("7"),
            Some("8"),
            Some("9"),
            Some("0"),
            Some("U"),
            Some("I"),
            Some("O"),
            Some("J"),
            Some("K"),
            None,
        ],
        _ => [None; 13],
    }
}

/// The three effect slots of one FX unit (`fx.{unit}.{slot}.*`), for a deck or the master.
fn fx_slots(b: &mut B, unit: &str, fg: &str) {
    let toggle = || ActionKind::Toggle;
    let master = unit == "master";
    for slot in 1..=3 {
        let fid = |s: &str| format!("fx.{unit}.{slot}.{s}");
        b.add(
            fid("type"),
            format!("FX {slot} type"),
            fg,
            choice(&FX_TYPES, if slot == 1 { 1 } else { 0 }),
            "Which effect this slot runs.",
            false,
            None,
            Some("fx"),
        );
        b.add(
            fid("on"),
            format!("FX {slot} on"),
            fg,
            toggle(),
            "Switches the effect on or off. Echo and reverb tails keep ringing after you switch them off.",
            slot == 1 && !master,
            None,
            Some("fx"),
        );
        b.add(
            fid("mix"),
            format!("FX {slot} amount"),
            fg,
            cont(specs::MIX),
            "How much of the effect you hear.",
            slot == 1 && !master,
            None,
            Some("dry-wet"),
        );
        b.add(
            fid("beats"),
            format!("FX {slot} beats"),
            fg,
            choice(&["1/16", "1/8", "1/4", "1/2", "3/4", "1", "2", "4", "8", "16"], 4),
            "The effect's timing in beats, locked to the tempo.",
            false,
            None,
            None,
        );
        b.add(
            fid("p1"),
            format!("FX {slot} parameter 1"),
            fg,
            cont(specs::UNIT),
            "The effect's main setting (feedback, depth or size).",
            false,
            None,
            None,
        );
        b.add(
            fid("p2"),
            format!("FX {slot} parameter 2"),
            fg,
            cont(specs::UNIT),
            "The effect's second setting (tone or rate).",
            false,
            None,
            None,
        );
    }
}

/// Builds the full registry for `num_decks` decks and `num_pads` sampler pads.
pub fn registry(num_decks: usize, num_pads: usize) -> Vec<ActionSpec> {
    let mut b = B { v: Vec::with_capacity(512) };
    let toggle = || ActionKind::Toggle;
    let trig = || ActionKind::Trigger;
    let mom = || ActionKind::Momentary;

    for d in 0..num_decks {
        let l = (b'A' + d as u8) as char;
        let g = format!("Deck {l}");
        let sc = deck_shortcuts(d);
        let id = |s: &str| format!("deck.{l}.{s}");
        b.add(
            id("play"),
            "Play / pause",
            &g,
            trig(),
            "Starts or pauses this deck. Starts on the beat when quantise and sync are on.",
            true,
            sc[0],
            Some("play"),
        );
        b.add(
            id("cue"),
            "Cue",
            &g,
            mom(),
            "Paused: sets the cue point here and plays while held. Playing: jumps back to the cue point and stops.",
            true,
            sc[1],
            Some("cue-point"),
        );
        b.add(
            id("sync"),
            "Sync",
            &g,
            toggle(),
            "Matches this deck's tempo and beat to the tempo master, and keeps it locked.",
            true,
            sc[2],
            Some("sync"),
        );
        b.add(
            id("master"),
            "Tempo master",
            &g,
            trig(),
            "Makes this deck the one other synced decks follow.",
            false,
            sc[12],
            Some("tempo-master"),
        );
        b.add(
            id("keylock"),
            "Key lock",
            &g,
            toggle(),
            "Keeps the musical pitch the same when you change tempo, so vocals do not sound higher or lower.",
            false,
            None,
            Some("key-lock"),
        );
        b.add(
            id("tempo"),
            "Tempo",
            &g,
            cont(specs::TEMPO),
            "Speeds the track up or slows it down within the tempo range.",
            false,
            None,
            Some("tempo"),
        );
        b.add(
            id("tempo_range"),
            "Tempo range",
            &g,
            choice(&TEMPO_RANGES.map(|r| r.0), 3),
            "How far the tempo fader can change the speed. Small ranges give finer control.",
            false,
            None,
            None,
        );
        b.add(
            id("tempo_reset"),
            "Reset tempo",
            &g,
            trig(),
            "Returns the track to its original tempo.",
            false,
            None,
            None,
        );
        b.add(
            id("nudge_down"),
            "Nudge slower",
            &g,
            mom(),
            "Slows the track briefly while held, to pull its beat back into line by ear.",
            false,
            sc[10],
            Some("nudge"),
        );
        b.add(
            id("nudge_up"),
            "Nudge faster",
            &g,
            mom(),
            "Speeds the track briefly while held, to push its beat into line by ear.",
            false,
            sc[11],
            Some("nudge"),
        );
        b.add(
            id("key_shift"),
            "Key shift",
            &g,
            cont(specs::KEY_SHIFT),
            "Moves the musical key up or down without changing tempo.",
            false,
            None,
            Some("key"),
        );
        b.add(
            id("key_sync"),
            "Key sync",
            &g,
            trig(),
            "Shifts this track to the nearest key that fits the tempo master's key.",
            false,
            None,
            Some("harmonic-mixing"),
        );
        for (i, n) in (1..=16).enumerate() {
            let s = if i < 4 { sc[3 + i] } else { None };
            b.add(
                id(&format!("hotcue.{n}")),
                format!("Hot cue {n}"),
                &g,
                mom(),
                "Empty: saves this spot. Set: jumps to it instantly (in time with the beat when quantise is on).",
                i < 4,
                s,
                Some("hot-cue"),
            );
            b.add(
                id(&format!("hotcue.{n}.delete")),
                format!("Delete hot cue {n}"),
                &g,
                trig(),
                "Removes this hot cue.",
                false,
                None,
                None,
            );
        }
        b.add(
            id("loop.auto"),
            "Loop",
            &g,
            toggle(),
            "Repeats the next few beats seamlessly. Press again to leave the loop.",
            true,
            sc[7],
            Some("loop"),
        );
        b.add(
            id("loop.size"),
            "Loop size",
            &g,
            choice(&["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4", "8", "16", "32"], 7),
            "Length of the loop in beats.",
            false,
            None,
            None,
        );
        b.add(id("loop.halve"), "Halve loop", &g, trig(), "Makes the loop half as long.", false, sc[8], None);
        b.add(id("loop.double"), "Double loop", &g, trig(), "Makes the loop twice as long.", false, sc[9], None);
        b.add(id("loop.in"), "Loop in", &g, trig(), "Marks where a manual loop starts.", false, None, None);
        b.add(
            id("loop.out"),
            "Loop out",
            &g,
            trig(),
            "Marks where a manual loop ends and starts looping.",
            false,
            None,
            None,
        );
        b.add(id("loop.reloop"), "Reloop", &g, trig(), "Jumps back into the last loop.", false, None, None);
        b.add(
            id("loop.roll"),
            "Loop roll",
            &g,
            mom(),
            "Loops a short slice while held; on release the track continues as if it never stopped.",
            false,
            None,
            Some("loop-roll"),
        );
        b.add(
            id("loop.move_back"),
            "Move loop back",
            &g,
            trig(),
            "Moves the loop earlier by its own length.",
            false,
            None,
            None,
        );
        b.add(
            id("loop.move_fwd"),
            "Move loop forward",
            &g,
            trig(),
            "Moves the loop later by its own length.",
            false,
            None,
            None,
        );
        b.add(
            id("beatjump.back"),
            "Beat jump back",
            &g,
            trig(),
            "Jumps back by the beat-jump size, staying on the beat.",
            false,
            None,
            Some("beat-jump"),
        );
        b.add(
            id("beatjump.fwd"),
            "Beat jump forward",
            &g,
            trig(),
            "Jumps forward by the beat-jump size, staying on the beat.",
            false,
            None,
            Some("beat-jump"),
        );
        b.add(
            id("beatjump.size"),
            "Beat jump size",
            &g,
            choice(&["1", "2", "4", "8", "16", "32"], 4),
            "How many beats a beat jump moves.",
            false,
            None,
            None,
        );
        b.add(id("slip"), "Slip", &g, toggle(), "While on, loops, scratches and reverse play over a hidden playhead; when they end the track resumes where it would have been.", false, None, Some("slip"));
        b.add(
            id("censor"),
            "Censor",
            &g,
            mom(),
            "Plays backwards while held, then carries on as if it had not.",
            false,
            None,
            None,
        );
        b.add(id("reverse"), "Reverse", &g, toggle(), "Plays the track backwards.", false, None, None);
        b.add(id("brake"), "Brake", &g, trig(), "Stops the track like a turntable powering down.", false, None, None);
        b.add(id("spinup"), "Spin up", &g, trig(), "Starts the track like a turntable powering up.", false, None, None);
        b.add(
            id("double"),
            "Instant double",
            &g,
            trig(),
            "Loads this track onto another deck at the same position and in time.",
            false,
            None,
            None,
        );
        b.add(id("eject"), "Eject", &g, trig(), "Unloads the track from this deck.", false, None, None);
        b.add(
            id("grid.set_downbeat"),
            "Set downbeat",
            &g,
            trig(),
            "Marks the current position as beat 1 of a bar.",
            false,
            None,
            Some("downbeat"),
        );
        b.add(
            id("grid.halve"),
            "Halve BPM",
            &g,
            trig(),
            "Fixes a grid detected at double the real tempo.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.double"),
            "Double BPM",
            &g,
            trig(),
            "Fixes a grid detected at half the real tempo.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.nudge_back"),
            "Shift grid earlier",
            &g,
            trig(),
            "Moves the beatgrid 1 ms earlier.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.nudge_fwd"),
            "Shift grid later",
            &g,
            trig(),
            "Moves the beatgrid 1 ms later.",
            false,
            None,
            Some("beatgrid"),
        );

        let mg = format!("Mixer {l}");
        let mid = |s: &str| format!("mixer.{l}.{s}");
        b.add(
            mid("trim"),
            "Trim",
            &mg,
            cont(specs::TRIM),
            "Sets how loud the track enters the mixer. Auto-gain sets it for you.",
            false,
            None,
            Some("gain"),
        );
        b.add(
            mid("eq.high"),
            "High EQ",
            &mg,
            cont(specs::EQ_GAIN),
            "Turns the treble (cymbals, hi-hats, air) up or down.",
            false,
            None,
            Some("eq"),
        );
        b.add(
            mid("eq.mid"),
            "Mid EQ",
            &mg,
            cont(specs::EQ_GAIN),
            "Turns the middle (vocals, synths, snares) up or down.",
            false,
            None,
            Some("eq"),
        );
        b.add(
            mid("eq.low"),
            "Low EQ",
            &mg,
            cont(specs::EQ_GAIN),
            "Turns the bass and kick drum up or down. Lower it on one track so two basslines do not clash.",
            false,
            None,
            Some("eq"),
        );
        b.add(
            mid("eq.kill.high"),
            "Kill highs",
            &mg,
            toggle(),
            "Removes the treble completely.",
            false,
            None,
            Some("eq"),
        );
        b.add(
            mid("eq.kill.mid"),
            "Kill mids",
            &mg,
            toggle(),
            "Removes the middle completely.",
            false,
            None,
            Some("eq"),
        );
        b.add(mid("eq.kill.low"), "Kill lows", &mg, toggle(), "Removes the bass completely.", false, None, Some("eq"));
        b.add(
            mid("filter"),
            "Filter",
            &mg,
            cont(specs::FILTER),
            "Left removes highs (muffled, far away); right removes lows (thin, airy). Centre is off.",
            true,
            None,
            Some("filter"),
        );
        b.add(
            mid("filter_res"),
            "Filter resonance",
            &mg,
            cont(specs::RESONANCE),
            "Adds a ringing peak at the filter's edge.",
            false,
            None,
            Some("resonance"),
        );
        b.add(mid("fader"), "Volume", &mg, cont(specs::FADER), "This channel's volume.", true, None, Some("fader"));
        b.add(
            mid("cue"),
            "Headphone cue",
            &mg,
            toggle(),
            "Sends this channel to your headphones so you can listen before the audience hears it.",
            true,
            None,
            Some("headphone-cue"),
        );
        b.add(
            mid("assign"),
            "Crossfader side",
            &mg,
            choice(&XFADER_ASSIGN, if d % 2 == 0 { 0 } else { 2 }),
            "Which side of the crossfader this channel is on. Thru ignores the crossfader.",
            false,
            None,
            Some("crossfader"),
        );
        b.add(
            mid("color"),
            "Colour FX",
            &mg,
            cont(specs::FILTER),
            "One knob for the selected colour effect. Centre is off.",
            false,
            None,
            Some("colour-fx"),
        );
        b.add(
            mid("color_type"),
            "Colour FX type",
            &mg,
            choice(&["Filter", "Noise", "Space", "Dub echo", "Crush"], 0),
            "Which effect the colour knob controls.",
            false,
            None,
            None,
        );

        fx_slots(&mut b, &l.to_string(), &format!("FX {l}"));
    }

    fx_slots(&mut b, "master", "Master FX");

    let mg = "Mixer";
    b.add(
        "mixer.crossfader",
        "Crossfader",
        mg,
        cont(specs::CROSSFADER),
        "Blends from the left deck to the right deck.",
        true,
        None,
        Some("crossfader"),
    );
    b.add(
        "mixer.crossfader_curve",
        "Crossfader curve",
        mg,
        choice(&CROSSFADER_CURVES, 1),
        "Smooth for long blends, sharp for quick cuts and scratching.",
        false,
        None,
        Some("crossfader"),
    );
    b.add(
        "mixer.crossfader_reverse",
        "Reverse crossfader",
        mg,
        ActionKind::Toggle,
        "Swaps the crossfader's sides (hamster switch).",
        false,
        None,
        None,
    );
    b.add(
        "mixer.fader_curve",
        "Channel fader curve",
        mg,
        choice(&FADER_CURVES, 1),
        "How quickly the channel faders get loud as you raise them.",
        false,
        None,
        None,
    );
    b.add(
        "mixer.eq_mode",
        "EQ mode",
        mg,
        choice(&EQ_MODES, 1),
        "Classic EQ shapes the tone gently; Isolator can remove each band completely.",
        false,
        None,
        Some("isolator"),
    );
    b.add(
        "mixer.master",
        "Master volume",
        mg,
        cont(specs::MASTER_DB),
        "Volume of everything the audience hears.",
        true,
        None,
        Some("master"),
    );
    b.add(
        "mixer.booth",
        "Booth volume",
        mg,
        cont(specs::MASTER_DB),
        "Volume of the booth monitor output.",
        false,
        None,
        None,
    );
    b.add(
        "mixer.cue_mix",
        "Cue mix",
        mg,
        cont(specs::MIX),
        "Headphones: left hears only the cued channels, right hears the master.",
        false,
        None,
        Some("cue-mix"),
    );
    b.add(
        "mixer.headphones",
        "Headphone volume",
        mg,
        cont(specs::MASTER_DB),
        "Volume in your headphones.",
        true,
        None,
        None,
    );
    b.add(
        "mixer.split_cue",
        "Split cue",
        mg,
        ActionKind::Toggle,
        "Cue in the left ear and master in the right, for mixing with one pair of headphones.",
        false,
        None,
        Some("split-cue"),
    );
    b.add(
        "mixer.auto_gain",
        "Auto-gain",
        mg,
        ActionKind::Toggle,
        "Sets each track's trim so all tracks start equally loud.",
        false,
        None,
        Some("gain"),
    );
    b.add(
        "mixer.limiter",
        "Master limiter",
        mg,
        ActionKind::Toggle,
        "Stops the master output from distorting. Leave it on.",
        false,
        None,
        Some("limiter"),
    );

    let sg = "Sampler";
    for n in 1..=num_pads {
        // Shift plus the number keys play the first eight pads (the numbers alone are
        // hot cues). Function keys are avoided: browsers and webviews claim several.
        let key = format!("Shift+{n}");
        b.add(
            format!("sampler.pad.{n}"),
            format!("Pad {n}"),
            sg,
            ActionKind::Momentary,
            "Plays this pad's sound: air horns, risers, drum hits or loops on top of your mix.",
            n <= 4,
            (n <= 8).then_some(key.as_str()),
            Some("sampler"),
        );
        b.add(
            format!("sampler.pad.{n}.mode"),
            format!("Pad {n} mode"),
            sg,
            choice(&["One-shot", "Gate", "Loop"], 0),
            "One-shot plays to the end, gate plays while held, loop repeats in time.",
            false,
            None,
            None,
        );
    }
    b.add("sampler.volume", "Sampler volume", sg, cont(specs::FADER), "Volume of all pads.", true, None, None);
    b.add(
        "sampler.stop_all",
        "Stop all pads",
        sg,
        ActionKind::Trigger,
        "Stops every pad that is playing, including loops.",
        false,
        None,
        None,
    );

    let gg = "Transport";
    b.add(
        "global.quantize",
        "Quantise",
        gg,
        ActionKind::Toggle,
        "Snaps cues, loops and jumps to the beat so everything stays in time.",
        false,
        None,
        Some("quantise"),
    );
    b.add(
        "global.quantize_size",
        "Quantise size",
        gg,
        choice(&["1/8 beat", "1/4 beat", "1/2 beat", "1 beat", "1 bar", "1 phrase"], 3),
        "The grid that quantise snaps to.",
        false,
        None,
        None,
    );
    b.add(
        "global.record",
        "Record",
        gg,
        ActionKind::Toggle,
        "Records the master output and every control movement.",
        true,
        Some("Mod+R"),
        Some("recording"),
    );
    b.add(
        "global.master_bpm",
        "Master tempo",
        gg,
        cont(ParamSpec::new(60.0, 200.0, 124.0, Unit::Bpm, Taper::Linear).step(0.01)),
        "Tempo of the internal clock when no deck is tempo master.",
        false,
        None,
        Some("tempo-master"),
    );

    let ag = "App";
    for (i, name) in ["Library", "Decks", "Arrange", "Edit", "Mix"].iter().enumerate() {
        let sc = format!("Mod+{}", i + 1);
        b.add(
            format!("app.workspace.{}", name.to_ascii_lowercase()),
            format!("Go to {name}"),
            ag,
            ActionKind::Trigger,
            format!("Opens the {name} workspace."),
            true,
            Some(&sc),
            None,
        );
    }
    b.add(
        "app.palette",
        "Command palette",
        ag,
        ActionKind::Trigger,
        "Search every command by name.",
        true,
        Some("Mod+K"),
        None,
    );
    b.add("app.undo", "Undo", ag, ActionKind::Trigger, "Undoes the last change.", true, Some("Mod+Z"), None);
    b.add(
        "app.redo",
        "Redo",
        ag,
        ActionKind::Trigger,
        "Redoes the last undone change.",
        true,
        Some("Mod+Shift+Z"),
        None,
    );
    b.add(
        "app.view_mode",
        "Easy or Pro",
        ag,
        ActionKind::Toggle,
        "Easy shows the essentials; Pro shows every control. Nothing is locked.",
        true,
        Some("Mod+E"),
        Some("easy-pro"),
    );
    b.add(
        "app.explain",
        "Explain mode",
        ag,
        ActionKind::Momentary,
        "Hold to see what every visible control does.",
        true,
        Some("?"),
        None,
    );
    b.add(
        "app.settings",
        "Settings",
        ag,
        ActionKind::Trigger,
        "Audio device, library, analysis, appearance and shortcuts.",
        true,
        Some("Mod+,"),
        None,
    );
    b.add(
        "app.coach",
        "Coach",
        ag,
        ActionKind::Toggle,
        "Shows hints while you mix, based on what MixIt hears.",
        true,
        None,
        Some("coach"),
    );
    b.add(
        "app.save",
        "Save mix project",
        ag,
        ActionKind::Trigger,
        "Saves the mix project you are arranging.",
        true,
        Some("Mod+S"),
        None,
    );
    b.add(
        "app.save_as",
        "Save mix project as",
        ag,
        ActionKind::Trigger,
        "Saves the mix project under a new name.",
        false,
        Some("Mod+Shift+S"),
        None,
    );
    b.add(
        "app.open",
        "Open mix project",
        ag,
        ActionKind::Trigger,
        "Opens a saved mix project in Arrange.",
        true,
        Some("Mod+O"),
        None,
    );
    b.add(
        "app.sampler",
        "Sampler and master FX",
        ag,
        ActionKind::Toggle,
        "Shows or hides the sampler pads and the effects on the whole mix.",
        true,
        Some("Mod+P"),
        Some("sampler"),
    );
    b.add(
        "app.guide",
        "Guide and practice labs",
        ag,
        ActionKind::Toggle,
        "Opens the built-in guide: what each part of DJing means, step-by-step practice labs, and fixes for common problems.",
        true,
        Some("Mod+G"),
        Some("guide"),
    );
    b.add(
        "app.feedback",
        "Mix feedback",
        ag,
        ActionKind::Trigger,
        "Shows how your last recorded mix went: what went well, what to work on, and every transition checked.",
        true,
        None,
        None,
    );
    b.add(
        "app.edit_track",
        "Edit track",
        ag,
        ActionKind::Trigger,
        "Opens the track editor for the selected deck: fix the beat grid, name and colour cues, choose where the track starts, and turn a passage into a loop or a sampler pad.",
        true,
        Some("Mod+Shift+E"),
        None,
    );

    b.v
}

/// Looks up a spec by id.
pub fn find<'a>(registry: &'a [ActionSpec], id: &str) -> Option<&'a ActionSpec> {
    registry.iter().find(|a| a.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique_and_well_formed() {
        let r = registry(4, 16);
        let mut seen = HashSet::new();
        for a in &r {
            assert!(seen.insert(a.id.clone()), "duplicate {}", a.id);
            assert!(a.id.split('.').count() >= 2, "bad id {}", a.id);
            assert!(!a.explain.is_empty(), "no explanation for {}", a.id);
            assert!(a.explain.len() < 200, "explanation too long for {}", a.id);
        }
        assert!(r.len() > 300);
    }

    #[test]
    fn shortcuts_do_not_clash() {
        let r = registry(4, 16);
        let mut seen = HashSet::new();
        for a in &r {
            if let Some(s) = &a.shortcut {
                assert!(seen.insert(s.clone()), "shortcut {s} used twice");
            }
        }
    }

    #[test]
    fn serialises_for_the_ui() {
        let r = registry(2, 8);
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"id\":\"deck.A.play\""));
        assert!(json.contains("\"type\":\"continuous\""));
        let back: Vec<ActionSpec> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, r);
        assert!(find(&r, "mixer.B.eq.low").is_some());
    }
}
