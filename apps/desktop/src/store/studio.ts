// Studio strips as the UI knows them. The engine keeps the live settings; the UI keeps a
// copy of every strip someone opened or changed, so it can draw the EQ and send the
// settings again after the engine restarts.
import { create } from "zustand";
import { backend } from "../backend";
import type { MixProject, StudioDto } from "../backend/types";
import { useApp } from "./app";
import { WARMTH_MAX_DB, defaultStudio, glueComp, punchComp } from "../lib/studio";

/** Index of the master strip (channels are 0..3). */
export const MASTER_STRIP = 4;

interface StudioStore {
  /** Known settings per strip (decks 0..3, master 4); null until first loaded. */
  settings: (StudioDto | null)[];
  /** The strip whose studio panel is open. */
  open: number | null;
  /** The Arrange lane (0..3, or MASTER_STRIP for the mix's master) whose studio is open. */
  lane: number | null;
  /** Loudness target for the master (an id from LOUDNESS_TARGETS). */
  target: string;
  set: (p: Partial<StudioStore>) => void;
}

export const useStudio = create<StudioStore>((set) => ({
  settings: [null, null, null, null, null],
  open: null,
  lane: null,
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
  useStudio.getState().set(strip === null ? { open: null } : { open: strip, lane: null });
  if (strip !== null) void loadStudio(strip);
  // The spectrum analyser runs only while a studio panel shows it.
  void backend()
    .setScope(strip === null ? "off" : strip === MASTER_STRIP ? "master" : strip)
    .catch(() => undefined);
}

/** Opens the studio for an Arrange lane or the project's master (MASTER_STRIP). */
export function openLaneStudio(lane: number | null) {
  if (lane !== null && useStudio.getState().open !== null) openStudio(null);
  useStudio.getState().set({ lane });
}

/** Level change (dB) that brings a measured loudness to a target, kept to what the
 * master output can do. Null when the measurement is silence. */
export function matchGainDb(measuredLufs: number, targetLufs: number, currentOutputDb: number): number | null {
  if (!Number.isFinite(measuredLufs) || measuredLufs < -60) return null;
  const next = currentOutputDb + (targetLufs - measuredLufs);
  return Math.round(Math.max(-24, Math.min(12, next)) * 10) / 10;
}

/** Echo times in beats, in the order of the registry's `mixer.echo.time` choices. */
export const ECHO_BEATS = [0.25, 0.5, 0.75, 1, 2, 4];

/** A recorded mix with the live sound added: every deck's and the master's studio strip
 * and the shared reverb and echo, so it plays back in Arrange as it sounded. */
export async function withLiveSound(p: MixProject): Promise<MixProject> {
  const all = await Promise.all([0, 1, 2, 3, MASTER_STRIP].map((i) => loadStudio(i)));
  const m = useApp.getState().mixer;
  return {
    ...p,
    strips: all.slice(0, 4),
    master_strip: all[MASTER_STRIP],
    returns: { space_level_db: m.spaceLevel, space_size: m.spaceSize, echo_level_db: m.echoLevel, echo_feedback: m.echoFeedback, echo_beats: ECHO_BEATS[m.echoTime] ?? 0.75 },
  };
}
