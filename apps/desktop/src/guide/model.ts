// The guide's data model and the lab runner: labs are lists of steps, and each step can
// check itself against what the app is doing (decks, mixer, project) so it ticks off when
// you actually do it.
import { create } from "zustand";
import type { DeckTele, Telemetry } from "../backend/types";
import { useApp, type ChannelState } from "../store/app";
import { useTelemetry } from "../store/telemetry";

export type PracticeId = "p1" | "p2" | "p3" | "p4" | "p5" | "p6";

export const PRACTICE_TITLES: Record<PracticeId, string> = {
  p1: "Practice 1 - Warm House",
  p2: "Practice 2 - Deep House",
  p3: "Practice 3 - Night Techno",
  p4: "Practice 4 - Clashing Keys",
  p5: "Practice 5 - Melodic Trance",
  p6: "Practice 6 - Live Drummer",
};

export type Memory = Record<string, number | boolean | undefined>;

/** What a check can look at. */
export interface LabCtx {
  t: Telemetry;
  app: ReturnType<typeof useApp.getState>;
  /** Per-lab scratch space for things that happen over time. */
  m: Memory;
  /** Seconds since the page started (for timing things). */
  now: number;
}

export interface Step {
  id: string;
  title: string;
  /** Plain-language detail: how, and what to listen for. */
  body?: string;
  /** Registry ids of the controls to light up. */
  controls?: string[];
  /** Pad tab to open on a deck so the controls are visible. */
  tab?: [number, string];
  /** Needs the Pro view (controls hidden in Easy). */
  pro?: boolean;
  /** Offers a button that loads this practice track on this deck. */
  load?: [number, PracticeId];
  /** Ticks off by itself when this is true. Without it the step has a "Done" button. */
  check?: (c: LabCtx) => boolean;
}

export interface Lab {
  id: string;
  number: number;
  title: string;
  goal: string;
  /** Practice tracks to load on decks A, B... (Lab 7 builds a timeline instead). */
  decks?: PracticeId[];
  arrange?: boolean;
  pro?: boolean;
  /** Control values set when the lab is set up, after the defaults (all EQs flat, deck A up, others down). */
  prepare?: [string, number | boolean][];
  /** Decks whose hot cues are cleared at setup, so a "save a hot cue" step starts fresh. */
  freshCues?: number[];
  /** Runs every tick before the checks, to note things that happen over time. */
  observe?: (c: LabCtx) => void;
  steps: Step[];
  listen: string;
  mistake: string;
}

// ------------------------------------------------------------------ helpers for checks

export const tele = (c: LabCtx, d: number): DeckTele | undefined => c.t.decks[d];
export const ch = (c: LabCtx, d: number): ChannelState => c.app.mixer.channels[d];
export const playing = (c: LabCtx, d: number) => !!tele(c, d)?.playing;

/** Deck index holding a practice track, or -1. */
export function deckWith(c: LabCtx, id: PracticeId): number {
  return c.app.decks.findIndex((d) => d?.detail.track.title === PRACTICE_TITLES[id]);
}

/** How much of a deck reaches the master (fader × crossfader side), 0..1. */
export function audible(c: LabCtx, d: number): number {
  const x = c.app.mixer.crossfader;
  const side = c.app.mixer.assign[d] ?? (d % 2 === 0 ? 0 : 2);
  const xf = side === 1 ? 1 : side === 0 ? Math.min(1, 1 - x) : Math.min(1, 1 + x);
  return playing(c, d) ? ch(c, d).fader * xf : 0;
}

/** Distance in beats from the nearest boundary of `every` beats. */
export function offBoundary(beat: number, every: number): number {
  const r = ((beat % every) + every) % every;
  return Math.min(r, every - r);
}

/** Remembers when a deck starts playing, and where another deck was at that moment. */
export function noteStart(c: LabCtx, d: number, other: number, key: string) {
  const was = c.m[`${key}:was`];
  const now = playing(c, d);
  if (now && !was && playing(c, other)) c.m[key] = tele(c, other)!.beat;
  c.m[`${key}:was`] = now;
}

/** Notes a jump in a deck's play position bigger than `beats` (beat jump, hot cue). */
export function noteJump(c: LabCtx, d: number, key: string, beats = 1.5) {
  const b = tele(c, d)?.beat ?? 0;
  const last = c.m[`${key}:last`] as number | undefined;
  if (last !== undefined && playing(c, d) && Math.abs(b - last) > beats) c.m[key] = true;
  c.m[`${key}:last`] = b;
}

// ------------------------------------------------------------------ progress and runner

const STORAGE = "mixit.guide.v1";

interface Saved {
  done: Record<string, string[]>; // lab id -> done step ids
}

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE) ?? "");
    if (s && typeof s === "object" && s.done) return s as Saved;
  } catch {
    // Missing or unreadable progress starts fresh.
  }
  return { done: {} };
}

function save(s: Saved) {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(s));
  } catch {
    // Progress is a convenience; a full or blocked storage loses nothing important.
  }
}

export type GuideTab = "learn" | "labs" | "fix" | "chain" | "keys";

interface GuideState {
  tab: GuideTab;
  topic: string | null;
  lab: string | null;
  done: Record<string, string[]>;
  /** Controls lit up right now ("Show me"). */
  highlight: string[];
  /** Controls the current lab step is about, marked more softly while the lab runs. */
  focus: string[];
  set: (p: Partial<GuideState>) => void;
  markDone: (lab: string, step: string) => void;
  resetLab: (lab: string) => void;
}

export const useGuide = create<GuideState>((set, get) => ({
  tab: "learn",
  topic: null,
  lab: null,
  done: load().done,
  highlight: [],
  focus: [],
  set: (p) => set(p),
  markDone: (lab, step) => {
    const cur = get().done[lab] ?? [];
    if (cur.includes(step)) return;
    const done = { ...get().done, [lab]: [...cur, step] };
    set({ done });
    save({ done });
  },
  resetLab: (lab) => {
    const done = { ...get().done, [lab]: [] };
    set({ done });
    save({ done });
    memories.delete(lab);
  },
}));

const memories = new Map<string, Memory>();

export function labMemory(lab: string): Memory {
  let m = memories.get(lab);
  if (!m) memories.set(lab, (m = {}));
  return m;
}

export function context(lab: string): LabCtx {
  return { t: useTelemetry.getState().t, app: useApp.getState(), m: labMemory(lab), now: performance.now() / 1000 };
}

/** One pass of the active lab: observe, then tick off steps whose checks pass. */
export function runLab(lab: Lab) {
  const c = context(lab.id);
  lab.observe?.(c);
  const done = useGuide.getState().done[lab.id] ?? [];
  for (const s of lab.steps) {
    if (!s.check || done.includes(s.id)) continue;
    try {
      if (s.check(c)) useGuide.getState().markDone(lab.id, s.id);
    } catch {
      // A check that cannot run yet (deck not loaded) just stays open.
    }
  }
}

/** The first step not yet done. */
export function currentStep(lab: Lab, done: string[]): Step | undefined {
  return lab.steps.find((s) => !done.includes(s.id));
}

/** Lights up controls for a few seconds and scrolls the first into view. */
export function showControls(ids: string[], ms = 4000) {
  useGuide.getState().set({ highlight: ids });
  const el = ids.map((id) => document.querySelector(`[data-action="${CSS.escape(id)}"]`)).find(Boolean);
  el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(() => {
    if (useGuide.getState().highlight === ids) useGuide.getState().set({ highlight: [] });
  }, ms);
}
let showTimer = 0;
