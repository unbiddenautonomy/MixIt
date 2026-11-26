import { describe, expect, it, vi } from "vitest";
import { DemoBackend } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { refreshRows, showDescribed } from "../components/library/data";
import { useLibrary } from "../store/library";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

describe("search by sound", () => {
  it("ranks tracks by how well they fit a description", async () => {
    const b = new DemoBackend();
    const all = await b.search("");
    const genre = all.find((r) => r.analysis === "done" && r.genre)!.genre;
    const found = await b.soundSearch(`${genre} music`, 20);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((m) => m.score >= 0 && m.score <= 1)).toBe(true);
    for (let i = 1; i < found.length; i++) expect(found[i - 1].score).toBeGreaterThanOrEqual(found[i].score);
    expect(found[0].track.genre).toBe(genre);
    expect(await b.soundSearch("  ")).toEqual([]);
  }, 30_000);

  it("shows the matches in the library and clears the typed search", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    useLibrary.getState().set({ query: "dark rolling bass" });
    await showDescribed("dark rolling bass");
    expect(useLibrary.getState().source).toEqual({ type: "described", text: "dark rolling bass" });
    expect(useLibrary.getState().query).toBe("");
    await refreshRows();
    const { rows, matches } = useLibrary.getState();
    expect(rows.length).toBeGreaterThan(0);
    expect(matches[rows[0].id]).toBeGreaterThanOrEqual(matches[rows[rows.length - 1].id]);
  }, 30_000);

  it("says so instead when it is turned off", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    await b.saveSettings({ ...(await b.appInfo()).settings, soundSearch: false });
    useLibrary.getState().set({ source: { type: "all" } });
    await showDescribed("warm piano");
    expect(useLibrary.getState().source).toEqual({ type: "all" });
  }, 30_000);
});
