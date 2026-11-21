// App-side commands: the `app.*` registry actions (handled by the UI, not the engine),
// the coach's one-click fixes, and settings changes.
import { toast } from "sonner";
import { backend } from "../backend";
import type { Settings } from "../backend/types";
import { useApp, type Workspace } from "../store/app";
import { useLibrary } from "../store/library";
import { livePosition, useTelemetry } from "../store/telemetry";
import { quantized } from "../components/deck/Pads";
import { refreshRows } from "../components/library/data";
import { confirmDiscard, openProject, redoProject, saveProject, setProject, undoProject } from "../components/arrange/projectIo";
import type { MixProject, TrackRef } from "../backend/types";
import { buildProject, MixCapture } from "./capture";
import { HOT_CUE_COLORS } from "./waveform";
import { act, setValue, tap } from "./actions";
import { startTransition, type TransitionId } from "./transition";

export async function updateSettings(patch: Partial<Settings>) {
  const cur = useApp.getState().settings;
  if (!cur) return;
  const next = { ...cur, ...patch };
  useApp.getState().set({ settings: next });
  try {
    const saved = await backend().saveSettings(next);
    useApp.getState().set({ settings: saved });
    if ("device" in patch || "bufferFrames" in patch || "sampleRate" in patch || "cueChannel" in patch) {
      useApp.getState().set({ audio: await backend().audioStatus() });
    }
  } catch (e) {
    useApp.getState().set({ settings: cur });
    toast.error(`Could not save settings: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const WORKSPACES: Record<string, Workspace> = { library: "library", decks: "mix", mix: "mix", arrange: "arrange", edit: "arrange" };

// While recording, every deck and mixer move is captured too, so the mix can be opened
// in Arrange and fixed afterwards (see lib/capture.ts).
let capture: MixCapture | null = null;
let captureOff: (() => void) | null = null;

function trackRefFor(deck: number): TrackRef | null {
  const info = useApp.getState().decks[deck];
  if (!info) return null;
  const t = info.detail.track;
  return { hash: null, path: t.path, title: t.title, artist: t.artist, bpm: info.detail.bpm ?? t.bpm ?? 120, key: null, duration: t.duration };
}

function startCapture() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `Live mix ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  const c = new MixCapture(name, useApp.getState().audio?.sampleRate ?? 48_000);
  capture = c;
  captureOff?.();
  captureOff = useTelemetry.subscribe((s) => c.add(s.t, useApp.getState().mixer, trackRefFor));
}

function stopCapture(): MixProject | null {
  captureOff?.();
  captureOff = null;
  const c = capture;
  capture = null;
  return c ? buildProject(c.capture()) : null;
}

/** Opens a captured live mix in Arrange (asking first if the open project has unsaved edits). */
export async function openCapturedMix(p: MixProject) {
  if (!(await confirmDiscard("open the recorded mix"))) return;
  setProject(p, null);
  useApp.getState().set({ workspace: "arrange" });
}

export async function toggleRecording() {
  const rec = useTelemetry.getState().t.recording;
  try {
    if (rec) {
      const path = await backend().recordStop();
      const project = stopCapture();
      toast.success("Recording saved", {
        description: project ? `${path}. Every move you made was captured too: open it in Arrange to fix a transition or a fade.` : path,
        action: project ? { label: "Edit in Arrange", onClick: () => void openCapturedMix(project) } : undefined,
        duration: project ? 15_000 : undefined,
      });
    } else {
      await backend().recordStart();
      startCapture();
      toast.message("Recording", { description: "Everything on the master output is being saved, and every move you make, so you can edit the mix afterwards." });
    }
  } catch (e) {
    toast.error(String(e));
  }
}

/** Runs an `app.*` action. Returns true when handled. */
export function runApp(id: string): boolean {
  const s = useApp.getState();
  const p = id.split(".");
  if (p[0] !== "app") return false;
  switch (p[1]) {
    case "palette":
      s.set({ paletteOpen: !s.paletteOpen });
      return true;
    case "settings":
      s.set({ settingsOpen: true });
      return true;
    case "view_mode":
      updateSettings({ viewMode: s.settings?.viewMode === "pro" ? "easy" : "pro" });
      return true;
    case "explain":
      s.set({ explainHeld: true });
      return true;
    case "save":
    case "save_as":
      saveProject(p[1] === "save_as");
      return true;
    case "open":
      openProject();
      return true;
    case "sampler":
      s.set(s.workspace === "mix" ? { samplerOpen: !s.samplerOpen } : { workspace: "mix", samplerOpen: true });
      return true;
    case "guide":
      s.set({ guideOpen: !s.guideOpen });
      return true;
    case "coach":
      updateSettings({ coach: !s.settings?.coach });
      return true;
    case "workspace":
      s.set({ workspace: WORKSPACES[p[2]] ?? "mix" });
      return true;
    case "undo":
    case "redo": {
      const ok = s.workspace === "arrange" && (p[1] === "undo" ? undoProject() : redoProject());
      if (!ok) toast.message(p[1] === "undo" ? "Nothing to undo" : "Nothing to redo");
      return true;
    }
    default:
      return false;
  }
}

/** Runs a coach or palette command: registry actions, app actions and UI helpers. */
export function runCommand(run: string, arg?: number[]) {
  if (run === "app.transition" && arg) {
    const tr = useApp.getState().transitions.find((t) => t.id === "bassSwap") ?? useApp.getState().transitions[0];
    startTransition(arg[0], arg[1], (tr?.id ?? "blend") as TransitionId, tr?.beats ?? 32);
    return;
  }
  if (run === "app.suggest") {
    useApp.getState().set({ workspace: "mix" });
    useLibrary.getState().set({ source: { type: "suggest" }, suggestFor: null });
    refreshRows();
    return;
  }
  if (run === "bass-cut" && arg) {
    setValue(`mixer.${String.fromCharCode(65 + arg[0])}.eq.low`, -26);
    return;
  }
  if (run === "global.record") {
    toggleRecording();
    return;
  }
  if (runApp(run)) {
    if (run === "app.explain") window.setTimeout(() => useApp.getState().set({ explainHeld: false, explain: !useApp.getState().explain }), 0);
    return;
  }
  const spec = useApp.getState().registry.find((a) => a.id === run);
  if (spec?.kind.type === "toggle") act(run, { type: "press" });
  else tap(run);
}

/** Keyboard shortcuts the app handles itself before they reach the engine. */
export function handleShortcut(id: string): boolean {
  if (id === "global.record") {
    toggleRecording();
    return true;
  }
  const m = /^deck\.([A-D])\.hotcue\.(\d)$/.exec(id);
  if (m) {
    const deck = m[1].charCodeAt(0) - 65;
    const slot = Number(m[2]) - 1;
    const info = useApp.getState().decks[deck];
    if (info && !info.detail.cues.some((c) => c.role === "hot" && c.slot === slot)) {
      backend().setHotCue(deck, slot, quantized(deck, livePosition(deck)), null, HOT_CUE_COLORS[slot]);
      return true;
    }
    return false;
  }
  return runApp(id);
}
