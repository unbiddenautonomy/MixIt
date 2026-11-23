import { describe, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
import { setBackendForTests } from "../backend";
import { DemoBackend } from "../backend/demo";
import type { Telemetry } from "../backend/types";
import { GLIDE_PCT_PER_BAR, glideBars, glideFader } from "../lib/glide";
import { glideTick, startGlide, useAutoDj } from "../store/autodj";
import { useTelemetry } from "../store/telemetry";

describe("the tempo glide", () => {
  it("eases half a percent every 8 bars back to the track's own tempo, and stops there", () => {
    // 2% fast on an 8% fader.
    expect(glideFader(0.25, 0.08, 0)).toBeCloseTo(0.25, 9);
    expect(glideFader(0.25, 0.08, 8)).toBeCloseTo((0.02 - 0.005) / 0.08, 9);
    expect(glideFader(0.25, 0.08, 31)).toBeGreaterThan(0);
    expect(glideFader(0.25, 0.08, 32)).toBe(0);
    expect(glideFader(0.25, 0.08, 500)).toBe(0);
    // Slow tracks come up the same way.
    expect(glideFader(-0.25, 0.08, 16)).toBeCloseTo(-0.125, 9);
    expect(glideFader(-0.25, 0.08, 40)).toBe(0);
    expect(glideBars(0.25, 0.08)).toBe(32);
    expect(GLIDE_PCT_PER_BAR * 8).toBe(0.5);
  });

  it("moves a playing deck's tempo back to its own on the demo engine", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    let tele: Telemetry | null = null;
    b.onTelemetry((t) => {
      tele = t;
      useTelemetry.setState({ t });
    });
    const step = (seconds: number) => {
      const sim = b as unknown as { last: number; tick: () => void };
      for (let i = 0; i < seconds * 10; i++) {
        sim.last = performance.now() - 100;
        sim.tick();
        glideTick(tele!);
      }
      return tele!.decks[0];
    };
    const id = (await b.search("")).find((r) => r.bpm && r.duration > 200)!.id;
    await b.loadTrack(0, id);
    await b.action("deck.A.play", { type: "press" });
    await b.action("deck.A.play", { type: "release" });
    await b.action("deck.A.tempo", { type: "value", value: 0.25 });
    let d = step(0.5);
    const own = d.baseBpm;
    expect(d.rate).toBeCloseTo(1 + 0.25 * d.tempoRange, 6);
    useAutoDj.setState({ glide: true, gliding: null, log: [] });
    startGlide(0);
    expect(useAutoDj.getState().gliding?.deck).toBe(0);
    expect(useAutoDj.getState().gliding?.start).toBeCloseTo(0.25, 9);
    expect(useAutoDj.getState().log[0].text).toMatch(/drift .* back to this track's own/);
    // 8 bars in: half a percent slower.
    const barS = (4 * 60) / d.bpm;
    d = step(barS * 8);
    expect(d.rate).toBeLessThan(1 + 0.25 * d.tempoRange - 0.004);
    expect(d.rate).toBeGreaterThan(1 + 0.25 * d.tempoRange - 0.0065);
    // All the way back, then it lets go.
    d = step(barS * 30);
    expect(d.tempo).toBe(0);
    expect(d.bpm).toBeCloseTo(own, 6);
    expect(useAutoDj.getState().gliding).toBeNull();
    expect(useAutoDj.getState().log[0].text).toMatch(/Back at A's own tempo/);
  });

  it("stops when the DJ moves the tempo, and is off when switched off", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    let tele: Telemetry | null = null;
    b.onTelemetry((t) => (tele = t));
    const tick = () => {
      const sim = b as unknown as { last: number; tick: () => void };
      sim.last = performance.now() - 100;
      sim.tick();
      glideTick(tele!);
    };
    const id = (await b.search("")).find((r) => r.bpm && r.duration > 200)!.id;
    await b.loadTrack(0, id);
    await b.action("deck.A.play", { type: "press" });
    await b.action("deck.A.play", { type: "release" });
    await b.action("deck.A.tempo", { type: "value", value: -0.3 });
    tick();
    useTelemetry.setState({ t: tele! });
    useAutoDj.setState({ glide: false, gliding: null });
    startGlide(0);
    expect(useAutoDj.getState().gliding).toBeNull();
    useAutoDj.setState({ glide: true });
    startGlide(0);
    expect(useAutoDj.getState().gliding).not.toBeNull();
    await b.action("deck.A.tempo", { type: "value", value: 0.4 });
    tick();
    tick();
    expect(useAutoDj.getState().gliding).toBeNull();
    expect(useAutoDj.getState().log[0].text).toMatch(/You moved the tempo/);
  });
});
