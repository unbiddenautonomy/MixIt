// Hear a mix first: renders a planned transition (Auto DJ's next mix, or the change between
// two tracks in its queue) and plays it in the preview player, in the headphones, so you
// know how it will sound before the audience does.
import { create } from "zustand";
import { toast } from "sonner";
import { backend } from "../backend";
import type { TrackDetail, TrackRow } from "../backend/types";
import { planMix, type MixPlan } from "../lib/autodj";
import { rehearsal } from "../lib/rehearse";
import { useApp } from "./app";
import { useAutoDj } from "./autodj";
import { useTelemetry } from "./telemetry";
import { resolveRoute, sendSettings, useTrackPreview } from "./trackPreview";

interface RehearseState {
  /** Which mix is loaded ("next", or "<out id>-<in id>" for a pair in the queue). */
  key: string | null;
  status: "idle" | "loading" | "ready";
  title: string;
  summary: string;
  duration: number;
  /** Seconds into the passage where the transition starts and ends. */
  mixAt: number;
  mixEnd: number;
}

const IDLE: RehearseState = { key: null, status: "idle", title: "", summary: "", duration: 0, mixAt: 0, mixEnd: 0 };

export const useRehearse = create<RehearseState>(() => IDLE);

let request = 0;

/** Whether any deck is playing with its channel up, so the audience hears it. */
export function musicOnAir(): boolean {
  const { decks } = useTelemetry.getState().t;
  const ch = useApp.getState().mixer.channels;
  return decks.some((d, i) => d.loaded && d.playing && (ch[i]?.fader ?? 1) > 0.05);
}

/** Whether a mix can be heard now without the audience hearing it too (says why not). */
function safeToHear(): boolean {
  if (resolveRoute(useTrackPreview.getState().route) === "speakers" && musicOnAir()) {
    toast.error("The preview would play on the speakers while music is playing, so the audience would hear it. Choose a headphone output in Settings (Audio), or stop the music first.");
    return false;
  }
  return true;
}

/** Plays `plan` (from `out` into `inc`) in the preview player. */
export async function hearMix(key: string, out: TrackDetail, inc: TrackDetail, plan: MixPlan) {
  if (!safeToHear()) {
    request++;
    useRehearse.setState(IDLE);
    return;
  }
  const my = ++request;
  // The preview player plays one thing: the mix takes over from a track preview.
  useTrackPreview.setState({ track: null, loading: false, sections: [], cues: [] });
  const r = rehearsal(out, inc, plan);
  useRehearse.setState({ key, status: "loading", title: `${out.track.title} into ${inc.track.title}`, summary: plan.summary, duration: 0, mixAt: r.mixAt, mixEnd: r.mixEnd });
  sendSettings();
  try {
    const duration = await backend().previewMix(r.project, r.from, r.to);
    if (my !== request) return;
    useRehearse.setState({ status: "ready", duration });
  } catch (e) {
    if (my !== request) return;
    useRehearse.setState(IDLE);
    toast.error(`Could not play the mix: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Plans the change from `a` into `b` with Auto DJ's settings and plays it. */
export async function hearPair(a: TrackRow, b: TrackRow) {
  const key = `${a.id}-${b.id}`;
  if (!safeToHear()) return;
  const my = ++request;
  useRehearse.setState({ ...IDLE, key, status: "loading", title: `${a.title} into ${b.title}` });
  try {
    const [out, inc] = await Promise.all([backend().trackDetail(a.id), backend().trackDetail(b.id)]);
    if (my !== request) return;
    await hearMix(key, out, inc, planMix(out, inc, useAutoDj.getState().options));
  } catch (e) {
    if (my !== request) return;
    useRehearse.setState(IDLE);
    toast.error(`Could not plan that mix: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Auto DJ's next planned mix, from the deck playing now. */
export async function hearNext() {
  const { current, next } = useAutoDj.getState();
  const out = current !== null ? useApp.getState().decks[current]?.detail : null;
  if (!out || !next) return;
  await hearMix("next", out, next.detail, next.plan);
}

export function toggleMix() {
  const s = useRehearse.getState();
  if (s.status !== "ready") return;
  const p = useTelemetry.getState().t.preview;
  if (!p?.playing && (p?.position ?? 0) >= s.duration - 0.05) void backend().previewSeek(0);
  void backend().previewPlay(!p?.playing);
}

export function seekMix(seconds: number) {
  const s = useRehearse.getState();
  if (s.status !== "ready") return;
  void backend().previewSeek(Math.max(0, Math.min(s.duration, seconds)));
  void backend().previewPlay(true);
}

export function stopMix() {
  request++;
  if (useRehearse.getState().key !== null) void backend().previewClose();
  useRehearse.setState(IDLE);
}

// A track preview takes the player back: forget the mix (the player already replaced it).
useTrackPreview.subscribe((s, prev) => {
  if (s.track && s.track !== prev.track && useRehearse.getState().key !== null) {
    request++;
    useRehearse.setState(IDLE);
  }
});
