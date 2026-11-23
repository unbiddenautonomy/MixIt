// The nine practice labs. Each step says what to do in plain words and, where the app
// can tell, checks itself off when you do it.
import { usePreview } from "../components/arrange/preview";
import { useAssistant } from "../components/feedback/MixAssistant";
import { useStudio } from "../store/studio";
import { singingAt } from "../lib/coach";
import { audible, ch, deckWith, noteJump, noteStart, offBoundary, playing, tele, type Lab } from "./model";

const A = 0;
const B = 1;
const ECHO = 1; // index in the FX list

export const LABS: Lab[] = [
  {
    id: "phrase-drop",
    number: 1,
    title: "Phrases and clean cue drops",
    goal: "Start the second track exactly at the beginning of a phrase, so the change feels intentional instead of random.",
    decks: ["p1", "p2"],
    freshCues: [B],
    observe: (c) => noteStart(c, B, A, "bStartAt"),
    steps: [
      {
        id: "play-a",
        title: "Play deck A",
        body: "Count along: 1-2-3-4 is one bar. The red lines in the waveform mark phrases, every 8 bars. Changes in the music (a new drum part, a breakdown) land on those lines.",
        controls: ["deck.A.play"],
        check: (c) => playing(c, A),
      },
      {
        id: "phrase-pass",
        title: "Watch deck A cross a red phrase line",
        body: "Notice how something changes in the music right there. That is the moment DJs aim for.",
        check: (c) => (tele(c, A)?.beat ?? 0) >= 34 && playing(c, A),
      },
      {
        id: "sync-b",
        title: "Turn on Sync on deck B",
        body: "Sync matches deck B's tempo and beat to deck A, so their kicks will land together.",
        controls: ["deck.B.sync"],
        check: (c) => !!tele(c, B)?.sync,
      },
      {
        id: "hot-cue",
        title: "Save a hot cue on deck B where the drums start",
        body: "Hot cue 1 is a bookmark. Click an empty pad to save the current spot; pressing it later jumps straight there.",
        controls: ["deck.B.hotcue.1"],
        tab: [B, "cues"],
        check: (c) => !!c.app.decks[B]?.detail.cues.some((q) => q.role === "hot"),
      },
      {
        id: "drop",
        title: "Start deck B on the first beat of a phrase",
        body: "Watch deck A approach a red line and press Play on deck B right on it. With sync and quantise on, MixIt starts it on the exact beat if you are close.",
        controls: ["deck.B.play"],
        check: (c) => typeof c.m.bStartAt === "number" && offBoundary(c.m.bStartAt as number, 32) <= 1,
      },
      {
        id: "blend",
        title: "Bring deck B into the mix",
        body: "Raise deck B's volume fader and move the crossfader towards the middle. Both tracks now play together, in time.",
        controls: ["mixer.B.fader", "mixer.crossfader"],
        check: (c) => audible(c, A) > 0.3 && audible(c, B) > 0.3,
      },
    ],
    listen: "Both rhythms lock together, and the new track enters as if it was always meant to be there.",
    mistake: "Starting the new track somewhere in the middle of a phrase. If you miss, stop deck B, press its hot cue and wait for the next red line.",
  },
  {
    id: "bass-swap",
    number: 2,
    title: "The 16-bar bass swap",
    goal: "Blend two tracks without a muddy, boomy low end, by letting only one track carry the bass at a time.",
    decks: ["p1", "p3"],
    observe: (c) => {
      // Seconds when both tracks were loud with full bass (the mistake to avoid).
      const both = audible(c, A) > 0.4 && audible(c, B) > 0.4 && ch(c, A).low > -6 && ch(c, B).low > -6;
      const last = (c.m.tick as number) ?? c.now;
      if (both) c.m.mud = ((c.m.mud as number) ?? 0) + Math.min(0.5, c.now - last);
      c.m.tick = c.now;
      noteStart(c, B, A, "bStartAt");
    },
    steps: [
      {
        id: "play",
        title: "Play deck A and turn on Sync on deck B",
        controls: ["deck.A.play", "deck.B.sync"],
        check: (c) => playing(c, A) && !!tele(c, B)?.sync,
      },
      {
        id: "cut-low",
        title: "Turn deck B's Low EQ all the way down",
        body: "Low is the kick and bassline. Taking it out of the incoming track before it starts means the two basslines never stack.",
        controls: ["mixer.B.eq.low", "mixer.B.eq.kill.low"],
        check: (c) => ch(c, B).low <= -20 || ch(c, B).kills[0],
      },
      {
        id: "bring-in",
        title: "Start deck B on a phrase and bring it up",
        body: "Raise its fader and centre the crossfader. You hear its hats and melody, but deck A still owns the bass.",
        controls: ["deck.B.play", "mixer.B.fader", "mixer.crossfader"],
        check: (c) => audible(c, B) > 0.4 && audible(c, A) > 0.4 && (ch(c, B).low <= -15 || ch(c, B).kills[0]),
      },
      {
        id: "swap",
        title: "Swap the bass on a phrase line",
        body: "On the next red line, turn deck A's Low down and deck B's Low up at the same moment (or sweep both over a few bars).",
        controls: ["mixer.A.eq.low", "mixer.B.eq.low"],
        check: (c) => playing(c, A) && playing(c, B) && ch(c, A).low <= -15 && ch(c, B).low >= -3 && !ch(c, B).kills[0],
      },
      {
        id: "out",
        title: "Fade deck A out",
        body: "Pull deck A's fader down, or move the crossfader across to B.",
        controls: ["mixer.A.fader", "mixer.crossfader"],
        check: (c) => playing(c, B) && audible(c, A) < 0.1 && audible(c, B) > 0.4,
      },
    ],
    listen: "The kick and bass stay punchy all the way through. In the middle of the blend there is never a moment where it booms.",
    mistake: "Leaving both Low EQs up in the middle of the transition. The lab counts how many seconds that happened.",
  },
  {
    id: "filter-echo",
    number: 3,
    title: "High-pass filter and echo exit",
    goal: "End a track gracefully: thin it out with the filter and let an echo carry it away instead of cutting it off.",
    decks: ["p3"],
    steps: [
      {
        id: "play",
        title: "Play deck A",
        controls: ["deck.A.play"],
        check: (c) => playing(c, A),
      },
      {
        id: "hpf",
        title: "Slowly turn deck A's filter to the right",
        body: "Right of centre is a high-pass filter: it removes the bass first, then the mids. Take four to eight bars to get past halfway.",
        controls: ["mixer.A.filter"],
        check: (c) => ch(c, A).filter >= 0.5,
      },
      {
        id: "echo",
        title: "Switch on an Echo on deck A",
        body: "Open deck A's FX tab, pick Echo in a slot and switch it on. Half a beat or three quarters sounds natural.",
        controls: ["fx.A.1.type", "fx.A.1.on"],
        tab: [A, "fx"],
        check: (c) => c.app.mixer.fx[A].some((f) => f.type === ECHO && f.on),
      },
      {
        id: "fade",
        title: "Pull deck A's fader down while the echo rings",
        body: "The echoes keep repeating after the track is gone, so the exit sounds like a fade, not a stop.",
        controls: ["mixer.A.fader"],
        check: (c) => ch(c, A).fader < 0.1 && c.app.mixer.fx[A].some((f) => f.type === ECHO && f.on),
      },
      {
        id: "reset",
        title: "Switch the echo off and centre the filter",
        body: "Clean up, so the next track on this deck starts plain.",
        controls: ["fx.A.1.on", "mixer.A.filter"],
        check: (c) => !c.app.mixer.fx[A].some((f) => f.on) && Math.abs(ch(c, A).filter) < 0.05,
      },
    ],
    listen: "The low end thins out gradually and a soft trail of echoes remains, instead of a sudden silence or a click.",
    mistake: "Leaving the echo switched on after the track has gone; the next track will start drenched in it.",
  },
  {
    id: "key-lock",
    number: 4,
    title: "Key lock, key shift and harmonic mixing",
    goal: "Hear the difference between changing speed and changing pitch, and why some keys clash.",
    decks: ["p5", "p4"],
    pro: true,
    prepare: [["deck.A.keylock", false]],
    observe: (c) => {
      if (deckWith(c, "p4") === B && playing(c, A) && playing(c, B) && audible(c, B) > 0.3) c.m.heardClash = true;
      if (c.m.heardClash && deckWith(c, "p2") === B && playing(c, A) && playing(c, B) && audible(c, B) > 0.3) c.m.heardMatch = true;
    },
    steps: [
      {
        id: "no-lock",
        title: "Play deck A with key lock off and push the tempo up 6% or more",
        body: "Listen to the chords: everything gets faster and higher, like a record spun too fast.",
        controls: ["deck.A.keylock", "deck.A.tempo"],
        check: (c) => playing(c, A) && !tele(c, A)!.keylock && Math.abs(tele(c, A)!.rate - 1) >= 0.05,
      },
      {
        id: "lock",
        title: "Now turn key lock on, at the same tempo",
        body: "It is still faster, but the pitch drops back to normal. That is time-stretching.",
        controls: ["deck.A.keylock"],
        check: (c) => !!tele(c, A)?.keylock && Math.abs(tele(c, A)!.rate - 1) >= 0.05,
      },
      {
        id: "reset",
        title: "Reset the tempo",
        controls: ["deck.A.tempo"],
        check: (c) => Math.abs((tele(c, A)?.rate ?? 0) - 1) < 0.01 && !!tele(c, A)?.keylock,
      },
      {
        id: "shift",
        title: "Shift the key up a semitone",
        body: "Key shift changes the pitch without changing the speed, the opposite of what you just heard.",
        controls: ["deck.A.key_shift"],
        pro: true,
        check: (c) => (tele(c, A)?.keyShift ?? 0) !== 0,
      },
      {
        id: "clash",
        title: "Put the key back, then play Practice 4 on deck B alongside",
        body: "Practice 4 is in 3B, far from deck A's 5A on the Camelot wheel. Listen to how the chords rub against each other.",
        controls: ["deck.A.key_shift", "deck.B.play", "mixer.crossfader"],
        check: (c) => !!c.m.heardClash,
      },
      {
        id: "match",
        title: "Swap deck B for Practice 2 and compare",
        body: "Practice 2 (9A) is still not a neighbour of 5A, so press Match key on deck B: MixIt shifts it to fit. The suggestions list shows which tracks fit without shifting.",
        controls: ["deck.B.key_sync"],
        load: [B, "p2"],
        check: (c) => !!c.m.heardMatch,
      },
    ],
    listen: "With key lock on, tempo changes keep the melody at its pitch. Neighbouring Camelot keys (8A with 7A, 9A or 8B) blend without sour notes.",
    mistake: "Confusing tempo with key. Tempo is speed; key is which notes are played. Big tempo changes with key lock can sound a little phasey.",
  },
  {
    id: "slip-roll",
    number: 5,
    title: "Loop roll, slip mode and phrase recovery",
    goal: "Play with the track (stutters, jumps) without losing your place in the phrase.",
    decks: ["p1"],
    pro: true,
    prepare: [["deck.A.slip", false]],
    observe: (c) => {
      const t = tele(c, A);
      if (t?.looping.active && t.slip && t.looping.beats <= 1) c.m.rolled = true;
      if (c.m.rolled && !t?.looping.active) c.m.released = true;
      if (t?.slip) noteJump(c, A, "jumped");
    },
    steps: [
      {
        id: "slip",
        title: "Play deck A and turn Slip on",
        body: "Slip keeps a hidden play head running in the background while you play tricks.",
        controls: ["deck.A.play", "deck.A.slip"],
        pro: true,
        check: (c) => playing(c, A) && !!tele(c, A)?.slip,
      },
      {
        id: "roll",
        title: "Hold Loop roll for two to four beats",
        body: "In deck A's Loop tab, pick ½ or ¼ beat and hold Roll: the track stutters.",
        controls: ["deck.A.loop.roll"],
        tab: [A, "loop"],
        pro: true,
        check: (c) => !!c.m.rolled,
      },
      {
        id: "release",
        title: "Let go and listen where it comes back",
        body: "It continues exactly where the song would have been, still on the phrase, as if the stutter was part of the track.",
        check: (c) => !!c.m.released,
      },
      {
        id: "jump",
        title: "With Slip still on, beat jump or press a hot cue",
        body: "Jump around for a moment. Watch the faint second play head in the waveform: it keeps going.",
        controls: ["deck.A.beatjump.fwd", "deck.A.hotcue.1"],
        tab: [A, "jump"],
        check: (c) => !!c.m.jumped,
      },
      {
        id: "off",
        title: "Turn Slip off",
        body: "With Slip off, jumps and loops really move the track, which is what you want for preparing a mix.",
        controls: ["deck.A.slip"],
        check: (c) => !!c.m.jumped && !tele(c, A)?.slip,
      },
    ],
    listen: "Re-entries land in time with the phrase instead of falling behind.",
    mistake: "Forgetting whether Slip is on. If a hot cue 'does not stay', Slip is on.",
  },
  {
    id: "beatgrid",
    number: 6,
    title: "Beatgrids, downbeats and drifting tempo",
    goal: "Check that the beat grid sits on the kicks, including on a live-band track whose tempo drifts.",
    decks: ["p6"],
    pro: true,
    observe: (c) => {
      const d = c.app.decks[A]?.detail;
      if (!d?.bpm) return;
      if (c.m.bpm0 === undefined) c.m.bpm0 = d.bpm;
      const b0 = c.m.bpm0 as number;
      if (d.bpm > b0 * 1.8 || d.bpm < b0 * 0.55) c.m.tried = true;
      if (c.m.tried && Math.abs(d.bpm - b0) < b0 * 0.01) c.m.restored = true;
      if (c.m.first0 === undefined) c.m.first0 = d.firstBeat;
      if (Math.abs(d.firstBeat - (c.m.first0 as number)) > 0.005) c.m.moved = true;
      if (c.m.pins0 === undefined) c.m.pins0 = d.warps.length;
      if (d.warps.length !== c.m.pins0) c.m.pinned = true;
    },
    steps: [
      {
        id: "grid-tab",
        title: "Open deck A's Grid tab",
        body: "It shows the analysed tempo and whether the grid follows a drifting tempo (this track speeds up from 118 to 122 BPM).",
        tab: [A, "grid"],
        pro: true,
        check: (c) => c.app.padTabs[A] === "grid",
      },
      {
        id: "listen",
        title: "Play from the start and watch the beat lines",
        body: "The lines should sit on every kick, early in the track and late in it. The grid bends with the tempo, so they stay together.",
        controls: ["deck.A.play"],
        check: (c) => playing(c, A) && (tele(c, A)?.beat ?? 0) > 32,
      },
      {
        id: "double",
        title: "Try Double tempo, look, then Half tempo to put it back",
        body: "A grid at the wrong tempo puts lines between the kicks. Analysis can mistake a track for double or half its speed; these buttons fix it.",
        controls: ["deck.A.grid.double", "deck.A.grid.halve"],
        pro: true,
        check: (c) => !!c.m.restored,
      },
      {
        id: "downbeat",
        title: "Set the downbeat on the first kick of a bar",
        body: "Pause on a strong first beat (where the music starts a new bar) and press Set downbeat. Grid earlier and later move it by 5 ms.",
        controls: ["deck.A.grid.set_downbeat", "deck.A.grid.nudge_back", "deck.A.grid.nudge_fwd"],
        pro: true,
        check: (c) => !!c.m.moved,
      },
      {
        id: "pin",
        title: "Pin a beat where the lines drift",
        body: "If a line ever sits beside a kick later in a track, pause on that kick and press Pin beat here. The line moves onto it and the beats before it spread out evenly. A cyan diamond marks the pin; Remove pin takes it away.",
        controls: ["deck.A.grid.warp", "deck.A.grid.unwarp"],
        pro: true,
        check: (c) => !!c.m.pinned,
      },
    ],
    listen: "Beat lines and kicks line up from start to end, so sync and loops stay tight.",
    mistake: "Forcing one fixed tempo onto a live recording. MixIt's grid follows drift on its own; fix the downbeat and double or half errors, and pin a beat only where a line still misses its kick.",
  },
  {
    id: "automation",
    number: 7,
    title: "Timeline automation and export",
    goal: "Build a repeatable transition on the timeline with drawn curves, listen to it, and render it to a file.",
    arrange: true,
    observe: (c) => {
      if (usePreview.getState().status === "playing") c.m.previewed = true;
      const j = c.app.jobs.render;
      if (j?.finished && !j.error) c.m.rendered = true;
    },
    steps: [
      {
        id: "clips",
        title: "Two overlapping clips on different lanes",
        body: "Set up puts Practice 1 and Practice 2 on the timeline with 8 bars of overlap. You can drag clips to change it.",
        check: (c) => {
          const cl = c.app.project?.clips ?? [];
          return cl.some((a) => cl.some((b) => a.lane !== b.lane && a.start < b.start + b.length && b.start < a.start + a.length));
        },
      },
      {
        id: "volume",
        title: "Draw a volume fade on the outgoing clip",
        body: "Select the first clip, pick Volume under Automation and click two points in the overlap: high, then low. Or press Ramp out.",
        check: (c) => !!c.app.project?.clips.some((cl) => (cl.lanes.find((l) => l.param === "Volume")?.points.length ?? 0) >= 2),
      },
      {
        id: "low",
        title: "Draw a bass swap: Low EQ down on one clip, up on the other",
        body: "Pick Low EQ. On the outgoing clip draw it from 0 dB down to cut; on the incoming clip, from cut up to 0 dB. Ramp in and Ramp out do this in one click.",
        check: (c) => (c.app.project?.clips.filter((cl) => (cl.lanes.find((l) => l.param === "EqLow")?.points.length ?? 0) >= 2).length ?? 0) >= 2,
      },
      {
        id: "listen",
        title: "Listen to the transition",
        body: "Click the ruler just before the overlap and press Play from bar, or use the clip's Hear the mix in. Adjust points until it sounds smooth.",
        check: (c) => !!c.m.previewed,
      },
      {
        id: "render",
        title: "Render the mix to a WAV file",
        body: "Render mix writes exactly what you heard, every time. Open the file in any player to check it.",
        check: (c) => !!c.m.rendered,
      },
    ],
    listen: "Smooth fades with no clicks, pops or sudden jumps in volume.",
    mistake: "Ending a volume curve above zero at the clip's edge, which makes a small pop where the clip stops.",
  },
  {
    id: "studio",
    number: 8,
    title: "Shape a track in the studio",
    goal: "Use the studio on a channel to shape the tone, add punch and a reverb tail, then let the mix assistant check the result.",
    decks: ["p1"],
    observe: (c) => {
      // The reverb send was up while the track played, so its tail can ring on.
      if (playing(c, A) && ch(c, A).space >= 0.3) c.m.sent = true;
      if (c.m.sent && ch(c, A).fader < 0.05) c.m.tailed = true;
    },
    steps: [
      {
        id: "play",
        title: "Play deck A",
        controls: ["deck.A.play"],
        check: (c) => playing(c, A) && audible(c, A) > 0.3,
      },
      {
        id: "open",
        title: "Open deck A's studio",
        body: "Press the sliders button at the top of deck A's channel on the mixer. The picture shows the sound: bass on the left, cymbals on the right.",
        check: () => useStudio.getState().open === A,
      },
      {
        id: "eq",
        title: "Change one part of the sound with an EQ band",
        body: "Click a band dot and drag it up or down (2 dB or more). Try a small cut around 300 Hz to clear mud, or a lift above 8 kHz for shine. Drag sideways to move it, scroll to make it wider or narrower.",
        check: () => {
          const s = useStudio.getState().settings[A];
          return !!s?.eqOn && s.bands.some((b) => b.enabled && (Math.abs(b.gainDb) >= 2 || b.shape === "lowCut" || b.shape === "highCut"));
        },
      },
      {
        id: "punch",
        title: "Add Punch and watch the Compressing meter",
        body: "Turn Punch up until the meter moves a few dB on the kicks. The drums get firmer and the level steadier. Past about 10 dB it starts to sound squashed.",
        controls: ["mixer.A.punch"],
        check: (c) => ch(c, A).punch >= 0.3 && (tele(c, A)?.compGrDb ?? 0) >= 1,
      },
      {
        id: "tail",
        title: "Send some to Space, then pull the fader down",
        body: "Turn Space up so you hear the room, then bring deck A's fader all the way down. The reverb keeps ringing after the track has gone: the classic way to end a track.",
        controls: ["mixer.A.space", "mixer.A.fader"],
        check: (c) => !!c.m.tailed,
      },
      {
        id: "assistant",
        title: "Bring the fader back up and open the mix assistant",
        body: "The stethoscope button in the top bar listens for a few seconds and lists anything to fix, each with a one-click fix and why it helps.",
        controls: ["app.assistant"],
        check: (c) => !!c.m.tailed && useAssistant.getState().open && ch(c, A).fader > 0.3,
      },
    ],
    listen: "The track sounds fuller and firmer than before, with no harsh or boomy part sticking out, and the reverb tail fades smoothly.",
    mistake: "Boosting several EQ bands a lot. Cutting what is too much usually sounds cleaner than boosting what is missing, and keeps the level out of the limiter.",
  },
  {
    id: "vocals",
    number: 9,
    title: "Mixing around vocals",
    goal: "Blend two songs that both have singing without the voices talking over each other.",
    decks: ["p7", "p8"],
    observe: (c) => {
      const sings = (d: number) => playing(c, d) && singingAt(c.app.decks[d], tele(c, d)?.position ?? 0);
      if (sings(A)) c.m.heardA = true;
      // Both voices up at once, with deck B's mids still full: the clash to avoid.
      const both = sings(A) && sings(B) && audible(c, A) > 0.3 && audible(c, B) > 0.3;
      const last = (c.m.tick as number) ?? c.now;
      if (both && ch(c, B).mid > -6) c.m.clash = ((c.m.clash as number) ?? 0) + Math.min(0.5, c.now - last);
      if (both && ch(c, B).mid <= -10) c.m.ducked = true;
      c.m.tick = c.now;
    },
    steps: [
      {
        id: "play",
        title: "Play deck A and find the pink line",
        body: "The pink line along the top of the waveforms marks where the track has singing. MixIt hears it in the analysis.",
        controls: ["deck.A.play"],
        check: (c) => playing(c, A),
      },
      {
        id: "hear",
        title: "Listen as the singer comes in on deck A",
        body: "The voice starts on the first drop, right where the pink line begins.",
        check: (c) => !!c.m.heardA,
      },
      {
        id: "bring-in",
        title: "Sync deck B, start it and raise its fader",
        body: "Deck B sings too. When both voices play at once the words blur together, even though the keys fit.",
        controls: ["deck.B.sync", "deck.B.play", "mixer.B.fader"],
        check: (c) => !!tele(c, B)?.sync && playing(c, B) && audible(c, B) > 0.3,
      },
      {
        id: "duck",
        title: "While both sing, turn deck B's Mid down",
        body: "Voices live in the mids. Lowering deck B's Mid (to about -12 dB) moves its singer to the back while deck A's carries on. The coach suggests the same when it hears two voices.",
        controls: ["mixer.B.eq.mid"],
        check: (c) => !!c.m.ducked,
      },
      {
        id: "swap",
        title: "When deck A's vocal ends, bring B's Mid back and fade A out",
        body: "Wait for the end of deck A's pink line, then turn deck B's Mid back up and pull deck A down. Now deck B's singer has the floor.",
        controls: ["mixer.B.eq.mid", "mixer.A.fader"],
        check: (c) => playing(c, B) && ch(c, B).mid >= -3 && audible(c, A) < 0.1 && audible(c, B) > 0.4,
      },
    ],
    listen: "Only one voice at a time is clear and in front. The other track's music keeps going underneath.",
    mistake: "Letting both singers play at full level. The lab counts the seconds that happened; Mix it and Automix avoid it for you.",
  },
];

export function labById(id: string | null): Lab | undefined {
  return LABS.find((l) => l.id === id);
}
