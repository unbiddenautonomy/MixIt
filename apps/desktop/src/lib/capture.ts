// Records a live mix as an editable Arrange project. While Rec is on, the decks' play
// state and beat positions (from telemetry) and the mixer and effect settings (from the
// store, since the engine does not report them back) are sampled about 20 times a second.
// `buildProject` turns those frames into clips on a beat timeline with automation, so a
// late transition or a clumsy fade can be fixed afterwards instead of mixing again.

import type { AutomationLane, AutomationPoint, Clip, MixProject, ProjectParam, Telemetry, TrackRef } from "../backend/types";
import type { ChannelState, FxSlot, MixerState } from "../store/app";

export const FX_BEAT_VALUES = [0.0625, 0.125, 0.25, 0.5, 0.75, 1, 2, 4, 8, 16];
/** Frames per second kept while capturing. */
export const CAPTURE_RATE = 20;

export interface DeckFrame {
  token: number;
  playing: boolean;
  /** Track grid beat. */
  beat: number;
  /** Effective tempo (BPM) the deck plays at. */
  bpm: number;
  keylock: boolean;
  keyShift: number;
  /** Channel volume 0..1, with the crossfader folded in. */
  volume: number;
  low: number;
  mid: number;
  high: number;
  filter: number;
  trim: number;
  /** Effect wet amount (0 when no effect is on) and which one. */
  fxMix: number;
  fxKind: number;
  fxBeats: number;
  /** Studio pan and the reverb and echo sends (missing in older captures). */
  pan?: number;
  space?: number;
  echo?: number;
}

export interface CaptureFrame {
  /** Seconds since capture started (engine clock). */
  t: number;
  clockBpm: number;
  decks: (DeckFrame | null)[];
  /** The master output, for the feedback report. */
  master?: { peak: number; clipped: boolean; limiterDb: number; lufs: number };
}

export interface Capture {
  name: string;
  frames: CaptureFrame[];
  /** What each deck load token played. */
  tracks: Record<number, TrackRef>;
}

// ---------------------------------------------------------------- sampling

/** Crossfader gain for a channel: assign 0 = side A, 1 = thru, 2 = side B. */
export function crossfaderGain(x: number, assign: number, reverse: boolean): number {
  if (assign === 1) return 1;
  const pos = reverse ? -x : x;
  return assign === 0 ? Math.max(0, Math.min(1, 1 - pos)) : Math.max(0, Math.min(1, 1 + pos));
}

function fxOf(slots: FxSlot[] | undefined): { mix: number; kind: number; beats: number } {
  const on = slots?.find((s) => s.on && s.type > 0);
  return on ? { mix: on.mix, kind: on.type, beats: FX_BEAT_VALUES[on.beats] ?? 1 } : { mix: 0, kind: 0, beats: 1 };
}

/** One frame from telemetry and the mixer store. */
export function sampleFrame(t: number, tele: Telemetry, mixer: MixerState): CaptureFrame {
  return {
    t,
    clockBpm: tele.clockBpm,
    master: { peak: Math.max(tele.master.peak[0], tele.master.peak[1]), clipped: tele.master.clipped, limiterDb: tele.master.limiterGrDb, lufs: tele.master.momentaryLufs },
    decks: tele.decks.map((d, i) => {
      if (!d.loaded) return null;
      const c: ChannelState = mixer.channels[i];
      const fx = fxOf(mixer.fx[i]);
      return {
        token: d.token,
        playing: d.playing,
        beat: d.beat,
        bpm: d.bpm,
        keylock: d.keylock,
        keyShift: d.keyShift,
        volume: c.fader * crossfaderGain(mixer.crossfader, mixer.assign[i] ?? (i % 2 === 0 ? 0 : 2), mixer.crossfaderReverse),
        low: c.kills[0] ? -26 : c.low,
        mid: c.kills[1] ? -26 : c.mid,
        high: c.kills[2] ? -26 : c.high,
        filter: c.filter,
        trim: c.trim,
        fxMix: fx.mix,
        fxKind: fx.kind,
        fxBeats: fx.beats,
        pan: c.pan,
        space: c.space,
        echo: c.echo,
      };
    }),
  };
}

// ---------------------------------------------------------------- building the project

/** Beat jumps smaller than this (short loop rolls) are not split into clips. */
const MIN_JUMP_BEATS = 1;
/** Clips shorter than this (a scratch, a stab) are dropped. */
const MIN_CLIP_BEATS = 0.5;
/** Quieter than this, a deck counts as not heard (cueing in the headphones). */
const AUDIBLE = 0.01;
const TOLERANCE: Record<ProjectParam, number> = { Volume: 0.02, EqLow: 0.5, EqMid: 0.5, EqHigh: 0.5, Filter: 0.02, FxMix: 0.02, Pan: 0.02, Space: 0.02, Echo: 0.02 };
const DEFAULTS: Record<ProjectParam, number> = { Volume: 1, EqLow: 0, EqMid: 0, EqHigh: 0, Filter: 0, FxMix: 0, Pan: 0, Space: 0, Echo: 0 };

interface Run {
  deck: number;
  token: number;
  /** Frame indices, inclusive. */
  from: number;
  to: number;
}

/** Consecutive frames where a deck plays one track without jumping. */
function runs(frames: CaptureFrame[], deck: number): Run[] {
  const out: Run[] = [];
  let cur: Run | null = null;
  for (let i = 0; i < frames.length; i++) {
    const d = frames[i].decks[deck];
    const prev = i > 0 ? frames[i - 1].decks[deck] : null;
    const playing = !!d && d.playing;
    let continues = !!cur && playing && !!prev && prev.playing && prev.token === d!.token;
    if (continues) {
      const dt = frames[i].t - frames[i - 1].t;
      const expected = ((prev!.bpm + d!.bpm) / 2 / 60) * dt;
      if (Math.abs(d!.beat - prev!.beat - expected) >= MIN_JUMP_BEATS) continues = false;
    }
    if (continues) cur!.to = i;
    else {
      if (cur) out.push(cur);
      cur = playing ? { deck, token: d!.token, from: i, to: i } : null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Keeps the points needed to redraw a sampled curve within `tol` (Douglas–Peucker). */
export function simplify(pts: { beat: number; value: number }[], tol: number): { beat: number; value: number }[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let err = tol;
    for (let i = a + 1; i < b; i++) {
      const f = (pts[i].beat - pts[a].beat) / Math.max(1e-9, pts[b].beat - pts[a].beat);
      const e = Math.abs(pts[i].value - (pts[a].value + (pts[b].value - pts[a].value) * f));
      if (e > err) {
        err = e;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function mode<T>(xs: T[]): T {
  const n = new Map<T, number>();
  let best = xs[0];
  for (const x of xs) {
    const c = (n.get(x) ?? 0) + 1;
    n.set(x, c);
    if (c > (n.get(best) ?? 0)) best = x;
  }
  return best;
}

/** Tempo segments from the clock: a new step wherever the tempo moves by 0.05 BPM.
 * Frames before beat 0 (before the lead-in) set the starting tempo. */
export function tempoSegments(beats: number[], frames: CaptureFrame[]) {
  const segs: { start_beat: number; bpm: number; end_bpm: number }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const bpm = Math.round(frames[i].clockBpm * 100) / 100;
    const at = Math.max(0, round(beats[i]));
    const last = segs[segs.length - 1];
    if (last && at <= last.start_beat) {
      last.bpm = last.end_bpm = bpm;
      continue;
    }
    if (!last || Math.abs(last.bpm - bpm) >= 0.05) segs.push({ start_beat: at, bpm, end_bpm: bpm });
  }
  if (!segs.length) return [{ start_beat: 0, bpm: 120, end_bpm: 120 }];
  segs[0].start_beat = 0;
  return segs;
}

/**
 * Turns a capture into a project. The timeline follows the master clock; each stretch a
 * deck played without jumping becomes a clip (beat-matched to the clock, as a synced deck
 * would be), trimmed to where it was heard, with automation for volume, EQ, filter and
 * effect. Returns null when nothing was heard.
 */
export function buildProject(cap: Capture): MixProject | null {
  const f = cap.frames;
  if (f.length < 2) return null;
  // Timeline beat of every frame, integrating the clock tempo.
  const beat: number[] = [0];
  for (let i = 1; i < f.length; i++) beat.push(beat[i - 1] + ((f[i - 1].clockBpm + f[i].clockBpm) / 2 / 60) * (f[i].t - f[i - 1].t));

  type Draft = { run: Run; from: number; to: number };
  const drafts: Draft[] = [];
  const decks = Math.max(...f.map((x) => x.decks.length));
  for (let d = 0; d < decks; d++) {
    for (const r of runs(f, d)) {
      // Trim to where the deck was heard.
      let a = r.from;
      let b = r.to;
      while (a <= b && f[a].decks[d]!.volume < AUDIBLE) a++;
      while (b >= a && f[b].decks[d]!.volume < AUDIBLE) b--;
      if (a > b || !cap.tracks[r.token]) continue;
      // Extend to the next frame so consecutive clips meet without a gap.
      const end = Math.min(b + 1, r.to + (r.to + 1 < f.length ? 1 : 0));
      if (beat[end] - beat[a] < MIN_CLIP_BEATS && end - a < 2) continue;
      drafts.push({ run: r, from: a, to: end });
    }
  }
  if (!drafts.length) return null;
  drafts.sort((x, y) => x.from - y.from);

  // Shift the timeline so the first clip starts on beat 4 to 8 with its bars on the
  // project's bars (a bar of lead-in before it).
  const first = drafts[0];
  const fd = f[first.from].decks[first.run.deck]!;
  const offset = 4 + (((fd.beat % 4) + 4) % 4) - beat[first.from];
  const T = (i: number) => beat[i] + offset;

  const clips: Clip[] = drafts.map((dr, k) => {
    const d = dr.run.deck;
    const span = f.slice(dr.from, dr.to + 1).map((x) => x.decks[d]);
    const live = span.filter((x): x is DeckFrame => !!x);
    const head = live[0];
    const lanes: AutomationLane[] = [];
    const series: [ProjectParam, (x: DeckFrame) => number][] = [
      ["Volume", (x) => x.volume],
      ["EqLow", (x) => x.low],
      ["EqMid", (x) => x.mid],
      ["EqHigh", (x) => x.high],
      ["Filter", (x) => x.filter],
      ["FxMix", (x) => x.fxMix],
      ["Pan", (x) => x.pan ?? 0],
      ["Space", (x) => x.space ?? 0],
      ["Echo", (x) => x.echo ?? 0],
    ];
    for (const [param, get] of series) {
      const pts = span.map((x, j) => ({ beat: T(dr.from + j), value: x ? get(x) : DEFAULTS[param] }));
      if (pts.every((p) => Math.abs(p.value - DEFAULTS[param]) < TOLERANCE[param] / 2)) continue;
      const simple = simplify(pts, TOLERANCE[param]);
      lanes.push({ param, points: simple.map((p): AutomationPoint => ({ beat: round(p.beat), value: round(p.value), curve: "Linear" })) });
    }
    const fxOn = live.filter((x) => x.fxMix > 0 && x.fxKind > 0);
    const track = cap.tracks[dr.run.token];
    return {
      id: k + 1,
      track,
      lane: d,
      start: round(T(dr.from)),
      length: round(Math.max(MIN_CLIP_BEATS, T(dr.to) - T(dr.from))),
      source_start: round(head.beat),
      key_shift: mode(live.map((x) => Math.round(x.keyShift * 100) / 100)),
      keylock: mode(live.map((x) => x.keylock)),
      gain_db: round(head.trim),
      lanes,
      fx: fxOn.length ? { kind: mode(fxOn.map((x) => x.fxKind)), beats: mode(fxOn.map((x) => x.fxBeats)) } : null,
      name: track.title,
    };
  });

  // The clock free-runs before anything plays, so the tempo starts where the first clip does.
  const from = first.from;
  const segs = tempoSegments(
    f.slice(from).map((_, i) => T(from + i)),
    f.slice(from),
  );
  return {
    version: 1,
    name: cap.name,
    tempo: { segments: segs, time_signatures: [{ start_beat: 0, numerator: 4, denominator: 4 }] },
    clips,
    markers: [{ beat: clips[0].start, label: "Recording starts" }],
    master_gain_db: 0,
    next_id: clips.length + 1,
  };
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

// ---------------------------------------------------------------- recorder

export class MixCapture {
  private frames: CaptureFrame[] = [];
  private tracks: Record<number, TrackRef> = {};
  private frame0: number | null = null;
  private lastT = -Infinity;

  constructor(
    readonly name: string,
    private sampleRate: number,
  ) {}

  /** Adds a telemetry snapshot (thinned to CAPTURE_RATE). `trackFor` names what a token plays. */
  add(tele: Telemetry, mixer: MixerState, trackFor: (deck: number) => TrackRef | null) {
    if (this.frame0 === null) this.frame0 = tele.frame;
    const t = (tele.frame - this.frame0) / this.sampleRate;
    if (t - this.lastT < 1 / CAPTURE_RATE - 1e-6) return;
    this.lastT = t;
    const fr = sampleFrame(t, tele, mixer);
    fr.decks.forEach((d, i) => {
      if (d && !(d.token in this.tracks)) {
        const ref = trackFor(i);
        if (ref) this.tracks[d.token] = ref;
      }
    });
    this.frames.push(fr);
  }

  get seconds(): number {
    return Math.max(0, this.lastT);
  }

  capture(): Capture {
    return { name: this.name, frames: this.frames, tracks: this.tracks };
  }
}
