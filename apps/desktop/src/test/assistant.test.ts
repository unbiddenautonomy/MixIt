import { describe, expect, it } from "vitest";
import { MASTER_EQ_FIXES, RATE, assess, bandLevel, windowLufs, withMasterEq, type Context, type Sample } from "../lib/assistant";
import { defaultStudio } from "../lib/studio";
import { useApp } from "../store/app";

const mixer = () => structuredClone(useApp.getState().mixer);
const ctx = (over: Partial<Context> = {}): Context => ({ mixer: mixer(), master: null, targetLufs: -14, targetName: "Streaming", ...over });

/** A flat spectrum (dB per band) with optional bumps between two frequencies. */
function spectrum(bumps: [number, number, number][] = []): number[] {
  return Array.from({ length: 96 }, (_, k) => {
    const f = 20 * Math.pow(1000, (k + 0.5) / 96);
    return -30 + bumps.filter(([lo, hi]) => f >= lo && f <= hi).reduce((a, [, , db]) => a + db, 0);
  });
}

function samples(n: number, over: Partial<Sample> = {}, decks: Partial<Sample["decks"][number]>[] = [{ on: true, lowRms: 0.001 }, { on: false }]): Sample[] {
  return Array.from({ length: n }, (_, i) => ({
    t: i / RATE,
    decks: decks.map((d) => ({ on: false, lowRms: 0, compGrDb: 0, ...d })),
    lufs: -14,
    truePeakDb: -3,
    limiterGrDb: 0,
    correlation: 0.8,
    clipped: false,
    spectrum: null,
    ...over,
  }));
}

const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe("mix assistant", () => {
  it("waits for a few seconds of music before judging", () => {
    expect(assess(samples(RATE * 2), ctx())).toEqual([]);
    expect(assess(samples(RATE * 10, {}, [{ on: false }, { on: false }]), ctx())).toEqual([]);
    expect(ids(assess(samples(RATE * 4), ctx()))).toEqual(["loud-ok"]);
  });

  it("reports clipping first, with a master cut sized to the limiting", () => {
    const f = assess(samples(RATE * 4, { limiterGrDb: -6, lufs: -9 }), ctx());
    expect(f[0].id).toBe("limiter");
    expect(f[0].level).toBe("problem");
    expect(f[0].fix?.do).toEqual({ kind: "master-db", delta: -6 });
    expect(f[0].concept).toBe("clipping");
    // Also louder than the target.
    expect(ids(f)).toContain("loud");
  });

  it("finds two basslines and offers to cut the quieter one or duck it", () => {
    const f = assess(samples(RATE * 4, {}, [{ on: true, lowRms: 0.3 }, { on: true, lowRms: 0.1 }]), ctx());
    const bass = f.find((x) => x.id === "bass-01");
    expect(bass?.fix?.do).toEqual({ kind: "action", id: "mixer.B.eq.low", value: -26 });
    expect(f.find((x) => x.id === "duck-1")?.fix?.do).toEqual({ kind: "duck", deck: 1, under: 0 });
    // A brief overlap is not reported.
    const brief = [...samples(RATE * 4, {}, [{ on: true, lowRms: 0.3 }, { on: false }]), ...samples(RATE, {}, [{ on: true, lowRms: 0.3 }, { on: true, lowRms: 0.2 }])];
    expect(ids(assess(brief, ctx()))).not.toContain("bass-01");
  });

  it("compares loudness with the target in the energy domain", () => {
    expect(ids(assess(samples(RATE * 4, { lufs: -22 }), ctx()))).toContain("quiet");
    expect(assess(samples(RATE * 4, { lufs: -22 }), ctx()).find((f) => f.id === "quiet")?.fix?.do).toEqual({ kind: "match-loudness", targetLufs: -14 });
    // Half at -10 and half at -20 averages near -12.6 (energy), not -15 (plain mean).
    const mixed = [...samples(RATE * 2, { lufs: -10 }), ...samples(RATE * 2, { lufs: -20 })];
    expect(windowLufs(mixed)).toBeCloseTo(-12.6, 1);
    expect(ids(assess(mixed, ctx({ targetLufs: -16, targetName: "Apple Music" })))).toContain("loud");
  });

  it("warns about peaks near full scale and mono cancellation", () => {
    expect(ids(assess(samples(RATE * 4, { truePeakDb: -0.2 }), ctx()))).toContain("true-peak");
    const m = mixer();
    m.channels[0].width = 1.6;
    const f = assess(samples(RATE * 4, { correlation: -0.2 }), ctx({ mixer: m }));
    const mono = f.find((x) => x.id === "mono");
    expect(mono?.level).toBe("problem");
    expect(mono?.fix?.do).toEqual({ kind: "action", id: "mixer.A.width", value: 1 });
  });

  it("notices heavy compression only when Punch is up", () => {
    const m = mixer();
    m.channels[0].punch = 0.8;
    expect(ids(assess(samples(RATE * 4, {}, [{ on: true, compGrDb: 14 }]), ctx({ mixer: m })))).toContain("comp-0");
    expect(ids(assess(samples(RATE * 4, {}, [{ on: true, compGrDb: 14 }]), ctx()))).not.toContain("comp-0");
  });

  it("reads the tonal balance from the master spectrum", () => {
    expect(bandLevel(spectrum(), 100, 1000)).toBeCloseTo(-30, 5);
    expect(bandLevel(spectrum([[2500, 5000, 10]]), 2500, 5000)).toBeGreaterThan(-22);
    const flat = assess(samples(RATE * 4, { spectrum: spectrum() }), ctx());
    expect(ids(flat).filter((x) => ["boomy", "muddy", "harsh", "dull"].includes(x))).toEqual([]);
    const bad = assess(samples(RATE * 4, { spectrum: spectrum([[30, 120, 12], [200, 500, 8], [2500, 5000, 7], [8000, 20000, -20]]) }), ctx());
    expect(ids(bad)).toEqual(expect.arrayContaining(["boomy", "muddy", "harsh", "dull"]));
    expect(bad.find((f) => f.id === "harsh")?.fix?.do).toEqual({ kind: "master-eq", preset: "tame-harsh" });
  });

  it("ranks problems before tips before good news", () => {
    const f = assess(samples(RATE * 4, { lufs: -22, clipped: true }), ctx());
    const rank = { problem: 0, tip: 1, good: 2 };
    for (let i = 1; i < f.length; i++) expect(rank[f[i].level]).toBeGreaterThanOrEqual(rank[f[i - 1].level]);
  });

  it("adds a master EQ band once and deepens it on a second press", () => {
    const s0 = defaultStudio();
    const s1 = withMasterEq(s0, "clear-mud");
    expect(s1.eqOn).toBe(true);
    const on = s1.bands.filter((b) => b.enabled);
    expect(on).toHaveLength(1);
    expect(on[0]).toMatchObject({ shape: "bell", freq: MASTER_EQ_FIXES["clear-mud"].freq, gainDb: -2.5 });
    const s2 = withMasterEq(s1, "clear-mud");
    expect(s2.bands.filter((b) => b.enabled)).toHaveLength(1);
    expect(s2.bands.find((b) => b.enabled)?.gainDb).toBe(-5);
    expect(withMasterEq(withMasterEq(s2, "clear-mud"), "clear-mud").bands.find((b) => b.enabled)?.gainDb).toBe(-6);
    // A different fix gets its own band; the original strip is untouched.
    expect(withMasterEq(s2, "add-air").bands.filter((b) => b.enabled)).toHaveLength(2);
    expect(s0.bands.some((b) => b.enabled)).toBe(false);
  });
});
