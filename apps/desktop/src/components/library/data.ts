// Loading library data into the store for whatever the sidebar has selected.
import { toast } from "sonner";
import { backend } from "../../backend";
import type { TrackRow } from "../../backend/types";
import { useApp } from "../../store/app";
import { useLibrary } from "../../store/library";
import { useTelemetry } from "../../store/telemetry";
import { ask } from "../shell/Dialogs";

let seq = 0;

function fail(e: unknown) {
  toast.error(e instanceof Error ? e.message : String(e));
}

/** Plain-text filter for lists that the backend does not search (playlists, history). */
export function localFilter(rows: TrackRow[], query: string): TrackRow[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
  if (words.length === 0) return rows;
  return rows.filter((r) => {
    const hay = `${r.title} ${r.artist} ${r.album} ${r.genre} ${r.label} ${r.comment}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export async function refreshRows() {
  const my = ++seq;
  const { source, query, set } = useLibrary.getState();
  // The Auto DJ and Fix library pages show their own lists.
  if (source.type === "autodj" || source.type === "care") return;
  set({ loading: true });
  try {
    let rows: TrackRow[] = [];
    if (source.type === "all") rows = await backend().search(query);
    else if (source.type === "playlist") {
      const pl = useLibrary.getState().playlists.find((p) => p.id === source.id);
      // Smart lists run their query plus whatever is typed in the search box.
      if (pl?.kind === "smart" && pl.query) rows = await backend().search(`${pl.query} ${query}`.trim());
      else rows = localFilter(await backend().playlistTracks(source.id), query);
    } else if (source.type === "history") {
      const h = await backend().history();
      const all = await backend().search("");
      const byId = new Map(all.map((r) => [r.id, r]));
      rows = h
        .slice()
        .reverse()
        .map((e) => (e.track_id != null ? byId.get(e.track_id) : undefined))
        .filter((r): r is TrackRow => !!r);
      rows = localFilter(rows, query);
    } else if (source.type === "suggest") {
      await refreshSuggestions();
      rows = useLibrary.getState().suggestions.map((s) => s.track);
    }
    if (my === seq) set({ rows, loading: false });
  } catch (e) {
    if (my === seq) set({ loading: false });
    fail(e);
  }
}

export async function refreshPlaylists() {
  try {
    useLibrary.getState().set({ playlists: await backend().playlists() });
  } catch (e) {
    fail(e);
  }
}

export async function refreshStats() {
  try {
    useLibrary.getState().set({ stats: await backend().stats() });
  } catch (e) {
    fail(e);
  }
}

/** The track suggestions follow: the chosen one, else the master or playing deck's. */
export function suggestionSeed(): number | null {
  const { suggestFor } = useLibrary.getState();
  if (suggestFor != null) return suggestFor;
  const { decks } = useApp.getState();
  const t = useTelemetry.getState().t;
  const order = [t.masterDeck, ...t.decks.map((d, i) => (d.playing ? i : -1)), ...decks.map((d, i) => (d ? i : -1))];
  for (const i of order) if (i != null && i >= 0 && decks[i]) return decks[i]!.detail.track.id;
  return null;
}

export async function refreshSuggestions() {
  const seed = suggestionSeed();
  const { energy, set } = useLibrary.getState();
  if (seed == null) {
    set({ suggestions: [] });
    return;
  }
  try {
    set({ suggestions: await backend().suggestNext(seed, energy, 60) });
  } catch (e) {
    fail(e);
  }
}

export async function refreshAll() {
  await Promise.all([refreshPlaylists(), refreshStats(), refreshCare()]);
  await refreshRows();
}

/** Checks for missing files and duplicates (shown under Fix library). */
export async function refreshCare() {
  try {
    const [missing, duplicates] = await Promise.all([backend().missingTracks(), backend().duplicates()]);
    useLibrary.getState().set({ missing, duplicates });
  } catch {
    /* not available: leave as is */
  }
}

/** Library tracks by id (from the rows on screen, else a search). */
export async function rowsById(ids: number[]): Promise<TrackRow[]> {
  const have = new Map(useLibrary.getState().rows.map((r) => [r.id, r]));
  if (ids.every((id) => have.has(id))) return ids.map((id) => have.get(id)!);
  const all = new Map((await backend().search("")).map((r) => [r.id, r]));
  return ids.map((id) => all.get(id)).filter((r): r is TrackRow => !!r);
}

/**
 * Writes the library's details into the tracks' files (title, artist, genre, label, year,
 * tempo and key in the chosen notation), after asking: it changes the files.
 */
export async function writeTagsToFiles(ids: number[]) {
  const b = backend;
  if (!ids.length) return;
  if (b().kind === "web") {
    toast.message("Writing tags needs the desktop app", { description: "A web page cannot change files on your computer. Your edits are kept in MixIt's library." });
    return;
  }
  const notation = useApp.getState().settings?.keyNotation ?? "camelot";
  const n = ids.length === 1 ? "this track's file" : `${ids.length} files`;
  const example = notation === "camelot" ? "8A" : notation === "openKey" ? "1m" : "Am";
  if (
    !(await ask({
      title: `Write tags to ${n}?`,
      body: `Title, artist, album, genre, label, comment, year, tempo and key (as ${example}) go into the file, so other apps and DJ gear show them too. The audio is not touched.`,
      confirm: "Write tags",
    }))
  )
    return;
  try {
    const r = await b().writeTags(ids, notation);
    if (r.failed.length === 0) toast.success(r.written === 1 ? "Tags written to the file" : `Tags written to ${r.written} files`);
    else toast.warning(`Tags written to ${r.written} of ${ids.length} files`, { description: r.failed.slice(0, 3).map(([, why]) => why).join("\n") + (r.failed.length > 3 ? `\n…and ${r.failed.length - 3} more` : "") });
  } catch (e) {
    toast.error(String(e));
  }
}
