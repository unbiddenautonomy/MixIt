import { describe, expect, it } from "vitest";
import type { TrackRow } from "../backend/types";
import { camelotNeighbours, insights } from "../lib/insights";

const NOW = new Date(2026, 10, 21).getTime() / 1000;
let n = 0;
const t = (o: Partial<TrackRow>): TrackRow =>
  ({ id: ++n, path: "", title: `T${n}`, artist: "", album: "", genre: "", label: "", year: null, duration: 300, bpm: null, key: null, energy: null, lufs: null, rating: 0, color: null, playCount: 0, lastPlayed: null, addedAt: NOW - 86_400, missing: false, analysis: "done", comment: "", ...o }) as TrackRow;
const key = (camelot: string) => ({ index: 0, camelot, openKey: "", name: "" });

describe("collection insights", () => {
  it("finds where tempos and keys sit", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => t({ bpm: 122 + (i % 6), key: key("8A"), energy: 6, genre: "House", playCount: i % 3 })),
      ...Array.from({ length: 5 }, () => t({ bpm: 140, key: key("5B"), energy: 9, genre: "Techno" })),
      t({ bpm: 174, missing: true, analysis: "pending" }),
    ];
    const s = insights(rows, NOW);
    expect(s.tracks).toBe(36);
    expect(s.missing).toBe(1);
    expect(s.analysed).toBe(35);
    expect(s.sweetSpot).toMatchObject({ from: 122, to: 130 });
    expect(s.tempo.reduce((a, b) => a + b.count, 0)).toBeGreaterThanOrEqual(35);
    expect(s.tempo[0].query).toBe("bpm:122-123.99");
    expect(s.keys["8A"]).toBe(30);
    expect(s.keys["5B"]).toBe(5);
    expect(s.energy[5]).toMatchObject({ count: 30, query: "energy:6" });
    expect(s.genres[0]).toEqual({ query: 'genre:"House"', label: "House", count: 30 });
    expect(s.added[11].count).toBe(36);
    expect(s.mostPlayed[0].playCount).toBe(2);
    expect(s.notes.join(" ")).toMatch(/between 122 and 130 BPM/);
    expect(s.notes.join(" ")).toMatch(/8A is your most common key/);
    expect(s.notes.join(" ")).toMatch(/Fix library/);
    expect(s.notes.join(" ")).toMatch(/still need analysing/);
  });

  it("copes with an empty library", () => {
    const s = insights([], NOW);
    expect(s.tempo).toEqual([]);
    expect(s.sweetSpot).toBeNull();
    expect(s.notes[0]).toMatch(/empty/);
  });

  it("knows the Camelot neighbours", () => {
    expect(camelotNeighbours("8A")).toEqual(["8B", "7A", "9A"]);
    expect(camelotNeighbours("12B")).toEqual(["12A", "11B", "1B"]);
    expect(camelotNeighbours("1A")).toEqual(["1B", "12A", "2A"]);
  });
});
