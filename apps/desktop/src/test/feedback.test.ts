import { describe, expect, it } from "vitest";
import type { Capture, CaptureFrame, DeckFrame } from "../lib/capture";
import { mixReport } from "../lib/feedback";
import type { TrackRef } from "../backend/types";

const ref = (title: string, key: { tonic: number; mode: "Major" | "Minor" } | null = null): TrackRef => ({ hash: null, path: `/m/${title}.wav`, title, artist: "", bpm: 124, key, duration: 300 });
const deck = (p: Partial<DeckFrame>): DeckFrame => ({ token: 1, playing: true, beat: 0, bpm: 124, keylock: true, keyShift: 0, volume: 1, low: 0, mid: 0, high: 0, filter: 0, trim: 0, fxMix: 0, fxKind: 0, fxBeats: 1, ...p });
const ramp = (x: number, a: number, z: number) => Math.max(0, Math.min(1, (x - a) / (z - a)));

interface Opts {
  bOffset?: number; // beats B's grid is shifted against A
  bBpm?: number;
  bassSwap?: boolean;
  gap?: boolean;
  keys?: [number, number];
}

/** A plays clock beats 0..96, B comes in over 64..80 and plays to 160. */
function mix(o: Opts = {}): Capture {
  const frames: CaptureFrame[] = [];
  const bps = 124 / 60;
  for (let i = 0; i * 0.05 * bps <= 160; i++) {
    const t = i * 0.05;
    const b = t * bps;
    const aOn = o.gap ? b < 60 : b < 96;
    const a = aOn ? deck({ token: 1, beat: b, volume: o.gap ? 1 : 1 - ramp(b, 80, 96) }) : null;
    const bBpm = o.bBpm ?? 124;
    const bBeat = (b - 64) * (bBpm / 124) + (o.bOffset ?? 0);
    const low = o.bassSwap === false ? 0 : b < 80 ? -26 : 0;
    const aLow = o.bassSwap === false ? 0 : b < 80 ? 0 : -26;
    if (a) a.low = aLow;
    const bb = b >= (o.gap ? 64 : 64) ? deck({ token: 2, beat: bBeat, bpm: bBpm, volume: o.gap ? 1 : ramp(b, 64, 72), low }) : null;
    frames.push({ t, clockBpm: 124, decks: [a, bb, null, null], master: { peak: 0.7, clipped: false, limiterDb: 0, lufs: -10 } });
  }
  const keys = o.keys ?? [9, 9];
  return { name: "Test", frames, tracks: { 1: ref("One", { tonic: keys[0], mode: "Minor" }), 2: ref("Two", { tonic: keys[1], mode: "Minor" }) } };
}

describe("mix feedback", () => {
  it("praises a clean bass-swap blend", () => {
    const r = mixReport(mix())!;
    expect(r.transitions).toHaveLength(1);
    const t = r.transitions[0];
    expect(t.from).toBe("One");
    expect(t.offsetMs).toBeLessThan(2);
    expect(t.barOffset).toBe(0);
    expect(t.phraseOffset).toBe(0);
    expect(t.bassClash).toBeLessThan(2);
    expect(t.usedEq).toBe(true);
    expect(r.findings.filter((f) => f.severity !== "good")).toEqual([]);
    expect(r.findings.map((f) => f.id)).toContain("clean");
    expect(r.score).toBe(100);
  });

  it("catches off-beat kicks, a wrong bar, clashing bass and keys", () => {
    const r = mixReport(mix({ bOffset: 2.1, bassSwap: false, keys: [9, 3] }))!;
    const ids = r.findings.filter((f) => f.severity !== "good").map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["phase", "downbeat", "bass", "key"]));
    expect(r.transitions[0].offsetMs).toBeGreaterThan(40);
    expect(r.score).toBeLessThan(80);
    expect(r.findings.find((f) => f.id === "bass")!.lab).toBe("bass-swap");
  });

  it("notices phrases a few bars apart and tempos that drift", () => {
    expect(mixReport(mix({ bOffset: 8 }))!.findings.map((f) => f.id)).toContain("phrase");
    const r = mixReport(mix({ bBpm: 127 }))!;
    expect(r.transitions[0].tempoPct).toBeCloseTo(2.4, 0);
    expect(r.findings[0].id).toBe("tempo");
  });

  it("finds silence between tracks", () => {
    const r = mixReport(mix({ gap: true }))!;
    const s = r.findings.find((f) => f.id === "silence")!;
    expect(s.severity).toBe("problem");
    expect(s.at).toBeGreaterThan(28);
    expect(r.transitions).toHaveLength(0);
  });

  it("says nothing about a recording with nothing in it", () => {
    expect(mixReport({ name: "x", frames: [], tracks: {} })).toBeNull();
  });
});

describe("phrase-aligned transitions", async () => {
  const { phraseStart } = await import("../lib/transition");
  it("starts the new track at the top of the next phrase", () => {
    // Out deck at beat 37.5, new track cued at its beat 0: next phrase is beat 64.
    expect(phraseStart(37.5, 0, 4, 200)).toBe(64);
    // New track cued 2 bars into a phrase: start where the out deck is 2 bars in too.
    expect(phraseStart(37.5, 8, 4, 200)).toBe(40);
    // Not enough track left: no phrase start.
    expect(phraseStart(37.5, 0, 4, 10)).toBeNull();
  });
});
