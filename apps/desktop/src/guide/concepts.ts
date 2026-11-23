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

export type ConceptGroup = "Basics" | "Beat and tempo" | "Mixer" | "Keys" | "Effects and tricks" | "Studio" | "Your library" | "Sound quality";

export const CONCEPT_GROUPS: ConceptGroup[] = ["Basics", "Beat and tempo", "Mixer", "Keys", "Effects and tricks", "Studio", "Your library", "Sound quality"];

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
      "Each deck counts for you: the lights next to the tempo show the beat of the bar (red on beat 1), the number shows the bar of the 8-bar phrase, and underneath it says how many bars until the next part, such as 'Drop in 6 bars'.",
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
    title: "Snap to beat (quantise)",
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
  {
    id: "slicer",
    title: "Slicer and roll pads",
    group: "Effects and tricks",
    summary: "Pads on each deck that chop the music into pieces you can replay, or stutter it in time.",
    body: [
      "The slicer cuts the bar (or 2 or 4 bars) that is playing into eight slices, one per pad. Hold a pad and that slice repeats in time with the beat; let go and the track carries on from where it would have been, so you never lose your place.",
      "Roll pads repeat a tiny piece of the music, from a 32nd of a beat to 4 beats. Hold one for a drum roll, move from a long roll to short ones for a build-up, and let go on the drop.",
    ],
    controls: ["deck.A.slice.1", "deck.A.slice.size", "deck.A.roll.4"],
    glossary: ["slicer", "loop-roll"],
  },
  {
    id: "key-pads",
    title: "Key pads",
    group: "Effects and tricks",
    summary: "Play a hot cue in eight different keys, like notes on a keyboard.",
    body: [
      "Pick a hot cue (a vocal shout or a synth stab works best), open the Keys tab and press the pads: each one plays the cue a semitone higher than the last, with key lock on so the tempo stays put. Tap them in a rhythm to play a melody.",
      "Middle covers three semitones below the track's key to four above; Low and High move the pads down or up. Under each pad is the key it plays, so you can stay on keys that fit the other track. Reset key brings the track back to its own key.",
    ],
    controls: ["deck.A.keypad.1", "deck.A.keypad.cue", "deck.A.keypad.range"],
    glossary: ["key-pads"],
  },
  {
    id: "sequencer",
    title: "Step sequencer",
    group: "Effects and tricks",
    summary: "Program the sampler pads into a beat that plays in time with the music.",
    body: [
      "The Steps tab shows a row of squares for each pad. Each square is a step, usually a sixteenth of a beat's length so four squares make one beat. Light a square and that pad plays on that step every time the pattern comes round.",
      "The pattern follows the playing track, so it always lands on the beat, even when you change the tempo. Swing pushes every second step a little later for a looser groove. Start from a pattern such as Four on the floor, then change it to make it yours.",
      "Use it to add claps or hats over a track that needs more drive, or to keep a beat going while you change records.",
    ],
    controls: ["app.sequencer"],
    glossary: ["sequencer"],
  },
  {
    id: "mic",
    title: "Using a mic",
    group: "Effects and tricks",
    summary: "Talk to the crowd, record your own sounds, or bring in a turntable or phone.",
    body: [
      "Turn the mic on from the mic button at the top. It gets its own channel on the left of the mixer. Speak and watch the level bar: turn the gain up until your voice reaches about two thirds of the bar, and never into the red.",
      "Press Go on air when you want the audience to hear you. Wear headphones, or keep the mic away from the speakers: a mic that hears the speakers feeds back into itself and howls.",
      "You can also record from the mic: a short shout or tag goes onto a sampler pad with the silence cut off, and a longer take (a turntable, a phone, a jam) goes into your library as a track you can mix like any other.",
    ],
    controls: ["mic.on_air", "mic.level", "mic.talkover", "mic.record"],
    glossary: ["mic"],
  },
  {
    id: "talk-over",
    title: "Talk-over",
    group: "Effects and tricks",
    summary: "The music dips by itself while you speak, so the crowd hears every word.",
    body: [
      "With talk-over on, MixIt listens to the mic. When you start speaking it turns the music down (12 dB at first, about a quarter as loud), and a moment after you stop it brings the music back up smoothly.",
      "Keep announcements short and on the phrase: say it in the last bars before a drop, and let the drop answer you.",
    ],
    controls: ["mic.talkover", "mic.talkover_depth"],
    glossary: ["talk-over"],
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
      "MixIt also remembers your past sets: a track you have played right after this one before gets a lift and says so, because you already know that change works. Tracks that sound alike get a small lift too.",
      "Not sure which one to pick? Press Hear the mix on a suggestion: MixIt plays the change from the current track into it in your headphones, the way Auto DJ would mix it (transition, length, key shift and tempo), so you can compare a few before choosing.",
      "A set usually builds: start calm, rise to the peak, and give the room a breather now and then.",
    ],
  },
  {
    id: "set-flow",
    title: "How a set flows",
    group: "Your library",
    summary: "See a playlist as a set: energy, tempo, and which changes of track will be hard to mix.",
    body: [
      "Open a playlist and press Flow. Each bar is a track: its height is the energy and its colour the key, so neighbours with similar colours mix in key. The line is the tempo. The dot between two tracks says how easy that change is: green mixes smoothly, amber needs a little care (a key shift, a bigger tempo change, an energy jump) and red is hard.",
      "Click a red or amber dot to see why, and MixIt finds tracks in your library that mix well with both sides, so you can insert one as a bridge. Smooth the order rearranges the whole playlist so each track flows into the next; Build up does the same while starting calm and rising to a peak.",
    ],
  },
  {
    id: "preview",
    title: "Previewing tracks",
    group: "Your library",
    summary: "Hear any track in your headphones before you load it, while the music keeps playing.",
    body: [
      "Hover a track and press its play button, or select it and press P. It plays in your headphones only, so the crowd never hears it, and it starts where the music starts rather than on silence. Click the waveform to jump around, or use the section buttons to hear the drop.",
      "Found the part you want? Press A or B in the preview bar and the track loads on that deck at the point you were listening to. Without a separate headphone output (a laptop on its own), the preview plays on the speakers instead; the headphone button switches between the two.",
      "Turn on In time to hear the track the way it would sound mixed in: it plays at the tempo of the music that is on, with its bars lined up, so the two fit together in your ears. Like a record sped up on a turntable, its pitch moves a little with the tempo.",
    ],
    controls: ["app.preview"],
    glossary: ["preview"],
  },
  {
    id: "smart-playlists",
    title: "Smart playlists",
    group: "Your library",
    summary: "Playlists that fill themselves with every track that fits your rules, including ones you add later.",
    body: [
      "Press the wand beside Playlists and say what you want in plain rules: tempo between 120 and 126, genre contains house, energy at least 6, tag is vocal, never played. The count shows how many tracks match as you go, and you can choose the order (slow to fast, calm first, newest first, shuffled).",
      "A smart playlist is a saved search, so it stays up to date by itself. Already typed a search you like? Press the wand next to the search box to keep it. Right-click a smart playlist and choose Edit rules to change it; Edit as search text shows the same rules in the search language.",
    ],
  },
  {
    id: "past-sets",
    title: "Your past sets",
    group: "Your library",
    summary: "Every time you play, MixIt keeps the list of tracks, so you can play a good night again or share what you played.",
    body: [
      "History shows what you played this session, newest first. Under it are your last few sets, named by the night (Last night, Thu 19 Nov); click one to see its tracks in the order you played them, how long it ran and when it started.",
      "Save as playlist turns a set into a playlist in the same order, to play it again or build on it. Copy tracklist puts the list with the time each track started on the clipboard, ready to paste under a recording. Right-click a set to rename it (Rooftop, Sarah's birthday) or forget it; forgetting keeps the tracks and their play counts.",
    ],
  },
  {
    id: "tags",
    title: "Your own tags",
    group: "Your library",
    summary: "Label tracks with your own words, like vocal, peak time or dark, and find them again by feel.",
    body: [
      "Genre and tempo say what a track is; your tags say how you use it. Add them in a track's details (type a word and press Enter), right-click tracks and choose Tag, or drag tracks onto a tag in the sidebar. Select several tracks to tag them all at once.",
      "Click a tag in the sidebar to see its tracks, or search with tag:vocal (put tags with spaces in quotes: tag:\"peak time\"). Mix them with other searches, like tag:dark bpm:~124, or make a smart playlist from one. Right-click a tag to rename it (renaming it to another tag's name merges the two), give it a group or a colour, or delete it.",
    ],
  },
  {
    id: "backups",
    title: "Backing up your library",
    group: "Your library",
    summary: "MixIt copies your library every day, so a mistake or a broken drive never costs you your cues and playlists.",
    body: [
      "Your library is everything MixIt knows about your music: the analysis, beat grids you fixed, cues, playlists, tags and what you played. Once a day MixIt saves a copy of it and keeps the last 10. Find them in Settings, Library, Backups, where you can also back up now or save a copy to a USB stick or another drive.",
      "Restore puts a backup back as your library. MixIt first saves the library as it is, marked Before a restore, so you can always go back. Backups hold the library, not the music files themselves: keep a copy of your music folders too.",
    ],
  },
  {
    id: "fix-library",
    title: "Moved files and duplicates",
    group: "Your library",
    summary: "Find music that moved to another folder or drive, and fold copies of the same track into one.",
    body: [
      "If you move or rename your music, MixIt marks those tracks as missing. Fix library (in the sidebar, when there is something to fix) lists them. Search a folder and MixIt finds each file by its name, or by its sound when the name changed, and keeps its cues, beat grid and history.",
      "The same song often ends up in a collection twice. Fix library groups copies with the same audio; keep one and the rest are folded into it, so its playlists, tags, cues and play count all end up on the copy you kept.",
    ],
  },
  {
    id: "other-apps",
    title: "Bringing your music from other DJ apps",
    group: "Your library",
    summary: "Move your collection over from rekordbox, Traktor, Serato or VirtualDJ without redoing your cues, grids and playlists.",
    body: [
      "Open the import menu beside Add music (or drop the file onto MixIt). From rekordbox, export your collection as XML (File, Export Collection in xml format). From Traktor, pick its collection.nml, which lives in your Documents folder under Native Instruments, Traktor.",
      "From Serato, pick the _Serato_ folder (in your Music folder, or at the top of a USB drive). Crates come in as playlists, crates inside crates as folders, and the cues, loops and grids Serato saved inside your music files come along.",
      "From VirtualDJ, pick the VirtualDJ folder (in Documents on Windows) that holds database.xml. Your playlists and lists come in with their folders; filter folders are skipped, because their rules work differently here.",
      "MixIt brings in each track with its tempo, beat grid, key, rating, comment, hot cues, loops and playlists in their folders. Tracks MixIt already knows keep what you set up here, so importing twice is safe. Files that are not on this computer are added as missing, so playlists stay whole: Fix library finds them once you point it at the right drive.",
      "Going the other way, the same menu exports your collection for rekordbox (XML) or Traktor (.nml), with cues, loops, grids and playlists. Right-click a playlist to export just that one, or save it as M3U for other apps and DJ gear. In Traktor, open the exported file with Import Collection. For Serato, right-click tracks and choose Write cues for Serato: the cues go into the music files, where Serato reads them.",
    ],
  },
  {
    id: "build-a-set",
    title: "Building a set for a night",
    group: "Your library",
    summary: "Tell MixIt how long you play and how the energy should move: it picks the tracks, every change easy to mix.",
    body: [
      "Press the rising-line button beside Playlists (or right-click a playlist or a track) and choose Build a set. Pick how long you play, where the tracks come from (your whole collection, one playlist, or a search like genre:house) and the shape of the night.",
      "Warm-up starts calm and rises gently, for opening a night. Build to the peak goes from easy to full power. Peak time stays high with a short breather. Journey rises to a peak two-thirds in and comes back down. Cool-down closes a night. Steady keeps the level.",
      "MixIt chooses each next track so the tempo is close, the keys fit and the sound flows, while the energy follows your shape. It counts each track as about four-fifths of its length, because the ends overlap when you mix.",
      "The chart shows each track's energy against the shape. Try another gives a different set from the same choices; Save as playlist keeps it, ready for Automix, Auto DJ or the USB stick.",
    ],
  },
  {
    id: "sounds-like",
    title: "Finding tracks that sound alike",
    group: "Your library",
    summary: "Right-click a track and choose Find tracks that sound like this: MixIt lists the tracks with the most similar sound, whatever their tempo or key.",
    body: [
      "When MixIt analyses a track it also notes how it sounds: how bright or dark it is, how much bass, mids and highs it has, how noisy or clean the sounds are, how hard the drums hit and how many kicks, snares and hats land each second.",
      "Find tracks that sound like this (in a track's right-click menu, or Sounds like in the panel on the right) compares that with every other analysed track and lists the closest first. The Match column says how alike they are: 80 or more is very close.",
      "Keep as smart playlist (at the top of the list) saves it as a playlist that fills itself, with the search like:42 (42 being the track's number); you can type like: into any search too. It is a good way to dig up tracks you forgot you had, or to keep a set's character while you change tempo or key. Suggestions use it too: a next track that sounds alike gets a small lift and says so.",
      "Tracks analysed before this feature are analysed again in the background, so give a large library a little while.",
    ],
  },
  {
    id: "club-habits",
    title: "Fader start and instant doubles",
    group: "Effects and tricks",
    summary: "Two habits from club gear: start a deck by raising its fader, and copy a playing track to another deck in time.",
    body: [
      "Fader start (turn it on in Settings, Mixing): raise a channel's volume fader from the bottom and its deck starts; pull it all the way down and the deck stops and goes back to its cue point. It saves a hand when you drop a track in on the beat.",
      "Instant double: click a deck's letter and choose Copy deck A here. The same track loads at the same spot, synced and playing in time, with its fader where you left it. Loop, echo or scratch one copy while the other keeps the groove, then fade back.",
    ],
  },
  {
    id: "vocals",
    title: "Vocals and instrumentals",
    group: "Your library",
    summary: "MixIt hears where a track has singing or rapping, so two voices do not clash.",
    body: [
      "When MixIt analyses a track it listens for voices: a voice never holds a note quite still, and all of its overtones wobble together. The pink line along the top of a deck's overview shows where the singing is, and the panel on the right says how much of the track has it.",
      "Two voices at once are hard to follow even when the keys fit, so the coach warns you when both decks are singing and offers to lower the mids on one. Bring the next track in during an instrumental part instead, or let its vocal start after the other ends.",
      "Mix it does this for you: during a blend, while both tracks sing, the outgoing track's mids step back and come up again when one voice stops. Automix plans around it too: when two vocals would meet in a transition it shortens the blend, two bars at a time, until they do not, and dips the mids where they cannot be kept apart.",
      "Starting a mix halfway through a sung line cuts it off, so Mix it and Auto DJ look at where the playing track sings. When the next phrase lands in the middle of a line, Mix it waits up to one more phrase for the line to end (a message tells you how long), and Auto DJ moves its planned start to the nearest point that is clear of singing, earlier or later, and says why in its plan.",
      "Search with vocals:no for instrumentals (great for long blends and for talking over), vocals:yes for tracks with singing, or vocals:30+ for tracks that sing in at least 30%. Turn on the Vocals column in the track list to see the share for every track.",
      "It is worked out from the sound alone, without an online service, so a heavily processed voice can be missed and a wobbly lead synth can now and then count as singing.",
    ],
    lab: "vocals",
  },
  {
    id: "set-clock",
    title: "Keeping to your set time",
    group: "Effects and tricks",
    summary: "Tell MixIt when your set ends and it counts down and warns you before a track runs over.",
    body: [
      "Click Set length in the bar at the top and choose how long you play, or type the time you finish, such as 02:00. The bar then shows the time left, turning amber in the last ten minutes and red in the last three.",
      "The coach keeps an eye on it: it tells you when the track playing would run past the end of your set, or when the next track is longer than the time that will be left, so you can mix out early or pick a shorter one. Build a set starts with the time you have left as its length.",
    ],
  },
  {
    id: "safety-loop",
    title: "The safety loop",
    group: "Effects and tricks",
    summary: "If a track is about to end with nothing mixed in, its last bars loop so the music never stops.",
    body: [
      "When the only track playing reaches its last bars and no other deck is being heard, MixIt loops the four bars just before the track fades out, on the beat, so the dance floor never hears silence. The deck shows an amber note while it holds.",
      "Mix in the next track as usual and bring the loop's deck down, or press Let it end to leave the loop and let the track play out. Going back earlier in the track arms it again. You can turn it off in Settings, Mixing.",
    ],
    controls: ["global.safety_loop"],
  },
  {
    id: "now-playing",
    title: "Showing the track on a stream",
    group: "Your library",
    summary: "Keep a text file with the track playing now, for OBS or other streaming software.",
    body: [
      "In Settings, Mixing, choose a file under Now playing for streams. Whenever a new track becomes the one your audience hears, MixIt writes its artist and title there. In OBS add a Text source, tick Read from file and pick the same file, and the track shows on your stream by itself.",
      "What to write sets the line: {artist} - {title} by default, and you can add {album}, {genre}, {label}, {bpm} or {key}, for example Now playing: {title} by {artist}.",
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
    id: "arrange-editing",
    title: "Editing the timeline",
    group: "Your library",
    summary: "Select, copy, repeat, cut and fade clips, label the mix with markers, and loop a passage while you work on it.",
    body: [
      "Click a clip to select it, Ctrl/⌘-click to add more, or drag a box over an empty part of the lanes. Drag any selected clip and the whole group moves together, so a transition you have built keeps its shape.",
      "Copy and paste (Ctrl/⌘+C and V) put clips at the play marker, the green line you set by clicking the ruler. Duplicate (Ctrl/⌘+D) repeats them right after themselves. Ctrl/⌘+B cuts clips in two at the marker, and Alt-click cuts a clip where you click, so you can drop a verse or move a breakdown.",
      "Drag the small squares at a clip's top corners to fade it in or out. Markers label parts of the mix such as Intro or Drop: drag them to move, double-click to rename. Press L to loop: Play then repeats the selected clips (or a stretch you Shift-drag on the ruler) until you stop it.",
    ],
    controls: ["app.clip_split", "app.clip_duplicate", "app.arrange_loop", "app.marker_add"],
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
  {
    id: "auto-dj",
    title: "Auto DJ",
    group: "Basics",
    summary: "MixIt mixes a queue of tracks for you and says why it mixes each one the way it does.",
    body: [
      "Add tracks to the Auto DJ queue (right-click a track, drag tracks onto Auto DJ in the sidebar, or choose Play with Auto DJ on a playlist) and press Start. MixIt loads each next track on the free deck, cues it at its mix-in point and mixes it in at the top of a phrase near the end of the current track.",
      "It picks the transition from the music: a bass swap when both tracks have heavy bass, a filter fade when the keys clash or the energy drops, an echo out when the tempos are far apart or a track ends abruptly, and a long blend when everything fits. With Fix clashing keys on, it shifts the next track a semitone or two so the melodies agree.",
      "Some tracks end soon after their mix-out point, with no long outro to mix over. With Loop a short ending on, Auto DJ loops the last 8 or 16 beats of the old track on the beat while the new one comes in, so the mix still gets its full 32 beats; the loop is let go when the mix is over. Turn it off to have it make a shorter mix instead.",
      "Each new track is synced to the one before, so it starts at that track's tempo. With Ease the tempo back on, Auto DJ then lets the tempo drift back to the new track's own speed, half a percent every 8 bars, too slowly for anyone to notice. A set then doesn't stay stretched to its first track's tempo, and every track ends up sounding as it should. Touch the tempo yourself and it stops.",
      "Watch the Next card and the log to learn why each choice was made. Touch any control to take over, press Mix now to mix early, or Stop to carry on by hand.",
      "To hear a mix before it happens, point at a track in the queue and press Hear this mix under it: MixIt plays the change from that track into the next one in the preview player, exactly as Auto DJ plans it (the same transition, length, key shift and tempo), from a few bars before to a few bars after. While Auto DJ plays, Hear it first on the Next card does the same for the coming mix. The blue part of the strip is the transition; Jump to the mix goes to just before it.",
      "Rehearse the set above the queue does it for the whole queue: every change one after another, a few bars either side of each, so you can hear a whole set's mixes in a few minutes. The bar says which change you are hearing, and Next change skips to the next one.",
      "Between the tracks in the queue, a dot shows how easy each change is to mix: green is smooth, amber needs care (a key shift, a bigger tempo step, an energy jump), red is rough (clashing keys or a tempo jump of more than 8%), with the reason beside it. Best order puts the queue in the order that mixes best, with the energy going the way you chose (Calmer, Steady or Build up), and Undo puts it back. On a rough change, Add ... between puts in a track from your library that goes well with both sides.",
      "The preview plays in your headphones when you have set a headphone output in Settings. Without one it would come out of the speakers, so MixIt only plays it then while no music is on air.",
    ],
    controls: ["app.autodj"],
  },
  // ---------------------------------------------------------------- studio
  {
    id: "studio",
    title: "The studio on every channel",
    group: "Studio",
    summary: "A detailed EQ you can see, plus compression, warmth and effects sends, behind the sliders button on each channel.",
    body: [
      "The three EQ knobs on the mixer are quick and musical. The studio goes further: up to eight EQ bands you drag on a picture of the sound, so you can see where the bass, the voice and the cymbals are and change just that part.",
      "It also holds a compressor (Punch), tape-style warmth, stereo width, a gate for noisy mics, and sends to a shared reverb and echo. Presets like \"Clearer vocals\" or \"Make room for the other deck\" set it up for you.",
      "Each Arrange lane has the same studio, and so does the whole mix (Master), so a mix you plan sounds the way you hear it.",
    ],
    controls: ["mixer.A.punch", "mixer.A.warmth", "mixer.A.space"],
    lab: "studio",
  },
  {
    id: "compressor",
    title: "Compression (Punch and Glue)",
    group: "Studio",
    summary: "Turns loud moments down so the whole sound is more even, punchier and easier to hear.",
    body: [
      "A compressor listens to the level and turns it down whenever it gets louder than a threshold. The quiet parts can then come up, so a track sounds fuller and steadier.",
      "Punch is a one-knob compressor for a channel: it lets the start of each drum hit through, then holds the body up. Glue is a gentle one for the whole mix, so separate tracks sound like one record.",
      "Too much squashes the life out of the music. Watch the Compressing meter: a few dB is plenty.",
    ],
    controls: ["mixer.A.punch", "mixer.glue"],
    glossary: ["compressor"],
    lab: "studio",
  },
  {
    id: "saturation",
    title: "Warmth (saturation)",
    group: "Studio",
    summary: "Adds the gentle harmonics of tape and valves, so a thin track feels fuller.",
    body: [
      "Saturation bends the loudest parts of the wave slightly, adding harmonics the ear hears as warmth and weight. A little makes a clean digital track feel richer and louder without turning it up.",
      "Turned far up it becomes audible distortion: a creative effect, but not what you want on everything.",
    ],
    controls: ["mixer.A.warmth"],
    glossary: ["saturation"],
  },
  {
    id: "stereo",
    title: "Pan and stereo width",
    group: "Studio",
    summary: "Where a sound sits between the speakers, and how wide it spreads.",
    body: [
      "Pan moves a channel towards the left or right speaker. In a DJ mix both tracks usually stay in the middle; pan is useful for a mic or a sampler sound.",
      "Width makes a track narrower (towards mono) or wider. Narrowing one track leaves space at the sides for another. MixIt keeps the bass in the middle either way, because bass in the sides sounds weak on club systems and vanishes on a phone.",
    ],
    controls: ["mixer.A.pan", "mixer.A.width"],
    glossary: ["pan", "stereo-width"],
  },
  {
    id: "sends",
    title: "Reverb and echo sends",
    group: "Studio",
    summary: "Send some of a channel to a shared reverb (Space) or echo, and let it ring on.",
    body: [
      "Space and Echo on each channel send a copy of the sound to one shared reverb and one shared echo. The original carries on untouched; the effect is added on top.",
      "Because the effect is separate, it keeps ringing after you pull the fader down or stop the track: the classic way to end a track on a wash of reverb or a trail of echoes.",
      "The echo follows the tempo. Set its time and repeats, and the reverb's size, in the Master studio.",
    ],
    controls: ["mixer.A.space", "mixer.A.echo", "mixer.space.level", "mixer.echo.level"],
    glossary: ["send", "reverb", "echo"],
    lab: "studio",
  },
  {
    id: "ducking",
    title: "Ducking",
    group: "Studio",
    summary: "One channel turns itself down whenever another is loud.",
    body: [
      "Pick \"Duck under\" on a channel and choose another deck. Whenever that deck plays loud, this one dips automatically, then comes back up.",
      "It is how radio voices sit over music, and it lets a new bassline come through without riding the fader. The Ducked meter shows how far it is down.",
    ],
    controls: ["mixer.A.duck_source", "mixer.A.duck"],
    glossary: ["ducking"],
  },
  {
    id: "gate",
    title: "Noise gate",
    group: "Studio",
    summary: "Silences a channel between sounds, cutting hiss, hum or a noisy room.",
    body: ["A gate stays closed while the sound is quieter than its threshold and opens when something louder comes through. On a mic it removes the room and the hum between your words; on a track it can tighten a loose recording."],
    controls: ["mixer.A.gate"],
    glossary: ["gate"],
  },
  {
    id: "loudness",
    title: "Loudness and LUFS",
    group: "Studio",
    summary: "How loud a mix feels, measured the way streaming services and broadcasters do.",
    body: [
      "LUFS measures loudness the way ears hear it. Streaming services turn every track to about −14 LUFS, so a mix made louder than that is turned down and only loses its punch.",
      "Pick a target in the Master studio and press Match, or pick it when you render. Clubs run louder (around −9), podcasts and Apple Music quieter (−16).",
    ],
    controls: ["mixer.master", "mixer.glue"],
  },
  {
    id: "sound-editor",
    title: "Editing a sound",
    group: "Studio",
    summary: "Trim, cut, fade, normalise and reverse a mic take, a pad or part of a track.",
    body: [
      "Open the sound editor from a pad's menu, the mic's last take or a track's menu in the library. Select with the mouse, then trim, cut, copy and paste, fade, change the volume, normalise or reverse.",
      "Every change is a step in a list over the untouched original, so you can undo, or take out an early step and keep the later ones. Save puts the result on a pad or in your library as a new file.",
    ],
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
