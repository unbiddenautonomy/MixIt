import { describe, expect, it } from "vitest";
import { beatAt, phraseInfo } from "../lib/phrase";

// 120 BPM: a beat every 0.5 s, the first downbeat at 1 s; sections at bar 0, 16 and 32.
const grid = { analysed: true, constantGrid: true, beats: [], firstBeat: 1, beatPeriod: 0.5, beatsPerBar: 4 };
const sections = [
  { start: 1, end: 33, bars: 16, label: "Intro", energy: 3 },
  { start: 33, end: 65, bars: 16, label: "Drop", energy: 8 },
  { start: 65, end: 97, bars: 16, label: "Outro", energy: 4 },
];

describe("counting beats and phrases", () => {
  it("finds the beat on constant and warped grids", () => {
    expect(beatAt(grid, 1)).toBe(0);
    expect(beatAt(grid, 3.25)).toBeCloseTo(4.5);
    const warped = { analysed: true, constantGrid: false, beats: [1, 1.5, 2.1, 2.6], firstBeat: 1, beatPeriod: 0.5 };
    expect(beatAt(warped, 1.8)).toBeCloseTo(1.5);
    expect(beatAt(warped, 2.6)).toBeCloseTo(3);
    expect(beatAt({ ...grid, analysed: false }, 2)).toBeNull();
  });

  it("says where in the phrase the music is and what comes next", () => {
    const d = { ...grid, sections };
    // 4.5 s = beat 7 = bar 2, beat 4.
    expect(phraseInfo(d, 4.5)).toEqual({ beatInBar: 3, barInPhrase: 2, barsLeftInPhrase: 7, next: { label: "Drop", bars: 15 } });
    // The last bar before the drop.
    expect(phraseInfo(d, 31.2)?.next).toEqual({ label: "Drop", bars: 1 });
    // In the drop: bar 17 is bar 1 of a phrase; the outro is 16 bars on.
    expect(phraseInfo(d, 33)).toMatchObject({ barInPhrase: 1, next: { label: "Outro", bars: 16 } });
    expect(phraseInfo(d, 90)?.next).toBeNull();
  });
});
