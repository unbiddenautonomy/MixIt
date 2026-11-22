import { describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import { setBackendForTests } from "../backend";
import { DemoBackend } from "../backend/demo";
import type { SectionDto, Telemetry, TrackDetail } from "../backend/types";
import { valueAt } from "../lib/arrangeOps";
import { beatAtSeconds, planMix } from "../lib/autodj";
import { fromCamelot, keyDto } from "../lib/keys";
import { medley, rehearsal } from "../lib/rehearse";
import { useApp } from "../store/app";
import { changeAt, hearPair, hearSet, musicOnAir, stopMix, useRehearse } from "../store/rehearse";
import { useAutoDj } from "../store/autodj";
import { emptyTelemetry, useTelemetry } from "../store/telemetry";
import { previewTrack, useTrackPreview } from "../store/trackPreview";

/** A 128-bar track with an outro from bar 112 (beat 448). */
function track(o: { bpm?: number; camelot?: [number, "A" | "B"]; energy?: number; id?: number } = {}): TrackDetail {
  const bpm = o.bpm ?? 124;
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
    track: { id: o.id ?? 1, title: `Track ${o.id ?? 1}`, artist: "MixIt", path: `/Music/${o.id ?? 1}.flac`, duration: t + 2 } as TrackDetail["track"],
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
    key: keyDto(fromCamelot(...(o.camelot ?? [8, "A"]))),
    keyConfidence: 1,
    keySecond: null,
    tuningCents: 0,
    lufs: -9,
    truePeak: -1,
    autoGainDb: 0,
    energy: o.energy ?? 5,
    energyCurve: [],
    energyCurveStart: 0,
    sections,
    cues: [],
    audible: [first, t],
  };
}

describe("a mix written out to hear first", () => {
  it("plays the outgoing track into the planned blend and on into the next track", () => {
    const out = track({ id: 1 });
    const inc = track({ id: 2, bpm: 126 });
    const plan = planMix(out, inc);
    expect(plan.kind).toBe("blend");
    const r = rehearsal(out, inc, plan);
    const [a, b] = r.project.clips;
    // 16 beats of lead-in, then the transition at the planned beat of the outgoing track.
    expect(a.start).toBe(0);
    expect(a.source_start).toBe(plan.outStartBeat - 16);
    expect(b.start).toBe(16);
    expect(b.lane).not.toBe(a.lane);
    expect(b.source_start).toBeCloseTo(beatAtSeconds(inc, plan.inCueSeconds), 9);
    expect(b.track.path).toBe("/Music/2.flac");
    // Synced: one tempo, the outgoing track's.
    expect(r.project.tempo.segments).toEqual([{ start_beat: 0, bpm: 124, end_bpm: 124 }]);
    // The crossfade: the outgoing track fades out over the plan's beats as the next comes in.
    expect(valueAt(a, "Volume", 15)).toBe(1);
    expect(valueAt(a, "Volume", 16 + plan.beats)).toBeCloseTo(0, 6);
    expect(valueAt(b, "Volume", 16)).toBeCloseTo(0, 6);
    expect(valueAt(b, "Volume", 16 + plan.beats)).toBe(1);
    expect(a.start + a.length).toBeLessThanOrEqual(16 + plan.beats + 1e-9);
    expect([r.from, r.to]).toEqual([0, 16 + plan.beats + 16]);
    expect(r.mixAt).toBeCloseTo((16 * 60) / 124, 9);
    expect(r.mixEnd).toBeCloseTo(((16 + plan.beats) * 60) / 124, 9);
  });

  it("keeps a key shift (with key lock) and a bass swap's swap", () => {
    const out = track({ id: 1, energy: 8 });
    const inc = track({ id: 2, energy: 8, camelot: [3, "A"] });
    const plan = planMix(out, inc);
    expect(plan.keyShift).not.toBe(0);
    const r = rehearsal(out, inc, plan);
    const b = r.project.clips[1];
    expect(b.key_shift).toBe(plan.keyShift);
    expect(b.keylock).toBe(true);
    if (plan.kind === "bassSwap") {
      expect(valueAt(b, "EqLow", 17)).toBeLessThan(-20);
      expect(valueAt(r.project.clips[0], "EqLow", 16 + plan.beats - 1)).toBeLessThan(-20);
    }
  });

  it("lets the next track keep its own tempo across a big gap", () => {
    const out = track({ id: 1, bpm: 124 });
    const inc = track({ id: 2, bpm: 140 });
    const plan = planMix(out, inc);
    expect(plan.sync).toBe(false);
    const r = rehearsal(out, inc, plan);
    expect(r.project.tempo.segments).toEqual([
      { start_beat: 0, bpm: 124, end_bpm: 124 },
      { start_beat: 16, bpm: 140, end_bpm: 140 },
    ]);
    expect(r.mixEnd - r.mixAt).toBeCloseTo((plan.beats * 60) / 140, 9);
  });

  it("starts no earlier than the outgoing track's first beat", () => {
    const out = track({ id: 1 });
    const plan = { ...planMix(out, track({ id: 2 })), outStartBeat: 8 };
    const r = rehearsal(out, track({ id: 2 }), plan);
    expect(r.project.clips[0].source_start).toBe(0);
    expect(r.project.clips[1].start).toBe(8);
    expect(r.mixAt).toBeCloseTo((8 * 60) / 124, 9);
  });
});

describe("hearing a mix in the preview player", () => {
  async function rig() {
    const b = new DemoBackend();
    setBackendForTests(b);
    let tele: Telemetry | null = null;
    b.onTelemetry((t) => (tele = t));
    const tick = (seconds: number) => {
      const sim = b as unknown as { last: number; tick: () => void };
      for (let i = 0; i < seconds * 10; i++) {
        sim.last = performance.now() - 100;
        sim.tick();
      }
      return tele!;
    };
    const rows = (await b.search("")).filter((r) => r.bpm && r.duration > 120);
    return { b, rows, tick };
  }

  it("plays the change between two queued tracks, then gives the player back to a track preview", async () => {
    const { rows, tick } = await rig();
    useTelemetry.setState({ t: structuredClone(emptyTelemetry) });
    useTrackPreview.setState({ route: "speakers" });
    await hearPair(rows[0], rows[1]);
    const s = useRehearse.getState();
    expect(s).toMatchObject({ key: `${rows[0].id}-${rows[1].id}`, status: "ready", title: `${rows[0].title} into ${rows[1].title}` });
    expect(s.summary).toMatch(/beats|Cut|Brake/);
    expect(s.duration).toBeGreaterThan(s.mixEnd);
    expect(s.mixAt).toBeGreaterThan(0);
    const t = tick(1);
    expect(t.preview.playing).toBe(true);
    expect(t.preview.position).toBeGreaterThan(0.5);
    expect(t.preview.synced).toBe(false);
    // A track preview takes over the player.
    await previewTrack(rows[2]);
    expect(useRehearse.getState().key).toBeNull();
    stopMix();
  });

  it("will not play on the speakers while the audience hears music", async () => {
    const { rows } = await rig();
    toast.error.mockClear();
    const t = structuredClone(emptyTelemetry);
    t.decks[0] = { ...t.decks[0], loaded: true, playing: true };
    useTelemetry.setState({ t });
    const ch = useApp.getState().mixer.channels.map((c, i) => (i === 0 ? { ...c, fader: 1 } : c));
    useApp.setState({ mixer: { ...useApp.getState().mixer, channels: ch } });
    expect(musicOnAir()).toBe(true);
    useTrackPreview.setState({ route: "speakers" });
    await hearPair(rows[0], rows[1]);
    expect(useRehearse.getState().key).toBeNull();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/audience would hear it/));
    // In the headphones it plays.
    useTrackPreview.setState({ route: "headphones" });
    await hearPair(rows[0], rows[1]);
    expect(useRehearse.getState().status).toBe("ready");
    stopMix();
    expect(useRehearse.getState().key).toBeNull();
  });
});

describe("a looped ending written out", () => {
  it("repeats the looped beats under the transition, with its automation", () => {
    const out = track({ id: 1 });
    const inc = track({ id: 2 });
    const plan = { ...planMix(out, inc), kind: "blend" as const, beats: 32, loopBeats: 8, outStartBeat: 320 };
    const r = rehearsal(out, inc, plan);
    const outs = r.project.clips.filter((c) => c.lane === 0).sort((x, y) => x.start - y.start);
    // The lead-in plus the first time round, then three more times round the 8 beats.
    expect(outs.map((c) => [c.start, c.length, c.source_start])).toEqual([
      [0, 24, 304],
      [24, 8, 320],
      [32, 8, 320],
      [40, 8, 320],
    ]);
    expect(new Set(r.project.clips.map((c) => c.id)).size).toBe(r.project.clips.length);
    // The fade carries on across the pieces.
    expect(valueAt(outs[2], "Volume", 40)).toBeLessThan(valueAt(outs[1], "Volume", 28));
    expect(r.to).toBe(16 + 32 + 16);
  });
});

describe("rehearsing a whole set", () => {
  it("plays each change back to back, at each change's tempo", () => {
    const a = track({ id: 1, bpm: 124 });
    const b = track({ id: 2, bpm: 126 });
    const c = track({ id: 3, bpm: 140 });
    const steps = [
      { out: a, inc: b, plan: planMix(a, b) },
      { out: b, inc: c, plan: planMix(b, c) },
    ];
    expect(steps[1].plan.sync).toBe(false);
    const m = medley(steps);
    const r0 = rehearsal(a, b, steps[0].plan, 8, 8);
    const len0 = r0.to - r0.from;
    // Two clips a change, the second change after the first.
    expect(m.project.clips).toHaveLength(4);
    expect(new Set(m.project.clips.map((x) => x.id)).size).toBe(4);
    expect(m.project.clips[2].start).toBe(len0);
    expect(m.to).toBe(len0 + (8 + steps[1].plan.beats + 8));
    // Automation moves with its clip.
    expect(valueAt(m.project.clips[2], "Volume", len0 + 7)).toBe(1);
    // The tempo map: the first change at 124 (synced), the second at 126, then 140 from its mix.
    expect(m.project.tempo.segments.map((s) => [s.start_beat, s.bpm])).toEqual([
      [0, 124],
      [len0, 126],
      [len0 + 8, 140],
    ]);
    // Where each transition is, in seconds into the medley.
    expect(m.changes[0].at).toBeCloseTo(r0.mixAt, 9);
    expect(m.changes[1].at).toBeCloseTo((len0 * 60) / 124 + (8 * 60) / 126, 9);
    expect(m.changes[1].end - m.changes[1].at).toBeCloseTo((steps[1].plan.beats * 60) / 140, 9);
    expect(m.changes.map((x) => x.label)).toEqual(["Track 1 into Track 2", "Track 2 into Track 3"]);
  });

  it("plays the Auto DJ queue's changes in the preview player", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    useTelemetry.setState({ t: structuredClone(emptyTelemetry) });
    useTrackPreview.setState({ route: "speakers" });
    const rows = (await b.search("")).filter((r) => r.bpm && r.duration > 120).slice(0, 4);
    useAutoDj.setState({ queue: rows, phase: "off", next: null, current: null });
    await hearSet();
    const s = useRehearse.getState();
    expect(s).toMatchObject({ key: "set", status: "ready", title: "The whole set: 3 changes" });
    expect(s.changes).toHaveLength(3);
    expect(s.changes[0].label).toMatch(new RegExp(`^${rows[0].title.replace(/[()]/g, ".")} into`));
    expect(s.duration).toBeGreaterThan(s.changes[2].end);
    expect(changeAt(s.changes[1].at + 0.1)).toBe(1);
    expect(changeAt(0)).toBe(0);
    stopMix();
    // One track: nothing to rehearse.
    useAutoDj.setState({ queue: rows.slice(0, 1) });
    await hearSet();
    expect(useRehearse.getState().key).toBeNull();
  });
});
