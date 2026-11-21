// Opening, saving and rendering mix projects, and small project helpers shared by the
// Arrange view.
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../../backend";
import type { Clip, MixProject } from "../../backend/types";
import { useApp } from "../../store/app";
import { ask } from "../shell/Dialogs";

export function emptyProject(name = "Untitled mix", bpm = 124): MixProject {
  return { version: 1, name, tempo: { segments: [{ start_beat: 0, bpm, end_bpm: bpm }], time_signatures: [{ start_beat: 0, numerator: 4, denominator: 4 }] }, clips: [], markers: [], master_gain_db: 0, next_id: 1 };
}

/** Tempo at `beat` (segments can ramp from bpm to end_bpm). */
export function bpmAt(p: MixProject, beat: number): number {
  const segs = p.tempo.segments;
  if (segs.length === 0) return 120;
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].start_beat <= beat) i++;
  const s = segs[i];
  const next = segs[i + 1];
  if (!next || s.bpm === s.end_bpm) return s.bpm;
  const f = (beat - s.start_beat) / Math.max(1e-9, next.start_beat - s.start_beat);
  return s.bpm + (s.end_bpm - s.bpm) * Math.max(0, Math.min(1, f));
}

/** Seconds from the project start to `beat`, integrating the tempo map. */
export function beatToSeconds(p: MixProject, beat: number): number {
  const segs = p.tempo.segments.length ? p.tempo.segments : [{ start_beat: 0, bpm: 120, end_bpm: 120 }];
  let t = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const end = i + 1 < segs.length ? segs[i + 1].start_beat : Infinity;
    if (beat <= s.start_beat) break;
    const b1 = Math.min(beat, end);
    const len = b1 - s.start_beat;
    if (s.bpm === s.end_bpm || !Number.isFinite(end)) t += (len * 60) / s.bpm;
    else {
      // Linear ramp in BPM over the segment: integrate 60 / bpm(b) db.
      const k = (s.end_bpm - s.bpm) / (end - s.start_beat);
      const bpmAtB1 = s.bpm + k * len;
      t += Math.abs(k) < 1e-9 ? (len * 60) / s.bpm : (60 / k) * Math.log(bpmAtB1 / s.bpm);
    }
  }
  return t;
}

export function projectBeats(p: MixProject): number {
  return p.clips.reduce((m, c) => Math.max(m, c.start + c.length), 0);
}

// Undo history for project edits. Edits with the same key in quick succession (one
// drag, typing a name) count as one step. Each step keeps a plain-language label so the
// history can be shown and jumped through.
interface Step {
  project: MixProject;
  label: string;
}
const undoStack: Step[] = [];
const redoStack: Step[] = [];
let lastKey = "";
let lastAt = 0;

/** What the History list shows: labels of the edits that can be undone and redone. */
export const useHistory = create<{ undo: string[]; redo: string[]; base: string }>(() => ({ undo: [], redo: [], base: "Opened" }));
const publish = () => useHistory.setState({ undo: undoStack.map((s) => s.label), redo: redoStack.map((s) => s.label).reverse() });

const CLIP_LABELS: Record<string, string> = {
  start: "Move clip",
  lane: "Move clip to another deck",
  length: "Trim clip",
  source_start: "Change where the clip starts in its track",
  gain_db: "Change clip gain",
  key_shift: "Change clip key",
  keylock: "Turn key lock on or off",
  lanes: "Edit automation",
  fx: "Change clip effect",
  name: "Rename clip",
};

/** A label for an edit key from `updateClip` and friends. */
export function labelFor(key?: string): string {
  if (!key) return "Edit";
  if (key === "name") return "Rename mix";
  const m = /^clip:\d+:(.+)$/.exec(key);
  if (m) {
    const fields = m[1].split(",");
    return CLIP_LABELS[fields[0]] ?? "Edit clip";
  }
  return key;
}

/**
 * With a path (or null), replaces the project (open, new, close) and clears the
 * history. Without one, records an edit that can be undone, under `label` (or a label
 * made from `key`).
 */
export function setProject(p: MixProject | null, path?: string | null, key?: string, label?: string) {
  if (path !== undefined) {
    undoStack.length = 0;
    redoStack.length = 0;
    lastKey = "";
    useHistory.setState({ base: !p ? "Opened" : path ? "Opened" : p.name.startsWith("Live mix") ? "Recorded" : "Started" });
    publish();
    // A project made by Automix has no file yet, so it counts as unsaved.
    useApp.getState().set({ project: p, projectPath: path, projectDirty: !!p && !path });
    return;
  }
  const cur = useApp.getState().project;
  const now = performance.now();
  if (cur && !(key && key === lastKey && now - lastAt < 1500)) {
    undoStack.push({ project: cur, label: label ?? labelFor(key) });
    if (undoStack.length > 200) undoStack.shift();
  }
  lastKey = key ?? "";
  lastAt = now;
  redoStack.length = 0;
  publish();
  useApp.getState().set({ project: p, projectDirty: true });
}

export function undoProject(): boolean {
  const cur = useApp.getState().project;
  const prev = undoStack.pop();
  if (!prev || !cur) return false;
  redoStack.push({ project: cur, label: prev.label });
  lastKey = "";
  publish();
  useApp.getState().set({ project: prev.project, projectDirty: true });
  return true;
}

export function redoProject(): boolean {
  const cur = useApp.getState().project;
  const next = redoStack.pop();
  if (!next || !cur) return false;
  undoStack.push({ project: cur, label: next.label });
  lastKey = "";
  publish();
  useApp.getState().set({ project: next.project, projectDirty: true });
  return true;
}

/**
 * Goes to a point in the history: `done` edits applied (0 is how the project started,
 * the undo list's length is now). Edits after it can be redone.
 */
export function jumpHistory(done: number) {
  while (undoStack.length > done && undoProject());
  while (undoStack.length < done && redoProject());
}

export function updateClip(id: number, patch: Partial<Clip>, label?: string) {
  const p = useApp.getState().project;
  if (!p) return;
  setProject({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, undefined, `clip:${id}:${Object.keys(patch).join(",")}`, label);
}

/**
 * Asks before throwing away unsaved project edits. Resolves true when it is fine to
 * replace the project (nothing unsaved, or the user chose to discard).
 */
export async function confirmDiscard(action = "continue"): Promise<boolean> {
  const { project, projectDirty } = useApp.getState();
  if (!project || !projectDirty) return true;
  return ask({
    title: `Discard changes to “${project.name}”?`,
    body: `Your edits to this mix are not saved. If you ${action}, they are lost. Save first with ${navigator.platform.includes("Mac") ? "⌘S" : "Ctrl+S"} or the Save button.`,
    confirm: "Discard changes",
    cancel: "Keep editing",
    danger: true,
  });
}

/** Closes the project, after asking if it has unsaved edits. */
export async function closeProject() {
  if (await confirmDiscard("close it")) setProject(null, null);
}

export async function openProject() {
  if (!(await confirmDiscard("open another project"))) return;
  const f = await backend().pickFiles(["mixit", "json"], "MixIt project");
  if (!f?.[0]) return;
  await openAt(f[0]);
}

/** Opens a project file (dropped on the window, for example). */
export async function openProjectAt(path: string) {
  if (!(await confirmDiscard("open another project"))) return;
  await openAt(path);
}

async function openAt(path: string) {
  try {
    const p = await backend().openProject(path);
    setProject(p, path);
    useApp.getState().set({ workspace: "arrange" });
    const issues = await backend().checkProject(p);
    if (issues.length) toast.warning(`${issues.length} problem${issues.length === 1 ? "" : "s"} in this project`, { description: issues.slice(0, 3).join("\n") });
  } catch (e) {
    toast.error(`Could not open the project: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function saveProject(saveAs: boolean) {
  const { project, projectPath } = useApp.getState();
  if (!project) {
    toast.message("Nothing to save yet. Make a mix with Automix or drag tracks into Arrange.");
    return;
  }
  let path = projectPath;
  if (!path || saveAs) path = await backend().pickSave(`${project.name}.mixit`, ["mixit"]);
  if (!path) return;
  try {
    await backend().saveProject(path, project);
    // Edits made while the save ran stay unsaved.
    const still = useApp.getState().project === project;
    useApp.getState().set({ projectPath: path, projectDirty: !still });
    toast.success("Project saved", { description: path });
  } catch (e) {
    toast.error(String(e));
  }
}

export interface ExportChoice {
  format: "wav" | "flac";
  /** Integrated loudness to turn the finished mix to; null keeps it as mixed. */
  targetLufs: number | null;
}

export async function renderProject(choice: ExportChoice = { format: "wav", targetLufs: null }) {
  const { project } = useApp.getState();
  if (!project || project.clips.length === 0) {
    toast.message("Nothing to render yet. Make a mix with Automix first.");
    return;
  }
  const path = await backend().pickSave(`${project.name}.${choice.format}`, [choice.format]);
  if (!path) return;
  try {
    await backend().renderProject(project, path, choice.format, choice.targetLufs);
    toast.message("Rendering your mix…", { description: "Progress shows in Arrange. You can keep working." });
  } catch (e) {
    toast.error(String(e));
  }
}

/** Renders one file per deck lane, for finishing the mix in another program. */
export async function renderStems(format: "wav" | "flac") {
  const { project } = useApp.getState();
  if (!project || project.clips.length === 0) {
    toast.message("Nothing to export yet. Make a mix with Automix first.");
    return;
  }
  const kind = backend().kind;
  let folder = "";
  if (kind === "tauri") {
    const picked = await backend().pickSave(`${project.name} - stems`, []);
    if (!picked) return;
    folder = picked;
  }
  try {
    await backend().renderStems(project, folder, format);
    toast.message("Exporting stems…", { description: kind === "tauri" ? `One file per deck, in ${folder}` : "One file per deck, to your downloads." });
  } catch (e) {
    toast.error(String(e));
  }
}

/** The beat heard `seconds` after `fromBeat` (inverse of beatToSeconds). */
export function beatAfter(p: MixProject, fromBeat: number, seconds: number): number {
  const t0 = beatToSeconds(p, fromBeat);
  let lo = fromBeat;
  let hi = fromBeat + (seconds * 400) / 60 + 1; // no tempo is above 400 BPM
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (beatToSeconds(p, mid) - t0 < seconds) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
