// Ask MixIt's test set: sentences the way people type them, each with what it should do.
// The rules must get at least 95 % right; any smaller trained model we try is checked
// on the same sentences. The registry is the real one (see crates/mixit-core/tests/registry_snapshot.rs).
import { describe, expect, it } from "vitest";
import type { ActionSpec } from "../backend/types";
import { type AskContext, normalise, planRequest, understand, type Understood } from "../lib/ask";
import registryJson from "./fixtures/registry.json";

const registry = registryJson as unknown as ActionSpec[];

const flat = { high: 0, mid: 0, low: 0, fader: 1, filter: 0, trim: 0 };

/** Deck A is playing at 124 BPM, deck B is loaded (126 BPM) and waiting. */
function ctx(over: Partial<AskContext> = {}): AskContext {
  return {
    registry,
    decks: [
      { loaded: true, playing: true, baseBpm: 124, tempo: 0, tempoRange: 0.08, keyShift: 0, track: { id: 7, title: "Playing Song", key: "8A" } },
      { loaded: true, playing: false, baseBpm: 126, tempo: 0, tempoRange: 0.08, keyShift: 0, track: { id: 8, title: "Waiting Song", key: "9A" } },
    ],
    masterDeck: 0,
    mixer: { channels: [flat, flat, flat, flat], master: 0, fx: [0, 1, 2, 3, 4].map(() => [{ type: 1, on: false }, { type: 3, on: false }, { type: 4, on: false }]) },
    playlists: [
      { id: 1, name: "Warm up" },
      { id: 2, name: "House bangers" },
      { id: 3, name: "Sunday chill" },
      { id: 4, name: "Peak time" },
    ],
    genres: ["Deep House", "Techno", "Drum and Bass", "Hip Hop", "Disco"],
    selected: { id: 42, title: "Selected Song" },
    soundSearch: true,
    ...over,
  };
}

/** One line for what was understood, to compare with the expected one. */
function brief(u: Understood | null): string {
  if (!u) return "nothing";
  const a = u.ask;
  switch (a.kind) {
    case "control":
      return a.steps
        .map((s) => {
          switch (s.do) {
            case "set":
              return `set ${s.id} ${s.on ? "on" : "off"}`;
            case "value":
              return `value ${s.id} ${Math.round(s.value * 1000) / 1000}`;
            case "choose":
              return `choose ${s.id} ${s.index}`;
            default:
              return `${s.do} ${s.id}`;
          }
        })
        .join("; ") || "nothing to do";
    case "find":
      return `find ${a.query}${a.playlist != null ? ` @${a.playlist}` : ""}`;
    case "describe":
      return `describe ${a.text}`;
    case "similar":
      return `similar ${a.id}`;
    case "next":
      return `next ${a.energy}`;
    case "buildSet":
      return `set ${Object.entries(a.plan)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`.trim();
    case "explain":
      return `explain ${a.id}`;
    case "extra":
      return `extra ${a.id}`;
  }
}

// Loop sizes: 1/32 1/16 1/8 1/4 1/2 1 2 4 8 16 32 (index 7 = 4 beats, 8 = 8 beats).
// Beat jump sizes: 1 2 4 8 16 32. FX types: None, Echo, Ping-pong delay, Reverb, …
const CASES: [string, string][] = [
  // Playing and stopping.
  ["play", "press deck.B.play"],
  ["start deck b", "press deck.B.play"],
  ["play the right deck", "press deck.B.play"],
  ["Hit play on B please", "press deck.B.play"],
  ["stop", "press deck.A.play"],
  ["pause deck A", "press deck.A.play"],
  ["pause the left deck", "press deck.A.play"],
  ["stop the music", "press deck.A.play"],
  ["play deck a", "nothing to do"],
  ["eject deck b", "press deck.B.eject"],
  ["brake deck a", "press deck.A.brake"],
  ["back to the cue on deck b", "tap deck.B.cue"],
  ["let it play out", "press deck.A.let_end"],
  // Sync, keys and tempo.
  ["sync deck b", "set deck.B.sync on"],
  ["sync b", "set deck.B.sync on"],
  ["turn off sync on deck B", "set deck.B.sync off"],
  ["unsync deck a", "set deck.A.sync off"],
  ["match the tempo on deck b", "set deck.B.sync on"],
  ["beatmatch deck b", "set deck.B.sync on"],
  ["key lock on for deck b", "set deck.B.keylock on"],
  ["turn key lock off", "set deck.A.keylock off"],
  ["match the keys on deck b", "press deck.B.key_sync"],
  ["reset the tempo on deck b", "press deck.B.tempo_reset"],
  ["set the tempo of deck b to 124", "value deck.B.tempo -0.198"],
  ["play deck b at 128 bpm", "value deck.B.tempo 0.198"],
  ["speed up deck b a bit", "value deck.B.tempo 0.063"],
  ["slow it down", "value deck.A.tempo -0.125"],
  ["slow deck a down by 2%", "value deck.A.tempo -0.25"],
  ["pitch deck b up 2 semitones", "value deck.B.key_shift 2"],
  ["key down one semitone on deck a", "value deck.A.key_shift -1"],
  ["reset the key on deck b", "value deck.B.key_shift 0"],
  ["make deck b the tempo leader", "press deck.B.master"],
  // Loops and jumps.
  ["loop 4 beats", "choose deck.A.loop.size 7; set deck.A.loop.auto on"],
  ["loop two bars on deck b", "choose deck.B.loop.size 8; set deck.B.loop.auto on"],
  ["loop 1 bar", "choose deck.A.loop.size 7; set deck.A.loop.auto on"],
  ["loop half a beat", "choose deck.A.loop.size 4; set deck.A.loop.auto on"],
  ["loop it", "set deck.A.loop.auto on"],
  ["exit the loop", "set deck.A.loop.auto off"],
  ["stop looping deck b", "set deck.B.loop.auto off"],
  ["halve the loop", "press deck.A.loop.halve"],
  ["double the loop on deck a", "press deck.A.loop.double"],
  ["reloop", "press deck.A.loop.reloop"],
  ["jump forward 8 beats", "choose deck.A.beatjump.size 3; press deck.A.beatjump.fwd"],
  ["jump back 4 bars on deck b", "choose deck.B.beatjump.size 4; press deck.B.beatjump.back"],
  ["skip ahead", "press deck.A.beatjump.fwd"],
  // Hot cues.
  ["jump to cue 3", "tap deck.A.hotcue.3"],
  ["hot cue 2 on deck b", "tap deck.B.hotcue.2"],
  ["set hot cue 5", "tap deck.A.hotcue.5"],
  ["delete hot cue 1 on deck b", "press deck.B.hotcue.1.delete"],
  // EQ.
  ["kill the bass on deck b", "set mixer.B.eq.kill.low on"],
  ["cut the bass", "value mixer.A.eq.low -26"],
  ["swap the bass on deck a", "value mixer.A.eq.low -26"],
  ["bass down a bit", "value mixer.A.eq.low -3"],
  ["turn the bass down on deck b", "value mixer.B.eq.low -6"],
  ["less treble", "value mixer.A.eq.high -6"],
  ["boost the highs on b", "set mixer.B.eq.kill.high off; value mixer.B.eq.high 3"],
  ["more mids", "set mixer.A.eq.kill.mid off; value mixer.A.eq.mid 3"],
  ["bring back the bass", "set mixer.A.eq.kill.low off; value mixer.A.eq.low 0"],
  ["low eq to -10 db on deck b", "set mixer.B.eq.kill.low off; value mixer.B.eq.low -10"],
  ["take out the hi hats", "value mixer.A.eq.high -26"],
  ["reset the eq on deck b", "set mixer.B.eq.kill.low off; value mixer.B.eq.low 0; set mixer.B.eq.kill.mid off; value mixer.B.eq.mid 0; set mixer.B.eq.kill.high off; value mixer.B.eq.high 0"],
  // Stems.
  ["mute the vocals", "set deck.A.stem.vocals.mute on"],
  ["mute the vocals on deck b", "set deck.B.stem.vocals.mute on"],
  ["drop the drums on b", "set deck.B.stem.drums.mute on"],
  ["remove the vocals", "set deck.A.stem.vocals.mute on"],
  ["no vocals on deck b", "set deck.B.stem.vocals.mute on"],
  ["bring the vocals back", "set deck.A.stem.vocals.mute off"],
  ["unmute the drums", "set deck.A.stem.drums.mute off"],
  ["mute the bassline", "set deck.A.stem.bass.mute on"],
  ["solo the drums on deck b", "set deck.B.stem.drums.mute off; set deck.B.stem.vocals.mute on; set deck.B.stem.bass.mute on; set deck.B.stem.melody.mute on"],
  ["acapella on deck b", "set deck.B.stem.vocals.mute off; set deck.B.stem.drums.mute on; set deck.B.stem.bass.mute on; set deck.B.stem.melody.mute on"],
  ["just the vocals", "set deck.A.stem.vocals.mute off; set deck.A.stem.drums.mute on; set deck.A.stem.bass.mute on; set deck.A.stem.melody.mute on"],
  ["instrumental version on deck a", "set deck.A.stem.vocals.mute on; set deck.A.stem.drums.mute off; set deck.A.stem.bass.mute off; set deck.A.stem.melody.mute off"],
  ["bring all the stems back", "set deck.A.stem.vocals.mute off; set deck.A.stem.drums.mute off; set deck.A.stem.bass.mute off; set deck.A.stem.melody.mute off"],
  ["vocals down on deck b", "value deck.B.stem.vocals 0.5"],
  // Filter.
  ["filter deck a down", "value mixer.A.filter -0.6"],
  ["high pass deck b", "value mixer.B.filter 0.6"],
  ["low pass filter all the way", "value mixer.A.filter -1"],
  ["a little low pass", "value mixer.A.filter -0.3"],
  ["take the filter off", "value mixer.A.filter 0"],
  ["reset the filter on deck b", "value mixer.B.filter 0"],
  // Volume and the crossfader.
  ["fade out deck a", "value mixer.A.fader 0"],
  ["bring in deck b", "value mixer.B.fader 1"],
  ["turn deck b down", "value mixer.B.fader 0.8"],
  ["turn it down a bit", "value mixer.A.fader 0.9"],
  ["volume to 50% on deck b", "value mixer.B.fader 0.5"],
  ["mute deck b", "value mixer.B.fader 0"],
  ["master volume up", "value mixer.master 3"],
  ["turn everything down a bit", "value mixer.master -1.5"],
  ["crossfader to the middle", "value mixer.crossfader 0"],
  ["crossfader all the way left", "value mixer.crossfader -1"],
  ["fade over to deck b", "value mixer.crossfader 1"],
  ["move the crossfader to b", "value mixer.crossfader 1"],
  // Effects.
  ["add some echo", "choose fx.A.1.type 1; value fx.A.1.mix 0.5; set fx.A.1.on on"],
  ["add reverb to deck b", "choose fx.B.2.type 3; value fx.B.2.mix 0.5; set fx.B.2.on on"],
  ["a little reverb on deck a", "choose fx.A.2.type 3; value fx.A.2.mix 0.25; set fx.A.2.on on"],
  ["put a flanger on deck b", "choose fx.B.1.type 5; value fx.B.1.mix 0.5; set fx.B.1.on on"],
  ["echo out deck a", "choose fx.A.1.type 1; value fx.A.1.mix 0.5; set fx.A.1.on on"],
  ["add a 1 beat delay", "choose fx.A.1.type 1; choose fx.A.1.beats 5; value fx.A.1.mix 0.5; set fx.A.1.on on"],
  ["lots of phaser on the master", "choose fx.master.1.type 6; value fx.master.1.mix 0.8; set fx.master.1.on on"],
  ["turn off the effects on deck b", "set fx.B.1.on off; set fx.B.2.on off; set fx.B.3.on off"],
  ["stop the reverb", "set fx.A.2.on off"],
  ["noise riser on everything", "choose fx.master.1.type 16; value fx.master.1.mix 0.5; set fx.master.1.on on"],
  // Mic, recording, pads, snap.
  ["turn the mic on", "set mic.on_air on"],
  ["mic off", "set mic.on_air off"],
  ["mute my microphone", "set mic.on_air off"],
  ["turn on talk over", "set mic.talkover on"],
  ["start recording", "set global.record on"],
  ["record my mix", "set global.record on"],
  ["stop recording", "set global.record off"],
  ["play pad 3", "tap sampler.pad.3"],
  ["stop all the pads", "press sampler.stop_all"],
  ["snap to beat on", "set global.quantize on"],
  ["turn off quantize", "set global.quantize off"],
  // App.
  ["go to the library", "app app.workspace.library"],
  ["open arrange", "app app.workspace.arrange"],
  ["show me the mixer", "app app.workspace.mix"],
  ["open settings", "app app.settings"],
  ["undo", "app app.undo"],
  ["open the guide", "app app.guide:on"],
  ["close the sampler", "app app.sampler:off"],
  ["start auto dj", "app app.autodj:on"],
  ["switch to pro view", "app app.view.pro"],
  ["easy mode", "app app.view.easy"],
  ["take the tour", "app app.tour"],
  ["how did i do", "app app.feedback"],
  ["mix it", "app app.mix_it"],
  ["analyse my tracks", "extra x.analyse"],
  ["analyze new music", "extra x.analyse"],
  ["tidy up the track names", "extra x.tidy"],
  ["add a music folder", "extra x.add"],
  ["export the mix as a wav", "extra x.render"],
  ["export stems", "extra x.stems"],
  // Explaining a control.
  ["what does key lock do", "explain deck.A.keylock"],
  ["what is slip", "explain deck.A.slip"],
  ["explain the crossfader", "explain mixer.crossfader"],
  ["what's talk-over for", "explain mic.talkover"],
  ["how do i use the safety loop", "explain global.safety_loop"],
  ["what does sync do", "explain deck.A.sync"],
  // What next.
  ["what should i play next", "next steady"],
  ["what goes well with this", "next steady"],
  ["suggest the next track", "next steady"],
  ["next track with more energy", "next up"],
  ["something with more energy", "next up"],
  ["i need something calmer", "next down"],
  ["what can i play next to bring the energy down", "next down"],
  ["give me something harder", "next up"],
  ["what to play after this one", "next steady"],
  // Finding tracks.
  ["find instrumentals", "find vocals:no"],
  ["show me tracks around 124 bpm", "find bpm:~124"],
  ["techno between 128 and 132 bpm", "find bpm:128-132 genre:techno"],
  ["deep house tracks without vocals", "find vocals:no genre:\"deep house\""],
  ["songs in A minor", "find key:Am"],
  ["tracks in 8a", "find key:8A"],
  ["find tracks in key with this one", "find key:~8A"],
  ["bangers i haven't played yet", "find energy:7+ played:never"],
  ["show me my favourites", "find rating:4+"],
  ["5 star tracks", "find rating:5+"],
  ["new tracks", "find added:<2w"],
  ["tracks by daft punk", "find artist:\"daft punk\""],
  ["disco tracks faster than 120", "find bpm:>120 genre:disco"],
  ["hip hop slower than 95 bpm", "find bpm:<95 genre:\"hip hop\""],
  ["vocal tracks in my house bangers playlist", "find vocals:yes @2"],
  ["low energy tracks", "find energy:<5"],
  ["tracks that need analysing", "find analysed:no"],
  ["show tracks tagged opener", "find tag:opener"],
  ["tracks that sound like dark rolling bass", "describe dark rolling bass"],
  ["find something dreamy and warm", "describe dreamy warm"],
  ["music with a big punchy kick", "describe big punchy kick"],
  ["more like this", "similar 7"],
  ["tracks that sound like this one", "similar 7"],
  ["find tracks similar to the selected one", "similar 42"],
  // Planning a set.
  ["build a one hour warm-up set", "set minutes=60 shape=warmUp"],
  ["make me a 90 minute peak time set from my house bangers playlist", "set minutes=90 playlist=2 shape=peak"],
  ["plan a 2 hour journey set", "set minutes=120 shape=journey"],
  ["build a set", "set"],
  ["30 minute cool down set with no vocals", "set minutes=30 shape=coolDown vocals=instrumental"],
  ["give me an hour and a half of techno, building up", "set minutes=90 query=genre:techno shape=build"],
  ["put together a 45 min set between 120 and 124 bpm", "set minutes=45 query=bpm:120-124"],
  ["warm-up set from sunday chill", "set playlist=3 shape=warmUp"],
  ["plan an hour long closing set starting with this track", "set minutes=60 seed=42 shape=coolDown"],
  ["make a steady deep house set for 2 hours", "set minutes=120 query=genre:\"deep house\" shape=steady"],
  ["build a set with not too many vocals", "set vocals=breathe"],
  ["a peak time set from my peak time playlist", "set playlist=4 shape=peak"],
  ["bass down 3 db on deck b", "set mixer.B.eq.kill.low off; value mixer.B.eq.low -3"],
  ["a 1 hour set to talk over", "set minutes=60 vocals=instrumental"],
  // Controls by their own names.
  ["slip on deck b", "set deck.B.slip on"],
  ["censor", "tap deck.A.censor"],
  ["turn on the master limiter", "set mixer.limiter on"],
  ["auto-gain off", "set mixer.auto_gain off"],
  ["crossfader curve sharp cut", "choose mixer.crossfader_curve 2"],
  ["eq mode isolator", "choose mixer.eq_mode 1"],
  ["safety loop off", "set global.safety_loop off"],
  ["noise gate on deck b", "set mixer.B.gate on"],
  ["split cue on", "set mixer.split_cue on"],
  ["tempo range 16%", "choose deck.A.tempo_range 3"],
  // A second set, written after the rules and checked once before any change (58 of 67 right).
  ["start the other deck", "press deck.B.play"],
  ["pause it", "press deck.A.play"],
  ["can you play deck 2", "press deck.B.play"],
  ["turn sync on for the right deck", "set deck.B.sync on"],
  ["lock the key on deck a", "set deck.A.keylock on"],
  ["bring deck b to 124 bpm", "value deck.B.tempo -0.198"],
  ["make deck b a little faster", "value deck.B.tempo 0.063"],
  ["set a 8 beat loop", "choose deck.A.loop.size 8; set deck.A.loop.auto on"],
  ["loop the last bar on deck b", "choose deck.B.loop.size 7; set deck.B.loop.auto on"],
  ["get out of the loop", "set deck.A.loop.auto off"],
  ["jump back 16 beats", "choose deck.A.beatjump.size 4; press deck.A.beatjump.back"],
  ["go to hot cue 4 on the left deck", "tap deck.A.hotcue.4"],
  ["remove cue 2", "press deck.A.hotcue.2.delete"],
  ["kill the lows on deck a", "set mixer.A.eq.kill.low on"],
  ["less bass on the right", "value mixer.B.eq.low -6"],
  ["turn the highs up a little on deck b", "set mixer.B.eq.kill.high off; value mixer.B.eq.high 2"],
  ["cut the mids", "value mixer.A.eq.mid -26"],
  ["bring the bass back in on deck b", "set mixer.B.eq.kill.low off; value mixer.B.eq.low 0"],
  ["take the vocals out of deck b", "set deck.B.stem.vocals.mute on"],
  ["mute drums", "set deck.A.stem.drums.mute on"],
  ["only the drums on deck a", "set deck.A.stem.drums.mute off; set deck.A.stem.vocals.mute on; set deck.A.stem.bass.mute on; set deck.A.stem.melody.mute on"],
  ["unmute the vocals on b", "set deck.B.stem.vocals.mute off"],
  ["put a low pass on deck b", "value mixer.B.filter -0.6"],
  ["filter it up", "value mixer.A.filter 0.6"],
  ["no filter", "value mixer.A.filter 0"],
  ["fade deck b in", "value mixer.B.fader 1"],
  ["deck a volume down", "value mixer.A.fader 0.8"],
  ["make it louder", "value mixer.A.fader 1"],
  ["master down 3 db", "value mixer.master -3"],
  ["crossfader to deck a", "value mixer.crossfader -1"],
  ["center the crossfader", "value mixer.crossfader 0"],
  ["throw some echo on deck b", "choose fx.B.1.type 1; value fx.B.1.mix 0.5; set fx.B.1.on on"],
  ["reverb on the master", "choose fx.master.2.type 3; value fx.master.2.mix 0.5; set fx.master.2.on on"],
  ["effects off", "set fx.A.1.on off; set fx.A.2.on off; set fx.A.3.on off"],
  ["add distortion", "choose fx.A.1.type 12; value fx.A.1.mix 0.5; set fx.A.1.on on"],
  ["switch the mic on", "set mic.on_air on"],
  ["talk over off", "set mic.talkover off"],
  ["begin recording", "set global.record on"],
  ["hit pad 1", "tap sampler.pad.1"],
  ["open the library", "app app.workspace.library"],
  ["go to arrange", "app app.workspace.arrange"],
  ["open the sequencer", "app app.sequencer:on"],
  ["stop auto dj", "app app.autodj:off"],
  ["what does the filter do", "explain mixer.A.filter"],
  ["what is a hot cue", "explain deck.A.hotcue.1"],
  ["what's beat jump", "explain deck.A.beatjump.back"],
  ["what do i play next", "next steady"],
  ["what comes next", "next steady"],
  ["suggest something with less energy", "next down"],
  ["keep the energy going, what next", "next steady"],
  ["show me house tracks", "find genre:house"],
  ["instrumentals around 126 bpm", "find bpm:~126 vocals:no"],
  ["techno in 5a", "find key:5A genre:techno"],
  ["tracks i haven't played in a month", "find played:>1m"],
  ["songs by the weeknd", "find artist:\"the weeknd\""],
  ["something that sounds like a sunny beach party", "describe a sunny beach party"],
  ["find me dark minimal techno", "find techno genre:minimal"],
  ["tracks with a female vocal and piano", "describe female vocal piano"],
  ["build a 2 hour peak time set", "set minutes=120 shape=peak"],
  ["make a warm up set from my warm up playlist", "set playlist=1 shape=warmUp"],
  ["i need an opening set of 45 minutes", "set minutes=45 shape=warmUp"],
  ["create a set for an hour with instrumentals only", "set minutes=60 vocals=instrumental"],
  ["plan a closing set from sunday chill", "set playlist=3 shape=coolDown"],
  ["build a 90 min disco set", "set minutes=90 query=genre:disco"],
  ["undo that", "app app.undo"],
  ["analyse the library", "extra x.analyse"],
  ["render my mix to mp3", "extra x.render"],
];

describe("Ask MixIt", () => {
  it("understands at least 95 % of the test set", () => {
    const c = ctx();
    const wrong: string[] = [];
    for (const [text, want] of CASES) {
      const got = brief(understand(text, c));
      if (got !== want) wrong.push(`  “${text}”\n      want ${want}\n      got  ${got}`);
    }
    const right = CASES.length - wrong.length;
    const share = right / CASES.length;
    console.log(`Ask MixIt: ${right} of ${CASES.length} (${(share * 100).toFixed(1)} %)${wrong.length ? `\n${wrong.join("\n")}` : ""}`);
    expect(share).toBeGreaterThanOrEqual(0.95);
  });

  it("only names controls that are in the registry", () => {
    const c = ctx();
    const ids = new Set(registry.map((a) => a.id));
    for (const [text] of CASES) {
      const u = understand(text, c);
      if (u?.ask.kind === "control") for (const s of u.ask.steps) if (s.do !== "app") expect(ids, text).toContain(s.id);
      if (u?.ask.kind === "explain") expect(ids, text).toContain(u.ask.id);
    }
  });

  it("says what it will do in plain words", () => {
    const c = ctx();
    expect(understand("cut the bass on deck b", c)?.say).toBe("Deck B: low EQ all the way down");
    expect(understand("loop 2 bars", c)?.say).toBe("Deck A: loop 2 bars");
    expect(understand("play deck b at 128 bpm", c)?.say).toBe("Deck B: tempo to 128 BPM");
    expect(understand("build a one hour warm-up set", c)?.say).toBe("Build a set: 1 hour, warm-up");
    expect(understand("find instrumentals around 124 bpm", c)?.say).toBe("Search the library: bpm:~124 vocals:no");
  });

  it("says when a tempo is out of the slider's reach", () => {
    expect(understand("play deck b at 150 bpm", ctx())?.say).toMatch(/as close as the tempo range allows: 136\.1 BPM/);
  });

  it("goes by what is playing when no deck is named", () => {
    const both = ctx();
    both.decks[1] = { ...both.decks[1], playing: true };
    // With A leading the tempo, B is the one coming in.
    expect(brief(understand("cut the bass", both))).toBe("value mixer.B.eq.low -26");
    const none = ctx();
    none.decks = none.decks.map((d) => ({ ...d, playing: false }));
    expect(brief(understand("play", none))).toBe("press deck.A.play");
  });

  it("searches by words when the listener is off", () => {
    expect(brief(understand("tracks that sound like dark rolling bass", ctx({ soundSearch: false })))).toBe("find dark rolling bass");
  });

  it("does not guess at sentences it can't read", () => {
    for (const t of ["", "x", "hello there", "the weather is nice today", "banana"]) expect(understand(t, ctx())).toBeNull();
  });

  it("reads numbers written as words", () => {
    expect(normalise("Please loop four beats")).toBe("loop 4 beats");
    expect(normalise("pitch up twenty two")).toBe("pitch up 22");
    expect(normalise("play this one next")).toBe("play this one next");
  });

  it("fills in Build a set's defaults for what a plan leaves out", () => {
    expect(planRequest({ minutes: 45, shape: "peak" })).toEqual({ query: "", playlist: null, minutes: 45, shape: "peak", seed: null, variety: 0, vocals: "any" });
  });
});
