import { describe, expect, it } from "vitest";
import type { EditOp } from "../backend/types";
import { applyEdits, demoSound, DEMO_SR, viewOf } from "../backend/demoSound";
import { afterStep, clipboardLength, describeOp, groupSteps, lengthAfter } from "../lib/soundEdit";

describe("sound editor steps", () => {
  it("say what they did in plain words", () => {
    expect(describeOp({ op: "fade", start: 0, end: 2, fadeIn: false, shape: "exponential" })).toBe("Fade out over 0.00 s to 2.00 s (natural)");
    expect(describeOp({ op: "normalize", to: "loudness", level: -14 })).toBe("Set the loudness to -14 LUFS");
    expect(describeOp({ op: "gain", start: 1, end: 75, db: -3 })).toBe("Turned down 1.00 s to 1:15.0 by 3.0 dB");
  });

  it("show Cut as one step", () => {
    const ops: EditOp[] = [
      { op: "copy", start: 1, end: 2 },
      { op: "delete", start: 1, end: 2 },
      { op: "paste", at: 0 },
    ];
    expect(groupSteps(ops)).toEqual([
      { from: 0, to: 1, label: "Cut 1.00 s to 2.00 s" },
      { from: 2, to: 2, label: "Pasted at 0.00 s" },
    ]);
    expect(clipboardLength(ops)).toBe(1);
  });

  it("track the length and selection the engine will produce", () => {
    expect(lengthAfter({ op: "delete", start: 1, end: 3 }, 10, 0)).toBe(8);
    expect(lengthAfter({ op: "trim", start: 2, end: 5 }, 10, 0)).toBe(3);
    expect(lengthAfter({ op: "paste", at: 2 }, 10, 1.5)).toBe(11.5);
    expect(afterStep({ op: "paste", at: 2 }, null, 2, 1.5)).toEqual({ sel: { start: 2, end: 3.5 }, cursor: 2 });
    expect(afterStep({ op: "delete", start: 3, end: 1 }, { start: 1, end: 3 }, 0, 0)).toEqual({ sel: null, cursor: 1 });
  });

  it("the demo stand-in agrees on lengths", () => {
    const a = demoSound(2);
    const ops: EditOp[] = [
      { op: "copy", start: 0.5, end: 1 },
      { op: "delete", start: 0.5, end: 1 },
      { op: "paste", at: 0 },
      { op: "insertSilence", at: 0, seconds: 0.25 },
    ];
    let len = 2;
    let clip = 0;
    for (const o of ops) {
      len = lengthAfter(o, len, clip);
      if (o.op === "copy") clip = o.end - o.start;
    }
    const out = applyEdits(a, ops);
    expect(out.length / 2 / DEMO_SR).toBeCloseTo(len, 3);
    expect(viewOf(out, 50).peaks).toHaveLength(50);
  });
});
