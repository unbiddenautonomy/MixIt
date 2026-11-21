// Undo and redo for library changes: playlist edits (remove, reorder, tidy, order for
// mixing), deleted playlists and folders, and track details. Each change is kept as a
// pair of steps; the toast after a change offers Undo, and Ctrl+Z / Ctrl+Shift+Z work
// while the Library is in front.
import { toast } from "sonner";
import { backend } from "../backend";
import type { PlaylistDto, TrackEdit, TrackRow } from "../backend/types";
import { refreshPlaylists, refreshRows } from "../components/library/data";
import { useLibrary } from "../store/library";

export interface Change {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const LIMIT = 50;
let done: Change[] = [];
let undone: Change[] = [];

export function libraryHistory() {
  return { undo: done.map((c) => c.label), redo: undone.map((c) => c.label) };
}

export function clearLibraryHistory() {
  done = [];
  undone = [];
}

async function refresh() {
  await refreshPlaylists();
  await refreshRows();
}

/**
 * Keeps a change that has just been made, and shows `message` with an Undo button
 * (pass `toastIt: false` when the caller shows its own message).
 */
export function remember(change: Change, message?: string, toastIt = true) {
  done.push(change);
  if (done.length > LIMIT) done.shift();
  undone = [];
  if (toastIt) toast.success(message ?? change.label, { action: { label: "Undo", onClick: () => void undoLibrary() } });
}

export async function undoLibrary(): Promise<boolean> {
  const c = done.pop();
  if (!c) return false;
  try {
    await c.undo();
    undone.push(c);
    await refresh();
    toast.message(`Undid: ${c.label}`, { action: { label: "Redo", onClick: () => void redoLibrary() } });
  } catch (e) {
    toast.error(`Could not undo: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}

export async function redoLibrary(): Promise<boolean> {
  const c = undone.pop();
  if (!c) return false;
  try {
    await c.redo();
    done.push(c);
    await refresh();
    toast.message(`Redid: ${c.label}`);
  } catch (e) {
    toast.error(`Could not redo: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}

// ------------------------------------------------------------------ playlist tracks

/**
 * Runs `change` on a list and keeps the tracks before and after, so it can be undone.
 * Returns what `change` returned.
 */
export async function withPlaylistUndo<T>(id: number, label: string, change: () => Promise<T>, message?: string): Promise<T> {
  const before = (await backend().playlistTracks(id)).map((t) => t.id);
  const out = await change();
  const after = (await backend().playlistTracks(id)).map((t) => t.id);
  if (before.length !== after.length || before.some((v, i) => v !== after[i])) {
    remember(
      {
        label,
        undo: () => backend().setPlaylistTracks(id, before),
        redo: () => backend().setPlaylistTracks(id, after),
      },
      message,
    );
  }
  return out;
}

// ------------------------------------------------------------------ deleted playlists

interface Saved {
  p: PlaylistDto;
  tracks: number[];
  kids: Saved[];
  position: number;
}

function save(p: PlaylistDto, all: PlaylistDto[], tracksOf: Map<number, number[]>): Saved {
  const siblings = all.filter((x) => x.parent === p.parent);
  return {
    p,
    tracks: tracksOf.get(p.id) ?? [],
    kids: all.filter((x) => x.parent === p.id).map((k) => save(k, all, tracksOf)),
    position: siblings.indexOf(p),
  };
}

async function restore(s: Saved, parent: number | null): Promise<number> {
  const id = await backend().createPlaylist(s.p.name, s.p.kind, { parent, query: s.p.query, tracks: s.p.kind === "list" ? s.tracks : undefined });
  await backend().movePlaylist(id, parent, s.position);
  for (const k of s.kids) await restore(k, id);
  return id;
}

/** Deletes a playlist or folder (with everything in it), keeping enough to bring it back. */
export async function deletePlaylistWithUndo(id: number) {
  const all = useLibrary.getState().playlists;
  const p = all.find((x) => x.id === id);
  if (!p) return;
  // The lists inside, with their tracks.
  const lists: number[] = [];
  const walk = (x: PlaylistDto) => {
    if (x.kind === "list") lists.push(x.id);
    all.filter((k) => k.parent === x.id).forEach(walk);
  };
  walk(p);
  const tracksOf = new Map<number, number[]>();
  for (const l of lists) tracksOf.set(l, (await backend().playlistTracks(l)).map((t) => t.id));
  const saved = save(p, all, tracksOf);
  let current = id;
  await backend().deletePlaylist(id);
  remember({
    label: `Delete “${p.name}”`,
    undo: async () => {
      current = await restore(saved, p.parent);
    },
    redo: () => backend().deletePlaylist(current),
  }, `Deleted “${p.name}”`);
}

// ------------------------------------------------------------------ track details

/** The fields of `edit` as they are now on each row, to put back on undo. */
export function reverseEdit(rows: TrackRow[], edit: TrackEdit): Map<number, TrackEdit> {
  const out = new Map<number, TrackEdit>();
  for (const r of rows) {
    const back: Record<string, unknown> = {};
    for (const k of Object.keys(edit) as (keyof TrackEdit)[]) back[k] = r[k];
    out.set(r.id, back as TrackEdit);
  }
  return out;
}

/** Edits tracks and keeps what they were, so the edit can be undone. */
export async function editTracksWithUndo(rows: TrackRow[], edit: TrackEdit, label: string, message?: string, toastIt = true): Promise<TrackRow | null> {
  const before = reverseEdit(rows, edit);
  const ids = rows.map((r) => r.id);
  let row: TrackRow | null = null;
  if (ids.length === 1) row = await backend().editTrack(ids[0], edit);
  else await backend().editTracks(ids, edit);
  remember(
    {
      label,
      undo: async () => {
        for (const [id, e] of before) await backend().editTrack(id, e);
      },
      redo: async () => {
        if (ids.length === 1) await backend().editTrack(ids[0], edit);
        else await backend().editTracks(ids, edit);
      },
    },
    message,
    toastIt,
  );
  return row;
}
