// The Troubleshoot tab: common problems in plain words, what causes them and how to fix
// them. Rows with a `detect` check watch the mix and say when the problem is happening now.
import type { AudioStatus, DeckInfo, Telemetry } from "../backend/types";
import { compatibility, keyFromIndex, transpose } from "../lib/keys";
import type { MixerState } from "../store/app";

export interface FixCtx {
  t: Telemetry;
  decks: (DeckInfo | null)[];
  mixer: MixerState;
  audio: AudioStatus | null;
  count: number;
}

export interface Problem {
  id: string;
  symptom: string;
  cause: string;
  fix: string;
  /** Controls involved, for "Show me" (deck A's unless `detect` names a deck). */
  controls?: string[];
  /** Concept to read more about. */
  concept?: string;
  /** Returns the decks this is happening on now (empty or undefined when it is not). */
  detect?: (c: FixCtx) => number[] | undefined;
  /** Fills a deck letter into control ids: deck.{D}.keylock. */
  deckControls?: string[];
}

const L = (d: number) => String.fromCharCode(65 + d);
const idx = (c: FixCtx) => Array.from({ length: c.count }, (_, i) => i);

/** How much of a deck reaches the master (fader × crossfader side), 0..1. */
function level(c: FixCtx, d: number): number {
  if (!c.t.decks[d]?.playing) return 0;
  const x = c.mixer.crossfader;
  const side = c.mixer.assign[d] ?? (d % 2 === 0 ? 0 : 2);
  const xf = side === 1 ? 1 : side === 0 ? Math.min(1, 1 - x) : Math.min(1, 1 + x);
  return c.mixer.channels[d].fader * xf;
}

const audibleDecks = (c: FixCtx, min = 0.3) => idx(c).filter((d) => level(c, d) > min);

export const PROBLEMS: Problem[] = [
  {
    id: "mud",
    symptom: "The mix sounds muddy or boomy during a blend",
    cause: "Two basslines and two kicks are playing at full strength at the same time.",
    fix: "Turn the low EQ down on one deck while both play, then swap on a phrase line.",
    deckControls: ["mixer.{D}.eq.low"],
    concept: "bass-swap",
    detect: (c) => {
      const bassy = audibleDecks(c, 0.4).filter((d) => c.mixer.channels[d].low > -6 && !c.mixer.channels[d].kills[0]);
      return bassy.length >= 2 ? bassy : undefined;
    },
  },
  {
    id: "drift",
    symptom: "The kicks gallop or drift apart",
    cause: "The decks are at slightly different tempos, or one is a little ahead.",
    fix: "Turn on Sync, or nudge the deck back into place and adjust its tempo slider.",
    deckControls: ["deck.{D}.sync", "deck.{D}.nudge_down", "deck.{D}.nudge_up"],
    concept: "beatmatch",
    detect: (c) => {
      const playing = idx(c).filter((d) => c.t.decks[d]?.playing);
      if (playing.length < 2) return undefined;
      return playing.filter((d) => !c.t.decks[d].master && !c.t.decks[d].sync && Math.abs(c.t.decks[d].phase) > 0.08);
    },
  },
  {
    id: "chipmunk",
    symptom: "A track sounds higher-pitched, like it is sped up",
    cause: "Key lock is off and the tempo was changed, so the pitch moved with the speed.",
    fix: "Turn key lock on. The tempo stays, the pitch goes back to normal.",
    deckControls: ["deck.{D}.keylock", "deck.{D}.tempo"],
    concept: "keylock",
    detect: (c) => idx(c).filter((d) => c.t.decks[d]?.playing && !c.t.decks[d].keylock && Math.abs(c.t.decks[d].rate - 1) > 0.04),
  },
  {
    id: "clash",
    symptom: "Melodies sound sour or out of tune together",
    cause: "The two tracks are in keys that clash.",
    fix: "Press Match key on the new deck, or pick a track the suggestions list marks as a good key match.",
    deckControls: ["deck.{D}.key_sync"],
    concept: "key",
    detect: (c) => {
      const both = audibleDecks(c);
      if (both.length < 2) return undefined;
      const [a, b] = both;
      const ka = c.decks[a]?.detail.key;
      const kb = c.decks[b]?.detail.key;
      if (!ka || !kb) return undefined;
      const r = compatibility(transpose(keyFromIndex(ka.index), c.t.decks[a].keyShift), transpose(keyFromIndex(kb.index), c.t.decks[b].keyShift));
      if (r !== "clash" && r !== "shift") return undefined;
      return [c.t.decks[a].master ? b : a];
    },
  },
  {
    id: "loud",
    symptom: "The sound is harsh, flat or distorted",
    cause: "The mix is too loud, and the limiter at the end is squashing it to stop it clipping.",
    fix: "Lower the gain on the loudest channel, or the master. Turn the speakers up instead of the mix.",
    controls: ["mixer.master", "mixer.A.trim", "mixer.B.trim"],
    concept: "clipping",
    detect: (c) => (c.t.master.limiterGrDb < -3 || c.t.master.clipped ? [] : undefined),
  },
  {
    id: "thin",
    symptom: "A track sounds thin, muffled or far away",
    cause: "Its filter is turned, or one of its EQ bands is cut.",
    fix: "Centre the filter (double-click it) and bring the EQ knobs back to the middle.",
    deckControls: ["mixer.{D}.filter", "mixer.{D}.eq.low", "mixer.{D}.eq.high"],
    concept: "filter",
    detect: (c) => {
      const on = audibleDecks(c, 0.5);
      if (on.length !== 1) return undefined;
      const ch = c.mixer.channels[on[0]];
      const off = Math.abs(ch.filter) > 0.3 || ch.low < -15 || ch.high < -15 || ch.kills.some(Boolean);
      return off ? on : undefined;
    },
  },
  {
    id: "fx-left-on",
    symptom: "A new track starts drenched in echo or reverb",
    cause: "An effect was left switched on from the last transition.",
    fix: "Switch the deck's effects off before the next track starts on it.",
    deckControls: ["fx.{D}.1.on", "fx.{D}.2.on", "fx.{D}.3.on"],
    concept: "fx",
    detect: (c) => idx(c).filter((d) => c.t.decks[d]?.loaded && !c.t.decks[d].playing && c.mixer.fx[d]?.some((f) => f.on)),
  },
  {
    id: "slip",
    symptom: "A hot cue or loop does not stay; the track jumps back",
    cause: "Slip mode is on, so the track returns to where it would have been.",
    fix: "Turn Slip off when you want jumps and loops to really move the track.",
    deckControls: ["deck.{D}.slip"],
    concept: "slip",
    detect: (c) => idx(c).filter((d) => c.t.decks[d]?.slip && c.t.decks[d].playing),
  },
  {
    id: "grid",
    symptom: "Sync gets it wrong, or beat lines fall between the kicks",
    cause: "The beatgrid has the wrong tempo (double or half) or starts on the wrong beat.",
    fix: "In the deck's Grid tab, use Double or Half tempo, and Set downbeat on a strong first beat.",
    deckControls: ["deck.{D}.grid.double", "deck.{D}.grid.halve", "deck.{D}.grid.set_downbeat"],
    concept: "beatgrid",
    detect: (c) => idx(c).filter((d) => c.t.decks[d]?.loaded && c.decks[d] && !c.decks[d]!.detail.analysed),
  },
  {
    id: "no-audio",
    symptom: "There is no sound at all",
    cause: "No audio device is selected, or the one in use was unplugged.",
    fix: "Open Settings, then Audio, and pick your speakers or controller.",
    controls: ["app.settings"],
    detect: (c) => (c.audio?.isVirtual ? [] : undefined),
  },
  {
    id: "dropouts",
    symptom: "Crackles, pops or short dropouts",
    cause: "The computer cannot fill the audio buffer in time.",
    fix: "In Settings, Audio, choose a larger buffer size. Close heavy apps. On laptops, plug in the charger.",
    controls: ["app.settings"],
    detect: (c) => (c.t.overruns > 0 || c.t.load > 0.85 ? [] : undefined),
  },
  {
    id: "headphones",
    symptom: "Nothing comes out of the headphones",
    cause: "No channel's headphone cue is on, or the headphone output is not set.",
    fix: "Press the headphone button on the channel you want to hear, and pick a headphone output in Settings.",
    deckControls: ["mixer.{D}.cue"],
    controls: ["mixer.headphones", "mixer.cue_mix"],
    concept: "cue",
  },
  {
    id: "jumpy-volume",
    symptom: "The new track is much louder or quieter than the old one",
    cause: "The tracks were mastered at different loudness.",
    fix: "Match the channel meters with Gain. Auto gain in Settings does it for you when tracks load.",
    deckControls: ["mixer.{D}.trim"],
    concept: "gain",
  },
  {
    id: "off-phrase",
    symptom: "The transition feels random, even though the beats match",
    cause: "The new track came in in the middle of a phrase.",
    fix: "Start it on a red phrase line in the waveform. Set a hot cue at its first beat so you can restart it cleanly.",
    deckControls: ["deck.{D}.hotcue.1", "deck.{D}.play"],
    concept: "phrase",
  },
];

/** Controls for a problem, with deck letters filled in. */
export function problemControls(p: Problem, decks: number[]): string[] {
  const ds = decks.length ? decks : [0];
  const fromDeck = (p.deckControls ?? []).flatMap((id) => ds.map((d) => id.replace("{D}", L(d))));
  return [...fromDeck, ...(p.controls ?? [])];
}

/** Problems happening now, with the decks they affect. */
export function detectProblems(c: FixCtx): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const p of PROBLEMS) {
    try {
      const r = p.detect?.(c);
      if (r && (r.length > 0 || p.deckControls === undefined)) out.set(p.id, r);
    } catch {
      // A check that cannot run (deck not ready) reports nothing.
    }
  }
  return out;
}

export function deckList(decks: number[]): string {
  return decks.map(L).join(" and ");
}
