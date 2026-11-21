import { beforeEach, describe, expect, it } from "vitest";
import type { TrackRow } from "../backend/types";
import { isShown, MIN_WIDTH, resetColumns, setShown, setWidth, track, useColumns } from "../lib/columns";
import { sortRows } from "../store/library";

describe("choosing columns", () => {
  beforeEach(() => resetColumns());

  it("follows the view until you choose, and the title always shows", () => {
    expect(isShown("bpm", "always", false)).toBe(true);
    expect(isShown("lufs", "pro", false)).toBe(false);
    expect(isShown("lufs", "pro", true)).toBe(true);
    expect(isShown("album", "extra", true)).toBe(false);
    setShown("album", true);
    setShown("bpm", false);
    expect(isShown("album", "extra", false)).toBe(true);
    expect(isShown("bpm", "always", true)).toBe(false);
    setShown("title", false);
    expect(isShown("title", "always", false)).toBe(true);
    expect(JSON.parse(localStorage.getItem("mixit.columns")!).shown).toMatchObject({ album: true, bpm: false });
  });

  it("keeps dragged widths, never too narrow, and puts them back", () => {
    expect(track("artist", "minmax(120px,1.4fr)")).toBe("minmax(120px,1.4fr)");
    setWidth("artist", 250.4);
    expect(track("artist", "minmax(120px,1.4fr)")).toBe("250px");
    setWidth("bpm", 3);
    expect(useColumns.getState().widths.bpm).toBe(MIN_WIDTH);
    setWidth("artist", null);
    expect(track("artist", "x")).toBe("x");
  });

  it("sorts the new columns, with empty values first", () => {
    const r = (id: number, p: Partial<TrackRow>) => ({ id, album: "", label: "", comment: "", year: null, lastPlayed: null, lufs: null, ...p }) as TrackRow;
    const rows = [r(1, { album: "beta", year: 2020, lastPlayed: 50 }), r(2, { album: "Alpha", year: null }), r(3, { album: "gamma", year: 1999, lastPlayed: 10 })];
    expect(sortRows(rows, "album", 1).map((x) => x.id)).toEqual([2, 1, 3]);
    expect(sortRows(rows, "year", 1).map((x) => x.id)).toEqual([2, 3, 1]);
    expect(sortRows(rows, "lastPlayed", -1).map((x) => x.id)).toEqual([1, 3, 2]);
  });
});
