// Arrange editing commands shared by the toolbar, the keyboard and the clip menu: copy,
// cut, paste, duplicate, split and delete on the selected clips, markers and the loop.
import { keyLabel } from "../../lib/platform";
import { toast } from "sonner";
import { addMarker, clipsInBox, copyClips, duplicateClips, markerNear, pasteClips, removeClips, splitClip, type ClipBoard } from "../../lib/arrangeOps";
import { useApp } from "../../store/app";
import { useArrangeUi } from "./ArrangeParts";
import { playPreview, stopPreview, usePreview } from "./preview";
import { projectBeats, setProject } from "./projectIo";

let board: ClipBoard | null = null;

const project = () => useApp.getState().project;
export const selectedIds = () => {
  const p = project();
  const ids = useArrangeUi.getState().selected;
  return p ? ids.filter((id) => p.clips.some((c) => c.id === id)) : [];
};
export const select = (ids: number[]) => useArrangeUi.getState().set({ selected: ids, ...(ids.length ? { tempoSel: null } : {}) });
const plural = (n: number) => `${n} clip${n === 1 ? "" : "s"}`;

function needSelection(): number[] | null {
  const ids = selectedIds();
  if (!ids.length) {
    toast.message("Select a clip first", { description: `Click a clip, ${keyLabel("Mod")}-click to add more, or drag a box around several.` });
    return null;
  }
  return ids;
}

export function selectAll() {
  const p = project();
  if (p) select(p.clips.map((c) => c.id));
}

export function copySelection(): boolean {
  const p = project();
  const ids = needSelection();
  if (!p || !ids) return false;
  board = copyClips(p, ids);
  toast.success(`Copied ${plural(ids.length)}`, { description: `Click the ruler where they should go, then paste with ${keyLabel("Mod+V")}.` });
  return true;
}

export function cutSelection() {
  const p = project();
  const ids = needSelection();
  if (!p || !ids) return;
  board = copyClips(p, ids);
  setProject(removeClips(p, ids), undefined, undefined, `Cut ${plural(ids.length)}`);
  select([]);
}

/** Pastes at the play marker (where you last clicked the ruler). */
export function paste() {
  const p = project();
  if (!p) return;
  if (!board) {
    toast.message("Nothing to paste", { description: "Copy or cut some clips first." });
    return;
  }
  const at = usePreview.getState().cursor;
  const { project: next, ids } = pasteClips(p, board, at);
  setProject(next, undefined, undefined, `Paste ${plural(ids.length)}`);
  select(ids);
  // Move the marker past what was pasted, so pasting again lines the copies up.
  usePreview.getState().set({ cursor: at + Math.ceil(board.span / 4) * 4 });
}

export function duplicateSelection() {
  const p = project();
  const ids = needSelection();
  if (!p || !ids) return;
  const { project: next, ids: made } = duplicateClips(p, ids);
  setProject(next, undefined, undefined, `Duplicate ${plural(ids.length)}`);
  select(made);
}

export function deleteSelection() {
  const p = project();
  const ids = needSelection();
  if (!p || !ids) return;
  setProject(removeClips(p, ids), undefined, undefined, `Remove ${plural(ids.length)}`);
  select([]);
}

/**
 * Cuts clips at a beat (the play marker by default): the selected clips, or every clip
 * under the marker when none is selected.
 */
export function splitAt(beat = usePreview.getState().cursor, only?: number[]) {
  let p = project();
  if (!p) return;
  const sel = only ?? selectedIds();
  const targets = p.clips.filter((c) => (sel.length ? sel.includes(c.id) : true) && beat > c.start && beat < c.start + c.length).map((c) => c.id);
  if (!targets.length) {
    toast.message("Nothing to cut here", { description: "Click the ruler to put the play marker over a clip, then cut. Alt-click a clip to cut it where you click." });
    return;
  }
  const made: number[] = [];
  for (const id of targets) {
    const r = splitClip(p, id, beat);
    p = r.project;
    made.push(...r.ids);
  }
  setProject(p, undefined, undefined, `Cut ${plural(targets.length)} in two`);
  select(made.filter((_, i) => i % 2 === 1));
}

export function selectBox(beatA: number, beatB: number, laneA: number, laneB: number, add: boolean) {
  const p = project();
  if (!p) return;
  const ids = clipsInBox(p, beatA, beatB, laneA, laneB);
  select(add ? [...new Set([...selectedIds(), ...ids])] : ids);
}

export function addMarkerAtCursor() {
  const p = project();
  if (!p) return;
  const beat = usePreview.getState().cursor;
  const { project: next, index } = addMarker(p, beat);
  if (next === p) toast.message("There is already a marker here");
  else setProject(next, undefined, undefined, `Add “${next.markers[index].label}”`);
}

export function jumpToMarker(dir: 1 | -1) {
  const p = project();
  if (!p) return;
  const m = markerNear(p, usePreview.getState().cursor, dir);
  if (m) usePreview.getState().set({ cursor: m.beat });
}

/** The stretch Loop repeats when none is set: the selection, or 8 bars from the marker. */
function defaultLoop(): { from: number; to: number } {
  const p = project();
  const ids = selectedIds();
  if (p && ids.length) {
    const sel = p.clips.filter((c) => ids.includes(c.id));
    return { from: Math.min(...sel.map((c) => c.start)), to: Math.max(...sel.map((c) => c.start + c.length)) };
  }
  const from = usePreview.getState().cursor;
  return { from, to: from + 32 };
}

export function toggleLoop() {
  const ui = useArrangeUi.getState();
  const on = !ui.looping;
  ui.set({ looping: on, loop: on ? (ui.loop ?? defaultLoop()) : ui.loop });
  if (usePreview.getState().status !== "idle") play();
}

/** Plays from the marker, or round the loop while Loop is on. */
export function play() {
  const p = project();
  if (!p || !p.clips.length) return;
  const { looping, loop } = useArrangeUi.getState();
  if (looping && loop && loop.to > loop.from) {
    void playPreview(p, loop.from, loop.to, true);
    return;
  }
  const cursor = usePreview.getState().cursor;
  void playPreview(p, cursor, Math.min(projectBeats(p) + 8, cursor + 128));
}

export function togglePlay() {
  if (usePreview.getState().status !== "idle") stopPreview();
  else play();
}

/** Runs an Arrange command from the keyboard or palette. False when it is not one. */
export function runArrangeCommand(name: string): boolean {
  if (useApp.getState().workspace !== "arrange" || !project()) return false;
  switch (name) {
    case "clip_copy":
      copySelection();
      return true;
    case "clip_cut":
      cutSelection();
      return true;
    case "clip_paste":
      paste();
      return true;
    case "clip_duplicate":
      duplicateSelection();
      return true;
    case "clip_delete":
      deleteSelection();
      return true;
    case "clip_split":
      splitAt();
      return true;
    case "select_all":
      selectAll();
      return true;
    case "marker_add":
      addMarkerAtCursor();
      return true;
    case "marker_next":
      jumpToMarker(1);
      return true;
    case "marker_prev":
      jumpToMarker(-1);
      return true;
    case "arrange_loop":
      toggleLoop();
      return true;
    case "arrange_play":
      togglePlay();
      return true;
    default:
      return false;
  }
}

export const ARRANGE_COMMANDS = ["clip_copy", "clip_cut", "clip_paste", "clip_duplicate", "clip_delete", "clip_split", "select_all", "marker_add", "marker_next", "marker_prev", "arrange_loop", "arrange_play"];
