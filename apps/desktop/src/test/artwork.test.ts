import { describe, expect, it, vi } from "vitest";
import { DemoBackend, demoCover } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { clearArtwork, loadArtwork, placeholderColors } from "../lib/artwork";

describe("cover art", () => {
  it("gives demo tracks their own covers and none to the rest", async () => {
    const b = new DemoBackend();
    const rows = await b.search("");
    const withArt = rows.filter((r) => r.hasArt);
    expect(withArt.length).toBeGreaterThan(rows.length / 2);
    const blob = await b.artwork(withArt[0].id);
    expect(blob?.type).toBe("image/svg+xml");
    expect(await b.artwork(rows.find((r) => !r.hasArt)!.id)).toBeNull();
    expect(demoCover("A", "B")).not.toEqual(demoCover("C", "B"));
    expect(placeholderColors("x")).toEqual(placeholderColors("x"));
  }, 30_000);

  it("reads each cover once and shares the wait", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    clearArtwork();
    const spy = vi.spyOn(b, "artwork");
    URL.createObjectURL ??= () => "blob:x";
    const id = (await b.search("")).find((r) => r.hasArt)!.id;
    const [a, c] = await Promise.all([loadArtwork(id, 64), loadArtwork(id, 64)]);
    expect(a).toBeTruthy();
    expect(c).toBe(a);
    await loadArtwork(id, 64);
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);
});
