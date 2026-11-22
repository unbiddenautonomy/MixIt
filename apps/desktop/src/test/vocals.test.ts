import { describe, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
import { DemoBackend, demoSearch } from "../backend/demo";
import type { DeckInfo, Telemetry } from "../backend/types";
import { coachTips, singingAt } from "../lib/coach";
import { vocalLabel, vocalWhere } from "../lib/vocals";
import { emptyTelemetry } from "../store/telemetry";
import { useApp } from "../store/app";

describe("vocals", () => {
  it("names how much of a track sings", () => {
    expect(vocalLabel(null)).toBeNull();
    expect(vocalLabel(0)).toBe("Instrumental");
    expect(vocalLabel(9)).toBe("A little singing");
    expect(vocalLabel(38)).toBe("Singing in about 40%");
    expect(vocalWhere([[45, 60], [90, 100]])).toBe("first at 0:45, 2 parts");
  });

  it("searches the demo library for vocals and instrumentals", async () => {
    const rows = await new DemoBackend().search("");
    const sung = demoSearch(rows, "vocals:yes");
    const none = demoSearch(rows, "vocals:no");
    expect(sung.length).toBeGreaterThan(0);
    expect(none.length).toBeGreaterThan(0);
    expect(sung.every((r) => (r.vocals ?? 0) >= 10)).toBe(true);
    expect(none.every((r) => (r.vocals ?? 99) < 5)).toBe(true);
    expect(demoSearch(rows, "vocals:20+").every((r) => (r.vocals ?? 0) >= 20)).toBe(true);
  });

  it("the coach warns when two voices sing at once", async () => {
    const b = new DemoBackend();
    const rows = await b.search("vocals:yes");
    const details = await Promise.all(rows.slice(0, 2).map((r) => b.trackDetail(r.id)));
    const decks = details.map((detail, i) => ({ deck: i, detail }) as unknown as DeckInfo);
    const at = details.map((d) => d.vocals![0][0] + 1);
    expect(singingAt(decks[0], at[0])).toBe(true);
    expect(singingAt(decks[0], 0)).toBe(false);
    const t: Telemetry = structuredClone(emptyTelemetry);
    for (const i of [0, 1]) t.decks[i] = Object.assign(structuredClone(t.decks[i]), { loaded: true, playing: true, position: at[i], master: i === 0, sync: true, bpm: 124, baseBpm: 124 });
    const mixer = structuredClone(useApp.getState().mixer);
    for (const c of mixer.channels) Object.assign(c, { fader: 1, low: -26 });
    const tips = coachTips(t, [decks[0], decks[1], null, null], mixer, 2);
    const tip = tips.find((x) => x.id === "vocals");
    expect(tip?.action).toEqual({ label: "Lower mids B", run: "mid-cut", arg: [1] });
    // Once deck B's mids are down, it stops warning.
    mixer.channels[1].mid = -18;
    expect(coachTips(t, [decks[0], decks[1], null, null], mixer, 2).some((x) => x.id === "vocals")).toBe(false);
  });
});
