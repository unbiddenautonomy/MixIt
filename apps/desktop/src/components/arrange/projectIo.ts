// Opening, saving and rendering mix projects, and small project helpers shared by the
// Arrange view.
import { toast } from "sonner";
import { backend } from "../../backend";
import type { Clip, MixProject } from "../../backend/types";
import { useApp } from "../../store/app";

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

export function setProject(p: MixProject | null, path?: string | null) {
  useApp.getState().set(path === undefined ? { project: p } : { project: p, projectPath: path });
}

export function updateClip(id: number, patch: Partial<Clip>) {
  const p = useApp.getState().project;
  if (!p) return;
  setProject({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

export async function openProject() {
  const f = await backend().pickFiles(["mixit", "json"], "MixIt project");
  if (!f?.[0]) return;
  try {
    const p = await backend().openProject(f[0]);
    setProject(p, f[0]);
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
    setProject(project, path);
    toast.success("Project saved", { description: path });
  } catch (e) {
    toast.error(String(e));
  }
}

export async function renderProject() {
  const { project } = useApp.getState();
  if (!project || project.clips.length === 0) {
    toast.message("Nothing to render yet. Make a mix with Automix first.");
    return;
  }
  const path = await backend().pickSave(`${project.name}.wav`, ["wav", "flac"]);
  if (!path) return;
  try {
    await backend().renderProject(project, path);
    toast.message("Rendering your mix…", { description: "Progress shows in Arrange. You can keep working." });
  } catch (e) {
    toast.error(String(e));
  }
}
