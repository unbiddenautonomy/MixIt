import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend } from "../backend";
import type { SequencerDto } from "../backend/types";
import { PRESETS, applyPreset, clearPattern, doublePattern, missingSounds, sequencerDto, setSequencerOn, setStep, setSteps, shiftRow, useSequencer } from "../store/sequencer";

const sent: SequencerDto[] = [];
setBackendForTests({ samplerSequence: async (s: SequencerDto) => void sent.push(s) } as unknown as Backend);

const row = (pad: number, n = useSequencer.getState().steps) => useSequencer.getState().pads[pad].slice(0, n).map((x) => (x ? "x" : ".")).join("");

describe("step sequencer pattern", () => {
  beforeEach(() => {
    clearPattern();
    setSteps(16);
    setSequencerOn(false);
    sent.length = 0;
  });

  it("toggles steps and sends only the steps that play", async () => {
    vi.useFakeTimers();
    setStep(0, 0, true);
    setStep(0, 4, true);
    setStep(0, 4, true);
    setStep(2, 15, true);
    vi.runAllTimers();
    vi.useRealTimers();
    expect(sent.length).toBe(1);
    const dto = sequencerDto();
    expect(dto.pads[0].length).toBe(16);
    expect(row(0)).toBe("x...x...........");
    expect(dto.pads[2][15]).toBe(true);
    setSequencerOn(true);
    expect(sent.at(-1)!.on).toBe(true);
  });

  it("doubles, shifts and keeps steps past the end when shortened", () => {
    setSteps(8);
    setStep(1, 0, true);
    setStep(1, 3, true);
    doublePattern();
    expect(useSequencer.getState().steps).toBe(16);
    expect(row(1)).toBe("x..x....x..x....");
    shiftRow(1, 1);
    expect(row(1)).toBe(".x..x....x..x...");
    shiftRow(1, -2);
    expect(row(1)).toBe("..x....x..x....x");
    setSteps(8);
    setSteps(16);
    expect(useSequencer.getState().pads[1].slice(8, 16).some(Boolean)).toBe(true);
  });

  it("puts a preset on the pads that hold its sounds", () => {
    const four = PRESETS.find((p) => p.id === "four")!;
    const kits = ["air_horn", "siren", "riser", "impact", "kick", "clap", "laser", "drum_loop"];
    expect(missingSounds(four, kits)).toEqual(["open_hat"]);
    expect(applyPreset(four, kits)).toBe(2);
    expect(row(4)).toBe("x...x...x...x...");
    expect(row(5)).toBe("....x.......x...");
    expect(row(0)).toBe("................");
    for (const p of PRESETS) for (const r of Object.values(p.rows)) expect(r.length, p.id).toBe(p.steps);
  });
});
