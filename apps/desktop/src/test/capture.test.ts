import { describe, expect, it } from "vitest";
import { buildProject, crossfaderGain, simplify, type Capture, type CaptureFrame, type DeckFrame } from "../lib/capture";
import type { TrackRef } from "../backend/types";
import { bpmAt } from "../components/arrange/projectIo";

const ref = (title: string): TrackRef => ({ hash: null, path: `/m/${title}.wav`, title, artist: "", bpm: 124, key: null, duration: 300 });

const deck = (p: Partial<DeckFrame>): DeckFrame => ({
  token: 1,
  playing: true,
  beat: 0,
  bpm: 124,
  keylock: false,
  keyShift: 0,
  volume: 1,
  low: 0,
  mid: 0,
  high: 0,
  filter: 0,
  trim: 0,
  fxMix: 0,
  fxKind: 0,
  fxBeats: 1,
  ...p,
});

/**
 * A two-deck blend at 124 BPM, 20 frames a second, as a function of the clock beat:
 * A plays from beat 0 (track beat 16) and fades out over beats 56..64, stopping at 66.
 * B starts in the headphones at clock beat 32 (track beat 0), is faded in over 48..56 with
 * its bass cut until 60, and at clock beat 80 jumps back 16 beats (a hot cue).
 */
function blend(): Capture {
  const frames: CaptureFrame[] = [];
  const bps = 124 / 60;
  for (let i = 0; i * 0.05 * bps <= 100; i++) {
    const t = i * 0.05;
    const b = t * bps;
    const ramp = (x: number, a: number, z: number) => Math.max(0, Math.min(1, (x - a) / (z - a)));
    const a = b < 66 ? deck({ token: 1, beat: 16 + b, volume: 1 - ramp(b, 56, 64) }) : deck({ token: 1, playing: false, beat: 16 + 66 });
    const bb = b < 32 ? null : deck({ token: 2, beat: b - 32 - (b >= 80 ? 16 : 0), volume: ramp(b, 48, 56), low: b < 60 ? -26 : 0 });
    frames.push({ t, clockBpm: 124, decks: [a, bb, null, null] });
  }
  return { name: "Test mix", frames, tracks: { 1: ref("One"), 2: ref("Two") } };
}

describe("live mix capture", () => {
  it("turns a blend into beat-aligned clips with automation", () => {
    const p = buildProject(blend())!;
    expect(p).not.toBeNull();
    expect(p.tempo.segments).toEqual([{ start_beat: 0, bpm: 124, end_bpm: 124 }]);
    const [a, b1, b2] = p.clips;
    expect(p.clips.map((c) => [c.lane, c.track.title])).toEqual([
      [0, "One"],
      [1, "Two"],
      [1, "Two"],
    ]);
    // A starts on a bar, one bar in, with its bars on the project's bars.
    expect(a.start).toBeGreaterThanOrEqual(4);
    expect(a.start).toBeLessThan(8);
    expect(a.source_start).toBeCloseTo(16, 1);
    expect((((a.start - a.source_start) % 4) + 4) % 4).toBeCloseTo(0, 3);
    // A ends where it went silent (beat 64 of the clock), not where it stopped.
    const shift = a.start; // clock beat 0 on the timeline
    expect(a.start + a.length).toBeCloseTo(shift + 64, 0);
    // B is trimmed to where it was heard (clock beat 48), keeps its phase against A.
    expect(b1.start).toBeCloseTo(shift + 48, 0);
    expect(b1.start - b1.source_start).toBeCloseTo(shift + 32, 1);
    // The hot cue jump splits B; both parts stay beat-aligned.
    expect(b1.start + b1.length).toBeCloseTo(b2.start, 3);
    expect(b2.start - b2.source_start).toBeCloseTo(shift + 48, 1);
    // Automation: A's fade and B's fade in and bass swap, with few points.
    const vol = a.lanes.find((l) => l.param === "Volume")!;
    expect(vol.points.length).toBeLessThanOrEqual(4);
    expect(vol.points[vol.points.length - 1].value).toBeLessThan(0.05);
    const low = b1.lanes.find((l) => l.param === "EqLow")!;
    expect(low.points[0].value).toBe(-26);
    expect(low.points[low.points.length - 1].value).toBe(0);
    expect(b2.lanes.find((l) => l.param === "EqLow")).toBeUndefined();
    expect(a.lanes.find((l) => l.param === "Filter")).toBeUndefined();
    expect(p.markers[0].beat).toBe(a.start);
  });

  it("starts the tempo where the first clip starts", () => {
    const cap = blend();
    // The clock free-ran at 120 before deck A started.
    cap.frames.unshift({ t: -1, clockBpm: 120, decks: [null, null, null, null] });
    expect(buildProject(cap)!.tempo.segments).toEqual([{ start_beat: 0, bpm: 124, end_bpm: 124 }]);
  });

  it("follows tempo changes on the clock", () => {
    const cap = blend();
    cap.frames.forEach((f, i) => (f.clockBpm = i < 400 ? 124 : 126));
    const p = buildProject(cap)!;
    expect(p.tempo.segments.length).toBe(2);
    expect(bpmAt(p, 0)).toBe(124);
    expect(bpmAt(p, 1000)).toBe(126);
  });

  it("gives nothing when nothing was heard", () => {
    const cap = blend();
    cap.frames.forEach((f) => f.decks.forEach((d) => d && (d.volume = 0)));
    expect(buildProject(cap)).toBeNull();
    expect(buildProject({ name: "x", frames: [], tracks: {} })).toBeNull();
  });

  it("simplifies curves and folds in the crossfader", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ beat: i, value: i / 49 }));
    expect(simplify(line, 0.01)).toHaveLength(2);
    const step = [...line.slice(0, 25).map((p) => ({ ...p, value: 0 })), ...line.slice(25).map((p) => ({ ...p, value: 1 }))];
    expect(simplify(step, 0.01).length).toBeLessThanOrEqual(4);
    expect(crossfaderGain(-1, 0, false)).toBe(1);
    expect(crossfaderGain(1, 0, false)).toBe(0);
    expect(crossfaderGain(1, 2, false)).toBe(1);
    expect(crossfaderGain(1, 2, true)).toBe(0);
    expect(crossfaderGain(0.3, 1, false)).toBe(1);
  });
});
