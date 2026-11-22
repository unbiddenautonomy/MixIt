// Hear a mix first: renders a planned transition (Auto DJ's next mix, or the change between
// two tracks in its queue) and plays it in the preview player, in the headphones, so you
// know how it will sound before the audience does.
import { create } from "zustand";
import { toast } from "sonner";
import { backend } from "../backend";
import type { TrackDetail, TrackRow } from "../backend/types";
import type { MixPlan } from "../lib/autodj";
import { medley, rehearsal } from "../lib/rehearse";
import { useApp } from "./app";
import { planFor, useAutoDj } from "./autodj";
import { queueStart } from "./queueFlow";
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
  /** Every transition in what is loaded (one for a single mix, each change for a set). */
  changes: { at: number; end: number; label: string }[];
}

const IDLE: RehearseState = { key: null, status: "idle", title: "", summary: "", duration: 0, mixAt: 0, mixEnd: 0, changes: [] };

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
  useRehearse.setState({ key, status: "loading", title: `${out.track.title} into ${inc.track.title}`, summary: plan.summary, duration: 0, mixAt: r.mixAt, mixEnd: r.mixEnd, changes: [{ at: r.mixAt, end: r.mixEnd, label: plan.summary }] });
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
    await hearMix(key, out, inc, planFor(out, inc));
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

/** The longest set Rehearse the set plays (changes): about ten minutes. */
export const MAX_CHANGES = 24;

/** Every change in the Auto DJ queue (from the track waiting or playing), one after another. */
export async function hearSet() {
  const { queue } = useAutoDj.getState();
  const start = queueStart();
  const rows = [...(start ? [start] : []), ...queue].slice(0, MAX_CHANGES + 1);
  if (rows.length < 2) {
    toast("Add at least two tracks to the queue to rehearse the set.");
    return;
  }
  if (!safeToHear()) return;
  const my = ++request;
  const n = rows.length - 1;
  useRehearse.setState({ ...IDLE, key: "set", status: "loading", title: `The whole set: ${n} change${n === 1 ? "" : "s"}` });
  useTrackPreview.setState({ track: null, loading: false, sections: [], cues: [] });
  sendSettings();
  try {
    const details = await Promise.all(rows.map((r) => backend().trackDetail(r.id)));
    if (my !== request) return;
    const steps = details.slice(1).map((inc, i) => ({ out: details[i], inc, plan: planFor(details[i], inc) }));
    const m = medley(steps);
    const changes = m.changes.map((c, i) => ({ ...c, label: `${c.label}: ${steps[i].plan.summary.toLowerCase()}` }));
    useRehearse.setState({ summary: `${n} change${n === 1 ? "" : "s"}, a few bars either side of each`, mixAt: changes[0].at, mixEnd: changes[0].end, changes });
    const duration = await backend().previewMix(m.project, m.from, m.to);
    if (my !== request) return;
    useRehearse.setState({ status: "ready", duration });
  } catch (e) {
    if (my !== request) return;
    useRehearse.setState(IDLE);
    toast.error(`Could not rehearse the set: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The change being heard now (or the next one when between changes), for the bar. */
export function changeAt(seconds: number): number {
  const c = useRehearse.getState().changes;
  const i = c.findIndex((x) => seconds < x.end);
  return i < 0 ? c.length - 1 : i;
}

/** Jumps to just before the next change (from where the player is). */
export function nextChange(position: number) {
  const c = useRehearse.getState().changes;
  const next = c.find((x) => x.at - 4 > position + 0.5) ?? c[0];
  if (next) seekMix(Math.max(0, next.at - 4));
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
