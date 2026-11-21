import { describe, expect, it } from "vitest";
import { beatToSeconds, bpmAt, emptyProject } from "../components/arrange/projectIo";
import { paletteFilter } from "../components/shell/CommandPalette";
import { bpmFits } from "../components/library/TrackTable";
import { localFilter } from "../components/library/data";
import { channelOrder } from "../components/mixer/Mixer";
import { clock, signedPct } from "../lib/format";
import { compatibility, fromCamelot, keyFromIndex, keyIndex, camelot } from "../lib/keys";
import { sortRows } from "../store/library";
import type { TrackRow } from "../backend/types";

const row = (p: Partial<TrackRow>): TrackRow => ({
  id: 1, path: "/a.mp3", title: "", artist: "", album: "", genre: "", label: "", year: null, duration: 200, bpm: 124, key: null,
  energy: 5, lufs: -9, rating: 0, color: null, playCount: 0, lastPlayed: null, addedAt: 0, missing: false, analysis: "done", comment: "", ...p,
});

describe("tempo map", () => {
  it("is linear for a constant tempo", () => {
    const p = emptyProject("x", 120);
    expect(beatToSeconds(p, 8)).toBeCloseTo(4, 9);
    expect(bpmAt(p, 100)).toBe(120);
  });
  it("integrates a ramp exactly", () => {
    const p = emptyProject("x", 120);
    p.tempo.segments = [
      { start_beat: 0, bpm: 120, end_bpm: 130 },
      { start_beat: 64, bpm: 130, end_bpm: 130 },
    ];
    // (60/k)·ln(130/120) with k = 10/64 beats⁻¹
    const k = 10 / 64;
    expect(beatToSeconds(p, 64)).toBeCloseTo((60 / k) * Math.log(130 / 120), 9);
    expect(beatToSeconds(p, 128)).toBeCloseTo((60 / k) * Math.log(130 / 120) + (64 * 60) / 130, 9);
    expect(bpmAt(p, 32)).toBeCloseTo(125, 9);
  });
});

describe("palette filter", () => {
  it("needs every word as a substring", () => {
    expect(paletteFilter("Add music folder", "loop")).toBe(0);
    expect(paletteFilter("Deck A Loop", "loop")).toBeGreaterThan(0);
    expect(paletteFilter("Deck A Halve loop", "deck a loop")).toBeGreaterThan(0);
    expect(paletteFilter("Deck A Loop", "loop") > paletteFilter("Deck A Halve loop", "loop")).toBe(true);
  });
});

describe("library helpers", () => {
  it("matches BPM including half and double time", () => {
    expect(bpmFits(126, 124)).toBe(true);
    expect(bpmFits(62, 124)).toBe(true);
    expect(bpmFits(140, 124)).toBe(false);
    expect(bpmFits(null, 124)).toBe(false);
  });
  it("filters by words and ignores field terms", () => {
    const rows = [row({ id: 1, title: "Deep Water", artist: "Ana" }), row({ id: 2, title: "Fire", artist: "Deep Crew" }), row({ id: 3, title: "Sun" })];
    expect(localFilter(rows, "deep").map((r) => r.id)).toEqual([1, 2]);
    expect(localFilter(rows, "deep bpm:120").map((r) => r.id)).toEqual([1, 2]);
    expect(localFilter(rows, "water ana").map((r) => r.id)).toEqual([1]);
  });
  it("sorts keys around the Camelot wheel", () => {
    const k = (c: string) => {
      const key = fromCamelot(Number(c.slice(0, -1)), c.slice(-1) as "A" | "B");
      const cm = camelot(key);
      return { index: keyIndex(key), camelot: `${cm.n}${cm.letter}`, openKey: "", name: "" };
    };
    const rows = [row({ id: 1, key: k("10A") }), row({ id: 2, key: k("2B") }), row({ id: 3, key: k("2A") })];
    expect(sortRows(rows, "key", 1).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("keys", () => {
  it("round-trips Camelot", () => {
    for (let i = 0; i < 24; i++) {
      const c = camelot(keyFromIndex(i));
      expect(keyIndex(fromCamelot(c.n, c.letter))).toBe(i);
    }
  });
  it("rates neighbours as compatible", () => {
    expect(compatibility(fromCamelot(8, "A"), fromCamelot(8, "A"))).toBe("same");
    expect(compatibility(fromCamelot(8, "A"), fromCamelot(9, "A"))).toBe("match");
    expect(compatibility(fromCamelot(8, "A"), fromCamelot(8, "B"))).toBe("match");
    // Far keys are not a direct match; a small key shift (with key lock) fixes them.
    expect(compatibility(fromCamelot(8, "A"), fromCamelot(2, "A"))).toBe("shift");
  });
});

describe("formatting and layout", () => {
  it("formats clocks and percentages", () => {
    expect(clock(65)).toBe("1:05");
    expect(clock(3725)).toBe("1:02:05");
    expect(clock(-5.25, true)).toBe("-0:05.2");
    expect(signedPct(0.025)).toBe("+2.5%");
  });
  it("orders four channels like a club mixer", () => {
    expect(channelOrder(2)).toEqual([0, 1]);
    expect(channelOrder(4)).toEqual([2, 0, 1, 3]);
  });
});
