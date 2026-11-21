import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  applyTransition,
  captureTemplate,
  clipKeyDto,
  matchKeyShift,
  moveClip,
  projectIssues,
  rampsInto,
  removeTempoChange,
  setTempoChange,
  snapClipStart,
  valueAt,
} from "../lib/arrangeOps";
import { bpmAt, emptyProject } from "../components/arrange/projectIo";
import type { Clip, MixProject } from "../backend/types";

const clip = (id: number, start: number, length: number, lane: number, p: Partial<Clip> = {}): Clip => ({
  id,
  track: { hash: null, path: `/m/${id}.wav`, title: `T${id}`, artist: "", bpm: 124, key: null, duration: 300 },
  lane,
  start,
  length,
  source_start: 0,
  key_shift: 0,
  keylock: true,
  gain_db: 0,
  lanes: [],
  fx: null,
  name: `T${id}`,
  ...p,
});

const two = (): MixProject => ({ ...emptyProject("Set", 124), clips: [clip(1, 0, 128, 0), clip(2, 96, 128, 0)], next_id: 3 });

describe("arrange edits", () => {
  it("adds, ramps and removes tempo changes", () => {
    let p = setTempoChange(two(), 64, 128, false);
    expect(p.tempo.segments.map((s) => s.start_beat)).toEqual([0, 64]);
    expect(bpmAt(p, 63)).toBe(124);
    expect(bpmAt(p, 64)).toBe(128);
    p = setTempoChange(p, 64, 128, true);
    expect(rampsInto(p, 1)).toBe(true);
    expect(bpmAt(p, 32)).toBeCloseTo(126);
    p = setTempoChange(p, 128, 300, false);
    expect(p.tempo.segments[2].bpm).toBe(250);
    p = removeTempoChange(p, 1);
    expect(p.tempo.segments.map((s) => s.start_beat)).toEqual([0, 128]);
    expect(removeTempoChange(p, 0)).toBe(p);
  });

  it("snaps to phrases of the track already playing", () => {
    const p = two();
    // Clip 1 starts at beat 0 from its beat 8: its phrases start at timeline beats -8, 24, 56, 88…
    p.clips[0] = { ...p.clips[0], source_start: 8 };
    const b = { ...p.clips[1], lane: 1 };
    expect(snapClipStart(p, b, 93, "phrase")).toBe(88);
    expect(snapClipStart(p, { ...b, lane: 0 }, 93, "bar")).toBe(92);
    expect(snapClipStart(p, b, 93.4, "beat")).toBe(93);
    // A clip coming in from its own beat 4 lines its phrase (beat 32) up with the mix's.
    expect(snapClipStart(p, { ...b, source_start: 4 }, 93, "phrase")).toBe(92);
  });

  it("moves automation with a moved clip", () => {
    const p = two();
    p.clips[1].lanes = [{ param: "Volume", points: [{ beat: 96, value: 0, curve: "Linear" }] }];
    const m = moveClip(p, 2, 100, 2);
    expect(m.clips[1].start).toBe(100);
    expect(m.clips[1].lane).toBe(2);
    expect(m.clips[1].lanes[0].points[0].beat).toBe(100);
  });

  it("writes a bass swap that never plays two basslines", () => {
    const p = applyTransition(two(), 1, 2, "BassSwap", 32);
    const [a, b] = p.clips;
    expect(a.start + a.length).toBe(128);
    expect(a.lane).not.toBe(b.lane);
    for (let beat = 96; beat < 128; beat += 0.5) {
      const both = valueAt(a, "EqLow", beat) > -6 && valueAt(b, "EqLow", beat) > -6;
      expect(both, `beat ${beat}`).toBe(false);
    }
    expect(valueAt(b, "EqLow", 120)).toBe(0);
    expect(() => applyTransition(p, 2, 1, "Blend", 16)).toThrow();
  });

  it("blends with equal power", () => {
    const [a, b] = applyTransition(two(), 1, 2, "Blend", 32).clips;
    const va = valueAt(a, "Volume", 112);
    const vb = valueAt(b, "Volume", 112);
    expect(va * va + vb * vb).toBeCloseTo(1, 2);
  });

  it("saves a transition as a template and reuses it at another length", () => {
    const p = applyTransition(two(), 1, 2, "FilterFade", 32);
    const t = captureTemplate(p, 1, 2, "My filter");
    expect(t.beats).toBe(32);
    const q: MixProject = { ...emptyProject("Other", 124), clips: [clip(1, 0, 200, 0), clip(2, 160, 128, 1)] };
    const r = applyTemplate(q, 1, 2, t, 16);
    const [a, b] = r.clips;
    expect(a.start + a.length).toBe(176);
    expect(valueAt(a, "Filter", 176)).toBeCloseTo(0.85);
    expect(valueAt(b, "Filter", 160)).toBeCloseTo(-0.85);
    expect(valueAt(b, "Filter", 176)).toBeCloseTo(0);
  });

  it("matches keys and reports clashes", () => {
    const p = two();
    p.clips[0].track.key = { tonic: 9, mode: "Minor" }; // 8A
    p.clips[1].track.key = { tonic: 2, mode: "Major" }; // 10B: clashes with 8A
    const issues = projectIssues(p, (b) => bpmAt(p, b));
    expect(issues.map((i) => i.kind).sort()).toEqual(["key", "overlap"]);
    const s = matchKeyShift(p, p.clips[1])!;
    expect(s).not.toBeNull();
    const fixed = { ...p, clips: [p.clips[0], { ...p.clips[1], key_shift: s, lane: 1 }] };
    expect(projectIssues(fixed, (b) => bpmAt(fixed, b))).toEqual([]);
    expect(clipKeyDto(fixed.clips[1])).not.toBeNull();
  });

  it("flags tracks stretched too far", () => {
    const p = { ...two(), clips: [clip(1, 0, 64, 0, { track: { ...clip(1, 0, 0, 0).track, bpm: 100 } })] };
    expect(projectIssues(p, (b) => bpmAt(p, b))[0]).toMatchObject({ kind: "stretch", clip: 1 });
  });
});

describe("edit history", () => {
  it("labels edits, merges a drag into one step and jumps back and forth", async () => {
    const { setProject, updateClip, jumpHistory, useHistory, labelFor } = await import("../components/arrange/projectIo");
    const { useApp } = await import("../store/app");
    setProject(two(), null);
    expect(useHistory.getState().base).toBe("Started");
    updateClip(2, { start: 100 });
    updateClip(2, { start: 104 }); // same drag
    updateClip(2, { gain_db: -3 });
    setProject(setTempoChange(useApp.getState().project!, 64, 126, false), undefined, undefined, "Add a tempo change at bar 17");
    expect(useHistory.getState().undo).toEqual(["Move clip", "Change clip gain", "Add a tempo change at bar 17"]);
    jumpHistory(1);
    expect(useApp.getState().project!.clips[1].start).toBe(104);
    expect(useApp.getState().project!.clips[1].gain_db).toBe(0);
    expect(useHistory.getState().redo).toEqual(["Change clip gain", "Add a tempo change at bar 17"]);
    jumpHistory(3);
    expect(useApp.getState().project!.tempo.segments).toHaveLength(2);
    jumpHistory(0);
    expect(useApp.getState().project!.clips[1].start).toBe(96);
    expect(labelFor("clip:4:lanes")).toBe("Edit automation");
  });
});
