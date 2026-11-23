import { create } from "zustand";
import type { ActionSpec, AppInfo, AudioStatus, DeckInfo, JobProgress, KitSound, MixProject, PadInfo, Settings, TransitionInfo, WaveformData } from "../backend/types";

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
  /** Studio one-knob controls (see `mixer.X.punch` and friends in the registry). */
  pan: number;
  punch: number;
  warmth: number;
  width: number;
  /** Reverb and echo sends, 0..1. */
  space: number;
  echo: number;
  /** Index into DUCK_SOURCES (0 = off, 1 = deck A…) and the amount 0..1. */
  duckSource: number;
  duck: number;
  gate: boolean;
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
  /** [unit][slot]: units 0 to 3 are the decks, 4 is the master. */
  fx: FxSlot[][];
  samplerVolume: number;
  loopSize: number[]; // index into LOOP_SIZES per deck
  jumpSize: number[];
  /** Index into SLICE_BARS per deck. */
  sliceSize: number[];
  /** Key pads per deck: the hot cue they play (0-based) and their range (index into KEYPAD_RANGES). */
  keypadCue: number[];
  keypadRange: number[];
  quantize: boolean;
  /** Indices into the registry's option lists. */
  crossfaderCurve: number;
  faderCurve: number;
  eqMode: number;
  splitCue: boolean;
  crossfaderReverse: boolean;
  /** A/B bypass: EQ, filters, effects and studio switched out to hear the plain music. */
  bypass: boolean;
  /** Crossfader side per channel: 0 = A, 1 = thru, 2 = B. */
  assign: number[];
  /** Master glue compressor 0..1. */
  glue: number;
  /** Shared reverb ("space") and echo returns. */
  spaceLevel: number;
  spaceSize: number;
  echoLevel: number;
  echoFeedback: number;
  /** Index into the registry's echo times. */
  echoTime: number;
}

export const LOOP_LABELS = ["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4", "8", "16", "32"];
export const LOOP_BEATS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
/** Slicer lengths, in the order of the registry's `deck.X.slice.size` choices. */
export const SLICE_BARS = [1, 2, 4];
/** Key pad ranges: the name and the semitone shift of pad 1 (`deck.X.keypad.range`). */
export const KEYPAD_RANGES: [string, number][] = [
  ["Low", -7],
  ["Middle", -3],
  ["High", 0],
];
/** Roll pad lengths in beats (`deck.X.roll.1` … `roll.8`). */
export const ROLL_BEATS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4];
export const JUMP_LABELS = ["1", "2", "4", "8", "16", "32"];
export const FX_BEAT_LABELS = ["1/16", "1/8", "1/4", "1/2", "3/4", "1", "2", "4", "8", "16"];
export const DECK_LETTERS = ["A", "B", "C", "D"];
/** FX unit index of the master effects. */
export const MASTER_FX = 4;
/** "A".."D" for deck units, "master" for the master unit. */
export const fxUnitName = (unit: number) => (unit === MASTER_FX ? "master" : DECK_LETTERS[unit]);

const channel = (): ChannelState => ({
  trim: 0,
  high: 0,
  mid: 0,
  low: 0,
  filter: 0,
  fader: 1,
  cue: false,
  kills: [false, false, false],
  pan: 0,
  punch: 0,
  warmth: 0,
  width: 1,
  space: 0,
  echo: 0,
  duckSource: 0,
  duck: 0.5,
  gate: false,
});
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
  /** The deck whose track the track editor shows (null when closed). */
  editorDeck: number | null;
  automixOpen: boolean;
  explain: boolean;
  explainHeld: boolean;
  /** Deck the library loads into with Enter, and suggestions follow. */
  targetDeck: number;
  jobs: Record<string, JobProgress>;
  project: MixProject | null;
  projectPath: string | null;
  /** The project has edits that are not saved to a file. */
  projectDirty: boolean;
  libraryHeight: number;
  kit: KitSound[];
  pads: PadInfo[];
  samplerOpen: boolean;
  samplerTab: "pads" | "seq" | "fx";
  /** The pad tab each deck shows ("cues", "loop", "jump", "fx", "grid"). */
  padTabs: string[];
  guideOpen: boolean;

  set: (p: Partial<AppState>) => void;
  setDeck: (d: DeckInfo) => void;
  setChannel: (deck: number, p: Partial<ChannelState>) => void;
  setMixer: (p: Partial<MixerState>) => void;
  setFx: (deck: number, slot: number, p: Partial<FxSlot>) => void;
  setJob: (j: JobProgress) => void;
  setPad: (p: PadInfo) => void;
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
    fx: [...[0, 1, 2, 3].map(() => [fxSlot(1), fxSlot(3), fxSlot(4)]), [fxSlot(3), fxSlot(1), fxSlot(4)]],
    samplerVolume: 0.8,
    loopSize: [7, 7, 7, 7],
    jumpSize: [2, 2, 2, 2],
    sliceSize: [1, 1, 1, 1],
    keypadCue: [0, 0, 0, 0],
    keypadRange: [1, 1, 1, 1],
    quantize: true,
    crossfaderCurve: 1,
    faderCurve: 1,
    eqMode: 1,
    splitCue: false,
    crossfaderReverse: false,
    bypass: false,
    assign: [0, 2, 0, 2],
    glue: 0,
    spaceLevel: -3,
    spaceSize: 0.5,
    echoLevel: -3,
    echoFeedback: 0.5,
    echoTime: 2,
  },
  workspace: "mix",
  paletteOpen: false,
  settingsOpen: false,
  editorDeck: null,
  automixOpen: false,
  explain: false,
  explainHeld: false,
  targetDeck: 0,
  jobs: {},
  project: null,
  projectPath: null,
  projectDirty: false,
  libraryHeight: 320,
  kit: [],
  pads: [],
  samplerOpen: true,
  samplerTab: "pads",
  padTabs: ["cues", "cues", "cues", "cues"],
  guideOpen: false,

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
  setPad: (p) => set((s) => ({ pads: s.pads.map((x) => (x.pad === p.pad ? p : x)) })),
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
