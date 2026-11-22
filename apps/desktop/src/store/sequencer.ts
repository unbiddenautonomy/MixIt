// The sampler's step sequencer: a grid of steps per pad that the engine plays on the beat.
// The pattern lives here (and in local storage, so it survives a restart); every change
// is sent to the engine as a whole, which is small and keeps the two in step.
import { create } from "zustand";
import { backend } from "../backend";
import type { SequencerDto } from "../backend/types";

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
  /** Which 16 steps the grid shows. */
  page: number;
  /** The grid turns the page with the playhead. */
  follow: boolean;
}

const empty = () => Array.from({ length: PADS }, () => Array<boolean>(MAX_STEPS).fill(false));

function restore(): Partial<SequencerState> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Partial<SequencerState>;
    const pads = empty();
    v.pads?.forEach((row, p) => row.forEach((on, s) => p < PADS && s < MAX_STEPS && (pads[p][s] = !!on)));
    return { steps: v.steps, stepBeats: v.stepBeats, swing: v.swing, pads, follow: v.follow };
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
  page: 0,
  follow: true,
  ...restore(),
}));

export function sequencerDto(s: SequencerState = useSequencer.getState()): SequencerDto {
  return { on: s.on, steps: s.steps, stepBeats: s.stepBeats, swing: s.swing, pads: s.pads.map((r) => r.slice(0, s.steps)) };
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
    localStorage.setItem(KEY, JSON.stringify({ steps: s.steps, stepBeats: s.stepBeats, swing: s.swing, pads: s.pads, follow: s.follow }));
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

export function setSteps(steps: number) {
  update((s) => ({ steps, page: Math.min(s.page, Math.max(0, Math.ceil(steps / PAGE) - 1)) }));
}

export const setStepBeats = (stepBeats: number) => update({ stepBeats });
export const setSwing = (swing: number) => update({ swing: Math.max(0, Math.min(0.5, swing)) });
export const setPage = (page: number) => useSequencer.setState({ page, follow: false });
export const setFollow = (follow: boolean) => update({ follow });

export function clearPattern(pad?: number) {
  update((s) => ({ pads: s.pads.map((r, p) => (pad === undefined || p === pad ? r.map(() => false) : r)) }));
}

/** Copies the first half of the pattern over the second (for a 32-step pattern, bar 1 onto bar 2). */
export function doublePattern() {
  update((s) => {
    const n = s.steps;
    if (n * 2 > MAX_STEPS) return {};
    return { steps: n * 2, pads: s.pads.map((r) => r.map((on, i) => (i < n ? on : i < 2 * n ? r[i - n] : on))) };
  });
}

/** Moves a pad's row one step earlier or later, wrapping round. */
export function shiftRow(pad: number, by: number) {
  update((s) => {
    const n = s.steps;
    const pads = s.pads.map((r) => [...r]);
    const row = s.pads[pad].slice(0, n);
    for (let i = 0; i < n; i++) pads[pad][(i + by + n) % n] = row[i];
    return { pads };
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
    padKits.forEach((kit, pad) => {
      const row = kit ? p.rows[kit] : undefined;
      if (!row) return;
      filled++;
      for (let s = 0; s < p.steps; s++) pads[pad][s] = row[s] === "x";
    });
    return { pads, steps: p.steps, stepBeats: p.stepBeats, swing: p.swing, page: 0 };
  });
  return filled;
}

/** A drum kit laid out for the sequencer, one sound per pad. */
export const DRUM_KIT = ["kick", "snare", "clap", "hat", "open_hat", "rim", "tom", "shaker"];
