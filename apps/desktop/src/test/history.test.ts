import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../backend/types";
import { historyTracklist, setLabel, setSeconds } from "../lib/history";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
const now = new Date(2026, 10, 21, 23, 30).getTime();

describe("past sets", () => {
  it("names a set by its night, or by the name it was given", () => {
    expect(setLabel({ name: "", firstPlayed: at(2026, 11, 21, 21) }, now)).toBe("Tonight");
    expect(setLabel({ name: "", firstPlayed: at(2026, 11, 21, 14) }, now)).toBe("Today");
    expect(setLabel({ name: "", firstPlayed: at(2026, 11, 20, 22) }, now)).toBe("Last night");
    expect(setLabel({ name: "", firstPlayed: at(2026, 11, 20, 13) }, now)).toBe("Yesterday");
    expect(setLabel({ name: "", firstPlayed: at(2026, 11, 14, 22) }, now)).not.toMatch(/2026/);
    expect(setLabel({ name: "", firstPlayed: at(2025, 6, 1, 22) }, now)).toMatch(/2025/);
    // The app's automatic session names are not shown; a name you gave is.
    expect(setLabel({ name: "Session 2026-11-21 21:00", firstPlayed: at(2026, 11, 21, 21) }, now)).toBe("Tonight");
    expect(setLabel({ name: " Rooftop ", firstPlayed: at(2026, 11, 21, 21) }, now)).toBe("Rooftop");
  });

  it("times the set and writes its tracklist", () => {
    const e = (id: number, t: number, title: string, artist = ""): HistoryEntry => ({ track_id: id, played_at: t, deck: 0, title, artist });
    const h = [e(1, 1000, "Intro", "Nova"), e(2, 1000 + 245, "Middle"), e(3, 1000 + 3 * 3600 + 5, "Late", "Kairo")];
    expect(setSeconds(h, (id) => (id === 3 ? 300 : undefined))).toBe(3 * 3600 + 5 + 300);
    expect(setSeconds(h)).toBe(3 * 3600 + 5 + 240);
    expect(setSeconds([])).toBe(0);
    expect(historyTracklist(h)).toBe("01. [0:00] Nova - Intro\n02. [4:05] Middle\n03. [3:00:05] Kairo - Late\n");
  });
});
