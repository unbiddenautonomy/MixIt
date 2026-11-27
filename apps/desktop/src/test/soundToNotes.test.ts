import { beforeEach, describe, expect, it } from "vitest";
import { setBackendForTests, type Backend } from "../backend";
import { DemoBackend } from "../backend/demo";
import type { HeardNote, SequencerDto } from "../backend/types";
import { clearPattern, commonNote, doublePattern, noteName, notesToPattern, sequencerDto, setPitch, setRow, setStep, setSteps, shiftRow, useSequencer } from "../store/sequencer";

const sent: SequencerDto[] = [];
setBackendForTests({ samplerSequence: async (s: SequencerDto) => void sent.push(s) } as unknown as Backend);

const note = (start: number, pitch: number, strength = 0.8, length = 0.2): HeardNote => ({ start, length, pitch, strength });

describe("notes to a pattern", () => {
  it("puts each note on its nearest step, pitched from the note heard most", () => {
    // At 120 BPM a sixteenth is 0.125 s. A3 is held longest, so it plays the pad as recorded.
    const notes = [note(0.0, 57, 0.8, 0.5), note(0.26, 60), note(0.49, 64), note(1.0, 62), note(1.51, 57, 0.8, 0.4)];
    const p = notesToPattern(notes, 120, 0.25);
    expect(p.root).toBe(57);
    expect(p.steps).toBe(16);
    expect(p.row.slice(0, 16).map((x) => (x ? "x" : ".")).join("")).toBe("x.x.x...x...x...");
    expect([0, 2, 4, 8, 12].map((s) => p.pitches[s])).toEqual([0, 3, 7, 5, 0]);
    expect(p.placed).toBe(5);
    expect(p.dropped).toBe(0);
  });

  it("skips empty bars before the first note and keeps the clearest note of a step", () => {
    // The tune starts in bar 2 (2 s in at 120 BPM), with a weak ghost on the first step.
    const p = notesToPattern([note(2.0, 60, 0.9), note(2.01, 67, 0.3), note(2.5, 62)], 120, 0.25, 60);
    expect(p.row[0]).toBe(true);
    expect(p.pitches[0]).toBe(0);
    expect(p.row[4]).toBe(true);
    expect(p.pitches[4]).toBe(2);
    expect(p.dropped).toBe(1);
  });

  it("moves notes too far from the pad's own note by octaves, and lengthens the pattern to fit", () => {
    const p = notesToPattern([note(0, 36), note(4.5, 96)], 120, 0.25, 60);
    expect(p.pitches[0]).toBe(-24);
    expect(p.pitches[36]).toBe(24);
    expect(p.steps).toBe(64);
    expect(commonNote([])).toBe(60);
    expect(noteName(57)).toBe("A3");
    expect(noteName(61)).toBe("C♯4");
  });
});

describe("pitches in the sequencer", () => {
  beforeEach(() => {
    clearPattern();
    setSteps(16);
    sent.length = 0;
  });

  it("go to the engine with the pattern and move with it", async () => {
    setStep(0, 2, true);
    setPitch(0, 2, 5);
    setPitch(0, 3, 99);
    expect(useSequencer.getState().pitches[0][3]).toBe(24);
    expect(sequencerDto().pitches?.[0].slice(0, 4)).toEqual([0, 0, 5, 24]);
    shiftRow(0, 1);
    expect(useSequencer.getState().pitches[0].slice(0, 5)).toEqual([0, 0, 0, 5, 24]);
    doublePattern();
    expect(useSequencer.getState().pitches[0][19]).toBe(5);
    clearPattern(0);
    expect(useSequencer.getState().pitches[0].every((n) => n === 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent.at(-1)?.pitches?.[0].every((n) => n === 0)).toBe(true);
  });

  it("takes a whole row from heard notes", async () => {
    const heard = await new DemoBackend().padNotes(0);
    const p = notesToPattern(heard.notes, heard.bpm ?? 120, 0.25);
    setRow(3, p.row, p.pitches, p.steps);
    const s = useSequencer.getState();
    expect(s.steps).toBe(16);
    expect(s.pads[3].filter(Boolean).length).toBe(12);
    expect(s.pitches[3][2]).toBe(p.pitches[2]);
  });
});
