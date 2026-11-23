import { describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import { setBackendForTests } from "../backend";
import { DemoBackend } from "../backend/demo";
import type { SectionDto, Telemetry, TrackDetail } from "../backend/types";
import { valueAt } from "../lib/arrangeOps";
import { beatAtSeconds, planMix } from "../lib/autodj";
import { fromCamelot, keyDto } from "../lib/keys";
import { medley, rehearsal, setMix, tempoAt } from "../lib/rehearse";
import { useApp } from "../store/app";
import { changeAt, hearPair, hearSet, musicOnAir, retryChange, stopMix, useRehearse } from "../store/rehearse";
import { chooseTransition, planFor, useAutoDj } from "../store/autodj";
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
    warps: [],
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

describe("a set as one mix", () => {
  it("plays each track whole into the next, each change as Auto DJ plans it", () => {
    const ds = [track({ id: 1 }), track({ id: 2, energy: 6 }), track({ id: 3, energy: 7 })];
    const plans = [planMix(ds[0], ds[1]), planMix(ds[1], ds[2])];
    const p = setMix(ds, plans);
    const [a, b, c] = [1, 2, 3].map((n) => p.clips.find((x) => x.track.path === `/Music/${n}.flac`)!);
    // Track 1 from its start; track 2 comes in where the plan says, from its mix-in point.
    expect(a.start).toBe(0);
    expect(a.source_start).toBe(0);
    expect(b.start).toBeCloseTo(plans[0].outStartBeat, 6);
    expect(b.source_start).toBeCloseTo(beatAtSeconds(ds[1], plans[0].inCueSeconds), 6);
    // Track 1 is out once the first transition is over; track 3 comes in on track 2's plan.
    expect(a.start + a.length).toBeCloseTo(b.start + plans[0].beats, 6);
    expect(c.start).toBeCloseTo(b.start + plans[1].outStartBeat - b.source_start, 6);
    expect(c.lane).not.toBe(b.lane);
    // The last track plays to its end; one marker per change.
    expect(c.start + c.length).toBeCloseTo(c.start + beatAtSeconds(ds[2], ds[2].track.duration) - c.source_start, 6);
    expect(p.markers.map((m) => m.label)).toEqual(["Track 1 into Track 2", "Track 2 into Track 3"]);
    expect(valueAt(a, "Volume", a.start + a.length - 1e-6)).toBeCloseTo(0, 2);
  });

  it("keeps a synced track at the old tempo through the mix, then eases it back", () => {
    const ds = [track({ id: 1, bpm: 124 }), track({ id: 2, bpm: 126 })];
    const plan = planMix(ds[0], ds[1]);
    expect(plan.sync).toBe(true);
    const held = setMix(ds, [plan]);
    expect(tempoAt(held.tempo.segments, plan.outStartBeat + plan.beats + 400)).toBe(124);
    const p = setMix(ds, [plan], { glide: true });
    const s = p.tempo.segments;
    const end = plan.outStartBeat + plan.beats;
    expect(tempoAt(s, end - 1)).toBe(124);
    // 2/126 is about 1.6%: 26 bars at 0.0625% a bar, then 126.
    expect(tempoAt(s, end + 52)).toBeGreaterThan(124.5);
    expect(tempoAt(s, end + 52)).toBeLessThan(126);
    expect(tempoAt(s, end + 26 * 4)).toBeCloseTo(126, 9);
    expect(tempoAt(s, end + 200)).toBe(126);
  });

  it("stops a glide where the next mix starts, and loops a short ending", () => {
    const ds = [track({ id: 1, bpm: 120 }), track({ id: 2, bpm: 126 }), track({ id: 3, bpm: 126 })];
    const p1 = planMix(ds[0], ds[1]);
    // Mix out of track 2 just after it comes in, while its glide is still running.
    const early = { ...planMix(ds[1], ds[2]), outStartBeat: beatAtSeconds(ds[1], p1.inCueSeconds) + p1.beats + 16, loopBeats: 16 };
    const p = setMix(ds, [p1, early], { glide: true });
    const at = p.markers[1].beat;
    const t = tempoAt(p.tempo.segments, at);
    expect(t).toBeGreaterThan(120);
    expect(t).toBeLessThan(126);
    // Held through the mix, then a new glide from there to track 3's own tempo.
    expect(tempoAt(p.tempo.segments, at + early.beats - 1)).toBeCloseTo(t, 9);
    expect(tempoAt(p.tempo.segments, at + 1000)).toBe(126);
    // Track 2's last bars loop from its mix point: more than one piece of it.
    expect(p.clips.filter((x) => x.track.path === "/Music/2.flac").length).toBeGreaterThan(1);
    expect(p.markers[1].beat).toBeGreaterThanOrEqual(p.markers[0].beat + p1.beats);
  });
});

describe("choosing the transition for one change", () => {
  it("overrides Auto DJ's choice for that change only, and says so", () => {
    const [a, b, c] = [track({ id: 1, energy: 8 }), track({ id: 2, energy: 8 }), track({ id: 3, energy: 8 })];
    useAutoDj.setState({ choices: {}, phase: "off", next: null });
    expect(planFor(a, b).kind).toBe("bassSwap");
    chooseTransition(1, 2, "echoOut");
    const p = planFor(a, b);
    expect(p.kind).toBe("echoOut");
    expect(p.reasons[0]).toBe("You chose an echo out for this change.");
    expect(planFor(b, c).kind).toBe("bassSwap");
    expect(planFor(b, a).kind).toBe("bassSwap");
    chooseTransition(1, 2, null);
    expect(planFor(a, b).kind).toBe("bassSwap");
    expect(useAutoDj.getState().choices).toEqual({});
  });

  it("plans the coming mix again when it is already waiting on a deck", () => {
    const [a, b] = [track({ id: 1, energy: 8 }), track({ id: 2, energy: 8 })];
    useApp.setState({ decks: [{ deck: 0, token: 1, detail: a, sampleRate: 44100 }, { deck: 1, token: 1, detail: b, sampleRate: 44100 }, null, null] });
    useAutoDj.setState({ choices: {}, phase: "waiting", current: 0, next: { deck: 1, track: b.track, detail: b, plan: planFor(a, b) }, log: [] });
    chooseTransition(1, 2, "blend");
    expect(useAutoDj.getState().next!.plan.kind).toBe("blend");
    expect(useAutoDj.getState().log[0].text).toMatch(/New plan for Track 2: blend over \d+ beats/);
    useAutoDj.setState({ choices: {}, phase: "off", current: null, next: null });
  });
});

describe("trying another transition while hearing", () => {
  it("renders the mix again with the new transition, keeps the choice and plays from the change", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    useTelemetry.setState({ t: structuredClone(emptyTelemetry) });
    useTrackPreview.setState({ route: "speakers" });
    const rows = (await b.search("")).filter((r) => r.bpm && r.duration > 120).slice(0, 3);
    useAutoDj.setState({ queue: rows, phase: "off", next: null, current: null, choices: {} });
    await hearPair(rows[0], rows[1]);
    expect(useRehearse.getState().changes[0].ids).toEqual([rows[0].id, rows[1].id]);
    const seek = vi.spyOn(b, "previewSeek");
    await retryChange(0, "cut");
    let s = useRehearse.getState();
    expect(s).toMatchObject({ key: `${rows[0].id}-${rows[1].id}`, status: "ready", summary: "Cut on the bar", title: `${rows[0].title} into ${rows[1].title}` });
    expect(useAutoDj.getState().choices).toEqual({ [`${rows[0].id}-${rows[1].id}`]: "cut" });
    expect(seek).toHaveBeenLastCalledWith(Math.max(0, s.changes[0].at - 4));
    // In the whole set, only that change takes the new transition.
    await hearSet();
    await retryChange(1, "echoOut");
    s = useRehearse.getState();
    expect(s.key).toBe("set");
    expect(s.changes[0].label).toMatch(/cut on the bar$/);
    expect(s.changes[1].label).toMatch(/echo out/);
    expect(seek).toHaveBeenLastCalledWith(Math.max(0, s.changes[1].at - 4));
    // Back to Auto DJ's choice.
    await retryChange(1, null);
    expect(Object.keys(useAutoDj.getState().choices)).toEqual([`${rows[0].id}-${rows[1].id}`]);
    stopMix();
    useAutoDj.setState({ queue: [], choices: {} });
  });
});
