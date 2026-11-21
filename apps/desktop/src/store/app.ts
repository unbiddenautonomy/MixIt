import { create } from "zustand";
import type { ActionSpec, AppInfo, AudioStatus, DeckInfo, JobProgress, MixProject, Settings, TransitionInfo, WaveformData } from "../backend/types";

export type Workspace = "mix" | "library" | "arrange";

/** Mixer and FX values the UI owns (the engine does not report them back). */
export interface ChannelState {
  trim: number;
  high: number;
  mid: number;
  low: number;
  filter: number;
  fader: number;
  cue: boolean;
  kills: [boolean, boolean, boolean];
}

export interface FxSlot {
  type: number;
  on: boolean;
  mix: number;
  beats: number; // index into FX_BEATS
  p1: number;
  p2: number;
}

export interface MixerState {
  channels: ChannelState[];
  crossfader: number;
  master: number;
  headphones: number;
  cueMix: number;
  fx: FxSlot[][]; // [deck][slot]
  loopSize: number[]; // index into LOOP_SIZES per deck
  jumpSize: number[];
  quantize: boolean;
  /** Indices into the registry's option lists. */
  crossfaderCurve: number;
  faderCurve: number;
  eqMode: number;
  splitCue: boolean;
  crossfaderReverse: boolean;
  /** Crossfader side per channel: 0 = A, 1 = thru, 2 = B. */
  assign: number[];
}

export const LOOP_LABELS = ["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4", "8", "16", "32"];
export const LOOP_BEATS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
export const JUMP_LABELS = ["1", "2", "4", "8", "16", "32"];
export const FX_BEAT_LABELS = ["1/16", "1/8", "1/4", "1/2", "3/4", "1", "2", "4", "8", "16"];
export const DECK_LETTERS = ["A", "B", "C", "D"];

const channel = (): ChannelState => ({ trim: 0, high: 0, mid: 0, low: 0, filter: 0, fader: 1, cue: false, kills: [false, false, false] });
const fxSlot = (type: number): FxSlot => ({ type, on: false, mix: 0.5, beats: 5, p1: 0.5, p2: 0.5 });

interface AppState {
  ready: boolean;
  error: string | null;
  info: AppInfo | null;
  registry: ActionSpec[];
  transitions: TransitionInfo[];
  fxTypes: string[];
  settings: Settings | null;
  audio: AudioStatus | null;
  decks: (DeckInfo | null)[];
  waveforms: Record<number, WaveformData>;
  mixer: MixerState;
  workspace: Workspace;
  paletteOpen: boolean;
  settingsOpen: boolean;
  automixOpen: boolean;
  explain: boolean;
  explainHeld: boolean;
  /** Deck the library loads into with Enter, and suggestions follow. */
  targetDeck: number;
  jobs: Record<string, JobProgress>;
  project: MixProject | null;
  projectPath: string | null;
  libraryHeight: number;

  set: (p: Partial<AppState>) => void;
  setDeck: (d: DeckInfo) => void;
  setChannel: (deck: number, p: Partial<ChannelState>) => void;
  setMixer: (p: Partial<MixerState>) => void;
  setFx: (deck: number, slot: number, p: Partial<FxSlot>) => void;
  setJob: (j: JobProgress) => void;
}

export const useApp = create<AppState>((set) => ({
  ready: false,
  error: null,
  info: null,
  registry: [],
  transitions: [],
  fxTypes: [],
  settings: null,
  audio: null,
  decks: [null, null, null, null],
  waveforms: {},
  mixer: {
    channels: [channel(), channel(), channel(), channel()],
    crossfader: 0,
    master: 0,
    headphones: -6,
    cueMix: 0.5,
    fx: [0, 1, 2, 3].map(() => [fxSlot(1), fxSlot(3), fxSlot(4)]),
    loopSize: [7, 7, 7, 7],
    jumpSize: [2, 2, 2, 2],
    quantize: true,
    crossfaderCurve: 1,
    faderCurve: 1,
    eqMode: 1,
    splitCue: false,
    crossfaderReverse: false,
    assign: [0, 2, 0, 2],
  },
  workspace: "mix",
  paletteOpen: false,
  settingsOpen: false,
  automixOpen: false,
  explain: false,
  explainHeld: false,
  targetDeck: 0,
  jobs: {},
  project: null,
  projectPath: null,
  libraryHeight: 320,

  set: (p) => set(p),
  setDeck: (d) => set((s) => ({ decks: s.decks.map((x, i) => (i === d.deck ? d : x)) })),
  setChannel: (deck, p) =>
    set((s) => ({ mixer: { ...s.mixer, channels: s.mixer.channels.map((c, i) => (i === deck ? { ...c, ...p } : c)) } })),
  setMixer: (p) => set((s) => ({ mixer: { ...s.mixer, ...p } })),
  setFx: (deck, slot, p) =>
    set((s) => ({
      mixer: { ...s.mixer, fx: s.mixer.fx.map((d, i) => (i === deck ? d.map((x, j) => (j === slot ? { ...x, ...p } : x)) : d)) },
    })),
  setJob: (j) => set((s) => ({ jobs: { ...s.jobs, [j.kind]: j } })),
}));

export function isPro(): boolean {
  return useApp.getState().settings?.viewMode === "pro";
}

export function usePro(): boolean {
  return useApp((s) => s.settings?.viewMode === "pro");
}

export function useNotation() {
  return useApp((s) => s.settings?.keyNotation ?? "camelot");
}

export function deckCount(): number {
  return useApp.getState().settings?.decks ?? 2;
}
