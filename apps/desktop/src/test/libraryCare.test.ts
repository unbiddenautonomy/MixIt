import { describe, expect, it } from "vitest";
import type { TrackRow } from "../backend/types";
import { bestCopy } from "../components/library/LibraryCare";

const row = (id: number, p: Partial<TrackRow> = {}): TrackRow => ({
  id,
  path: `/music/${id}.mp3`,
  title: "Song",
  artist: "Artist",
  album: "",
  genre: "",
  label: "",
  year: null,
  duration: 200,
  bpm: 124,
  key: null,
  energy: null,
  lufs: null,
  rating: 0,
  color: null,
  playCount: 0,
  lastPlayed: null,
  addedAt: 1000 + id,
  missing: false,
  analysis: "done",
  comment: "",
  ...p,
});

describe("choosing the copy to keep", () => {
  it("prefers a copy whose file is there", () => {
    expect(bestCopy([row(1, { missing: true, rating: 5 }), row(2)]).id).toBe(2);
  });
  it("then the best rated, then the most played", () => {
    expect(bestCopy([row(1, { rating: 2 }), row(2, { rating: 4 }), row(3, { rating: 4, playCount: 9 })]).id).toBe(3);
  });
  it("then the oldest", () => {
    expect(bestCopy([row(5, { addedAt: 50 }), row(4, { addedAt: 90 })]).id).toBe(5);
  });
  it("does not reorder the group it was given", () => {
    const g = [row(1, { missing: true }), row(2)];
    bestCopy(g);
    expect(g.map((t) => t.id)).toEqual([1, 2]);
  });
});
