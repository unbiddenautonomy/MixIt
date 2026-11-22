import { describe, expect, it, vi } from "vitest";
import { DemoBackend } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { refreshRows, showSoundsLike } from "../components/library/data";
import { useLibrary } from "../store/library";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

describe("sounds like", () => {
  it("ranks the other analysed tracks, best match first", async () => {
    const b = new DemoBackend();
    const all = await b.search("");
    const seed = all.find((r) => r.analysis === "done" && r.genre)!;
    const found = await b.soundsLike(seed.id, 10);
    expect(found.length).toBe(10);
    expect(found.every((m) => m.track.id !== seed.id && m.score >= 0 && m.score <= 1)).toBe(true);
    for (let i = 1; i < found.length; i++) expect(found[i - 1].score).toBeGreaterThanOrEqual(found[i].score);
    // The demo's sound follows the genre most, so the best match shares it.
    expect(found[0].track.genre).toBe(seed.genre);
  }, 30_000);

  it("shows the matches in the library with their scores", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    const seed = (await b.search("")).find((r) => r.analysis === "done")!;
    showSoundsLike(seed);
    expect(useLibrary.getState().source).toEqual({ type: "similar", id: seed.id, title: seed.title });
    await refreshRows();
    const { rows, matches } = useLibrary.getState();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.id === seed.id)).toBe(false);
    expect(matches[rows[0].id]).toBeGreaterThanOrEqual(matches[rows[rows.length - 1].id]);
  }, 30_000);
});
