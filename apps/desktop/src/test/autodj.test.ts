import { describe, expect, it } from "vitest";
import type { CueDto, SectionDto, TrackDetail } from "../backend/types";
import { beatAtSeconds, countdown, hasOutro, inCue, introBeats, keyMove, mixOutPoint, planMix, secondsAtBeat } from "../lib/autodj";
import { fromCamelot, keyDto } from "../lib/keys";

/** A track in the demo's shape: sections of the given bars at a tempo, with cues. */
function track(o: { bpm?: number; camelot?: [number, "A" | "B"] | null; energy?: number; bars?: [string, number, number][]; firstBeat?: number; cues?: boolean; tail?: number } = {}): TrackDetail {
  const bpm = o.bpm ?? 124;
  const period = 60 / bpm;
  const first = o.firstBeat ?? 0.1;
  const bars = o.bars ?? [
    ["Intro", 16, 0.35],
    ["Build", 16, 0.6],
    ["Drop", 32, 1],
    ["Breakdown", 16, 0.3],
    ["Drop", 32, 1],
    ["Outro", 16, 0.4],
  ];
  const sections: SectionDto[] = [];
  let t = first;
  for (const [label, b, energy] of bars) {
    sections.push({ start: t, end: t + b * 4 * period, bars: b, label, energy });
    t += b * 4 * period;
  }
  const end = t;
  const cues: CueDto[] = o.cues
    ? [
        { role: "mixIn", slot: null, seconds: first, loopSeconds: null, label: "Mix in", color: null },
        { role: "mixOut", slot: null, seconds: sections[sections.length - 1].start, loopSeconds: null, label: "Mix out", color: null },
      ]
    : [];
  const key = o.camelot === null ? null : keyDto(fromCamelot(...(o.camelot ?? [8, "A"])));
  return {
    track: { id: 1, title: "T", artist: "", duration: end + (o.tail ?? 2) } as TrackDetail["track"],
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
    key,
    keyConfidence: 1,
    keySecond: null,
    tuningCents: 0,
    lufs: -9,
    truePeak: -1,
    autoGainDb: 0,
    energy: o.energy ?? 7,
    energyCurve: [],
    energyCurveStart: 0,
    sections,
    cues,
    audible: [first, end],
  };
}

describe("Auto DJ grid maths", () => {
  it("converts between seconds and the deck's beat count both ways", () => {
    const d = track({ firstBeat: 0.25, bpm: 120 });
    expect(beatAtSeconds(d, 0.25)).toBe(0);
    expect(beatAtSeconds(d, 2.25)).toBe(4);
    expect(secondsAtBeat(d, 64)).toBeCloseTo(32.25, 9);
    // A drifting grid follows its beat list.
    const v = { ...d, constantGrid: false, firstBeat: 1, beats: [0.5, 1, 1.5, 2.1, 2.7] };
    expect(beatAtSeconds(v, 1)).toBe(0);
    expect(beatAtSeconds(v, 2.4)).toBeCloseTo(2.5, 9);
    expect(secondsAtBeat(v, 2.5)).toBeCloseTo(2.4, 9);
    expect(secondsAtBeat(v, beatAtSeconds(v, 3.3))).toBeCloseTo(3.3, 9);
  });

  it("finds the cue points, the intro and the outro", () => {
    const d = track({ cues: true });
    expect(inCue(d)).toBe(d.firstBeat);
    expect(mixOutPoint(d)).toBe(d.sections[5].start);
    const plain = track();
    expect(mixOutPoint(plain)).toBe(plain.sections[5].start);
    expect(introBeats(plain)).toBe(64);
    expect(hasOutro(plain)).toBe(true);
    expect(hasOutro(track({ bars: [["Intro", 16, 0.3], ["Drop", 32, 1]] }))).toBe(false);
    expect(countdown(65.4)).toBe("1:05");
    expect(countdown(-3)).toBe("0:00");
  });

  it("knows which keys fit and how far to shift the ones that do not", () => {
    const k = (n: number, l: "A" | "B") => keyDto(fromCamelot(n, l));
    expect(keyMove(k(8, "A"), k(9, "A"))).toEqual({ compat: "match", shift: 0 });
    expect(keyMove(k(8, "A"), k(10, "A")).compat).toBe("boost");
    const far = keyMove(k(8, "A"), k(3, "A"));
    expect(far.compat === "shift" || far.compat === "clash").toBe(true);
    if (far.shift) expect(Math.abs(far.shift)).toBeLessThanOrEqual(2);
    expect(keyMove(null, k(3, "B"))).toEqual({ compat: null, shift: 0 });
  });
});

describe("Auto DJ plans", () => {
  it("starts a long mix at the top of the outro phrase, early enough to finish", () => {
    const out = track({ energy: 5 });
    const inc = track({ energy: 5, camelot: [9, "A"] });
    const p = planMix(out, inc);
    const outroBeat = beatAtSeconds(out, out.sections[5].start);
    expect(p.outStartBeat % 32).toBe(0);
    expect(Math.abs(p.outStartBeat - outroBeat)).toBeLessThanOrEqual(16);
    expect(p.outStartBeat + p.beats).toBeLessThanOrEqual(beatAtSeconds(out, out.audible[1]));
    expect(p.kind).toBe("blend");
    expect(p.beats).toBe(32);
    expect(p.inCueSeconds).toBe(inc.firstBeat);
    expect(p.keyShift).toBe(0);
    expect(p.outStartSeconds).toBeCloseTo(secondsAtBeat(out, p.outStartBeat), 9);
    expect(p.reasons.join(" ")).toMatch(/keys fit/);
  });

  it("swaps the bass between two heavy tracks", () => {
    const p = planMix(track({ energy: 8 }), track({ energy: 7, camelot: [8, "B"] }));
    expect(p.kind).toBe("bassSwap");
    expect(p.summary).toBe("Bass swap over 32 beats");
  });

  it("echoes out across a big tempo gap, but treats double time as the same tempo", () => {
    const far = planMix(track({ bpm: 124 }), track({ bpm: 140 }));
    expect(far.kind).toBe("echoOut");
    expect(far.beats).toBeLessThanOrEqual(16);
    expect(far.reasons.join(" ")).toMatch(/tempos are far apart/);
    const half = planMix(track({ bpm: 140, energy: 5 }), track({ bpm: 70, energy: 5 }));
    expect(half.kind).not.toBe("echoOut");
    expect(half.tempoChangePct).toBe(0);
  });

  it("echoes out of a track that stops at full power right after its mix-out point", () => {
    const abrupt = track({ bars: [["Intro", 16, 0.3], ["Drop", 64, 1]], energy: 5 });
    abrupt.cues.push({ role: "mixOut", slot: null, seconds: abrupt.audible[1] - 2 * 4 * (60 / 124), loopSeconds: null, label: "Mix out", color: null });
    const p = planMix(abrupt, track({ energy: 5 }));
    expect(p.kind).toBe("echoOut");
    expect(p.reasons.join(" ")).toMatch(/full power/);
    // With a minute of music after the mix-out point it simply blends before the end.
    const long = track({ bars: [["Intro", 16, 0.3], ["Drop", 64, 1]], energy: 5 });
    const q = planMix(long, track({ energy: 5 }));
    expect(q.kind).toBe("blend");
    expect(q.outStartBeat + q.beats).toBeLessThanOrEqual(beatAtSeconds(long, long.audible[1]));
  });

  it("shifts a clashing key when allowed, and keeps a clash short when not", () => {
    const out = track({ camelot: [8, "A"], energy: 5 });
    const inc = track({ camelot: [3, "A"], energy: 5 });
    const km = keyMove(out.key, inc.key);
    const fixed = planMix(out, inc, { style: "auto", length: "auto", keyMatch: true });
    if (km.shift) {
      expect(fixed.keyShift).toBe(km.shift);
      expect(fixed.reasons.join(" ")).toMatch(/shifted/);
    }
    const raw = planMix(out, inc, { style: "auto", length: "auto", keyMatch: false });
    expect(raw.keyShift).toBe(0);
    expect(raw.kind).toBe("filterFade");
    expect(raw.beats).toBeLessThanOrEqual(16);
  });

  it("brings the energy down gently with a filter fade", () => {
    expect(planMix(track({ energy: 9 }), track({ energy: 4, camelot: [8, "A"] })).kind).toBe("filterFade");
  });

  it("follows a chosen style and length, and fits a short outro", () => {
    const p = planMix(track(), track(), { style: "cut", length: "auto", keyMatch: true });
    expect(p.kind).toBe("cut");
    expect(p.beats).toBe(0);
    expect(planMix(track({ energy: 5 }), track({ energy: 5 }), { style: "blend", length: 16, keyMatch: true }).beats).toBe(16);
    // A 4-bar outro leaves room for 16 beats at most, and the reasons say so.
    const short = track({ bars: [["Intro", 16, 0.3], ["Drop", 64, 1], ["Outro", 4, 0.4]], energy: 5 });
    const s = planMix(short, track({ energy: 5 }));
    expect(s.beats).toBeLessThanOrEqual(16);
    expect(s.outStartBeat + s.beats).toBeLessThanOrEqual(beatAtSeconds(short, short.audible[1]));
  });

  it("never plans a mix in the past", () => {
    const out = track({ energy: 5 });
    const late = beatAtSeconds(out, out.sections[5].start) + 10;
    const p = planMix(out, track({ energy: 5 }), undefined, late);
    expect(p.outStartBeat).toBeGreaterThan(late);
    expect(p.outStartBeat % 4).toBe(0);
  });

  it("explains a tempo change when the next track is synced", () => {
    const p = planMix(track({ bpm: 124, energy: 5 }), track({ bpm: 126, energy: 5 }));
    expect(p.tempoChangePct).toBeCloseTo(-1.6, 1);
    expect(p.reasons.join(" ")).toMatch(/synced from 126 to 124 BPM/);
  });
});
