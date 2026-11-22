import { beforeEach, describe, expect, it } from "vitest";
import type { DeckInfo, Telemetry } from "../backend/types";
import { coachTips } from "../lib/coach";
import { endAt, setLeftLabel, setMinutesLeft, setSecondsLeft, setSetEnd, useSetClock } from "../lib/setClock";
import { useApp } from "../store/app";
import { emptyTelemetry } from "../store/telemetry";

describe("set clock", () => {
  beforeEach(() => setSetEnd(null));

  it("counts down from a length or to an end time", () => {
    const now = new Date(2026, 10, 21, 23, 15, 0).getTime();
    setSetEnd({ minutes: 60 }, now);
    expect(setSecondsLeft(useSetClock.getState().endsAt, now)).toBe(3600);
    expect(setMinutesLeft(useSetClock.getState().endsAt, now)).toBe(60);
    // 02:00 is after midnight: tomorrow.
    const two = endAt("02:00", now)!;
    expect((two - now) / 60_000).toBe(165);
    expect(endAt("23:30", now)! - now).toBe(15 * 60_000);
    expect(endAt("25:00", now)).toBeNull();
    expect(endAt("soon", now)).toBeNull();
    expect(setLeftLabel(2530)).toBe("42:10 left");
    expect(setLeftLabel(-65)).toBe("Over by 1:05");
    setSetEnd(null);
    expect(useSetClock.getState().endsAt).toBeNull();
    expect(setSecondsLeft(null)).toBeNull();
  });

  it("the coach warns when a track runs past the end of the set", () => {
    const t: Telemetry = structuredClone(emptyTelemetry);
    const deck = (i: number, p: object) => (t.decks[i] = Object.assign(structuredClone(t.decks[i]), p));
    deck(0, { loaded: true, playing: true, master: true, sync: true, bpm: 124, baseBpm: 124, remaining: 290 });
    deck(1, { loaded: true, playing: false, sync: true, bpm: 124, baseBpm: 124, remaining: 400 });
    const info = { detail: { key: null, track: { title: "x" } } } as unknown as DeckInfo;
    const mixer = useApp.getState().mixer;
    const ids = (left: number | null) => coachTips(t, [info, info, null, null], mixer, 2, left).map((x) => x.id);
    expect(ids(200)).toContain("set-end");
    expect(ids(600)).toContain("set-fit");
    expect(ids(1200)).not.toContain("set-fit");
    expect(ids(null).some((x) => x.startsWith("set-"))).toBe(false);
  });
});
