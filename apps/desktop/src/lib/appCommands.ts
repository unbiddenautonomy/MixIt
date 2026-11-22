// App-side commands: the `app.*` registry actions (handled by the UI, not the engine),
// the coach's one-click fixes, and settings changes.
import { singingAt } from "./coach";
import { mixNow, startAutoDj, stopAutoDj, useAutoDj } from "../store/autodj";
import { orderQueue, saveQueue } from "../store/queueFlow";
import { mixQueue } from "../store/queueMix";
import { hearSet } from "../store/rehearse";
import { hearComingMix, mixItNow } from "./smartMix";
import { togglePreview, useTrackPreview } from "../store/trackPreview";
import { toggleSequencer } from "../store/sequencer";
import { runArrangeCommand } from "../components/arrange/editing";
import { setAssistantOpen, useAssistant } from "../components/feedback/MixAssistant";
import { withLiveSound } from "../store/studio";
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
import { cueSheet, stemOf, tracklistFromCapture, tracklistText, type TracklistEntry } from "./tracklist";
import { HOT_CUE_COLORS } from "./waveform";
import { act, setValue, tap } from "./actions";
import { toProjectKey } from "./arrangeOps";
import { startTransition, type TransitionId } from "./transition";
import { mixReport, type MixReport } from "./feedback";
import { showReport, useReport } from "../components/feedback/MixReport";
import { startTour } from "../guide/tour";
import { openEditor } from "../components/editor/TrackEditor";
import { redoLibrary, undoLibrary } from "./libraryUndo";

export async function updateSettings(patch: Partial<Settings>) {
  const cur = useApp.getState().settings;
  if (!cur) return;
  const next = { ...cur, ...patch };
  useApp.getState().set({ settings: next });
  try {
    const saved = await backend().saveSettings(next);
    useApp.getState().set({ settings: saved });
    if ("safetyLoop" in patch) await backend().action("global.safety_loop", { type: "set", value: saved.safetyLoop !== false });
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
  return { hash: null, path: t.path, title: t.title, artist: t.artist, bpm: info.detail.bpm ?? t.bpm ?? 120, key: toProjectKey(info.detail.key ?? t.key), duration: t.duration };
}

function startCapture() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `Live mix ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  const c = new MixCapture(name, useApp.getState().audio?.sampleRate ?? 48_000);
  capture = c;
  captureOff?.();
  captureOff = useTelemetry.subscribe((s) => c.add(s.t, useApp.getState().mixer, trackRefFor, (d, secs) => singingAt(useApp.getState().decks[d], secs)));
}

function stopCapture(): { project: MixProject | null; report: MixReport | null; tracklist: TracklistEntry[]; name: string } {
  captureOff?.();
  captureOff = null;
  const c = capture;
  capture = null;
  if (!c) return { project: null, report: null, tracklist: [], name: "Mix" };
  const cap = c.capture();
  return { project: buildProject(cap), report: mixReport(cap), tracklist: tracklistFromCapture(cap), name: cap.name };
}

/** Writes the tracklist beside a recording on the desktop: a CUE sheet and a text list. */
async function saveTracklist(path: string, name: string, list: TracklistEntry[]): Promise<boolean> {
  if (!list.length || !path || backend().kind !== "tauri") return false;
  const base = stemOf(path);
  try {
    await backend().saveText(`${base}.cue`, cueSheet(list, path, name));
    await backend().saveText(`${base}.txt`, tracklistText(list));
    return true;
  } catch {
    return false;
  }
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
      const captured = stopCapture();
      const report = captured.report;
      const project = captured.project ? await withLiveSound(captured.project).catch(() => captured.project) : null;
      const listed = await saveTracklist(path, captured.name, captured.tracklist);
      if (report) showReport(report, project, path, { entries: captured.tracklist, name: captured.name, saved: listed });
      const also = listed ? ` The tracklist (${captured.tracklist.length} tracks) is saved beside it as a CUE sheet.` : "";
      toast.success("Recording saved", {
        description: project ? `${path}.${also} Every move you made was captured too: open it in Arrange to fix a transition or a fade.` : `${path}.${also}`,
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
    case "autodj":
      if (useAutoDj.getState().phase === "off") {
        s.set({ workspace: "library" });
        useLibrary.getState().set({ source: { type: "autodj" } });
        void startAutoDj();
      } else stopAutoDj();
      return true;
    case "mix_it":
      mixItNow();
      return true;
    case "hear_mix":
      hearComingMix();
      return true;
    case "mix_now":
      if (useAutoDj.getState().phase === "off") toast.message("Auto DJ is not playing", { description: "Start Auto DJ first, or press T to Mix it yourself." });
      else void mixNow();
      return true;
    case "rehearse_set":
      void hearSet();
      return true;
    case "make_mix":
      void mixQueue();
      return true;
    case "best_order":
      orderQueue();
      return true;
    case "save_queue":
      void saveQueue();
      return true;
    case "sequencer":
      s.set({ workspace: "mix", samplerOpen: true, samplerTab: "seq" });
      toggleSequencer();
      return true;
    case "assistant":
      setAssistantOpen(!useAssistant.getState().open);
      return true;
    case "coach":
      updateSettings({ coach: !s.settings?.coach });
      return true;
    case "tour":
      startTour();
      return true;
    case "feedback":
      if (useReport.getState().report) useReport.setState({ open: true });
      else toast.message("No feedback yet", { description: "Press Rec, mix two or more tracks, then stop recording. MixIt then tells you how the mix went." });
      return true;
    case "edit_track":
      openEditor(s.targetDeck);
      return true;
    case "preview": {
      // The selected library track; pressing again on the same one pauses it.
      const lib = useLibrary.getState();
      const id = lib.selected[0] ?? useTrackPreview.getState().track?.id;
      const row = lib.rows.find((r) => r.id === id) ?? useTrackPreview.getState().track;
      if (row) togglePreview(row);
      else toast.message("Select a track in the library first", { description: "Then press P to hear it in your headphones." });
      return true;
    }
    case "workspace":
      s.set({ workspace: WORKSPACES[p[2]] ?? "mix" });
      return true;
    case "undo":
    case "redo": {
      if (s.workspace === "library") {
        void (p[1] === "undo" ? undoLibrary() : redoLibrary()).then((ok) => ok || toast.message(p[1] === "undo" ? "Nothing to undo" : "Nothing to redo"));
        return true;
      }
      const ok = s.workspace === "arrange" && (p[1] === "undo" ? undoProject() : redoProject());
      if (!ok) toast.message(p[1] === "undo" ? "Nothing to undo" : "Nothing to redo");
      return true;
    }
    default:
      return runArrangeCommand(p[1]);
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
  if (run === "mid-cut" && arg) {
    setValue(`mixer.${String.fromCharCode(65 + arg[0])}.eq.mid`, -18);
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
