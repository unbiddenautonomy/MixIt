import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import type { TrackRow } from "../backend/types";
import { tidyOrder } from "../components/library/data";

const row = (id: number, missing = false) => ({ id, missing }) as TrackRow;

describe("playlist tools", () => {
  it("tidies a list", () => {
    const rows = [row(1), row(2), row(1), row(3, true), row(2)];
    expect(tidyOrder(rows, "duplicates")).toEqual([1, 2, 3]);
    expect(tidyOrder(rows, "missing")).toEqual([1, 2, 1, 2]);
    const shuffled = tidyOrder(rows, "shuffle", () => 0);
    expect(shuffled.slice().sort()).toEqual([1, 1, 2, 2, 3]);
    expect(shuffled).not.toEqual(rows.map((r) => r.id));
  });

  it("moves playlists into folders, never into themselves", async () => {
    const b = new DemoBackend();
    const gigs = await b.createPlaylist("Gigs", "folder");
    const inner = await b.createPlaylist("Inner", "folder", { parent: gigs });
    const list = await b.createPlaylist("Friday", "list", { tracks: [1, 2] });
    await b.movePlaylist(list, gigs, 0);
    const kids = (await b.playlists()).filter((p) => p.parent === gigs).map((p) => p.name);
    expect(kids).toEqual(["Friday", "Inner"]);
    await expect(b.movePlaylist(gigs, inner, 0)).rejects.toThrow(/inside itself/);
    await expect(b.movePlaylist(inner, list, 0)).rejects.toThrow(/folders/);
    await b.movePlaylist(list, null, 0);
    expect((await b.playlists())[0].name).toBe("Friday");
    await b.setPlaylistTracks(list, [3, 3, 4]);
    expect((await b.playlistTracks(list)).map((t) => t.id)).toEqual([3, 3, 4]);
  }, 30_000);
});
