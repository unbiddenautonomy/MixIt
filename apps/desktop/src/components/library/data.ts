// Loading library data into the store for whatever the sidebar has selected.
import { toast } from "sonner";
import { backend } from "../../backend";
import type { TrackRow } from "../../backend/types";
import { useApp } from "../../store/app";
import { useLibrary } from "../../store/library";
import { useTelemetry } from "../../store/telemetry";
import { ask, choose } from "../shell/Dialogs";
import { plural } from "../../lib/format";
import { starterCategory, tagQuery } from "../../lib/tags";
import { historyTracklist } from "../../lib/history";

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
    else if (source.type === "tag") rows = await backend().search(`${tagQuery(source.name)} ${query}`.trim());
    else if (source.type === "playlist") {
      const pl = useLibrary.getState().playlists.find((p) => p.id === source.id);
      // Smart lists run their query plus whatever is typed in the search box.
      if (pl?.kind === "smart" && pl.query) rows = await backend().search(`${pl.query} ${query}`.trim());
      else rows = localFilter(await backend().playlistTracks(source.id), query);
    } else if (source.type === "history") {
      const past = source.session != null && source.session !== useLibrary.getState().currentSession;
      const h = past ? await backend().sessionHistory(source.session!) : await backend().history();
      set({ historyEntries: h });
      const all = await backend().search("");
      const byId = new Map(all.map((r) => [r.id, r]));
      // This session reads newest first (what just played); a past set in the order it was played.
      rows = (past ? h : h.slice().reverse())
        .map((e) => (e.track_id != null ? byId.get(e.track_id) : undefined))
        .filter((r): r is TrackRow => !!r);
      rows = localFilter(rows, query);
    } else if (source.type === "suggest") {
      await refreshSuggestions();
      rows = useLibrary.getState().suggestions.map((s) => s.track);
    }
    if (my === seq) {
      set({ rows, loading: false });
      void refreshRowTags();
    }
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
  await Promise.all([refreshPlaylists(), refreshStats(), refreshCare(), refreshTags(), refreshSessions()]);
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

/**
 * Writes hot cues, loops and beat grids into the tracks' files where Serato DJ looks for
 * them, after asking: it changes the files.
 */
export async function writeCuesForSerato(ids: number[]) {
  if (!ids.length) return;
  if (backend().kind === "web") {
    toast.message("Writing to files needs the desktop app", { description: "A web page cannot change files on your computer." });
    return;
  }
  const n = ids.length === 1 ? "this track's file" : `${ids.length} files`;
  if (
    !(await ask({
      title: `Write cues for Serato into ${n}?`,
      body: "Hot cues 1 to 8, saved loops, the track colour and the beat grid go into the file, so Serato DJ shows them. Cues Serato saved there before are replaced. The audio and other tags are not touched.",
      confirm: "Write cues",
    }))
  )
    return;
  try {
    const r = await backend().writeSerato(ids);
    if (r.failed.length === 0) toast.success(r.written === 1 ? "Cues written for Serato" : `Cues written to ${r.written} files for Serato`);
    else toast.warning(`Cues written to ${r.written} of ${ids.length} files`, { description: r.failed.slice(0, 3).map(([, why]) => why).join("\n") + (r.failed.length > 3 ? `\n…and ${r.failed.length - 3} more` : "") });
  } catch (e) {
    toast.error(String(e));
  }
}

// ---------------------------------------------------------------- playlist tools

/** A copy of a playlist (a smart one keeps its rules) beside the original. */
export async function duplicatePlaylist(id: number) {
  const p = useLibrary.getState().playlists.find((x) => x.id === id);
  if (!p || p.kind === "folder") return;
  try {
    const name = `${p.name} copy`;
    const tracks = p.kind === "list" ? (await backend().playlistTracks(id)).map((t) => t.id) : undefined;
    await backend().createPlaylist(name, p.kind, { parent: p.parent, query: p.query, tracks });
    await refreshPlaylists();
    toast.success(`Made “${name}”`);
  } catch (e) {
    fail(e);
  }
}

export type Tidy = "shuffle" | "duplicates" | "missing";

/** The new order of a list for a tidy-up: shuffled, without repeats, or without missing files. */
export function tidyOrder(rows: TrackRow[], how: Tidy, random: () => number = Math.random): number[] {
  if (how === "shuffle") {
    const ids = rows.map((r) => r.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
  }
  if (how === "missing") return rows.filter((r) => !r.missing).map((r) => r.id);
  const seen = new Set<number>();
  return rows.filter((r) => !seen.has(r.id) && !!seen.add(r.id)).map((r) => r.id);
}

/** Shuffles a list, or takes out repeated tracks or tracks whose files are missing. */
export async function tidyPlaylist(id: number, how: Tidy) {
  try {
    const rows = await backend().playlistTracks(id);
    const next = tidyOrder(rows, how);
    const gone = rows.length - next.length;
    if (how !== "shuffle" && gone === 0) {
      toast.message(how === "duplicates" ? "No track is in this playlist twice" : "Every file in this playlist is there");
      return;
    }
    await backend().setPlaylistTracks(id, next);
    await refreshPlaylists();
    if (useLibrary.getState().source.type === "playlist") await refreshRows();
    toast.success(how === "shuffle" ? "Shuffled" : `Took out ${gone} ${how === "duplicates" ? (gone === 1 ? "repeat" : "repeats") : gone === 1 ? "missing track" : "missing tracks"}`);
  } catch (e) {
    fail(e);
  }
}

/** Copies a playlist's music files to a folder or USB stick, with a playlist file beside them. */
export async function copyPlaylistFiles(id: number) {
  const p = useLibrary.getState().playlists.find((x) => x.id === id);
  if (!p) return;
  if (backend().kind === "web") {
    toast.message("Copying files needs the desktop app", { description: "A web page cannot copy files on your computer." });
    return;
  }
  try {
    const rows = p.kind === "smart" && p.query ? await backend().search(p.query) : await backend().playlistTracks(id);
    if (!rows.length) {
      toast.message("This playlist is empty");
      return;
    }
    const way = await choose({
      title: `Copy “${p.name}” to a folder or USB stick`,
      body: `MixIt makes a folder called “${p.name}” there, copies the ${plural(rows.length, "music file")} into it and adds a playlist file, so the set plays on other gear or another computer. Numbered names keep the order in any player.`,
      options: ["Keep the file names", "Number them in order"],
    });
    if (way == null) return;
    const dest = await backend().pickFolders("Choose where to copy the music (a USB stick, for example)");
    if (!dest?.[0]) return;
    await backend().copyFiles(rows.map((r) => r.id), dest[0], p.name, way === 1);
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------- your own tags

/** Reloads the list of tags and the tags of the rows on show. */
export async function refreshTags() {
  try {
    useLibrary.getState().set({ tags: await backend().listTags() });
  } catch {
    // Kept as they were.
  }
  await refreshRowTags();
}

async function refreshRowTags() {
  const rows = useLibrary.getState().rows;
  try {
    const pairs = await backend().tagsOf(rows.map((r) => r.id));
    if (useLibrary.getState().rows !== rows) return;
    useLibrary.getState().set({ rowTags: Object.fromEntries(pairs) });
  } catch {
    // Kept as they were.
  }
}

/** Puts a tag on tracks or takes it off, then refreshes what shows tags. */
export async function tagTracks(ids: number[], name: string, on: boolean) {
  const n = name.trim();
  if (!n || !ids.length) return;
  try {
    const known = useLibrary.getState().tags.find((t) => t.name.toLowerCase() === n.toLowerCase());
    await backend().setTag(ids, known?.name ?? n, on, known ? known.category : starterCategory(n));
    await refreshTags();
    if (useLibrary.getState().source.type === "tag") await refreshRows();
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------- past sets

export async function refreshSessions() {
  try {
    const { current, sessions } = await backend().historySessions();
    useLibrary.getState().set({ sessions, currentSession: current });
  } catch {
    // Kept as they were.
  }
}

async function setEntries(session: number | undefined) {
  const cur = useLibrary.getState().currentSession;
  return session != null && session !== cur ? backend().sessionHistory(session) : backend().history();
}

/** Makes a playlist of a set's tracks, in the order they were played. */
export async function saveSetAsPlaylist(session: number | undefined, name: string) {
  try {
    const entries = await setEntries(session);
    const ids = entries.map((e) => e.track_id).filter((id): id is number => id != null);
    if (!ids.length) {
      toast.error("Nothing was played in this set.");
      return;
    }
    await backend().createPlaylist(name, "list", { tracks: ids });
    await refreshPlaylists();
    toast.success(`Made the playlist “${name}”`, { description: `${ids.length} tracks, in the order you played them.` });
  } catch (e) {
    fail(e);
  }
}

/** Copies a set's tracklist ("01. [0:00] Artist - Title") to the clipboard. */
export async function copySetTracklist(session: number | undefined) {
  try {
    const text = historyTracklist(await setEntries(session));
    await navigator.clipboard.writeText(text);
    toast.success("Tracklist copied", { description: "Paste it under your mix or into a message." });
  } catch (e) {
    fail(e);
  }
}
