import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import { SET_SHAPES, shapeTarget } from "../lib/setShapes";

describe("set shapes", () => {
  it("rise, fall and hold the way their names say", () => {
    expect(shapeTarget("build", 1)).toBeGreaterThan(shapeTarget("build", 0) + 4);
    expect(shapeTarget("coolDown", 1)).toBeLessThan(shapeTarget("coolDown", 0) - 4);
    expect(shapeTarget("journey", 0.65)).toBeGreaterThan(shapeTarget("journey", 1));
    expect(shapeTarget("steady", 0.3, 5)).toBe(5);
    expect(shapeTarget("peak", 0.5)).toBeLessThan(shapeTarget("peak", 0.9));
    for (const s of SET_SHAPES) for (let t = 0; t <= 1; t += 0.05) expect(shapeTarget(s.id, t)).toBeGreaterThanOrEqual(1);
  });
});

describe("building a set in the demo", () => {
  it("fills the time with different tracks, opening with the seed", async () => {
    const b = new DemoBackend();
    const all = await b.search("");
    const seed = all.find((r) => r.bpm)!;
    const set = await b.buildSet({ query: "", minutes: 45, shape: "build", seed: seed.id });
    expect(set[0].id).toBe(seed.id);
    expect(new Set(set.map((r) => r.id)).size).toBe(set.length);
    const heard = set.reduce((a, r) => a + r.duration * 0.8, 0);
    expect(heard).toBeGreaterThanOrEqual(45 * 60);
    expect(heard).toBeLessThan(45 * 60 + 400);
    const other = await b.buildSet({ query: "", minutes: 45, shape: "build", variety: 3 });
    expect(other.map((r) => r.id)).not.toEqual(set.map((r) => r.id));
  }, 30_000);

  it("leaves the singers out, or gives them room", async () => {
    const b = new DemoBackend();
    const sings = (r: { vocals?: number | null }) => (r.vocals ?? 0) >= 10;
    const any = await b.buildSet({ query: "", minutes: 90, shape: "steady" });
    expect(any.some(sings)).toBe(true);
    const inst = await b.buildSet({ query: "", minutes: 60, shape: "steady", vocals: "instrumental" });
    expect(inst.length).toBeGreaterThan(0);
    expect(inst.every((r) => r.vocals != null && r.vocals < 5)).toBe(true);
    const room = await b.buildSet({ query: "", minutes: 90, shape: "steady", vocals: "breathe" });
    expect(room.some(sings)).toBe(true);
    for (let i = 2; i < room.length; i++) expect(sings(room[i - 2]) && sings(room[i - 1]) && sings(room[i])).toBe(false);
  }, 30_000);

  it("keeps to a playlist", async () => {
    const b = new DemoBackend();
    const pl = (await b.playlists()).find((p) => p.kind === "list" && p.count >= 5)!;
    const keep = new Set((await b.playlistTracks(pl.id)).map((r) => r.id));
    const set = await b.buildSet({ query: "", playlist: pl.id, minutes: 240, shape: "steady" });
    expect(set.length).toBeGreaterThan(0);
    expect(set.every((r) => keep.has(r.id))).toBe(true);
  }, 30_000);
});
