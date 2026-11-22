// Engine state at display rate. Canvas loops read it with useTelemetry.getState() so
// waveforms redraw without re-rendering React.
import { create } from "zustand";
import type { DeckTele, Telemetry } from "../backend/types";

const emptyDeck: DeckTele = {
  loaded: false,
  token: 0,
  playing: false,
  position: 0,
  duration: 0,
  remaining: 0,
  bpm: 0,
  baseBpm: 0,
  rate: 1,
  tempo: 0,
  tempoRange: 0.08,
  beat: 0,
  beatsPerBar: 4,
  keylock: false,
  keyShift: 0,
  sync: false,
  master: false,
  phase: 0,
  slip: false,
  slipPosition: 0,
  reverse: false,
  cue: 0,
  looping: { start: 0, end: 0, active: false, beats: 0 },
  peak: [0, 0],
  rms: 0,
  lowRms: 0,
  compGrDb: 0,
  duckDb: 0,
  gateOpen: false,
};

export const emptyTelemetry: Telemetry = {
  frame: 0,
  decks: [emptyDeck, emptyDeck, emptyDeck, emptyDeck],
  master: { peak: [0, 0], truePeakDb: -120, momentaryLufs: -70, shortTermLufs: -70, correlation: 1, limiterGrDb: 0, glueGrDb: 0, cuePeak: [0, 0], clipped: false },
  mic: { connected: false, live: false, onAir: false, peak: [0, 0], rms: 0, duckDb: 0, gateOpen: false, latencyMs: 0, driftPpm: 0, underruns: 0, capturing: false, capturedSeconds: 0 },
  clockBpm: 120,
  masterDeck: null,
  recording: false,
  recordedSeconds: 0,
  load: 0,
  overruns: 0,
  samplerPlaying: 0,
  sequencerStep: -1,
};

interface TeleState {
  t: Telemetry;
  /** performance.now() when `t` arrived, for smooth position interpolation. */
  at: number;
  set: (t: Telemetry) => void;
}

export const useTelemetry = create<TeleState>((set) => ({
  t: emptyTelemetry,
  at: 0,
  set: (t) => set({ t, at: performance.now() }),
}));

/** Position extrapolated to now (telemetry arrives at ~60 Hz; frames are drawn at 120+). */
export function livePosition(deck: number): number {
  const { t, at } = useTelemetry.getState();
  const d = t.decks[deck];
  if (!d || !d.playing) return d?.position ?? 0;
  const dt = Math.min(0.05, (performance.now() - at) / 1000);
  let p = d.position + dt * d.rate;
  if (d.looping.active && p >= d.looping.end && d.looping.end > d.looping.start) p = d.looping.start + (p - d.looping.end);
  return p;
}

export function useDeckTele<T>(deck: number, pick: (d: DeckTele) => T): T {
  return useTelemetry((s) => pick(s.t.decks[deck] ?? emptyDeck));
}
