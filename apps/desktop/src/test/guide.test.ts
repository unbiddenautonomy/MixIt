import { describe, expect, it } from "vitest";
import { withPoint } from "../components/arrange/AutomationEditor";
import { CONCEPTS } from "../guide/concepts";
import { LABS, labById } from "../guide/labs";
import { offBoundary, runLab, useGuide } from "../guide/model";
import { detectProblems, PROBLEMS, problemControls } from "../guide/troubleshoot";
import { useApp } from "../store/app";
import { emptyTelemetry, useTelemetry } from "../store/telemetry";
import type { Telemetry } from "../backend/types";

const playingOn = (...decks: number[]): Telemetry => ({
  ...emptyTelemetry,
  decks: emptyTelemetry.decks.map((d, i) => ({ ...d, loaded: decks.includes(i), playing: decks.includes(i), master: i === decks[0], rate: 1, keylock: true })),
});

describe("guide content", () => {
  it("has unique ids and links that resolve", () => {
    expect(new Set(LABS.map((l) => l.id)).size).toBe(LABS.length);
    expect(LABS.map((l) => l.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const l of LABS) expect(new Set(l.steps.map((s) => s.id)).size).toBe(l.steps.length);
    const concepts = new Set(CONCEPTS.map((c) => c.id));
    expect(concepts.size).toBe(CONCEPTS.length);
    for (const c of CONCEPTS) if (c.lab) expect(labById(c.lab), c.id).toBeDefined();
    for (const p of PROBLEMS) if (p.concept) expect(concepts.has(p.concept), p.id).toBe(true);
  });

  it("fills deck letters into a problem's controls", () => {
    const mud = PROBLEMS.find((p) => p.id === "mud")!;
    expect(problemControls(mud, [0, 1])).toEqual(["mixer.A.eq.low", "mixer.B.eq.low"]);
    expect(problemControls(mud, [])).toEqual(["mixer.A.eq.low"]);
  });
});

describe("lab checks", () => {
  it("measures distance from a phrase boundary", () => {
    expect(offBoundary(64, 32)).toBe(0);
    expect(offBoundary(63.5, 32)).toBeCloseTo(0.5);
    expect(offBoundary(33, 32)).toBeCloseTo(1);
    expect(offBoundary(-1, 32)).toBeCloseTo(1);
  });

  it("ticks off a step when you do it, and only then", () => {
    const lab = labById("phrase-drop")!;
    useGuide.getState().resetLab(lab.id);
    useTelemetry.getState().set(playingOn());
    runLab(lab);
    expect(useGuide.getState().done[lab.id]).toEqual([]);
    useTelemetry.getState().set(playingOn(0));
    runLab(lab);
    expect(useGuide.getState().done[lab.id]).toEqual(["play-a"]);
  });
});

describe("troubleshooting", () => {
  it("spots two basslines at once and stops when one is cut", () => {
    const s = useApp.getState();
    const mixer = { ...s.mixer, crossfader: 0, channels: s.mixer.channels.map((c) => ({ ...c, fader: 1, low: 0 })) };
    const ctx = { t: playingOn(0, 1), decks: s.decks, mixer, audio: null, count: 2 };
    expect(detectProblems(ctx).get("mud")).toEqual([0, 1]);
    mixer.channels[1] = { ...mixer.channels[1], low: -26 };
    expect(detectProblems(ctx).has("mud")).toBe(false);
  });

  it("notices key lock off with a big tempo change", () => {
    const s = useApp.getState();
    const t = playingOn(0);
    t.decks[0] = { ...t.decks[0], keylock: false, rate: 1.08 };
    expect(detectProblems({ t, decks: s.decks, mixer: s.mixer, audio: null, count: 2 }).get("chipmunk")).toEqual([0]);
  });
});

describe("automation points", () => {
  it("keeps one point per beat, sorted", () => {
    const pts = [
      { beat: 0, value: 1, curve: "Linear" as const },
      { beat: 8, value: 0, curve: "Linear" as const },
    ];
    expect(withPoint(pts, { beat: 4, value: 0.5, curve: "Linear" }).map((p) => p.beat)).toEqual([0, 4, 8]);
    expect(withPoint(pts, { beat: 8, value: 0.2, curve: "Linear" }).find((p) => p.beat === 8)!.value).toBe(0.2);
    // Moving point 0 past point 1 replaces it rather than duplicating.
    expect(withPoint(pts, { beat: 12, value: 1, curve: "Linear" }, 0).map((p) => p.beat)).toEqual([8, 12]);
  });
});
