import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import { size, when } from "../components/shell/Backups";

describe("library backups", () => {
  it("says when and how big in plain words", () => {
    const now = new Date(2026, 10, 21, 21, 41).getTime();
    expect(when(new Date(2026, 10, 21, 9, 5).getTime() / 1000, now)).toMatch(/^Today, /);
    expect(when(new Date(2026, 10, 20, 23, 59).getTime() / 1000, now)).toMatch(/^Yesterday, /);
    expect(when(new Date(2026, 10, 2, 8, 0).getTime() / 1000, now)).not.toMatch(/2026/);
    expect(when(new Date(2025, 0, 2, 8, 0).getTime() / 1000, now)).toMatch(/2025/);
    expect(size(500)).toBe("1 KB");
    expect(size(250_000)).toBe("244 KB");
    expect(size(3_500_000)).toBe("3.3 MB");
  });

  it("restores the demo library and keeps the one from before", async () => {
    const b = new DemoBackend();
    const path = await b.backupLibrary();
    const id = (await b.createPlaylist("Oops", "list")) as number;
    await b.setTag([1, 2, 3], "Mistake", true);
    expect((await b.playlists()).some((p) => p.id === id)).toBe(true);
    const safety = await b.restoreLibrary(path);
    expect((await b.playlists()).some((p) => p.id === id)).toBe(false);
    expect(await b.search("tag:mistake")).toEqual([]);
    const list = await b.backups();
    expect(list.map((x) => x.kind)).toEqual(["beforeRestore", "manual"]);
    expect(list[0].path).toBe(safety);
    // Undo the restore.
    await b.restoreLibrary(safety);
    expect((await b.search("tag:mistake")).length).toBe(3);
    await expect(b.restoreLibrary("/nowhere.mixitlib")).rejects.toThrow();
  }, 30_000);
});
