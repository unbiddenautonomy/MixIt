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
    pub const STEM_LEVEL: ParamSpec = ParamSpec::new(0.0, 1.0, 1.0, Unit::None, Taper::Linear).smoothing(20.0);
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
    pub const MIC_GAIN: ParamSpec = ParamSpec::new(-20.0, 30.0, 0.0, Unit::Decibels, Taper::Linear).smoothing(20.0);
    pub const MIC_LEVEL: ParamSpec = ParamSpec::new(0.0, 1.0, 0.8, Unit::None, Taper::Linear).smoothing(10.0);
    pub const TALKOVER_DEPTH: ParamSpec =
        ParamSpec::new(-30.0, 0.0, -12.0, Unit::Decibels, Taper::Linear).smoothing(20.0);
    pub const PAN: ParamSpec = ParamSpec::new(-1.0, 1.0, 0.0, Unit::None, Taper::Centered).smoothing(20.0);
    /// One-knob amounts that start at off (punch, warmth, sends, ducking, glue).
    pub const AMOUNT: ParamSpec = ParamSpec::new(0.0, 1.0, 0.0, Unit::None, Taper::Linear).smoothing(20.0);
    pub const WIDTH: ParamSpec = ParamSpec::new(0.0, 2.0, 1.0, Unit::None, Taper::Centered).smoothing(30.0);
    pub const RETURN_DB: ParamSpec = ParamSpec::new(-60.0, 6.0, -3.0, Unit::Decibels, Taper::Fader).smoothing(20.0);
    pub const RETURN_PARAM: ParamSpec = ParamSpec::new(0.0, 1.0, 0.5, Unit::None, Taper::Linear).smoothing(20.0);
}

/// Echo return times (beats) for `mixer.echo.time`.
pub const ECHO_TIMES: [(&str, f32); 6] =
    [("1/4 beat", 0.25), ("1/2 beat", 0.5), ("3/4 beat", 0.75), ("1 beat", 1.0), ("2 beats", 2.0), ("4 beats", 4.0)];
/// Slicer stretch lengths (beats) for `deck.X.slice.size`, cut into 8 slices.
pub const SLICE_SIZES: [(&str, f64); 3] = [("1 bar", 4.0), ("2 bars", 8.0), ("4 bars", 16.0)];
/// Roll pad lengths (beats) for `deck.X.roll.1` … `roll.8`.
pub const ROLL_SIZES: [(&str, f64); 8] = [
    ("1/32", 0.03125),
    ("1/16", 0.0625),
    ("1/8", 0.125),
    ("1/4", 0.25),
    ("1/2", 0.5),
    ("1", 1.0),
    ("2", 2.0),
    ("4", 4.0),
];

/// Key pad ranges for `deck.X.keypad.range`: the semitone offset of pad 1 (pads go up
/// one semitone each).
pub const KEYPAD_RANGES: [(&str, i8); 3] = [("Low", -7), ("Middle", -3), ("High", 0)];

/// Which deck a channel ducks under (`mixer.X.duck_source`).
pub const DUCK_SOURCES: [&str; 5] = ["Off", "Deck A", "Deck B", "Deck C", "Deck D"];

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

/// Shortcuts for the first two decks: deck A under the left hand, deck B under the right,
/// mirrored so each finger does the same job on both (little finger Cue, ring Play, middle
/// Sync, index tempo leader; loop keys with Loop in the middle, halve left and double right).
fn deck_shortcuts(d: usize) -> [Option<&'static str>; 13] {
    match d {
        // play, cue, sync, hc1..4, loop, halve, double, nudge-, nudge+, sync-master
        0 => [
            Some("X"),
            Some("Z"),
            Some("C"),
            Some("1"),
            Some("2"),
            Some("3"),
            Some("4"),
            Some("W"),
            Some("Q"),
            Some("E"),
            Some("A"),
            Some("S"),
            Some("V"),
        ],
        1 => [
            Some("."),
            Some("/"),
            Some(","),
            Some("7"),
            Some("8"),
            Some("9"),
            Some("0"),
            Some("I"),
            Some("U"),
            Some("O"),
            Some("J"),
            Some("K"),
            Some("M"),
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
            "How long each echo or sweep lasts, in beats, so it stays in time with the music.",
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
            "Starts or pauses this deck. With Sync and Snap to beat on, it starts right on the beat.",
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
            "Makes this deck play at the same speed as the leading deck, with the beats lined up, and keeps it that way.",
            true,
            sc[2],
            Some("sync"),
        );
        b.add(
            id("master"),
            "Tempo master",
            &g,
            trig(),
            "Makes this deck the leader: every deck with Sync on follows its speed.",
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
        // Stems: turn the singing, drums, bass or melody up, down or off (once a track is split).
        for (stem, name, what) in [
            ("vocals", "Vocals", "the singing and rapping"),
            ("drums", "Drums", "the drums and percussion"),
            ("bass", "Bass", "the bassline"),
            ("melody", "Melody", "everything else: synths, guitars, pianos, pads"),
        ] {
            b.add(
                id(&format!("stem.{stem}")),
                format!("{name} level"),
                &g,
                cont(specs::STEM_LEVEL),
                format!("Turns {what} of this track up or down. Works once the track is split into stems."),
                false,
                None,
                Some("stems"),
            );
            b.add(
                id(&format!("stem.{stem}.mute")),
                format!("Mute {}", name.to_lowercase()),
                &g,
                toggle(),
                format!(
                    "Silences {what} of this track, and brings them back. Works once the track is split into stems."
                ),
                true,
                None,
                Some("stems"),
            );
        }
        b.add(
            id("key_sync"),
            "Key sync",
            &g,
            trig(),
            "Moves this track's key the smallest step that sounds good with the leading deck's key.",
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
                "Empty: saves this spot. Saved: jumps straight to it (on the beat when Snap to beat is on).",
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
        for n in 1..=8 {
            b.add(
                id(&format!("slice.{n}")),
                format!("Slicer pad {n}"),
                &g,
                mom(),
                "Cuts the bar the track is in into 8 slices and plays this one while held, in time. Let go and the track carries on where it would have been.",
                false,
                None,
                Some("slicer"),
            );
            let (label, _) = ROLL_SIZES[n - 1];
            b.add(
                id(&format!("roll.{n}")),
                format!("Roll {label}"),
                &g,
                mom(),
                "Repeats a short slice while held (a stutter); on release the track carries on as if it never stopped.",
                false,
                None,
                Some("loop-roll"),
            );
        }
        for n in 1..=8 {
            b.add(
                id(&format!("keypad.{n}")),
                format!("Key pad {n}"),
                &g,
                mom(),
                "Plays from the chosen hot cue in another key, one semitone per pad, so you can play a melody with it.",
                false,
                None,
                Some("key-pads"),
            );
        }
        b.add(
            id("keypad.cue"),
            "Key pad cue",
            &g,
            choice(&["1", "2", "3", "4", "5", "6", "7", "8"], 0),
            "The hot cue the key pads play from. Pressing a hot cue also picks it.",
            false,
            None,
            Some("key-pads"),
        );
        b.add(
            id("keypad.range"),
            "Key pad range",
            &g,
            choice(&KEYPAD_RANGES.map(|(l, _)| l), 1),
            "Which keys the 8 pads cover: lower, around the track's own key, or higher.",
            false,
            None,
            Some("key-pads"),
        );
        b.add(
            id("slice.size"),
            "Slicer length",
            &g,
            choice(&SLICE_SIZES.map(|(l, _)| l), 1),
            "How much music the 8 slicer pads cover: 1, 2 or 4 bars.",
            false,
            None,
            Some("slicer"),
        );
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
            id("let_end"),
            "Let it end",
            &g,
            trig(),
            "Leaves the safety loop (or any loop) so the track plays out to its end.",
            false,
            None,
            Some("safety-loop"),
        );
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
            "Tells MixIt a bar starts here: the beat you are on becomes the first beat of a bar.",
            false,
            None,
            Some("downbeat"),
        );
        b.add(
            id("grid.halve"),
            "Halve BPM",
            &g,
            trig(),
            "Halves the tempo, for when MixIt counted twice as many beats as the music has.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.double"),
            "Double BPM",
            &g,
            trig(),
            "Doubles the tempo, for when MixIt counted only every other beat.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.nudge_back"),
            "Shift grid earlier",
            &g,
            trig(),
            "Moves the beat lines a tiny bit earlier, so they sit exactly on the kicks.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.nudge_fwd"),
            "Shift grid later",
            &g,
            trig(),
            "Moves the beat lines a tiny bit later, so they sit exactly on the kicks.",
            false,
            None,
            Some("beatgrid"),
        );
        b.add(
            id("grid.warp"),
            "Pin beat here",
            &g,
            trig(),
            "Pins the nearest beat line to the play head. Use it where the lines drift off the kicks on a track whose tempo wanders.",
            false,
            None,
            Some("warp"),
        );
        b.add(
            id("grid.unwarp"),
            "Remove pin",
            &g,
            trig(),
            "Takes away the pinned beat nearest the play head, so the beat lines around it go back to an even spacing.",
            false,
            None,
            Some("warp"),
        );

        let mg = format!("Mixer {l}");
        let mid = |s: &str| format!("mixer.{l}.{s}");
        b.add(
            mid("trim"),
            "Trim",
            &mg,
            cont(specs::TRIM),
            "How loud the track comes into the mixer. Auto-gain sets it so every track starts equally loud.",
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
            "Makes the filter sharper and more whistly as you turn it.",
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
            "Which end of the crossfader this channel belongs to. Thru means the crossfader does not affect it.",
            false,
            None,
            Some("crossfader"),
        );
        b.add(
            mid("color"),
            "Colour FX",
            &mg,
            cont(specs::FILTER),
            "One knob that adds the chosen effect as you turn it either way. The centre is off.",
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

        b.add(
            mid("pan"),
            "Pan",
            &mg,
            cont(specs::PAN),
            "Places this channel left or right in the stereo picture. Centre is straight ahead.",
            false,
            None,
            Some("pan"),
        );
        b.add(
            mid("punch"),
            "Punch",
            &mg,
            cont(specs::AMOUNT),
            "Evens out loud and quiet moments so the track hits harder and sits steadier in the mix (a compressor). A little goes a long way.",
            false,
            None,
            Some("compressor"),
        );
        b.add(
            mid("warmth"),
            "Warmth",
            &mg,
            cont(specs::AMOUNT),
            "Adds the gentle grit of tape: fuller, denser and rounder peaks, without simply getting louder.",
            false,
            None,
            Some("saturation"),
        );
        b.add(
            mid("width"),
            "Stereo width",
            &mg,
            cont(specs::WIDTH),
            "Left makes the track narrower (fully left is mono), right makes it wider. Narrow tracks leave room for others.",
            false,
            None,
            Some("stereo-width"),
        );
        b.add(
            mid("space"),
            "Space (reverb send)",
            &mg,
            cont(specs::AMOUNT),
            "Sends some of this channel into the shared reverb, as if it were played in a bigger room.",
            false,
            None,
            Some("send"),
        );
        b.add(
            mid("echo"),
            "Echo send",
            &mg,
            cont(specs::AMOUNT),
            "Sends some of this channel into the shared echo, which repeats in time with the beat.",
            false,
            None,
            Some("send"),
        );
        b.add(
            mid("duck_source"),
            "Duck under",
            &mg,
            choice(&DUCK_SOURCES, 0),
            "Which deck this channel gets quieter for. Pick the other deck so its kick and bass come through cleanly.",
            false,
            None,
            Some("ducking"),
        );
        b.add(
            mid("duck"),
            "Ducking amount",
            &mg,
            cont(specs::AMOUNT),
            "How far this channel dips while the deck it ducks under plays.",
            false,
            None,
            Some("ducking"),
        );
        b.add(
            mid("gate"),
            "Noise gate",
            &mg,
            toggle(),
            "Silences the channel between sounds, removing hiss and hum in the quiet parts.",
            false,
            None,
            Some("gate"),
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
        "Swaps which deck is on which side of the crossfader (scratch DJs call it a hamster switch).",
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
        "mixer.glue",
        "Glue",
        mg,
        cont(specs::AMOUNT),
        "Gently compresses the whole mix so the tracks sound like they belong together, as mastering engineers do.",
        false,
        None,
        Some("compressor"),
    );
    b.add(
        "mixer.space.level",
        "Reverb return",
        mg,
        cont(specs::RETURN_DB),
        "How loud the shared reverb is in the mix.",
        false,
        None,
        Some("send"),
    );
    b.add(
        "mixer.space.size",
        "Reverb size",
        mg,
        cont(specs::RETURN_PARAM),
        "From a small room (left) to a huge hall (right).",
        false,
        None,
        Some("reverb"),
    );
    b.add(
        "mixer.echo.level",
        "Echo return",
        mg,
        cont(specs::RETURN_DB),
        "How loud the shared echo is in the mix.",
        false,
        None,
        Some("send"),
    );
    b.add(
        "mixer.echo.feedback",
        "Echo repeats",
        mg,
        cont(specs::RETURN_PARAM),
        "How many times the echo repeats before it fades away.",
        false,
        None,
        Some("echo"),
    );
    b.add(
        "mixer.echo.time",
        "Echo time",
        mg,
        choice(&ECHO_TIMES.map(|(n, _)| n), 2),
        "How far apart the echoes are, in beats.",
        false,
        None,
        Some("echo"),
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
    b.add(
        "mixer.bypass",
        "Hear it plain (A/B)",
        mg,
        ActionKind::Toggle,
        "Turns all EQ, filters and effects off at once so you hear the plain music. Turn it off again to hear what your changes did.",
        true,
        Some("Mod+Shift+B"),
        Some("ab-bypass"),
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

    let mg = "Mic";
    b.add(
        "mic.on_air",
        "Mic on",
        mg,
        ActionKind::Toggle,
        "Lets the audience hear your mic. Wear headphones: speakers near the mic make it howl.",
        true,
        Some("Mod+Shift+M"),
        Some("mic"),
    );
    b.add(
        "mic.level",
        "Mic volume",
        mg,
        cont(specs::MIC_LEVEL),
        "How loud your mic is in the mix.",
        true,
        None,
        Some("mic"),
    );
    b.add(
        "mic.gain",
        "Mic gain",
        mg,
        cont(specs::MIC_GAIN),
        "Boosts a quiet mic. Set it so your voice moves the meter well into the green when you talk.",
        false,
        None,
        Some("gain"),
    );
    b.add(
        "mic.cue",
        "Mic in headphones",
        mg,
        ActionKind::Toggle,
        "Lets you hear your mic in your headphones, to check it before going on.",
        false,
        None,
        Some("headphone-cue"),
    );
    b.add(
        "mic.talkover",
        "Talk-over",
        mg,
        ActionKind::Toggle,
        "Turns the music down by itself while you speak, and back up when you stop.",
        true,
        None,
        Some("talk-over"),
    );
    b.add(
        "mic.talkover_depth",
        "Talk-over amount",
        mg,
        cont(specs::TALKOVER_DEPTH),
        "How far the music goes down while you speak.",
        false,
        None,
        Some("talk-over"),
    );
    for (band, label, what) in [
        ("high", "Mic high EQ", "Adds or removes brightness and hiss."),
        ("mid", "Mic mid EQ", "Adds or removes the body of your voice. Turn it up to cut through loud music."),
        ("low", "Mic low EQ", "Adds or removes boom. Turn it down if you sound muffled."),
    ] {
        b.add(format!("mic.eq.{band}"), label, mg, cont(specs::EQ_GAIN), what, false, None, Some("eq"));
    }
    b.add(
        "mic.low_cut",
        "Low cut",
        mg,
        ActionKind::Toggle,
        "Removes rumble, wind and thumps from touching the mic. Leave it on for voice; off for a turntable.",
        false,
        None,
        Some("mic"),
    );
    b.add(
        "mic.gate",
        "Cut background noise",
        mg,
        ActionKind::Toggle,
        "Keeps the mic quiet between words, so fans and room noise stay out of the mix.",
        false,
        None,
        Some("mic"),
    );
    b.add(
        "mic.mono",
        "Mono",
        mg,
        ActionKind::Toggle,
        "Uses one voice on both speakers. Leave it on for a mic; turn it off for a stereo source like a turntable.",
        false,
        None,
        Some("mic"),
    );
    b.add(
        "mic.record",
        "Record the mic",
        mg,
        ActionKind::Toggle,
        "Records what comes in on the mic, to put on a sampler pad or keep in your library as a track.",
        true,
        None,
        Some("mic"),
    );

    let gg = "Transport";
    b.add(
        "global.quantize",
        "Snap to beat",
        gg,
        ActionKind::Toggle,
        "Snap to beat: cues, loops and jumps land exactly on the beat, so everything stays in time.",
        false,
        None,
        Some("quantise"),
    );
    b.add(
        "global.quantize_size",
        "Snap size",
        gg,
        choice(&["1/8 beat", "1/4 beat", "1/2 beat", "1 beat", "1 bar", "1 phrase"], 3),
        "How finely Snap to beat rounds: from an eighth of a beat up to a whole 8-bar phrase.",
        false,
        None,
        None,
    );
    b.add(
        "global.safety_loop",
        "Safety loop",
        gg,
        ActionKind::Toggle,
        "When the only track playing is about to end and nothing is mixed in, its last bars loop on the beat so the music never stops.",
        false,
        None,
        Some("safety-loop"),
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
        "The tempo MixIt keeps for the sampler and effects when no deck is leading.",
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
    b.add(
        "app.clip_copy",
        "Copy clips",
        ag,
        ActionKind::Trigger,
        "Copies the selected clips in Arrange, to paste somewhere else in the mix.",
        true,
        Some("Mod+C"),
        None,
    );
    b.add(
        "app.clip_cut",
        "Cut clips",
        ag,
        ActionKind::Trigger,
        "Removes the selected clips in Arrange and keeps them to paste.",
        true,
        Some("Mod+X"),
        None,
    );
    b.add(
        "app.clip_paste",
        "Paste clips",
        ag,
        ActionKind::Trigger,
        "Pastes copied clips in Arrange at the play marker, keeping their spacing and moves.",
        true,
        Some("Mod+V"),
        None,
    );
    b.add(
        "app.clip_duplicate",
        "Duplicate clips",
        ag,
        ActionKind::Trigger,
        "Copies the selected clips in Arrange to just after themselves, to repeat a section.",
        true,
        Some("Mod+D"),
        None,
    );
    b.add(
        "app.clip_delete",
        "Delete clips",
        ag,
        ActionKind::Trigger,
        "Removes the selected clips from the mix in Arrange.",
        true,
        Some("Delete"),
        None,
    );
    b.add(
        "app.clip_split",
        "Cut clip in two",
        ag,
        ActionKind::Trigger,
        "Cuts the selected clips (or every clip under the play marker) in two at the marker.",
        true,
        Some("Mod+B"),
        None,
    );
    b.add(
        "app.select_all",
        "Select all clips",
        ag,
        ActionKind::Trigger,
        "Selects every clip in Arrange.",
        true,
        Some("Mod+A"),
        None,
    );
    b.add(
        "app.marker_add",
        "Add marker",
        ag,
        ActionKind::Trigger,
        "Adds a named marker on the Arrange ruler at the play marker, like Drop or Outro.",
        true,
        None,
        None,
    );
    b.add(
        "app.marker_next",
        "Next marker",
        ag,
        ActionKind::Trigger,
        "Moves the play marker to the next marker on the Arrange ruler.",
        true,
        None,
        None,
    );
    b.add(
        "app.marker_prev",
        "Previous marker",
        ag,
        ActionKind::Trigger,
        "Moves the play marker to the previous marker on the Arrange ruler.",
        true,
        None,
        None,
    );
    b.add(
        "app.preview",
        "Preview track",
        ag,
        ActionKind::Trigger,
        "Plays the selected library track in your headphones without loading it on a deck, so you can check it while the music plays. Press again to stop.",
        true,
        Some("P"),
        Some("preview"),
    );
    b.add(
        "app.arrange_loop",
        "Loop playback",
        ag,
        ActionKind::Trigger,
        "Repeats a stretch of the mix in Arrange while you adjust it.",
        true,
        Some("L"),
        None,
    );
    b.add(
        "app.arrange_play",
        "Play or stop the mix",
        ag,
        ActionKind::Trigger,
        "Plays the Arrange timeline from the play marker, or stops it.",
        true,
        Some("Space"),
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
        "Sampler pads",
        ag,
        ActionKind::Toggle,
        "Shows or hides the sampler pads in the tools panel under the decks.",
        true,
        Some("Mod+P"),
        Some("sampler"),
    );
    b.add(
        "app.tools",
        "Tools panel",
        ag,
        ActionKind::Toggle,
        "Shows or tucks away the tools panel under the decks: pads, step sequencer, effects, mic and recording.",
        true,
        Some("Mod+Shift+T"),
        None,
    );
    b.add(
        "app.tools_full",
        "Tools full screen",
        ag,
        ActionKind::Toggle,
        "Gives the tools panel the whole screen under the waveforms, or puts it back beside the library.",
        true,
        Some("Mod+Shift+F"),
        None,
    );
    b.add(
        "app.layout_edit",
        "Edit layout",
        ag,
        ActionKind::Toggle,
        "Lets you move parts of the screen by dragging their names: onto an edge to put one beside another, onto the middle to make it a tab. Press again (or Esc) when you're done.",
        true,
        Some("Mod+Shift+L"),
        None,
    );
    b.add(
        "app.layout_standard",
        "Standard layout",
        ag,
        ActionKind::Trigger,
        "Puts every part of the screen back where MixIt first had it, for the screens you have now. You can undo it.",
        false,
        None,
        None,
    );
    b.add(
        "app.controller",
        "Playing with a DJ controller",
        ag,
        ActionKind::Toggle,
        "Tells MixIt a DJ controller is plugged in, so the parts it has knobs for (the mixer) fold away to make room. Turn it off when you unplug it.",
        true,
        None,
        None,
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
        "app.autodj",
        "Auto DJ",
        ag,
        ActionKind::Toggle,
        "Mixes a queue of tracks for you, choosing where and how to mix each one, and explains every choice.",
        true,
        None,
        Some("auto-dj"),
    );
    b.add(
        "app.mix_it",
        "Mix it",
        ag,
        ActionKind::Trigger,
        "Runs a whole transition into the other deck on the beat, picking the transition, length and key shift the way Auto DJ does.",
        true,
        Some("T"),
        Some("auto-dj"),
    );
    b.add(
        "app.hear_mix",
        "Hear the mix first",
        ag,
        ActionKind::Trigger,
        "Plays the coming mix in your headphones before the audience hears it: Auto DJ's next mix, or what Mix it would do now.",
        true,
        Some("H"),
        Some("auto-dj"),
    );
    b.add(
        "app.mix_now",
        "Mix now",
        ag,
        ActionKind::Trigger,
        "Starts Auto DJ's next mix right away instead of waiting for the planned point.",
        true,
        None,
        Some("auto-dj"),
    );
    b.add(
        "app.rehearse_set",
        "Rehearse the set",
        ag,
        ActionKind::Trigger,
        "Plays every change in the Auto DJ queue one after another in your headphones, a few bars either side of each.",
        true,
        None,
        Some("auto-dj"),
    );
    b.add(
        "app.make_mix",
        "Make a mix from the queue",
        ag,
        ActionKind::Trigger,
        "Turns the Auto DJ queue into a finished mix in Arrange, every change as Auto DJ would do it, ready to render.",
        true,
        None,
        Some("auto-dj"),
    );
    b.add(
        "app.best_order",
        "Best order for the queue",
        ag,
        ActionKind::Trigger,
        "Reorders the Auto DJ queue so every change is as easy to mix as it can be, with the energy going your way.",
        true,
        None,
        Some("auto-dj"),
    );
    b.add(
        "app.save_queue",
        "Save the queue as a playlist",
        ag,
        ActionKind::Trigger,
        "Keeps the Auto DJ queue as a playlist in its order, to play again or share.",
        true,
        None,
        Some("auto-dj"),
    );
    b.add(
        "app.sequencer",
        "Step sequencer",
        ag,
        ActionKind::Toggle,
        "Plays the sampler pads in a looping pattern that follows the beat. Opens the sequencer and starts or stops it.",
        true,
        None,
        Some("sequencer"),
    );
    b.add(
        "app.assistant",
        "Mix assistant",
        ag,
        ActionKind::Toggle,
        "Listens to your mix and tells you what to fix (clashing bass, clipping, loudness, harsh or muddy tone), with a button that fixes it.",
        true,
        None,
        Some("studio"),
    );
    b.add(
        "app.tour",
        "Take the 2-minute tour",
        ag,
        ActionKind::Trigger,
        "Walks you through your first mix: play two tracks in time and blend from one into the other.",
        true,
        None,
        None,
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
