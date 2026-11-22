import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests } from "../backend";
import { setValue } from "../lib/actions";
import { useApp } from "../store/app";
import { emptyTelemetry, useTelemetry } from "../store/telemetry";
import type { Settings } from "../backend/types";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

const calls: string[] = [];
const fake = {
  action: async (id: string, input: { type: string }) => {
    calls.push(`${id}:${input.type}`);
  },
  seek: async (deck: number, s: number) => {
    calls.push(`seek:${deck}:${s}`);
  },
};

function deckState(playing: boolean) {
  const t = structuredClone(emptyTelemetry);
  t.decks[0] = { ...t.decks[0], loaded: true, playing, cue: 12.5 };
  useTelemetry.getState().set(t);
}

describe("fader start", () => {
  beforeEach(() => {
    calls.length = 0;
    setBackendForTests(fake as never);
    useApp.getState().set({ settings: { faderStart: true } as Settings });
    useApp.getState().setChannel(0, { fader: 0 });
  });

  it("starts the deck when the fader opens", async () => {
    deckState(false);
    void setValue("mixer.A.fader", 0.6);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContain("deck.A.play:press");
    expect(calls).toContain("deck.A.play:release");
  });

  it("stops and goes back to the cue when the fader closes", async () => {
    useApp.getState().setChannel(0, { fader: 0.8 });
    deckState(true);
    void setValue("mixer.A.fader", 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.startsWith("deck.A.play"))).toEqual(["deck.A.play:press", "deck.A.play:release"]);
    expect(calls).toContain("seek:0:12.5");
  });

  it("does nothing when it is off or the fader only moves", async () => {
    deckState(false);
    useApp.getState().setChannel(0, { fader: 0.5 });
    void setValue("mixer.A.fader", 0.7);
    useApp.getState().set({ settings: { faderStart: false } as Settings });
    useApp.getState().setChannel(0, { fader: 0 });
    void setValue("mixer.A.fader", 0.7);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.filter((c) => c.startsWith("deck."))).toEqual([]);
  });
});
