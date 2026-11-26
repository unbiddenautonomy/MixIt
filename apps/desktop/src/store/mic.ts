// The mic channel as the UI knows it. The engine does not report its control values back,
// so they live here (mirrored from every mic.* action, see lib/actions.ts) and are sent
// again whenever the mic is reconnected or the engine restarts.
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../backend";
import type { MicState, MicTake } from "../backend/types";
import { useApp } from "./app";

export interface MicControls {
  onAir: boolean;
  level: number;
  gain: number;
  cue: boolean;
  talkover: boolean;
  depth: number;
  high: number;
  mid: number;
  low: number;
  lowCut: boolean;
  gate: boolean;
  mono: boolean;
}

/** Where a mic recording goes when it stops. */
export type TakeTarget = "pad" | "library";

interface MicStore extends MicControls {
  state: MicState;
  recording: boolean;
  target: TakeTarget;
  /** The pad a "pad" take goes onto. */
  pad: number;
  lastTake: (MicTake & { target: TakeTarget; pad: number }) | null;
  set: (p: Partial<MicStore>) => void;
}

export const MIC_DEFAULTS: MicControls = {
  onAir: false,
  level: 0.8,
  gain: 0,
  cue: false,
  talkover: true,
  depth: -12,
  high: 0,
  mid: 0,
  low: 0,
  lowCut: true,
  gate: false,
  mono: true,
};

export const useMic = create<MicStore>((set) => ({
  ...MIC_DEFAULTS,
  state: { status: null, error: null, lost: false },
  recording: false,
  target: "pad",
  pad: 0,
  lastTake: null,
  set: (p) => set(p),
}));

/** Keeps the store in step with a mic.* action from any source (keys, palette, labs). */
export function mirrorMic(control: string, input: { type: string; value?: number | boolean }) {
  const s = useMic.getState();
  const v = input.type === "value" ? Number(input.value) : input.type === "set" ? Number(input.value) : null;
  const flip = (cur: boolean) => (input.type === "press" ? !cur : v !== null ? v > 0.5 : cur);
  const p: Partial<MicControls> = {};
  switch (control) {
    case "on_air":
      p.onAir = flip(s.onAir);
      break;
    case "cue":
      p.cue = flip(s.cue);
      break;
    case "talkover":
      p.talkover = flip(s.talkover);
      break;
    case "low_cut":
      p.lowCut = flip(s.lowCut);
      break;
    case "gate":
      p.gate = flip(s.gate);
      break;
    case "mono":
      p.mono = flip(s.mono);
      break;
    case "level":
      if (v !== null) p.level = v;
      break;
    case "gain":
      if (v !== null) p.gain = v;
      break;
    case "talkover_depth":
      if (v !== null) p.depth = v;
      break;
    case "eq.high":
      if (v !== null) p.high = v;
      break;
    case "eq.mid":
      if (v !== null) p.mid = v;
      break;
    case "eq.low":
      if (v !== null) p.low = v;
      break;
  }
  if (Object.keys(p).length) s.set(p);
}

/** Sends every mic control to the engine (after it was rebuilt or the mic reconnected). */
export async function syncMic() {
  const s = useMic.getState();
  const b = backend();
  const on = (id: string, value: boolean) => b.action(id, { type: "set", value });
  const val = (id: string, value: number) => b.action(id, { type: "value", value });
  await Promise.all([
    on("mic.on_air", s.onAir),
    on("mic.cue", s.cue),
    on("mic.talkover", s.talkover),
    on("mic.low_cut", s.lowCut),
    on("mic.gate", s.gate),
    on("mic.mono", s.mono),
    val("mic.level", s.level),
    val("mic.gain", s.gain),
    val("mic.talkover_depth", s.depth),
    val("mic.eq.high", s.high),
    val("mic.eq.mid", s.mid),
    val("mic.eq.low", s.low),
  ]).catch(() => undefined);
}

export async function refreshMic(): Promise<MicState> {
  const state = await backend().micState();
  useMic.getState().set({ state });
  return state;
}

/** Turns the mic input on or off (the system or browser may ask for permission). */
export async function setMicEnabled(on: boolean, patch: { micDevice?: string | null; micChannel?: number; micStereo?: boolean; micVoice?: boolean; micDenoise?: "strong" | "light" | "off" } = {}) {
  const { updateSettings } = await import("../lib/appCommands");
  if (!on) {
    // Never leave the audience hearing a mic that was just switched off.
    useMic.getState().set({ onAir: false });
    await backend().action("mic.on_air", { type: "set", value: false }).catch(() => undefined);
    if (useMic.getState().recording) await stopMicRecording().catch(() => undefined);
  }
  await updateSettings({ micEnabled: on, ...patch });
  const st = await refreshMic().catch(() => null);
  if (on && st?.status) await syncMic();
  if (on && st?.error) toast.error(st.error);
}

export async function startMicRecording() {
  const s = useMic.getState();
  if (s.recording) return;
  if (!useApp.getState().settings?.micEnabled) {
    toast.error("Turn the mic on first.");
    return;
  }
  try {
    await backend().micRecordStart();
    s.set({ recording: true, lastTake: null });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** Stops the recording and puts the take where it was meant to go. */
export async function stopMicRecording(): Promise<MicTake | null> {
  const s = useMic.getState();
  if (!s.recording) return null;
  s.set({ recording: false });
  const { target, pad } = s;
  try {
    const take = await backend().micRecordStop(target === "pad");
    s.set({ lastTake: { ...take, target, pad } });
    if (target === "pad") {
      const { loadPad } = await import("../components/sampler/SamplerPanel");
      const info = await loadPad(pad, { type: "file", path: take.path });
      if (info) toast.success(`Your recording (${take.seconds.toFixed(1)} s) is on pad ${pad + 1}.`);
    } else {
      await backend().addToLibrary([take.path]);
      toast.success(`Your recording (${Math.round(take.seconds)} s) is being added to the library.`);
    }
    return take;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

export function toggleMicRecording() {
  return useMic.getState().recording ? stopMicRecording() : startMicRecording();
}
