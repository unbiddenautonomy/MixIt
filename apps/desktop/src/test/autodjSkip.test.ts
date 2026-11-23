import { describe, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
import { setBackendForTests } from "../backend";
import { DemoBackend } from "../backend/demo";
import { startAutoDj, stopAutoDj, useAutoDj } from "../store/autodj";
import { useTelemetry } from "../store/telemetry";

describe("Auto DJ keeps going past broken tracks", () => {
  it("skips a missing file and a track that fails to load, and plays the next", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    b.onTelemetry((t) => useTelemetry.setState({ t }));
    const rows = (await b.search("")).filter((r) => r.bpm && !r.missing).slice(0, 4);
    const gone = { ...rows[0], missing: true };
    const broken = rows[1];
    const load = b.loadTrack.bind(b);
    vi.spyOn(b, "loadTrack").mockImplementation(async (deck, id) => {
      if (id === broken.id) throw new Error("The file could not be decoded.");
      return load(deck, id);
    });
    useAutoDj.setState({ queue: [gone, broken, rows[2], rows[3]], phase: "off", next: null, current: null, log: [] });
    await startAutoDj();
    const s = useAutoDj.getState();
    const log = s.log.map((e) => e.text).reverse();
    expect(log.some((t) => t.startsWith(`Skipped ${gone.title}: its file is missing`))).toBe(true);
    expect(log.some((t) => t === `Couldn't load ${broken.title} (The file could not be decoded), so I skipped it.`)).toBe(true);
    // The set carries on: the third track plays and the fourth is waiting.
    expect(s.played).toEqual([rows[2].id]);
    expect(s.next?.track.id).toBe(rows[3].id);
    expect(s.phase).toBe("waiting");
    stopAutoDj();
  });

  it("skips a next track that won't load and cues the one after it", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    b.onTelemetry((t) => useTelemetry.setState({ t }));
    const rows = (await b.search("")).filter((r) => r.bpm && !r.missing).slice(0, 3);
    const load = b.loadTrack.bind(b);
    vi.spyOn(b, "loadTrack").mockImplementation(async (deck, id) => {
      if (id === rows[1].id) throw new Error("No such file");
      return load(deck, id);
    });
    useAutoDj.setState({ queue: rows, phase: "off", next: null, current: null, log: [] });
    await startAutoDj();
    expect(useAutoDj.getState().next?.track.id).toBe(rows[2].id);
    stopAutoDj();
  });
});
