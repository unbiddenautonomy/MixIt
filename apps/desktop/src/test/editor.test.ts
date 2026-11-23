import { describe, expect, it } from "vitest";
import { beatsBetween, foldTempo, introEnd, snapToBeat, tapTempo } from "../lib/editor";
import { applyDemoGrid, demoBeatAt, demoTimeAt, type DemoTrack } from "../backend/demo";
import type { TrackDetail } from "../backend/types";

const detail = (p: Partial<TrackDetail>): TrackDetail =>
  ({ analysed: true, constantGrid: true, firstBeat: 0.25, beatPeriod: 0.5, beats: [], sections: [], ...p }) as TrackDetail;

describe("track editor helpers", () => {
  it("taps a steady tempo and ignores one sloppy tap", () => {
    const taps = [0, 0.5, 1.0, 1.5, 2.08, 2.5, 3.0, 3.5];
    expect(tapTempo(taps.slice(0, 3))).toBeNull();
    expect(tapTempo(taps)).toBe(120);
  });

  it("starts a new count after a pause", () => {
    const old = [0, 0.4, 0.8, 1.2, 1.6];
    expect(tapTempo([...old, 5, 5.5, 6])).toBeNull();
    expect(tapTempo([...old, 5, 5.5, 6, 6.5])).toBe(120);
  });

  it("folds taps on half or double beats to the analysed octave", () => {
    expect(foldTempo(62, 124)).toBe(124);
    expect(foldTempo(250, 124)).toBe(125);
    expect(foldTempo(128, 126)).toBe(128);
    expect(foldTempo(90, null)).toBe(90);
  });

  it("snaps to the grid, or to analysed beats on a drifting grid", () => {
    const d = detail({});
    expect(snapToBeat(d, 1.3)).toBeCloseTo(1.25);
    expect(snapToBeat(d, 1.3, 4)).toBeCloseTo(2.25);
    expect(snapToBeat(detail({ constantGrid: false, beats: [0.2, 0.71, 1.24] }), 0.9)).toBe(0.71);
    expect(snapToBeat(detail({ analysed: false }), 1.3)).toBe(1.3);
    expect(beatsBetween(d, 1, 3)).toBe(4);
  });

  it("finds where the intro ends", () => {
    const s = (label: string, start: number) => ({ label, start, end: start + 10, bars: 4, energy: 0.5 });
    expect(introEnd(detail({ sections: [s("Intro", 0), s("Intro", 10), s("Drop", 20)] }))).toBe(20);
    expect(introEnd(detail({ sections: [s("Intro", 0)] }))).toBeNull();
    expect(introEnd(detail({ sections: [s("Intro", 0), s("Intro", 10)] }))).toBeNull();
  });
});

describe("demo grid edits", () => {
  const track = () => ({ row: { id: 7, bpm: 120 }, period: 0.5, firstBeat: 0.1 }) as unknown as DemoTrack;

  it("sets the tempo, a bar start and a nudge", () => {
    const t = track();
    applyDemoGrid(t, { bpm: 125 }, new Set());
    expect(t.period).toBeCloseTo(0.48);
    applyDemoGrid(t, { downbeatAt: 5 }, new Set());
    // 5 s is a bar start: the earliest bar start before it is 5 - 2 bars of 1.92 s.
    expect(t.firstBeat).toBeCloseTo(5 - 2 * 1.92);
    applyDemoGrid(t, { nudgeMs: 10 }, new Set());
    expect(t.firstBeat).toBeCloseTo(5 - 2 * 1.92 + 0.01);
  });

  it("refuses edits while locked, but allows unlocking", () => {
    const t = track();
    const locked = new Set([7]);
    expect(() => applyDemoGrid(t, { bpm: 128 }, locked)).toThrow(/locked/);
    applyDemoGrid(t, { locked: false }, locked);
    expect(locked.has(7)).toBe(false);
    expect(() => applyDemoGrid(t, { bpm: 1000 }, locked)).toThrow(/400/);
  });

  it("pins beats where a live drummer drifts, and takes the pins away again", () => {
    const t = track();
    t.row.duration = 120;
    // Beat 64 really lands 30 ms late, beat 128 60 ms late.
    const real = (b: number) => 0.1 + b * 0.5 + (b / 64) * 0.03;
    applyDemoGrid(t, { warpAt: real(64) }, new Set());
    applyDemoGrid(t, { warpAt: real(128) }, new Set());
    for (const b of [0, 32, 64, 100, 128]) expect(demoTimeAt(t, b)).toBeCloseTo(real(b), 6);
    expect(demoBeatAt(t, real(100))).toBeCloseTo(100, 6);
    expect(t.pins!.map((p) => p.beat)).toEqual([0, 64, 128]);
    applyDemoGrid(t, { unwarpAt: real(70) }, new Set());
    expect(t.pins!.map((p) => p.beat)).toEqual([0, 128]);
    expect(demoTimeAt(t, 128)).toBeCloseTo(real(128), 6);
    applyDemoGrid(t, { straighten: true }, new Set());
    expect(t.pins).toBeUndefined();
    expect(t.period).toBeCloseTo((real(128) - 0.1) / 128, 9);
    // A pin near the start replaces the first one.
    applyDemoGrid(t, { warpAt: real(64) }, new Set());
    expect(() => applyDemoGrid(t, { warpAt: 0.05 }, new Set())).not.toThrow();
  });
});
