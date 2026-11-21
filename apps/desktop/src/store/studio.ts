// Studio strips as the UI knows them. The engine keeps the live settings; the UI keeps a
// copy of every strip someone opened or changed, so it can draw the EQ and send the
// settings again after the engine restarts.
import { create } from "zustand";
import { backend } from "../backend";
import type { StudioDto } from "../backend/types";
import { WARMTH_MAX_DB, defaultStudio, glueComp, punchComp } from "../lib/studio";

/** Index of the master strip (channels are 0..3). */
export const MASTER_STRIP = 4;

interface StudioStore {
  /** Known settings per strip (decks 0..3, master 4); null until first loaded. */
  settings: (StudioDto | null)[];
  /** The strip whose studio panel is open. */
  open: number | null;
  /** Loudness target for the master (an id from LOUDNESS_TARGETS). */
  target: string;
  set: (p: Partial<StudioStore>) => void;
}

export const useStudio = create<StudioStore>((set) => ({
  settings: [null, null, null, null, null],
  open: null,
  target: "streaming",
  set: (p) => set(p),
}));

const channelArg = (strip: number) => (strip === MASTER_STRIP ? null : strip);

/** Reads a strip's settings from the engine (once) and returns them. */
export async function loadStudio(strip: number): Promise<StudioDto> {
  const have = useStudio.getState().settings[strip];
  if (have) return have;
  const s = await backend()
    .studioGet(channelArg(strip))
    .catch(() => defaultStudio());
  store(strip, s);
  return s;
}

function store(strip: number, s: StudioDto) {
  useStudio.setState((st) => ({ settings: st.settings.map((x, i) => (i === strip ? s : x)) }));
}

/** Changes a strip and sends the result to the engine. */
export async function updateStudio(strip: number, change: (s: StudioDto) => StudioDto) {
  const cur = await loadStudio(strip);
  const next = change(structuredClone(cur));
  store(strip, next);
  await backend().studioSet(channelArg(strip), next);
}

/** Keeps known settings in step with one-knob actions (punch, warmth, width, gate, glue).
 * `v` is null for a toggle press. */
export function mirrorStudio(deck: number | null, control: string, v: number | null) {
  const strip = deck ?? MASTER_STRIP;
  const s = useStudio.getState().settings[strip];
  if (!s) return;
  let next: StudioDto | null = null;
  if (control === "punch" && v !== null) next = { ...s, compOn: v > 0.001, comp: punchComp(v) };
  else if (control === "glue" && v !== null) next = { ...s, compOn: v > 0.001, comp: glueComp(v) };
  else if (control === "warmth" && v !== null) next = { ...s, satOn: v > 0.001, driveDb: WARMTH_MAX_DB * v };
  else if (control === "width" && v !== null) next = { ...s, width: v };
  else if (control === "gate") next = { ...s, gateOn: v === null ? !s.gateOn : v > 0.5 };
  if (next) store(strip, next);
}

/** Sends every known strip to the engine (after it restarted). */
export async function pushStudio() {
  const b = backend();
  const all = useStudio.getState().settings;
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s) await b.studioSet(channelArg(i), s).catch(() => undefined);
  }
}

/** Opens the studio panel for a strip (and loads its settings). */
export function openStudio(strip: number | null) {
  useStudio.getState().set({ open: strip });
  if (strip !== null) void loadStudio(strip);
  // The spectrum analyser runs only while a studio panel shows it.
  void backend()
    .setScope(strip === null ? "off" : strip === MASTER_STRIP ? "master" : strip)
    .catch(() => undefined);
}

/** Level change (dB) that brings a measured loudness to a target, kept to what the
 * master output can do. Null when the measurement is silence. */
export function matchGainDb(measuredLufs: number, targetLufs: number, currentOutputDb: number): number | null {
  if (!Number.isFinite(measuredLufs) || measuredLufs < -60) return null;
  const next = currentOutputDb + (targetLufs - measuredLufs);
  return Math.round(Math.max(-24, Math.min(12, next)) * 10) / 10;
}
