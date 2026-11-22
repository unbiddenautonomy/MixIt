// The coach: plain-language tips from what is happening on the decks, each with a
// one-click fix where there is one.
import type { DeckInfo, Telemetry } from "../backend/types";
import type { MixerState } from "../store/app";
import { compatibility, keyFromIndex, transpose } from "./keys";
import { clock } from "./format";

export interface Tip {
  id: string;
  level: "info" | "warn" | "good";
  text: string;
  action?: { label: string; run: string; arg?: number[] };
}

const L = (d: number) => String.fromCharCode(65 + d);

/** Whether a deck is in one of its track's vocal parts at `seconds` (with a little lead-in). */
export function singingAt(d: DeckInfo | null | undefined, seconds: number, ahead = 0): boolean {
  return !!d?.detail.vocals?.some(([a, b]) => seconds >= a - ahead && seconds < b);
}

/** `setLeft`: seconds left in the set when a set clock runs (see setClock.ts). */
export function coachTips(t: Telemetry, decks: (DeckInfo | null)[], mixer: MixerState, count: number, setLeft: number | null = null): Tip[] {
  const tips: Tip[] = [];
  const idx = Array.from({ length: count }, (_, i) => i);
  const loaded = idx.filter((i) => t.decks[i]?.loaded && decks[i]);
  const playing = idx.filter((i) => t.decks[i]?.playing);
  if (loaded.length === 0) {
    tips.push({ id: "load", level: "info", text: "Start by loading a track: double-click one in the library, or drag it onto a deck." });
    return tips;
  }
  if (playing.length === 0) {
    const d = loaded[0];
    tips.push({ id: "play", level: "info", text: `Press Play on deck ${L(d)} to start your mix.`, action: { label: "Play", run: `deck.${L(d)}.play` } });
    return tips;
  }
  const cur = playing.find((i) => t.decks[i].master) ?? playing[0];
  const curTele = t.decks[cur];
  const others = idx.filter((i) => i !== cur);
  const next = others.find((i) => t.decks[i].loaded && !t.decks[i].playing);
  if (next === undefined && others.every((i) => !t.decks[i].loaded)) {
    const target = others[0];
    tips.push({ id: "pick", level: "info", text: `Pick the next track for deck ${L(target)}: the suggestions show what fits ${decks[cur]?.detail.track.title ?? "this track"}.`, action: { label: "Show suggestions", run: "app.suggest" } });
  }
  if (next !== undefined) {
    const nt = t.decks[next];
    const n = L(next);
    if (!nt.sync && Math.abs(nt.bpm - curTele.bpm) > 0.05 && curTele.bpm > 0 && nt.baseBpm > 0) {
      tips.push({
        id: "sync",
        level: "warn",
        text: `Deck ${n} runs at ${nt.bpm.toFixed(1)} BPM, deck ${L(cur)} at ${curTele.bpm.toFixed(1)}. Turn on Sync so the beats line up.`,
        action: { label: `Sync ${n}`, run: `deck.${n}.sync` },
      });
    }
    const ka = decks[cur]?.detail.key;
    const kb = decks[next]?.detail.key;
    if (ka && kb) {
      const a = transpose(keyFromIndex(ka.index), curTele.keyShift);
      const b = transpose(keyFromIndex(kb.index), nt.keyShift);
      const c = compatibility(a, b);
      if (c === "clash" || c === "shift") {
        tips.push({ id: "key", level: "warn", text: `The keys clash (${ka.camelot} and ${kb.camelot}). Match key shifts deck ${n} to fit, with key lock.`, action: { label: "Match key", run: `deck.${n}.key_sync` } });
      } else if (c === "same" || c === "match") {
        tips.push({ id: "keyok", level: "good", text: `Keys ${ka.camelot} and ${kb.camelot} fit together: this will sound smooth.` });
      }
    }
    const phraseBeats = 32;
    const toPhrase = phraseBeats - (((curTele.beat % phraseBeats) + phraseBeats) % phraseBeats);
    if (nt.sync && toPhrase <= 8 && toPhrase > 0) {
      tips.push({ id: "phrase", level: "info", text: `A new phrase starts in ${Math.ceil(toPhrase)} beats: a natural moment to bring in deck ${n}.`, action: { label: "Mix it", run: "app.transition", arg: [cur, next] } });
    }
    if (curTele.remaining > 0 && curTele.remaining < 45) {
      tips.push({ id: "ending", level: "warn", text: `Deck ${L(cur)} ends in ${clock(curTele.remaining)}. Start the transition now.`, action: { label: "Mix it", run: "app.transition", arg: [cur, next] } });
    }
  } else if (curTele.remaining > 0 && curTele.remaining < 60 && others.every((i) => !t.decks[i].loaded)) {
    tips.push({ id: "ending-empty", level: "warn", text: `Deck ${L(cur)} ends in ${clock(curTele.remaining)} and nothing is loaded next.`, action: { label: "Show suggestions", run: "app.suggest" } });
  }
  if (playing.length >= 2) {
    const audible = playing.filter((i) => mixer.channels[i].fader > 0.3);
    const bassy = audible.filter((i) => mixer.channels[i].low > -8 && !mixer.channels[i].kills[0]);
    if (bassy.length >= 2) {
      const quiet = bassy.find((i) => !t.decks[i].master) ?? bassy[1];
      tips.push({ id: "bass", level: "warn", text: `Two basslines at once sound muddy. Cut the low EQ on deck ${L(quiet)}.`, action: { label: `Cut bass ${L(quiet)}`, run: `bass-cut`, arg: [quiet] } });
    }
    // Two voices at once: the words clash even when the keys fit.
    const singing = audible.filter((i) => singingAt(decks[i], t.decks[i].position, 0.5) && mixer.channels[i].mid > -10);
    if (singing.length >= 2) {
      const quiet = singing.find((i) => !t.decks[i].master) ?? singing[1];
      tips.push({ id: "vocals", level: "warn", text: `Both tracks have singing right now, and two voices at once are hard to follow. Lower the mids on deck ${L(quiet)}, or bring it in after this vocal.`, action: { label: `Lower mids ${L(quiet)}`, run: "mid-cut", arg: [quiet] } });
    }
    const unsynced = playing.filter((i) => !t.decks[i].master && !t.decks[i].sync && Math.abs(t.decks[i].phase) > 0.08);
    for (const i of unsynced) {
      tips.push({ id: `phase-${i}`, level: "warn", text: `The beats on deck ${L(i)} drift from the master. Nudge it, or turn on Sync.`, action: { label: `Sync ${L(i)}`, run: `deck.${L(i)}.sync` } });
    }
  }
  // The set clock: the track playing or the next one runs past the end of the set.
  if (setLeft != null && setLeft > 0) {
    if (curTele.remaining > setLeft + 15) {
      tips.push({ id: "set-end", level: "warn", text: `Your set ends in ${clock(setLeft)}, before deck ${L(cur)} does (${clock(curTele.remaining)} left). Mix out early, or fade it out at the end.` });
    } else if (next !== undefined) {
      const after = setLeft - curTele.remaining;
      const nextLen = t.decks[next].remaining;
      if (after > 0 && nextLen > after + 30) {
        tips.push({ id: "set-fit", level: "info", text: `After this track there are ${clock(after)} of your set left, and deck ${L(next)} runs ${clock(nextLen)}. Mix it in early or pick a shorter track.` });
      }
    }
  }
  if (t.master.limiterGrDb < -3) {
    tips.push({ id: "hot", level: "warn", text: `The mix is too loud and the limiter is squashing it (${t.master.limiterGrDb.toFixed(1)} dB). Lower a channel's gain or the master.` });
  }
  return tips.slice(0, 3);
}
