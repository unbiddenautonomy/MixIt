import { beforeEach, describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../lib/actions", () => ({ press: vi.fn(async () => {}), release: vi.fn(async () => {}), setOn: vi.fn(async () => {}), setValue: vi.fn(async () => {}) }));
import type { DeckInfo, SectionDto, TrackDetail } from "../backend/types";
import { beatAtSeconds, planMix, secondsAtBeat } from "../lib/autodj";
import { fromCamelot, keyDto } from "../lib/keys";
import { cancelTransition, mixItStart, startTransition, useTransition } from "../lib/transition";
import { vocalClearStart, vocalOverlap } from "../lib/vocalTiming";
import { useApp } from "../store/app";
import { emptyTelemetry, useTelemetry } from "../store/telemetry";

// Half a second a beat (120 BPM), beat 0 at 0 s, so seconds are beats / 2.
const at = (b: number) => b / 2;
const clear = (regions: [number, number][], o: Partial<Parameters<typeof vocalClearStart>[0]> = {}) =>
  vocalClearStart({ regions, secondsAt: at, candidate: 32, beats: 16, beatsPerBar: 4, endBeat: 400, earliest: 0, ...o });

describe("vocal overlap", () => {
  it("adds up the singing inside a window", () => {
    expect(vocalOverlap(undefined, 0, 10)).toBe(0);
    expect(vocalOverlap([[2, 4], [6, 20]], 3, 8)).toBe(3);
    expect(vocalOverlap([[2, 4]], 5, 4)).toBe(0);
  });
});

describe("a start clear of the singing", () => {
  it("keeps the planned start when nothing is sung there, or only a breath", () => {
    expect(clear([])).toEqual({ start: 32, moved: false, before: 0 });
    expect(clear([[16, 16.5]]).moved).toBe(false);
    expect(clear([[60, 70]]).moved).toBe(false);
  });

  it("waits a whole phrase for a line to end rather than starting mid-phrase", () => {
    // Sung from beat 32 to 36: one bar later is clear, but a phrase later keeps builds lined up.
    const c = clear([[16, 18]]);
    expect(c).toMatchObject({ start: 64, moved: true });
    expect(c.before).toBeCloseTo(2, 9);
  });

  it("goes earlier only when later can't fit before the music ends", () => {
    expect(clear([[16, 18]], { endBeat: 70 }).start).toBe(0);
    // Never before the earliest beat it may start.
    expect(clear([[16, 18]], { endBeat: 70, earliest: 4 }).start).toBe(36);
  });

  it("stays put when the singing never stops nearby (the dip handles it)", () => {
    expect(clear([[0, 200]])).toMatchObject({ start: 32, moved: false });
  });
});

describe("Mix it waits for the line to end", () => {
  const deck = { beat: 0, position: 0, baseBpm: 120, bpm: 120, remaining: 200, beatsPerBar: 4 };
  it("moves at most a phrase later, never earlier", () => {
    expect(mixItStart([[15, 20]], deck, 32, 16, 4)).toMatchObject({ start: 64, moved: true });
    // Singing for the next phrase and more: start as planned.
    expect(mixItStart([[15, 50]], deck, 32, 16, 4)).toMatchObject({ start: 32, moved: false });
    // A gap only before the planned start is not used (Mix it starts no sooner than planned).
    expect(mixItStart([[10, 40]], { ...deck, beat: 0 }, 32, 16, 4).moved).toBe(false);
  });

  beforeEach(() => {
    cancelTransition();
    toast.mockClear();
  });

  it("starts a blend after deck A's line and says so", async () => {
    const t = structuredClone(emptyTelemetry);
    t.decks[0] = { ...t.decks[0], loaded: true, playing: true, position: 10, beat: 20, bpm: 120, baseBpm: 120, remaining: 200, beatsPerBar: 4 };
    t.decks[1] = { ...t.decks[1], loaded: true, playing: false, position: 0, beat: 0, bpm: 120, baseBpm: 120, remaining: 200, beatsPerBar: 4 };
    useTelemetry.setState({ t });
    const sung = { deck: 0, detail: { vocals: [[15, 22]] } } as unknown as DeckInfo;
    useApp.setState({ decks: [sung, null, null, null] });
    await startTransition(0, 1, "blend", 16);
    // The next phrase is beat 32 (16 s), inside the line; one phrase later (64) is clear.
    expect(useTransition.getState().running?.startBeat).toBe(64);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Deck A is singing.*starts in 22 s/));
    cancelTransition();

    // Without singing it starts on the next phrase, with no message.
    toast.mockClear();
    useApp.setState({ decks: [{ deck: 0, detail: {} } as unknown as DeckInfo, null, null, null] });
    await startTransition(0, 1, "blend", 16);
    expect(useTransition.getState().running?.startBeat).toBe(32);
    expect(toast).not.toHaveBeenCalled();
    cancelTransition();

    // A start Auto DJ planned is kept as it is.
    useApp.setState({ decks: [sung, null, null, null] });
    await startTransition(0, 1, "blend", 16, { atBeat: 32 });
    expect(useTransition.getState().running?.startBeat).toBe(32);
    cancelTransition();
  });
});

/** A 128-bar track at 124 BPM with an outro from bar 112 (beat 448), singing where asked (beats). */
function track(sung: [number, number][] = []): TrackDetail {
  const bpm = 124;
  const period = 60 / bpm;
  const first = 0.1;
  const plan: [string, number, number][] = [
    ["Intro", 16, 0.35],
    ["Build", 16, 0.6],
    ["Drop", 32, 1],
    ["Breakdown", 16, 0.3],
    ["Drop", 32, 1],
    ["Outro", 16, 0.4],
  ];
  const sections: SectionDto[] = [];
  let t = first;
  for (const [label, bars, energy] of plan) {
    sections.push({ start: t, end: t + bars * 4 * period, bars, label, energy });
    t += bars * 4 * period;
  }
  return {
    track: { id: 1, title: "T", artist: "", duration: t + 2 } as TrackDetail["track"],
    analysed: true,
    bpm,
    bpmCandidates: [],
    tempoConfidence: 1,
    driftMs: 0,
    constantGrid: true,
    gridLocked: false,
    beatsPerBar: 4,
    firstBeat: first,
    beatPeriod: period,
    beats: [],
    key: keyDto(fromCamelot(8, "A")),
    keyConfidence: 1,
    keySecond: null,
    tuningCents: 0,
    lufs: -9,
    truePeak: -1,
    autoGainDb: 0,
    energy: 5,
    energyCurve: [],
    energyCurveStart: 0,
    sections,
    cues: [],
    audible: [first, t],
    vocals: sung.map(([a, b]) => [first + a * period, first + b * period]),
  };
}

describe("Auto DJ plans around the singing", () => {
  it("plans the blend at the outro when it is instrumental", () => {
    const p = planMix(track(), track());
    expect(p.outStartBeat).toBe(448);
    expect(p.reasons.join(" ")).not.toMatch(/singing/);
  });

  it("starts after a line that runs into the outro", () => {
    const out = track([[440, 460]]);
    const p = planMix(out, track());
    expect(p.outStartBeat).toBe(480);
    expect(p.outStartBeat + p.beats).toBeLessThanOrEqual(beatAtSeconds(out, out.audible[1]) + 1e-6);
    expect(p.outStartSeconds).toBeCloseTo(secondsAtBeat(out, 480), 9);
    expect(p.reasons.join(" ")).toMatch(/singing at the planned point, so the mix moves 8 bars later/);
  });

  it("starts before the singing when it runs to the end", () => {
    const p = planMix(track([[452, 512]]), track());
    expect(p.outStartBeat).toBe(416);
    expect(p.reasons.join(" ")).toMatch(/8 bars earlier/);
  });

  it("never moves into the past", () => {
    const p = planMix(track([[452, 512]]), track(), undefined, 430);
    expect(p.outStartBeat).toBeGreaterThan(430);
  });
});
