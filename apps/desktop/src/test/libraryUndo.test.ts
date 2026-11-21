import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
import { DemoBackend } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { useLibrary } from "../store/library";
import { refreshPlaylists } from "../components/library/data";
import { clearLibraryHistory, deletePlaylistWithUndo, editTracksWithUndo, redoLibrary, reverseEdit, undoLibrary, withPlaylistUndo } from "../lib/libraryUndo";

let b: DemoBackend;
const ids = async (id: number) => (await b.playlistTracks(id)).map((t) => t.id);

describe("library undo", () => {
  beforeEach(() => {
    b = new DemoBackend();
    setBackendForTests(b);
    clearLibraryHistory();
  });

  it("puts a playlist's tracks back, and forward again", async () => {
    const list = await b.createPlaylist("Set", "list", { tracks: [1, 2, 3, 4] });
    await withPlaylistUndo(list, "Remove", () => b.removeFromPlaylist(list, [1, 2]));
    expect(await ids(list)).toEqual([1, 4]);
    expect(await undoLibrary()).toBe(true);
    expect(await ids(list)).toEqual([1, 2, 3, 4]);
    expect(await redoLibrary()).toBe(true);
    expect(await ids(list)).toEqual([1, 4]);
    // A change that changes nothing is not kept.
    await withPlaylistUndo(list, "Nothing", async () => {});
    await undoLibrary();
    expect(await ids(list)).toEqual([1, 2, 3, 4]);
    expect(await undoLibrary()).toBe(false);
  }, 30_000);

  it("brings back a deleted folder with its playlists", async () => {
    const gigs = await b.createPlaylist("Gigs", "folder");
    await b.createPlaylist("Friday", "list", { parent: gigs, tracks: [5, 6] });
    await b.createPlaylist("Fast", "smart", { parent: gigs, query: "bpm:>128" });
    await refreshPlaylists();
    await deletePlaylistWithUndo(gigs);
    expect((await b.playlists()).some((p) => p.name === "Gigs")).toBe(false);
    await undoLibrary();
    const all = await b.playlists();
    const back = all.find((p) => p.name === "Gigs")!;
    const fri = all.find((p) => p.name === "Friday")!;
    expect(fri.parent).toBe(back.id);
    expect(await ids(fri.id)).toEqual([5, 6]);
    expect(all.find((p) => p.name === "Fast")?.query).toBe("bpm:>128");
    await redoLibrary();
    expect((await b.playlists()).some((p) => p.name === "Gigs" || p.name === "Friday")).toBe(false);
  }, 30_000);

  it("undoes track edits field by field", async () => {
    const rows = (await b.search("")).slice(0, 2);
    expect(reverseEdit(rows, { genre: "X" }).get(rows[0].id)).toEqual({ genre: rows[0].genre });
    await editTracksWithUndo(rows, { genre: "Polka", rating: 5 }, "Edit");
    expect((await b.search("")).filter((r) => r.genre === "Polka")).toHaveLength(2);
    await undoLibrary();
    const now = await b.search("");
    for (const r of rows) {
      const n = now.find((x) => x.id === r.id)!;
      expect([n.genre, n.rating]).toEqual([r.genre, r.rating]);
    }
    expect(useLibrary.getState()).toBeTruthy();
  }, 30_000);
});
