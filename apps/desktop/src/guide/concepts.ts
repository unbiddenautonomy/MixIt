// Plain-English concepts for the guide's Learn tab. Each names the real controls it is
// about, so "Show me" can light them up, and links to the lab that practises it.

export interface Concept {
  id: string;
  title: string;
  group: ConceptGroup;
  /** One line, shown in the list. */
  summary: string;
  /** A few short paragraphs. */
  body: string[];
  /** Controls to light up with "Show me". */
  controls?: string[];
  /** Lab that practises this. */
  lab?: string;
  /** Pad tab to open on deck A so the controls are visible. */
  tab?: string;
  /** Registry glossary keys that point here. */
  glossary?: string[];
}

export type ConceptGroup = "Basics" | "Beat and tempo" | "Mixer" | "Keys" | "Effects and tricks" | "Your library" | "Sound quality";

export const CONCEPT_GROUPS: ConceptGroup[] = ["Basics", "Beat and tempo", "Mixer", "Keys", "Effects and tricks", "Your library", "Sound quality"];

export const CONCEPTS: Concept[] = [
  // ---------------------------------------------------------------- basics
  {
    id: "what-is-mixing",
    title: "What DJ mixing is",
    group: "Basics",
    summary: "Playing songs one after another without gaps, so the music never stops.",
    body: [
      "A DJ plays a track on one deck and prepares the next one on another. Before the first ends, the second starts in time with it, and for a while both play together. Then the first one fades away.",
      "Done well, listeners hardly notice the change: the beat keeps going, and the new song simply takes over. Everything else in MixIt is there to make that moment sound smooth.",
    ],
    controls: ["deck.A.play", "deck.B.play", "mixer.crossfader"],
    lab: "phrase-drop",
  },
  {
    id: "decks",
    title: "Decks",
    group: "Basics",
    summary: "A deck is a player for one track. You need at least two to mix.",
    body: [
      "Each deck has its own play button, tempo, cues and loops, and shows its track as a waveform. Decks A and B sit left and right of the mixer; in Pro you can turn on C and D for more layers.",
      "Load a track by double-clicking it in the library (it goes to the highlighted deck) or by dragging it onto a deck.",
    ],
    controls: ["deck.A.play", "deck.A.cue", "deck.A.eject"],
    glossary: ["play"],
  },
  {
    id: "cue",
    title: "Cue and headphones",
    group: "Basics",
    summary: "Listen to the next track in your headphones before the audience hears it.",
    body: [
      "The Cue button on a deck is a starting point: press it while paused to set where the track starts, hold it to listen from there, let go to jump back.",
      "The headphone button on a mixer channel sends that deck to your headphones only. That is how you check the next track is in time before you bring it into the mix. Pick a separate headphone output in Settings.",
    ],
    controls: ["deck.A.cue", "mixer.A.cue", "mixer.cue_mix", "mixer.headphones"],
  },
  {
    id: "hot-cues",
    title: "Hot cues",
    group: "Basics",
    summary: "Bookmarks in a track that you can jump to instantly.",
    body: [
      "Click an empty hot cue pad to save the current spot. Press it later and the track jumps straight there, even while playing. Good places are the first kick, the start of the drop, or the breakdown.",
      "With quantise on, hot cues snap to the nearest beat, so jumping never throws you out of time. Right-click or Shift-click a pad to delete it.",
    ],
    controls: ["deck.A.hotcue.1", "deck.A.hotcue.2"],
    tab: "cues",
    lab: "phrase-drop",
  },
  {
    id: "phrase",
    title: "Bars and phrases",
    group: "Basics",
    summary: "Music is built in blocks of 4 beats, 4 bars and 16 bars. Mix on those boundaries.",
    body: [
      "Count along with the kick: 1, 2, 3, 4. That is one bar. Dance music changes something every 8 or 16 bars, a phrase: a new drum part, a breakdown, the drop.",
      "The red lines in the waveform mark phrases. Starting the next track exactly on one makes the change sound intentional. Starting it mid-phrase is the most common reason a mix feels 'off' even when the beats are in time.",
    ],
    controls: ["deck.A.play"],
    lab: "phrase-drop",
  },
  // ---------------------------------------------------------------- beat and tempo
  {
    id: "bpm",
    title: "Tempo (BPM)",
    group: "Beat and tempo",
    summary: "Beats per minute: how fast a track goes. Two tracks must match to mix.",
    body: [
      "House is usually around 120 to 128 BPM, techno 125 to 140, drum and bass about 170. Two tracks at different tempos drift apart within seconds.",
      "The tempo slider speeds a deck up or slows it down. A few percent either way is normal and unnoticeable; double-click it to go back to the original speed.",
    ],
    controls: ["deck.A.tempo", "deck.A.tempo_reset"],
    glossary: ["tempo"],
    lab: "key-lock",
  },
  {
    id: "sync",
    title: "Sync",
    group: "Beat and tempo",
    summary: "Matches a deck's tempo and beat to the master deck automatically.",
    body: [
      "With Sync on, a deck follows the master deck: same tempo, and its beats line up with the master's beats. You can concentrate on when to start a track and how to blend it.",
      "The master deck is the one others follow. MixIt picks it for you (usually the one that has been playing longest); in Pro you can choose it.",
    ],
    controls: ["deck.A.sync", "deck.B.sync", "deck.A.master"],
    glossary: ["sync", "master"],
    lab: "phrase-drop",
  },
  {
    id: "beatmatch",
    title: "Beatmatching by ear",
    group: "Beat and tempo",
    summary: "Lining up the beats yourself, with the tempo slider and nudges.",
    body: [
      "Without Sync, listen to both kicks in your headphones. If they 'gallop' (two kicks close together), the new track is ahead or behind. Nudge it to fix the moment, and move the tempo slider to stop it drifting again.",
      "It takes practice, and it is how you handle tracks with drifting tempo or a wrong grid. Sync is not cheating, but knowing how to do it by ear means you are never stuck.",
    ],
    controls: ["deck.A.tempo", "deck.A.nudge_down", "deck.A.nudge_up"],
    glossary: ["nudge"],
  },
  {
    id: "beatgrid",
    title: "Beatgrid and downbeat",
    group: "Beat and tempo",
    summary: "The beat lines MixIt draws on a track. Sync, loops and quantise all rely on them.",
    body: [
      "When MixIt analyses a track it finds every beat and the first beat of each bar (the downbeat). Those lines are the beatgrid. If they sit on the kicks, sync and loops are tight.",
      "If the lines fall between the kicks, the tempo was read as double or half: use Double or Half tempo. If they are a little early or late, move the grid. If bar 1 starts on the wrong beat, set the downbeat. MixIt follows tempo drift on live recordings by itself.",
    ],
    controls: ["deck.A.grid.set_downbeat", "deck.A.grid.double", "deck.A.grid.halve", "deck.A.grid.nudge_back", "deck.A.grid.nudge_fwd"],
    tab: "grid",
    glossary: ["beatgrid", "downbeat"],
    lab: "beatgrid",
  },
  {
    id: "quantise",
    title: "Quantise",
    group: "Beat and tempo",
    summary: "Snaps cues, loops and jumps to the nearest beat so they stay in time.",
    body: [
      "With quantise on, pressing play, a hot cue or a loop button waits for or rounds to the nearest beat. Your timing does not have to be perfect, and tricks never knock a track out of time.",
      "Turn it off only when you want a cue somewhere between beats, such as on a vocal that starts early.",
    ],
    glossary: ["quantise"],
  },
  // ---------------------------------------------------------------- mixer
  {
    id: "fader",
    title: "Volume faders and the crossfader",
    group: "Mixer",
    summary: "Channel faders set each deck's volume; the crossfader blends left and right.",
    body: [
      "Each deck has a channel fader in the mixer. The crossfader at the bottom blends between the decks on its left and right sides: all the way left you hear only deck A, in the middle both.",
      "Many DJs leave the crossfader in the middle and blend with the channel faders, which gives more control. Either works.",
    ],
    controls: ["mixer.A.fader", "mixer.B.fader", "mixer.crossfader"],
    glossary: ["crossfader"],
    lab: "phrase-drop",
  },
  {
    id: "gain",
    title: "Gain and the level meter",
    group: "Mixer",
    summary: "Gain makes quiet and loud tracks equally loud before the fader.",
    body: [
      "Tracks are mastered at different loudness. Gain (trim) evens them out, so the fader position means the same thing on every deck. MixIt sets it automatically from the analysed loudness when Auto gain is on.",
      "Watch the channel meters: they should bounce around the same height on both decks. If a meter reaches the red, turn its gain down.",
    ],
    controls: ["mixer.A.trim", "mixer.B.trim"],
    glossary: ["gain"],
  },
  {
    id: "eq",
    title: "EQ: low, mid and high",
    group: "Mixer",
    summary: "Turn parts of the sound up or down: bass, the middle (vocals, synths) and the top (hi-hats).",
    body: [
      "Low is the kick and bassline, mid is vocals, chords and most instruments, high is hi-hats, cymbals and air. Turning a knob left takes that part away; all the way left (or the kill button) removes it completely.",
      "EQ is your main blending tool. Bring a new track in with its bass cut, so its hi-hats and melody appear first, then swap the bass over.",
    ],
    controls: ["mixer.A.eq.high", "mixer.A.eq.mid", "mixer.A.eq.low", "mixer.A.eq.kill.low"],
    glossary: ["eq", "isolator"],
    lab: "bass-swap",
  },
  {
    id: "bass-swap",
    title: "The bass swap",
    group: "Mixer",
    summary: "Only one track should carry the bass at a time.",
    body: [
      "Two basslines and two kicks playing together sound boomy and muddy, even when they are perfectly in time. So while two tracks overlap, keep one track's low EQ down.",
      "On a phrase line, turn the old track's low down and the new track's low up, either at once or over a few bars. The coach warns you when both basses are up.",
    ],
    controls: ["mixer.A.eq.low", "mixer.B.eq.low"],
    lab: "bass-swap",
  },
  {
    id: "filter",
    title: "Filter",
    group: "Mixer",
    summary: "One knob that makes a track muffled (left) or thin (right).",
    body: [
      "Left of centre is a low-pass filter: it removes the highs, as if the music were behind a wall. Right of centre is a high-pass filter: it removes the bass first, then the mids, until only a thin hiss is left.",
      "Sweeping the high-pass slowly over a few bars is a classic way to make a track exit. In Pro, the Resonance setting adds a sharper, whistling edge to the sweep.",
    ],
    controls: ["mixer.A.filter"],
    glossary: ["filter", "resonance"],
    lab: "filter-echo",
  },
  {
    id: "master",
    title: "Master output and the limiter",
    group: "Mixer",
    summary: "The final level of the whole mix, with a safety limiter at the end.",
    body: [
      "Master volume sets what reaches the speakers and recordings. MixIt's limiter catches peaks above 0 dB so nothing distorts, but if it works constantly it squashes the music and makes it sound flat.",
      "Aim for the master meter peaking just below the top. If the coach says the limiter is squashing, turn a channel's gain or the master down a little.",
    ],
    controls: ["mixer.master"],
    glossary: ["limiter"],
  },
  // ---------------------------------------------------------------- keys
  {
    id: "key",
    title: "Musical key and Camelot",
    group: "Keys",
    summary: "Which notes a track uses. Some keys sound good together, others clash.",
    body: [
      "Every melodic track is in a key. MixIt shows it as a Camelot code like 8A: a number from 1 to 12 and a letter (A for minor, darker; B for major, brighter).",
      "Keys that are the same, one number apart (7A, 9A), or the same number with the other letter (8B) mix smoothly. Others can sound sour while both play. The suggestions list ranks tracks that fit.",
    ],
    controls: ["deck.A.key_sync"],
    glossary: ["key"],
    lab: "key-lock",
  },
  {
    id: "keylock",
    title: "Key lock",
    group: "Keys",
    summary: "Keeps the pitch the same when you change the tempo.",
    body: [
      "Without key lock, speeding a track up also raises its pitch, like a record spun faster. With key lock on, MixIt time-stretches the audio: faster or slower, but the notes stay where they were.",
      "Keep it on for most mixing. Very large tempo changes with key lock can sound slightly smeared; that is the trade-off.",
    ],
    controls: ["deck.A.keylock", "deck.A.tempo"],
    lab: "key-lock",
  },
  {
    id: "key-shift",
    title: "Key shift and Match key",
    group: "Keys",
    summary: "Change a track's key without changing its speed.",
    body: [
      "Key shift moves a track up or down in semitones while the tempo stays the same. Match key does it for you: it shifts the deck to the nearest key that fits the master deck.",
      "One or two semitones sounds natural. Further than that, voices start to sound odd.",
    ],
    controls: ["deck.A.key_shift", "deck.A.key_sync"],
    lab: "key-lock",
  },
  // ---------------------------------------------------------------- effects and tricks
  {
    id: "loops",
    title: "Loops",
    group: "Effects and tricks",
    summary: "Repeat a few beats of a track for as long as you like.",
    body: [
      "Auto loop repeats the last few beats in time with the music: useful to stretch an intro that is too short for your blend, or to keep a track going while you find the next one.",
      "Halve and double change the length. In Pro you can set loop in and out by hand, move a loop and use loop roll.",
    ],
    controls: ["deck.A.loop.auto", "deck.A.loop.halve", "deck.A.loop.double"],
    tab: "loop",
    glossary: ["loop"],
    lab: "slip-roll",
  },
  {
    id: "slip",
    title: "Slip mode and loop roll",
    group: "Effects and tricks",
    summary: "Play tricks without losing your place in the track.",
    body: [
      "With Slip on, a hidden play head keeps running while you loop, jump or scratch. When you let go, the track continues where it would have been, so you stay on the phrase.",
      "Loop roll is a loop that lasts only while you hold it: hold it on ¼ or ½ beat for a stutter, and let go to drop back in.",
    ],
    controls: ["deck.A.slip", "deck.A.loop.roll"],
    tab: "loop",
    lab: "slip-roll",
  },
  {
    id: "beat-jump",
    title: "Beat jump",
    group: "Effects and tricks",
    summary: "Skip forward or back by an exact number of beats.",
    body: [
      "Beat jump moves the play head by 1 to 64 beats while staying perfectly in time. Jump 32 beats back to repeat a phrase you liked, or forward to skip a long breakdown.",
    ],
    controls: ["deck.A.beatjump.back", "deck.A.beatjump.fwd"],
    tab: "jump",
  },
  {
    id: "fx",
    title: "Effects",
    group: "Effects and tricks",
    summary: "Echo, reverb, flanger and more, on one deck or on the whole mix.",
    body: [
      "Each deck has effect slots. Pick an effect, switch it on, and set its amount. Effects that repeat (echo, delay) follow the beat, so the repeats land in time.",
      "Echo while fading a track out leaves a trail instead of a sudden stop. The master FX (in the sampler panel) affect the whole mix. Remember to switch effects off when you are done.",
    ],
    controls: ["fx.A.1.type", "fx.A.1.on", "fx.A.1.mix", "fx.A.1.beats"],
    tab: "fx",
    glossary: ["fx"],
    lab: "filter-echo",
  },
  {
    id: "sampler",
    title: "Sampler pads",
    group: "Effects and tricks",
    summary: "Air horns, risers, drum hits and loops on top of your mix.",
    body: [
      "The sampler has eight pads, loaded with a built-in kit to start. Press a pad to play it. Loop pads keep going in time with the mix until you press them again.",
      "You can load your own sounds or capture a few bars from a deck. Use them sparingly: a riser before a drop is great; an air horn every 16 bars is not.",
    ],
    controls: ["app.sampler", "sampler.volume", "sampler.stop_all"],
    glossary: ["sampler"],
  },
  // ---------------------------------------------------------------- library
  {
    id: "analysis",
    title: "Track analysis",
    group: "Your library",
    summary: "MixIt listens to every track to find its tempo, key, beats and sections.",
    body: [
      "When you add music, MixIt analyses it once: tempo (including drift), beatgrid, key, loudness, energy and where the intro, drops and outro are. That is what makes sync, suggestions and the coach work.",
      "If something looks wrong for a track, you can fix the grid on the deck or edit tempo and key in the track's details.",
    ],
  },
  {
    id: "suggestions",
    title: "Suggestions and energy",
    group: "Your library",
    summary: "Tracks that fit the one playing, by tempo, key and energy.",
    body: [
      "The suggestions list ranks your library against the track that is playing: close tempo, compatible key and similar sound score highest. Choose 'up' or 'down' energy to steer where the set goes.",
      "A set usually builds: start calm, rise to the peak, and give the room a breather now and then.",
    ],
  },
  {
    id: "recording",
    title: "Recording and rendering",
    group: "Your library",
    summary: "Save your live mix, or render a mix you built on the timeline.",
    body: [
      "Rec saves everything on the master output to a WAV file, exactly as you heard it. In Arrange, Render mix writes a timeline mix to a file, with every curve and effect, the same way every time.",
    ],
    controls: ["global.record"],
    glossary: ["recording"],
    lab: "automation",
  },
  {
    id: "automation",
    title: "Timeline and automation",
    group: "Your library",
    summary: "Build a mix on a timeline and draw how volume, EQ and filters change.",
    body: [
      "In Arrange, each track is a clip on a lane. Overlap two clips to make a transition, then draw automation curves: points that say 'volume here, low EQ there'. MixIt plays them back exactly.",
      "It is a calm way to design a transition, listen, adjust and render, instead of doing it live.",
    ],
    lab: "automation",
  },
  // ---------------------------------------------------------------- sound quality
  {
    id: "mud",
    title: "Muddy or boomy sound",
    group: "Sound quality",
    summary: "Too much bass at once. Almost always two basslines overlapping.",
    body: ["Cut the low EQ on one of the tracks. If it is a single track that sounds boomy, its gain is too high or your speakers are in a corner. The Troubleshoot tab spots this while you mix."],
    controls: ["mixer.A.eq.low", "mixer.B.eq.low"],
    lab: "bass-swap",
  },
  {
    id: "clipping",
    title: "Distortion and clipping",
    group: "Sound quality",
    summary: "The signal is too loud and gets flattened.",
    body: [
      "If a channel meter reaches the red, that track is too loud going in: lower its gain. If the master is in the red, lower the master. Turning everything up is never the fix; turn the speakers up instead.",
    ],
    controls: ["mixer.A.trim", "mixer.master"],
  },
];

export function conceptById(id: string | null): Concept | undefined {
  return CONCEPTS.find((c) => c.id === id);
}

/** The concept a registry glossary key points to. */
export function conceptForGlossary(key: string | null | undefined): Concept | undefined {
  if (!key) return undefined;
  return CONCEPTS.find((c) => c.glossary?.includes(key));
}
