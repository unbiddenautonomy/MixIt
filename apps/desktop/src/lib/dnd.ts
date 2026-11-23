// Dragging tracks and files onto decks, pads, playlists and the Arrange timeline.
//
// Tracks are dragged with pointer events, not HTML5 drag and drop: the desktop webview on
// Windows hands drag and drop to the system (so dropped files arrive with their paths),
// which leaves HTML5 drops inside the page dead there. Pointer drags work the same in
// every webview and browser.
//
// Files come from outside: in the desktop app as the system's drop event (with paths and
// the point where they landed), in a browser as an HTML5 drop of File objects, which the
// backend keeps under paths it can open later. Either way they go to the target under the
// pointer: a deck loads the first track, a pad takes the sound, a playlist or the Arrange
// timeline takes the tracks, and anywhere else adds them to the library. Mix projects,
// rekordbox and Traktor collections and playlists open or import as they would from their menus.
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { backend, isTauri } from "../backend";
import { openProjectAt } from "../components/arrange/projectIo";
import { fileName } from "./platform";

export interface DropContext {
  x: number;
  y: number;
  el: HTMLElement;
}

export interface DropHandlers {
  /** Library tracks dropped here (dropped audio files are imported first). */
  tracks?: (ids: number[], at: DropContext) => void | Promise<void>;
  /** Audio files dropped here, when the target wants the files themselves (a pad). */
  files?: (paths: string[], at: DropContext) => void | Promise<void>;
  /** What happens on drop, shown next to the pointer ("Load on deck A"). */
  label: string;
}

interface DragState {
  /** "tracks" while a track drag runs, "files" while files hover the window. */
  kind: "tracks" | "files" | null;
  ids: number[];
  text: string;
  x: number;
  y: number;
  /** The drop target under the pointer. */
  over: string | null;
  set: (p: Partial<DragState>) => void;
}

export const useDrag = create<DragState>((set) => ({ kind: null, ids: [], text: "", x: 0, y: 0, over: null, set: (p) => set(p) }));

const targets = new Map<string, { current: DropHandlers }>();

/**
 * Makes an element a drop target. Spread `props` on it; `over` is true while something
 * that it accepts hovers it.
 */
export function useDropTarget(key: string, handlers: DropHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    targets.set(key, ref);
    return () => {
      if (targets.get(key) === ref) targets.delete(key);
    };
  }, [key]);
  const over = useDrag((s) => s.over === key && s.kind !== null);
  return { props: { "data-drop": key }, over };
}

/** What dropping on a target does, for the drag hint. */
export function labelFor(key: string): string | null {
  return targets.get(key)?.current.label ?? null;
}

function targetAt(x: number, y: number): { key: string; el: HTMLElement; h: DropHandlers } | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) {
    const key = el.dataset?.drop;
    const h = key ? targets.get(key)?.current : undefined;
    if (key && h) return { key, el, h };
    el = el.parentElement;
  }
  return null;
}

// ------------------------------------------------------------------ track drags

const THRESHOLD = 5;

/**
 * Call from a pointerdown on something that can be dragged as tracks. The drag only
 * starts once the pointer moves a few pixels, so clicks and double-clicks still work.
 */
export function beginTrackDrag(e: React.PointerEvent | PointerEvent, ids: number[] | (() => number[]), text: string | (() => string)) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let started = false;
  const s = useDrag.getState();
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
      started = true;
      const list = typeof ids === "function" ? ids() : ids;
      s.set({ kind: "tracks", ids: list, text: typeof text === "function" ? text() : text });
      document.body.classList.add("dragging-tracks");
    }
    const t = targetAt(ev.clientX, ev.clientY);
    s.set({ x: ev.clientX, y: ev.clientY, over: t?.h.tracks || t?.h.files ? t.key : null });
  };
  const end = (ev: PointerEvent, drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    if (!started) return;
    document.body.classList.remove("dragging-tracks");
    const list = useDrag.getState().ids;
    s.set({ kind: null, ids: [], over: null });
    if (!drop) return;
    const t = targetAt(ev.clientX, ev.clientY);
    if (t?.h.tracks && list.length) {
      void Promise.resolve(t.h.tracks(list, { x: ev.clientX, y: ev.clientY, el: t.el })).catch(report);
    }
  };
  const up = (ev: PointerEvent) => end(ev, true);
  const cancel = (ev: PointerEvent) => end(ev, false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") end(new PointerEvent("pointercancel"), false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}

function report(e: unknown) {
  toast.error(e instanceof Error ? e.message : String(e));
}

// ------------------------------------------------------------------ file drops

const AUDIO = ["wav", "mp3", "flac", "aiff", "aif", "ogg", "m4a", "aac", "opus", "wma", "alac"];
const ext = (p: string) => (/\.([^./\\]+)$/.exec(p)?.[1] ?? "").toLowerCase();
const isAudio = (p: string) => AUDIO.includes(ext(p));

/** Sorts dropped paths into what MixIt can do with them. */
export function classify(paths: string[]) {
  const out = { audio: [] as string[], projects: [] as string[], rekordbox: [] as string[], traktor: [] as string[], playlists: [] as string[], folders: [] as string[], other: [] as string[] };
  for (const p of paths) {
    const e = ext(p);
    if (isAudio(p)) out.audio.push(p);
    else if (e === "mixit") out.projects.push(p);
    else if (e === "xml") out.rekordbox.push(p);
    else if (e === "nml") out.traktor.push(p);
    else if (e === "m3u" || e === "m3u8") out.playlists.push(p);
    else if (e === "") out.folders.push(p);
    else out.other.push(p);
  }
  return out;
}

/** Imports audio files and returns their library ids, in order. */
async function importAll(paths: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const p of paths) {
    try {
      ids.push((await backend().importTrack(p)).id);
    } catch (e) {
      report(e);
    }
  }
  return ids;
}

/** Handles files dropped at a point in the window. */
export async function dropFiles(paths: string[], x: number, y: number) {
  const c = classify(paths);
  const t = targetAt(x, y);
  const at = t ? { x, y, el: t.el } : null;
  const done: string[] = [];
  if (t && at && c.audio.length) {
    if (t.h.files) {
      await t.h.files(c.audio, at);
      c.audio = [];
    } else if (t.h.tracks) {
      const ids = await importAll(c.audio);
      if (ids.length) await t.h.tracks(ids, at);
      c.audio = [];
    }
  }
  if (c.audio.length || c.folders.length) {
    await backend().addToLibrary([...c.folders, ...c.audio]);
    done.push(c.folders.length ? "Adding the folder to your library" : `Adding ${c.audio.length === 1 ? "the track" : `${c.audio.length} tracks`} to your library`);
  }
  if (c.projects.length) {
    await openProjectAt(c.projects[0]);
  }
  if (!isTauri() && (c.rekordbox.length || c.traktor.length || c.playlists.length)) {
    // The browser only gets the file, not the music it points to on disk.
    done.push("Playlists and DJ app collections can only be imported in the desktop app");
    c.rekordbox = [];
    c.traktor = [];
    c.playlists = [];
  }
  for (const p of c.rekordbox) {
    await backend().importRekordbox(p);
    done.push("Importing the rekordbox collection");
  }
  for (const p of c.traktor) {
    await backend().importTraktor(p);
    done.push("Importing the Traktor collection");
  }
  for (const p of c.playlists) {
    const n = await backend().importM3u(p);
    done.push(`Imported a playlist of ${n} tracks`);
  }
  if (c.other.length && !done.length && !c.projects.length) toast.error("MixIt cannot open that kind of file. Drop music files, folders, mix projects (.mixit), playlists (.m3u) or a rekordbox (.xml) or Traktor (.nml) collection.");
  if (done.length) toast.message(done.join(". "));
}

/** Files from an HTML5 drop, including the contents of dropped folders. */
async function filesOf(dt: DataTransfer): Promise<File[]> {
  const items = [...dt.items].filter((i) => i.kind === "file");
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (e: FileSystemEntry, path: string): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push(path ? new File([f], f.name, { type: f.type, lastModified: f.lastModified }) : f);
      if (path) Object.defineProperty(out[out.length - 1], "webkitRelativePath", { value: `${path}/${f.name}` });
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, path ? `${path}/${e.name}` : e.name);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/** Listens for files dragged in from outside. Returns a function that stops listening. */
export function installFileDrop(): () => void {
  const s = useDrag.getState();
  if (isTauri()) {
    let off: (() => void) | null = null;
    let stopped = false;
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((ev) => {
        const p = ev.payload;
        const dpr = window.devicePixelRatio || 1;
        if (p.type === "enter" || p.type === "over") {
          const x = p.position.x / dpr;
          const y = p.position.y / dpr;
          const t = targetAt(x, y);
          s.set({ kind: "files", x, y, over: t?.key ?? null, text: p.type === "enter" ? describe(p.paths) : useDrag.getState().text });
        } else if (p.type === "drop") {
          const x = p.position.x / dpr;
          const y = p.position.y / dpr;
          s.set({ kind: null, over: null });
          void dropFiles(p.paths, x, y).catch(report);
        } else {
          s.set({ kind: null, over: null });
        }
      });
      if (stopped) un();
      else off = un;
    });
    return () => {
      stopped = true;
      off?.();
    };
  }
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  let leaveTimer = 0;
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    window.clearTimeout(leaveTimer);
    const t = targetAt(e.clientX, e.clientY);
    s.set({ kind: "files", x: e.clientX, y: e.clientY, over: t?.key ?? null, text: "" });
  };
  const leave = () => {
    // dragleave fires when crossing into children too: clear only if nothing follows.
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => s.set({ kind: null, over: null }), 80);
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    s.set({ kind: null, over: null });
    const dt = e.dataTransfer;
    const { clientX: x, clientY: y } = e;
    void filesOf(dt)
      .then((files) => {
        const paths = backend().registerFiles(files);
        return dropFiles(paths, x, y);
      })
      .catch(report);
  };
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
}

function describe(paths: string[]): string {
  const c = classify(paths);
  if (c.audio.length === 1 && paths.length === 1) return fileName(paths[0]) || "1 track";
  if (c.audio.length) return `${c.audio.length} tracks`;
  if (c.folders.length) return c.folders.length === 1 ? "A folder" : `${c.folders.length} folders`;
  if (c.projects.length) return "A mix project";
  return `${paths.length} files`;
}
