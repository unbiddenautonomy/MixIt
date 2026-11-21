import { describe, expect, it } from "vitest";
import { STUDIO_PRESETS, bandDb, defaultBand, defaultStudio, eqDb, freqToX, glueComp, punchComp, xToFreq } from "../lib/studio";
import { MASTER_STRIP, matchGainDb, mirrorStudio, useStudio } from "../store/studio";

describe("studio EQ curve", () => {
  it("a bell peaks at its gain at its frequency and is flat far away", () => {
    const b = { ...defaultBand(), enabled: true, shape: "bell" as const, freq: 1000, gainDb: 6, q: 1 };
    expect(bandDb(b, 1000)).toBeCloseTo(6, 1);
    expect(Math.abs(bandDb(b, 40))).toBeLessThan(0.2);
    expect(Math.abs(bandDb(b, 15_000))).toBeLessThan(0.3);
  });

  it("a low cut is −3 dB per section at its corner and steeper with more sections", () => {
    const b = { ...defaultBand(), enabled: true, shape: "lowCut" as const, freq: 100, q: Math.SQRT1_2, slopeDb: 12 };
    expect(bandDb(b, 100)).toBeCloseTo(-3, 0);
    expect(bandDb({ ...b, slopeDb: 24 }, 100)).toBeCloseTo(-6, 0);
    expect(bandDb({ ...b, slopeDb: 24 }, 50)).toBeLessThan(bandDb(b, 50) - 5);
    expect(Math.abs(bandDb(b, 2000))).toBeLessThan(0.1);
  });

  it("shelves reach their gain beyond the corner", () => {
    const lo = { ...defaultBand(), enabled: true, shape: "lowShelf" as const, freq: 200, gainDb: -6, q: Math.SQRT1_2 };
    const hi = { ...lo, shape: "highShelf" as const, freq: 4000, gainDb: 4 };
    expect(bandDb(lo, 25)).toBeCloseTo(-6, 0);
    expect(bandDb(hi, 18_000)).toBeCloseTo(4, 0);
  });

  it("the total adds the bands and is flat when the EQ is off or bands are disabled", () => {
    const s = defaultStudio();
    expect(eqDb(s, 1000)).toBe(0);
    s.bands[0] = { ...defaultBand(), enabled: true, shape: "bell", freq: 1000, gainDb: 3, q: 1 };
    s.bands[1] = { ...defaultBand(), enabled: true, shape: "bell", freq: 1000, gainDb: 2, q: 1 };
    expect(eqDb(s, 1000)).toBeCloseTo(5, 1);
    expect(eqDb({ ...s, eqOn: false }, 1000)).toBe(0);
  });

  it("maps frequencies to the log display and back", () => {
    expect(freqToX(20)).toBeCloseTo(0);
    expect(freqToX(20_000)).toBeCloseTo(1);
    for (const f of [30, 440, 5000]) expect(xToFreq(freqToX(f))).toBeCloseTo(f, 6);
  });
});

describe("studio presets and one-knob mappings", () => {
  it("presets fill free bands without touching ones in use", () => {
    const s = defaultStudio();
    s.bands[0] = { ...defaultBand(), enabled: true, freq: 777 };
    const out = STUDIO_PRESETS.find((p) => p.id === "clearer-vocals")!.apply(s);
    expect(out.bands[0].freq).toBe(777);
    expect(out.bands.filter((b) => b.enabled)).toHaveLength(3);
    // The original is not changed.
    expect(s.bands.filter((b) => b.enabled)).toHaveLength(1);
  });

  it("every preset gives settings in the engine's ranges", () => {
    for (const p of STUDIO_PRESETS) {
      const s = p.apply(defaultStudio());
      expect(s.bands).toHaveLength(8);
      for (const b of s.bands) {
        expect(b.freq).toBeGreaterThanOrEqual(20);
        expect(b.freq).toBeLessThanOrEqual(20_000);
        expect(Math.abs(b.gainDb)).toBeLessThanOrEqual(18);
      }
      expect(s.width).toBeGreaterThanOrEqual(0);
      expect(s.width).toBeLessThanOrEqual(2);
    }
  });

  it("punch and glue match the engine's mappings", () => {
    expect(punchComp(1)).toMatchObject({ thresholdDb: -30, ratio: 6 });
    expect(punchComp(0)).toMatchObject({ thresholdDb: -6, ratio: 1.5 });
    expect(glueComp(0.5)).toMatchObject({ thresholdDb: -12, ratio: 2, sidechainHpfHz: 90 });
  });

  it("one-knob actions keep the known settings in step", () => {
    useStudio.setState({ settings: [defaultStudio(), null, null, null, defaultStudio()] });
    mirrorStudio(0, "warmth", 0.5);
    expect(useStudio.getState().settings[0]).toMatchObject({ satOn: true, driveDb: 12 });
    mirrorStudio(0, "gate", null);
    expect(useStudio.getState().settings[0]?.gateOn).toBe(true);
    mirrorStudio(null, "glue", 0);
    expect(useStudio.getState().settings[MASTER_STRIP]?.compOn).toBe(false);
    // Unknown strips stay unknown until the panel loads them.
    mirrorStudio(1, "punch", 1);
    expect(useStudio.getState().settings[1]).toBeNull();
  });
});

describe("loudness matching", () => {
  it("moves the output by the difference and stays in range", () => {
    expect(matchGainDb(-20, -14, 0)).toBe(6);
    expect(matchGainDb(-8, -14, 2)).toBe(-4);
    expect(matchGainDb(-40, -9, 0)).toBe(12);
    expect(matchGainDb(-70, -14, 0)).toBeNull();
  });
});
