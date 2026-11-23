// Auto DJ planning: given the track that is playing and the one that comes next, decide
// where the mix starts, how long it lasts, which transition to use and whether to shift
// the key, and say why in plain words. Pure functions, so every decision is testable;
// `store/autodj.ts` carries the plan out on the live decks.
import type { KeyDto, TrackDetail } from "../backend/types";
import { bestShift, compatibility, keyFromIndex } from "./keys";
import type { TransitionId } from "./transition";
import { vocalClearStart } from "./vocalTiming";

/** Transition lengths Auto DJ picks from, longest first. */
export const LENGTHS = [64, 32, 16, 8];

export type Style = "auto" | TransitionId;

export interface PlanOptions {
  style: Style;
  /** Beats, or "auto" to fit the music. */
  length: "auto" | number;
  /** Shift the incoming key (with key lock) when the keys clash. */
  keyMatch: boolean;
  /** Loop the end of a track that runs out too soon after its mix-out point, so the mix
   * still gets its full length (default on). */
  extend?: boolean;
}

export const DEFAULT_OPTIONS: PlanOptions = { style: "auto", length: "auto", keyMatch: true, extend: true };

/** Loop lengths Auto DJ uses to stretch a short ending, longest first. */
export const LOOP_LENGTHS = [16, 8];

export interface MixPlan {
  kind: TransitionId;
  /** Length in beats (0 for a cut). */
  beats: number;
  /** Beat on the outgoing deck's grid where the transition starts (top of a phrase). */
  outStartBeat: number;
  outStartSeconds: number;
  /** Where the incoming deck starts playing (seconds). */
  inCueSeconds: number;
  /** Tempo change the incoming track gets when it syncs (percent). */
  tempoChangePct: number;
  /** Semitones to shift the incoming key, or 0. */
  keyShift: number;
  /** Beats of the outgoing track that loop from the start of the transition, so a track
   * that ends soon still gets a full-length mix (0: no loop). */
  loopBeats: number;
  /** Whether the incoming track syncs to the outgoing tempo (not across a big gap with
   * an echo out, cut or brake: it plays at its own tempo instead). */
  sync: boolean;
  /** Short name, e.g. "Bass swap over 32 beats". */
  summary: string;
  /** Why, in plain words, one sentence each. */
  reasons: string[];
}

const NAMES: Record<TransitionId, string> = {
  blend: "Blend",
  bassSwap: "Bass swap",
  filterFade: "Filter fade",
  echoOut: "Echo out",
  cut: "Cut",
  brake: "Brake",
};

export const transitionName = (k: TransitionId) => NAMES[k];

const bpbOf = (d: TrackDetail) => d.beatsPerBar || 4;

/** The grid beat (as the deck counts it, 0 at the first downbeat) at a time. */
export function beatAtSeconds(d: TrackDetail, t: number): number {
  const period = d.beatPeriod > 0 ? d.beatPeriod : 0.5;
  if (d.constantGrid || d.beats.length < 2) return (t - d.firstBeat) / period;
  const b = d.beats;
  const zero = nearestIndex(b, d.firstBeat);
  if (t <= b[0]) return (t - b[0]) / (b[1] - b[0]) - zero;
  if (t >= b[b.length - 1]) return b.length - 1 - zero + (t - b[b.length - 1]) / (b[b.length - 1] - b[b.length - 2]);
  let lo = 0;
  let hi = b.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (b[m] <= t) lo = m;
    else hi = m;
  }
  return lo + (t - b[lo]) / (b[hi] - b[lo]) - zero;
}

/** The time of a grid beat (inverse of `beatAtSeconds`). */
export function secondsAtBeat(d: TrackDetail, beat: number): number {
  const period = d.beatPeriod > 0 ? d.beatPeriod : 0.5;
  if (d.constantGrid || d.beats.length < 2) return d.firstBeat + beat * period;
  const b = d.beats;
  const i = beat + nearestIndex(b, d.firstBeat);
  if (i <= 0) return b[0] + i * (b[1] - b[0]);
  if (i >= b.length - 1) return b[b.length - 1] + (i - b.length + 1) * (b[b.length - 1] - b[b.length - 2]);
  const k = Math.floor(i);
  return b[k] + (i - k) * (b[k + 1] - b[k]);
}

function nearestIndex(xs: number[], v: number): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - v) < Math.abs(xs[best] - v)) best = i;
  return best;
}

const cue = (d: TrackDetail, role: "mixIn" | "mixOut") => d.cues.find((c) => c.role === role)?.seconds ?? null;
const isLabel = (label: string, name: string) => label.toLowerCase().replace(/[^a-z]/g, "") === name;

/** Where the incoming track should start: its mix-in cue, else its first downbeat. */
export function inCue(d: TrackDetail): number {
  const c = cue(d, "mixIn") ?? d.firstBeat;
  return Math.max(0, c);
}

/** Beats of calm intro the incoming track has from its cue (where the main part starts). */
export function introBeats(d: TrackDetail): number {
  const from = inCue(d);
  const main = d.sections.find((s) => s.start > from + 1 && !isLabel(s.label, "intro"));
  if (!main) return 32;
  return Math.max(0, Math.round(beatAtSeconds(d, main.start) - beatAtSeconds(d, from)));
}

/** Where the outgoing track wants to be mixed out (seconds): its mix-out cue, the start
 * of its outro, or a minute before the music ends. */
export function mixOutPoint(d: TrackDetail): number {
  const c = cue(d, "mixOut");
  if (c !== null) return c;
  const outro = [...d.sections].reverse().find((s) => isLabel(s.label, "outro"));
  if (outro) return outro.start;
  return Math.max(0, d.audible[1] - 60);
}

/** Whether the track ends with a calm outro to mix over (rather than stopping at full power). */
export function hasOutro(d: TrackDetail): boolean {
  const last = d.sections[d.sections.length - 1];
  if (!last) return true;
  return isLabel(last.label, "outro") || last.energy < 0.5;
}

const tempoRatio = (from: number, to: number) => {
  // Half and double time mix fine: compare in the nearest octave.
  let r = from / to;
  while (r > 1.5) r /= 2;
  while (r < 0.75) r *= 2;
  return r;
};

/** Semitones the incoming key needs (0 when the keys already work or there is no key). */
export function keyMove(out: KeyDto | null, inc: KeyDto | null): { compat: ReturnType<typeof compatibility> | null; shift: number | null } {
  if (!out || !inc) return { compat: null, shift: 0 };
  const a = keyFromIndex(out.index);
  const b = keyFromIndex(inc.index);
  const compat = compatibility(a, b);
  if (compat === "same" || compat === "match" || compat === "boost") return { compat, shift: 0 };
  return { compat, shift: bestShift(b, a, 2) };
}

/**
 * The plan for mixing from `out` into `inc`. `nowBeat` is where the outgoing deck is
 * now; the mix never starts before it.
 */
export function planMix(out: TrackDetail, inc: TrackDetail, opts: PlanOptions = DEFAULT_OPTIONS, nowBeat = -Infinity): MixPlan {
  const reasons: string[] = [];
  const bpb = bpbOf(out);
  const phrase = bpb * 8;
  const endBeat = beatAtSeconds(out, out.audible[1]);
  const outBpm = out.bpm ?? 120;
  const inBpm = inc.bpm ?? outBpm;
  const ratio = tempoRatio(outBpm, inBpm);
  const tempoChangePct = !out.bpm || !inc.bpm ? 0 : Math.round((ratio - 1) * 1000) / 10;
  // A track without a measured tempo (not analysed yet) can't be synced: treat the gap as
  // far, so it comes in at its own speed after an echo.
  const unknownTempo = !out.bpm || !inc.bpm;
  const farTempo = unknownTempo || Math.abs(tempoChangePct) > 8;

  // Keys.
  const km = keyMove(out.key, inc.key);
  let keyShift = 0;
  let keyClash = false;
  if (km.compat === "same" || km.compat === "match") reasons.push(`The keys fit together (${out.key!.camelot} and ${inc.key!.camelot}), so the melodies blend without clashing.`);
  else if (km.compat === "boost") reasons.push(`${inc.key!.camelot} is two steps up from ${out.key!.camelot}: an energy boost that still sounds musical.`);
  else if (km.compat) {
    if (opts.keyMatch && km.shift !== null && km.shift !== 0) {
      keyShift = km.shift;
      reasons.push(`The keys clash (${out.key!.camelot} and ${inc.key!.camelot}), so the next track is shifted ${keyShift > 0 ? "up" : "down"} ${Math.abs(keyShift)} semitone${Math.abs(keyShift) > 1 ? "s" : ""} with key lock to fit.`);
    } else {
      keyClash = true;
      reasons.push(`The keys clash (${out.key!.camelot} and ${inc.key!.camelot}), so the tracks overlap only briefly.`);
    }
  }

  // How much music is left after the mix-out point.
  const mixOutBeat = beatAtSeconds(out, mixOutPoint(out));
  const startCandidate = Math.max(Math.round(mixOutBeat / phrase) * phrase, 0);
  const room = Math.max(bpb, endBeat - startCandidate - bpb);
  const extend = opts.extend !== false;

  // Transition type.
  let kind: TransitionId;
  if (opts.style !== "auto") {
    kind = opts.style;
  } else if (unknownTempo) {
    kind = "echoOut";
    reasons.push(`${!inc.bpm ? inc.track.title : out.track.title} has not been analysed yet, so its tempo is unknown: the old track echoes out and the new one comes in at its own speed.`);
  } else if (farTempo) {
    kind = "echoOut";
    reasons.push(`The tempos are far apart (${Math.round(outBpm)} and ${Math.round(inBpm)} BPM), so the old track echoes out instead of both playing at a stretched tempo.`);
  } else if (!hasOutro(out) && room < (extend ? 8 : 16)) {
    kind = "echoOut";
    reasons.push("The track stops at full power right after the mix-out point, so an echo carries it out.");
  } else if (keyClash) {
    kind = "filterFade";
    reasons.push("A filter fade thins both tracks while they overlap, which hides the key clash.");
  } else if ((out.energy ?? 5) >= 6 && (inc.energy ?? 5) >= 6) {
    kind = "bassSwap";
    reasons.push("Both tracks have strong bass, so only one carries it at a time: the bass swaps over on a phrase.");
  } else if ((inc.energy ?? 5) <= (out.energy ?? 5) - 3) {
    kind = "filterFade";
    reasons.push("The next track is much calmer, so a filter fade lets the energy come down gently.");
  } else {
    kind = "blend";
    reasons.push("The tracks sit well together, so a long, smooth blend works.");
  }
  if (Math.abs(tempoChangePct) > 0.3 && !farTempo && kind !== "echoOut" && kind !== "cut" && kind !== "brake")
    reasons.push(`The next track is synced from ${Math.round(inBpm * 10) / 10} to ${Math.round(outBpm * 10) / 10} BPM (${tempoChangePct > 0 ? "+" : ""}${tempoChangePct}%) so the beats line up.`);

  // Length: what the music allows, or with a loop on the outgoing track's last bars.
  let beats: number;
  let loopBeats = 0;
  if (kind === "cut") beats = 0;
  else if (kind === "brake") beats = 4;
  else if (kind === "echoOut") beats = typeof opts.length === "number" ? Math.min(opts.length, 16) : 8;
  else {
    const intro = introBeats(inc);
    const want = typeof opts.length === "number" ? opts.length : keyClash ? 16 : 32 + (intro >= 64 && kind === "blend" ? 32 : 0);
    const loop = extend && room < Math.min(want, 32) ? (LOOP_LENGTHS.find((l) => l <= room) ?? 0) : 0;
    if (loop) {
      loopBeats = loop;
      beats = Math.min(want, 32);
      reasons.push(`The track ends ${Math.round(room + bpb)} beats after its mix-out point, so its last ${loop} beats loop while the next track comes in: a full ${beats}-beat mix instead of a rushed one.`);
    } else {
      beats = LENGTHS.find((l) => l <= want && l <= room) ?? 8;
      if (typeof opts.length !== "number" && beats < want) reasons.push(`There is room for ${beats} beats before the track ends (a ${want}-beat mix would run past it).`);
    }
  }

  // Start: the top of a phrase near the mix-out point, early enough to finish before the
  // music ends, and never in the past.
  // With a loop, only the looped beats have to fit before the end.
  const fit = () => loopBeats || Math.max(beats, bpb);
  let start = startCandidate;
  while (start > 0 && start + fit() > endBeat) start -= bpb;
  start = Math.max(0, start);
  if (start <= nowBeat + 0.25) {
    // Too late for the planned point: the next bar (or phrase when there is room).
    const nextPhrase = Math.ceil((nowBeat + 0.25) / phrase) * phrase;
    const nextBar = Math.ceil((nowBeat + 0.25) / bpb) * bpb;
    start = nextPhrase + fit() <= endBeat ? nextPhrase : nextBar;
    // Too late for the loop too: an ordinary mix of what is left.
    if (loopBeats && start + loopBeats > endBeat) {
      loopBeats = 0;
      beats = LENGTHS.find((l) => l <= Math.max(0, endBeat - start)) ?? bpb;
    }
  }
  // Not over the middle of a sung line: move to the nearest clear phrase (or bar) when one
  // is close, earlier or later.
  const clear = vocalClearStart({
    regions: out.vocals,
    secondsAt: (b) => secondsAtBeat(out, b),
    candidate: start,
    beats: loopBeats || beats,
    beatsPerBar: bpb,
    endBeat,
    earliest: nowBeat + 0.25,
  });
  if (clear.moved) {
    const bars = Math.round(Math.abs(clear.start - start) / bpb);
    reasons.push(
      `The current track is singing at the planned point, so the mix moves ${bars} bar${bars === 1 ? "" : "s"} ${clear.start > start ? "later" : "earlier"}, where it doesn't cut into a sung line.`,
    );
    start = clear.start;
  }

  const sync = !(farTempo && (kind === "echoOut" || kind === "cut" || kind === "brake"));
  if (!sync) reasons.push(unknownTempo ? "The next track keeps its own tempo." : `The next track keeps its own tempo of ${Math.round(inBpm)} BPM.`);
  const summary = kind === "cut" ? "Cut on the bar" : kind === "brake" ? "Brake stop" : `${NAMES[kind]} over ${beats} beats${loopBeats ? `, looping the last ${loopBeats}` : ""}`;
  return {
    kind,
    beats,
    outStartBeat: start,
    outStartSeconds: secondsAtBeat(out, start),
    inCueSeconds: inCue(inc),
    tempoChangePct,
    keyShift,
    loopBeats,
    sync,
    summary,
    reasons,
  };
}

/** "1:05" for a number of seconds (never negative). */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
