// Listening to part of an arrangement: the backend renders the passage, the webview
// plays it, and the timeline follows along.
import { create } from "zustand";
import { toast } from "sonner";
import { backend } from "../../backend";
import type { MixProject } from "../../backend/types";

interface PreviewState {
  status: "idle" | "loading" | "playing";
  from: number;
  to: number;
  /** Where Play starts (set by clicking the ruler). */
  cursor: number;
  audio: HTMLAudioElement | null;
  set: (p: Partial<PreviewState>) => void;
}

export const usePreview = create<PreviewState>((set) => ({ status: "idle", from: 0, to: 0, cursor: 0, audio: null, set: (p) => set(p) }));

let url: string | null = null;
let request = 0;

export function stopPreview() {
  request++;
  const { audio } = usePreview.getState();
  audio?.pause();
  if (url) URL.revokeObjectURL(url);
  url = null;
  usePreview.getState().set({ status: "idle", audio: null });
}

/** Plays a passage of the mix; with `loop` it repeats until stopped. */
export async function playPreview(project: MixProject, from: number, to: number, loop = false) {
  stopPreview();
  const my = ++request;
  usePreview.getState().set({ status: "loading", from, to });
  try {
    const wav = await backend().previewProject(project, from, to);
    if (my !== request) return;
    url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const audio = new Audio(url);
    audio.loop = loop;
    audio.onended = () => my === request && stopPreview();
    await audio.play();
    usePreview.getState().set({ status: "playing", audio });
  } catch (e) {
    if (my !== request) return;
    usePreview.getState().set({ status: "idle", audio: null });
    toast.error(`Could not preview: ${e instanceof Error ? e.message : String(e)}`);
  }
}
