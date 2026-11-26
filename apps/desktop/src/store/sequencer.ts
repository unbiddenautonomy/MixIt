// The sampler's step sequencer: a grid of steps per pad that the engine plays on the beat.
// The pattern lives here (and in local storage, so it survives a restart); every change
// is sent to the engine as a whole, which is small and keeps the two in step.
import { create } from "zustand";
import { backend } from "../backend";
import type { HeardNote, SequencerDto } from "../backend/types";

export const MAX_STEPS = 64;
export const PAGE = 16;
const PADS = 8;
const KEY = "mixit.sequencer";

export interface SequencerState {
  on: boolean;
  steps: number;
  stepBeats: number;
  swing: number;
  /** pads[p][s] for every step up to MAX_STEPS, so shortening keeps the steps after it. */
  pads: boolean[][];
  /** pitches[p][s]: semitones pad p is pitched on step s (0 = as recorded). */
  pitches: number[][];
  /** Which 16 steps the grid shows. */
  page: number;
  /** The grid turns the page with the playhead. */
  follow: boolean;
}

const empty = () => Array.from({ length: PADS }, () => Array<boolean>(MAX_STEPS).fill(false));
const level = () => Array.from({ length: PADS }, () => Array<number>(MAX_STEPS).fill(0));
/** Farthest a step is pitched either way (semitones). */
export const MAX_PITCH = 24;
const clampPitch = (n: number) => Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.round(n) || 0));

function restore(): Partial<SequencerState> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<SequencerState>;
    const pads = empty();
    v.pads?.forEach((row, p) => row.forEach((on, s) => p < PADS && s < MAX_STEPS && (pads[p][s] = !!on)));
    const pitches = level();
    v.pitches?.forEach((row, p) => row.forEach((n, s) => p < PADS && s < MAX_STEPS && (pitches[p][s] = clampPitch(Number(n)))));
    return { steps: v.steps, stepBeats: v.stepBeats, swing: v.swing, pads, pitches, follow: v.follow };
  } catch {
    return {};
  }
}

export const useSequencer = create<SequencerState>(() => ({
  on: false,
  steps: 16,
  stepBeats: 0.25,
  swing: 0,
  pads: empty(),
  pitches: level(),
  page: 0,
  follow: true,
  ...restore(),
}));

export function sequencerDto(s: SequencerState = useSequencer.getState()): SequencerDto {
  return { on: s.on, steps: s.steps, stepBeats: s.stepBeats, swing: s.swing, pads: s.pads.map((r) => r.slice(0, s.steps)), pitches: s.pitches.map((r) => r.slice(0, s.steps)) };
}

let timer = 0;
let lastSent = "";
/** Sends the pattern to the engine (straight away when it starts or stops). */
function push(now = false) {
  window.clearTimeout(timer);
  const go = () => {
    const dto = sequencerDto();
    const json = JSON.stringify(dto);
    if (json === lastSent) return;
    lastSent = json;
    void backend().samplerSequence(dto).catch(() => {});
  };
  if (now) go();
  else timer = window.setTimeout(go, 25);
}

function save() {
  const s = useSequencer.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ steps: s.steps, stepBeats: s.stepBeats, swing: s.swing, pads: s.pads, pitches: s.pitches, follow: s.follow }));
  } catch {
    /* storage is optional */
  }
}

function update(patch: Partial<SequencerState> | ((s: SequencerState) => Partial<SequencerState>), now = false) {
  useSequencer.setState(patch);
  push(now);
  save();
}

export function setSequencerOn(on: boolean) {
  update({ on }, true);
}

export const toggleSequencer = () => setSequencerOn(!useSequencer.getState().on);

export function setStep(pad: number, step: number, on: boolean) {
  update((s) => {
    if (s.pads[pad]?.[step] === on) return {};
    const pads = s.pads.map((r) => [...r]);
    pads[pad][step] = on;
    return { pads };
  });
}

/** Pitches a step of a pad up or down (semitones; 0 plays the sound as recorded). */
export function setPitch(pad: number, step: number, semitones: number) {
  update((s) => {
    const n = clampPitch(semitones);
    if (s.pitches[pad]?.[step] === n) return {};
    const pitches = s.pitches.map((r) => [...r]);
    pitches[pad][step] = n;
    return { pitches };
  });
}

/** Puts a whole row on a pad: which steps play and how far each is pitched. */
export function setRow(pad: number, row: boolean[], pitches: number[], steps?: number) {
  update((s) => {
    const pads = s.pads.map((r) => [...r]);
    const pitch = s.pitches.map((r) => [...r]);
    for (let i = 0; i < MAX_STEPS; i++) {
      pads[pad][i] = !!row[i];
      pitch[pad][i] = clampPitch(pitches[i] ?? 0);
    }
    const n = steps ?? s.steps;
    return { pads, pitches: pitch, steps: n, page: Math.min(s.page, Math.max(0, Math.ceil(n / PAGE) - 1)) };
  });
}

export function setSteps(steps: number) {
  update((s) => ({ steps, page: Math.min(s.page, Math.max(0, Math.ceil(steps / PAGE) - 1)) }));
}

export const setStepBeats = (stepBeats: number) => update({ stepBeats });
export const setSwing = (swing: number) => update({ swing: Math.max(0, Math.min(0.5, swing)) });
export const setPage = (page: number) => useSequencer.setState({ page, follow: false });
export const setFollow = (follow: boolean) => update({ follow });

export function clearPattern(pad?: number) {
  update((s) => ({
    pads: s.pads.map((r, p) => (pad === undefined || p === pad ? r.map(() => false) : r)),
    pitches: s.pitches.map((r, p) => (pad === undefined || p === pad ? r.map(() => 0) : r)),
  }));
}

/** Copies the first half of the pattern over the second (for a 32-step pattern, bar 1 onto bar 2). */
export function doublePattern() {
  update((s) => {
    const n = s.steps;
    if (n * 2 > MAX_STEPS) return {};
    const twice = <T>(r: T[]) => r.map((v, i) => (i < n ? v : i < 2 * n ? r[i - n] : v));
    return { steps: n * 2, pads: s.pads.map(twice), pitches: s.pitches.map(twice) };
  });
}

/** Moves a pad's row one step earlier or later, wrapping round. */
export function shiftRow(pad: number, by: number) {
  update((s) => {
    const n = s.steps;
    const pads = s.pads.map((r) => [...r]);
    const pitches = s.pitches.map((r) => [...r]);
    const row = s.pads[pad].slice(0, n);
    const pitch = s.pitches[pad].slice(0, n);
    for (let i = 0; i < n; i++) {
      pads[pad][(i + by + n) % n] = row[i];
      pitches[pad][(i + by + n) % n] = pitch[i];
    }
    return { pads, pitches };
  });
}

/** Rows written as "x...x..." (x = hit), keyed by the kit sound they are for. */
export interface Preset {
  id: string;
  name: string;
  help: string;
  steps: number;
  stepBeats: number;
  swing: number;
  rows: Record<string, string>;
}

export const PRESETS: Preset[] = [
  {
    id: "four",
    name: "Four on the floor",
    help: "A kick on every beat, the heartbeat of house and techno.",
    steps: 16,
    stepBeats: 0.25,
    swing: 0,
    rows: { kick: "x...x...x...x...", clap: "....x.......x...", open_hat: "..x...x...x...x." },
  },
  {
    id: "house",
    name: "House groove",
    help: "Four-on-the-floor with off-beat hats and a shaker that swings a little.",
    steps: 16,
    stepBeats: 0.25,
    swing: 0.12,
    rows: { kick: "x...x...x...x...", clap: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", open_hat: "..x...x...x...x.", shaker: ".x.x.x.x.x.x.x.x" },
  },
  {
    id: "breaks",
    name: "Breakbeat",
    help: "Kick and snare that skip around the beat instead of marching on it.",
    steps: 16,
    stepBeats: 0.25,
    swing: 0,
    rows: { kick: "x.........x.x...", snare: "....x.......x..x", hat: "x.x.x.x.x.x.x.x.", rim: ".......x.....x.." },
  },
  {
    id: "hiphop",
    name: "Hip hop",
    help: "A laid-back beat with plenty of swing.",
    steps: 16,
    stepBeats: 0.25,
    swing: 0.3,
    rows: { kick: "x......x..x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x." },
  },
  {
    id: "trap",
    name: "Trap",
    help: "Sparse kicks, a snare on the third beat and rolling hi-hats.",
    steps: 32,
    stepBeats: 0.25,
    swing: 0,
    rows: { kick: "x......x...x....x.....x.........", snare: "........x...............x.......", hat: "x.x.x.x.x.x.xxxxx.x.x.x.x.x.x.xx", tom: "..............................x." },
  },
  {
    id: "build",
    name: "Build-up",
    help: "Snares that get faster over two bars, for the moment before a drop.",
    steps: 32,
    stepBeats: 0.25,
    swing: 0,
    rows: { kick: "x...x...x...x...x...x...x...x...", snare: "x...x...x...x...x.x.x.x.xxxxxxxx" },
  },
];

/** The sounds a preset needs that no pad holds. */
export function missingSounds(p: Preset, padKits: (string | null)[]): string[] {
  return Object.keys(p.rows).filter((k) => !padKits.includes(k));
}

/** Puts a preset on the pads that hold its sounds. Returns how many rows it filled. */
export function applyPreset(p: Preset, padKits: (string | null)[]): number {
  let filled = 0;
  update(() => {
    const pads = empty();
    const pitches = level();
    padKits.forEach((kit, pad) => {
      const row = kit ? p.rows[kit] : undefined;
      if (!row) return;
      filled++;
      for (let s = 0; s < p.steps; s++) pads[pad][s] = row[s] === "x";
    });
    return { pads, pitches, steps: p.steps, stepBeats: p.stepBeats, swing: p.swing, page: 0 };
  });
  return filled;
}

/** A drum kit laid out for the sequencer, one sound per pad. */
export const DRUM_KIT = ["kick", "snare", "clap", "hat", "open_hat", "rim", "tom", "shaker"];

// ------------------------------------------------------------------ notes to a pattern

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/** A MIDI note's name, like "A3". */
export const noteName = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

export interface NotePattern {
  /** Steps the pattern needs (8, 16, 32 or 64). */
  steps: number;
  row: boolean[];
  /** Semitones from `root` on each step. */
  pitches: number[];
  /** The note that plays the pad as recorded. */
  root: number;
  /** Notes placed, and notes left out (past 64 steps, or sharing a step with a clearer one). */
  placed: number;
  dropped: number;
}

/** The note heard most often (by time), which by default plays the pad as recorded. */
export function commonNote(notes: HeardNote[]): number {
  const time = new Map<number, number>();
  for (const n of notes) time.set(n.pitch, (time.get(n.pitch) ?? 0) + n.length);
  let best = 60;
  let most = -1;
  for (const [p, t] of time) if (t > most || (t === most && p < best)) [best, most] = [p, t];
  return best;
}

/**
 * Lays heard notes on sequencer steps: each note on the step nearest its start at `bpm`,
 * one note a step (the clearest), empty bars before the first note left out, and each
 * step pitched by its distance from `root` (out-of-range notes move by octaves).
 */
export function notesToPattern(notes: HeardNote[], bpm: number, stepBeats: number, root = commonNote(notes)): NotePattern {
  const perStep = (60 / bpm) * stepBeats;
  const perBar = Math.max(1, Math.round(4 / stepBeats));
  const at = notes.map((n) => Math.round(n.start / perStep));
  const first = at.length ? Math.min(...at) : 0;
  const shift = Math.floor(first / perBar) * perBar;
  const best = new Map<number, HeardNote>();
  let dropped = 0;
  notes.forEach((n, i) => {
    const s = at[i] - shift;
    if (s >= MAX_STEPS) return void dropped++;
    const had = best.get(s);
    if (had) dropped++;
    if (!had || n.strength > had.strength) best.set(s, n);
  });
  const last = Math.max(-1, ...best.keys());
  const steps = [8, 16, 32, 64].find((n) => n > last && n >= perBar) ?? MAX_STEPS;
  const row = Array<boolean>(MAX_STEPS).fill(false);
  const pitches = Array<number>(MAX_STEPS).fill(0);
  for (const [s, n] of best) {
    let d = n.pitch - root;
    while (d > MAX_PITCH) d -= 12;
    while (d < -MAX_PITCH) d += 12;
    row[s] = true;
    pitches[s] = d;
  }
  return { steps, row, pitches, root, placed: best.size, dropped };
}
