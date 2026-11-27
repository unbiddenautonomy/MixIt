import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";

// The beat helper's offer on the deck (src-tauri/src/beats.rs), as the demo plays it:
// the hip-hop tracks' bars are heard starting a beat later.
async function hipHopOnDeck() {
  const b = new DemoBackend();
  const row = (await b.search("")).find((r) => r.genre === "Hip Hop")!;
  const info = await b.loadTrack(0, row.id);
  return { b, row, info };
}

describe("the beat helper's offer", () => {
  it("is on the deck until it is used, and Undo puts the old grid back", async () => {
    const { b, row, info } = await hipHopOnDeck();
    expect(info.detail.gridSuggestion?.why).toBe("the bars starting on a different beat");
    const before = info.detail.firstBeat;
    const period = info.detail.beatPeriod;
    let latest = info;
    b.onDeckLoaded((i) => (latest = i));
    await b.useGridSuggestion(0, true);
    expect(latest.detail.gridSuggestion ?? null).toBeNull();
    // Beat 1 moved by one beat (within a bar).
    const moved = (latest.detail.firstBeat - before + 4 * period) % (4 * period);
    expect(moved).toBeCloseTo(period, 6);
    await b.resetGrid(0);
    expect(latest.detail.firstBeat).toBeCloseTo(before, 6);
    // Not offered again, even after loading the track again.
    expect((await b.loadTrack(0, row.id)).detail.gridSuggestion ?? null).toBeNull();
  });

  it("can be turned down, leaving the grid as it was", async () => {
    const { b, info } = await hipHopOnDeck();
    let latest = info;
    b.onDeckLoaded((i) => (latest = i));
    await b.useGridSuggestion(0, false);
    expect(latest.detail.gridSuggestion ?? null).toBeNull();
    expect(latest.detail.firstBeat).toBe(info.detail.firstBeat);
  });

  it("isn't offered for tracks the analysis was sure of", async () => {
    const b = new DemoBackend();
    const row = (await b.search("")).find((r) => r.genre !== "Hip Hop")!;
    expect((await b.loadTrack(0, row.id)).detail.gridSuggestion ?? null).toBeNull();
  });
});
