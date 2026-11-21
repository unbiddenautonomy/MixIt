// The preview player: listen to a library track in the headphones without loading it on a
// deck. The engine plays it; this store remembers which track it is, its sections and
// cues for the jump buttons, and the volume and output the listener chose.
import { create } from "zustand";
import { toast } from "sonner";
import { backend } from "../backend";
import type { CueDto, PreviewRoute, SectionDto, TrackRow } from "../backend/types";
import { useApp } from "./app";
import { useTelemetry } from "./telemetry";

export type RouteChoice = "auto" | PreviewRoute;

interface Saved {
  gain: number;
  route: RouteChoice;
  /** Play in time with the decks. */
  sync: boolean;
}

const KEY = "mixit.preview";

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return { gain: typeof s?.gain === "number" ? s.gain : 0.8, route: s?.route === "headphones" || s?.route === "speakers" ? s.route : "auto", sync: s?.sync === true };
  } catch {
    return { gain: 0.8, route: "auto", sync: false };
  }
}

function save() {
  const { gain, route, sync } = useTrackPreview.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ gain, route, sync }));
  } catch {
    // Private windows: settings last for the session.
  }
}

interface PreviewState extends Saved {
  track: TrackRow | null;
  duration: number;
  sections: SectionDto[];
  cues: CueDto[];
  loading: boolean;
}

export const useTrackPreview = create<PreviewState>(() => ({ ...load(), track: null, duration: 0, sections: [], cues: [], loading: false }));

/** Headphones when the app has a separate headphone output, otherwise the speakers. */
export function resolveRoute(choice: RouteChoice): PreviewRoute {
  if (choice !== "auto") return choice;
  return backend().kind === "tauri" && useApp.getState().settings?.cueChannel != null ? "headphones" : "speakers";
}

function sendSettings() {
  const { gain, route, sync } = useTrackPreview.getState();
  void backend().previewSettings(gain, resolveRoute(route)).catch(() => {});
  void backend().previewSync(sync).catch(() => {});
}

/** Starts previewing `row` at `at` seconds (by default where the music starts). */
export async function previewTrack(row: TrackRow, at?: number) {
  if (row.missing) {
    toast.error("This track's file is missing. Find it in Fix library first.");
    return;
  }
  useTrackPreview.setState({ track: row, duration: row.duration, sections: [], cues: [], loading: true });
  sendSettings();
  const b = backend();
  try {
    const detail = b.trackDetail(row.id).catch(() => null);
    const d0 = await detail;
    // Start where the music starts (the first section or the load cue), not on silence.
    const start = at ?? d0?.cues.find((c) => c.role === "load")?.seconds ?? 0;
    const duration = await b.previewLoad(row.id, start);
    if (useTrackPreview.getState().track?.id !== row.id) return;
    useTrackPreview.setState({ duration, sections: d0?.sections ?? [], cues: d0?.cues ?? [], loading: false });
  } catch (e) {
    if (useTrackPreview.getState().track?.id === row.id) useTrackPreview.setState({ track: null, loading: false });
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

export function isPreviewing(id: number): boolean {
  const t = useTelemetry.getState().t.preview;
  return useTrackPreview.getState().track?.id === id && (t?.playing || useTrackPreview.getState().loading);
}

/** Plays or pauses the track in the preview player, or starts `row` if it is another one. */
export function togglePreview(row?: TrackRow) {
  const s = useTrackPreview.getState();
  if (row && s.track?.id !== row.id) {
    void previewTrack(row);
    return;
  }
  if (!s.track) return;
  const t = useTelemetry.getState().t.preview;
  void backend().previewPlay(!t?.playing);
}

export function seekPreview(seconds: number) {
  const { duration } = useTrackPreview.getState();
  void backend().previewSeek(Math.max(0, Math.min(duration, seconds)));
  void backend().previewPlay(true);
}

/** Jumps by `delta` seconds from where the preview is. */
export function nudgePreview(delta: number) {
  seekPreview((useTelemetry.getState().t.preview?.position ?? 0) + delta);
}

export function closePreview() {
  useTrackPreview.setState({ track: null, loading: false, sections: [], cues: [] });
  void backend().previewClose();
}

export function setPreviewGain(gain: number) {
  useTrackPreview.setState({ gain });
  save();
  sendSettings();
}

export function setPreviewRoute(route: RouteChoice) {
  useTrackPreview.setState({ route });
  save();
  sendSettings();
}

/** Plays the preview in time with the decks (tempo matched, bars lined up), or at its own speed. */
export function setPreviewSync(sync: boolean) {
  useTrackPreview.setState({ sync });
  save();
  void backend().previewSync(sync).catch(() => {});
}
