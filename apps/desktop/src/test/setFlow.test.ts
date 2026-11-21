import { describe, expect, it } from "vitest";
import type { TrackRow } from "../backend/types";
import { fromCamelot, keyDto } from "../lib/keys";
import { bridges, flow, summary, tempoChange, transition } from "../lib/setFlow";

const row = (id: number, bpm: number | null, cam: string | null, energy: number | null = 5): TrackRow => ({
  id,
  path: `/m/${id}.mp3`,
  title: `T${id}`,
  artist: "A",
  album: "",
  genre: "",
  label: "",
  year: null,
  duration: 300,
  bpm,
  key: cam ? keyDto(fromCamelot(Number(cam.slice(0, -1)), cam.slice(-1) as "A" | "B")) : null,
  energy,
  lufs: null,
  rating: 0,
  color: null,
  playCount: 0,
  lastPlayed: null,
  addedAt: 0,
  missing: false,
  analysis: "done",
  comment: "",
});

describe("set flow", () => {
  it("measures tempo changes allowing double and half time", () => {
    expect(tempoChange(124, 126)).toBeCloseTo(1.613, 2);
    expect(tempoChange(87, 174)).toBeCloseTo(0, 5);
    expect(tempoChange(140, 70)).toBeCloseTo(0, 5);
    expect(tempoChange(null, 120)).toBeNull();
  });

  it("grades each change of track", () => {
    expect(transition(row(1, 124, "8A"), row(2, 125, "9A")).grade).toBe("smooth");
    expect(transition(row(1, 124, "8A"), row(2, 124, "8B")).grade).toBe("smooth");
    const clash = transition(row(1, 124, "8A"), row(2, 124, "2B"));
    expect(transition(row(1, 124, "8A"), row(2, 124, "3B")).reasons[0]).toMatch(/key shift/);
    expect(clash.grade).toBe("rough");
    expect(clash.reasons[0]).toMatch(/Keys clash/);
    const fast = transition(row(1, 120, "8A"), row(2, 132, "8A"));
    expect(fast.grade).toBe("rough");
    expect(fast.reasons).toEqual(["Tempo jumps 10%"]);
    expect(transition(row(1, 120, "8A"), row(2, 126, "8A")).grade).toBe("ok");
    expect(transition(row(1, 124, "8A", 2), row(2, 124, "8A", 8)).reasons).toEqual(["Energy leaps up"]);
    // Unknown keys and tempos do not count against a change.
    expect(transition(row(1, null, null), row(2, null, null)).grade).toBe("smooth");
  });

  it("summarises a set", () => {
    const set = [row(1, 124, "9A"), row(2, 125, "8A"), row(3, 125, "2B"), row(4, 126, "2B")];
    expect(summary(flow(set))).toEqual({ smooth: 2, ok: 0, rough: 1 });
  });

  it("finds tracks that bridge a rough change", () => {
    const a = row(1, 120, "8A", 4);
    const b = row(2, 130, "10A", 8);
    const lib = [row(10, 125, "9A", 6), row(11, 125, "2B", 6), row(12, 140, "9A", 6), row(13, 124, "9A", 1), a, b];
    const found = bridges(a, b, lib, new Set([1, 2]));
    expect(found.map((x) => x.track.id)).toEqual([10, 13]);
    expect(found[0].into.grade).not.toBe("rough");
    expect(found[0].out.grade).not.toBe("rough");
  });
});
