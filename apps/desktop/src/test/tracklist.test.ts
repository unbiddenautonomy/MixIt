import { describe, expect, it } from "vitest";
import type { Capture, CaptureFrame, DeckFrame } from "../lib/capture";
import { cueSheet, timestamp, tracklistFromCapture, tracklistText } from "../lib/tracklist";

const deck = (token: number, volume: number, playing = true): DeckFrame => ({ token, playing, beat: 0, bpm: 124, keylock: false, keyShift: 0, volume, low: 0, mid: 0, high: 0, filter: 0, trim: 0, fxMix: 0, fxKind: 0, fxBeats: 1 });
const ref = (title: string, artist: string) => ({ hash: null, path: null, title, artist, bpm: 124, key: null, duration: 300 });

/** A mix at 10 frames a second: A alone, a 30 s blend into B, B alone; C only peeks in for 5 s. */
function mix(): Capture {
  const frames: CaptureFrame[] = [];
  for (let i = 0; i <= 3000; i++) {
    const t = i / 10;
    const a = t < 120 ? 1 : t < 150 ? 1 - (t - 120) / 30 : 0;
    const b = t < 115 ? null : t < 150 ? (t - 115) / 35 : 1;
    const c = t >= 200 && t < 205 ? 0.8 : null;
    frames.push({ t, clockBpm: 124, decks: [a > 0 ? deck(1, a) : null, b !== null ? deck(2, b) : null, c !== null ? deck(3, c) : null, null] });
  }
  return { name: "Test", frames, tracks: { 1: ref("First", "Ann"), 2: ref("Second \"Live\"", "Bo"), 3: ref("Peek", "Cy") } };
}

describe("recording tracklist", () => {
  it("lists the tracks heard, from when each became clearly audible", () => {
    const list = tracklistFromCapture(mix());
    expect(list.map((e) => e.title)).toEqual(["First", "Second \"Live\""]);
    expect(list[0].at).toBe(0);
    // B crosses half volume 17.5 s into its 35 s fade (115 + 17.5).
    expect(list[1].at).toBeCloseTo(132.5, 0);
  });

  it("formats times and text", () => {
    expect(timestamp(0)).toBe("0:00");
    expect(timestamp(245.9)).toBe("4:05");
    expect(timestamp(3723)).toBe("1:02:03");
    expect(tracklistText(tracklistFromCapture(mix()))).toBe("01. [0:00] Ann - First\n02. [2:12] Bo - Second \"Live\"\n");
  });

  it("writes a CUE sheet", () => {
    const cue = cueSheet(tracklistFromCapture(mix()), "C:\\Music\\Rec\\set.wav", "Friday");
    expect(cue).toContain('FILE "set.wav" WAVE');
    expect(cue).toContain('TITLE "Second \'Live\'"');
    expect(cue).toContain("INDEX 01 00:00:00");
    expect(cue).toMatch(/INDEX 01 02:1[23]:\d\d/);
    expect(cue.split("\r\n").filter((l) => l.includes("TRACK")).length).toBe(2);
  });
});
