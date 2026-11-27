import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import type { JobProgress, MixProject } from "../backend/types";
import { finishReferences } from "../components/feedback/MixReport";

// Finish my mix after a recording (src-tauri finish_mix, mixit-analysis::finish).
describe("finish my mix", () => {
  it("writes a finished copy beside the recording and says what changed", async () => {
    const b = new DemoBackend();
    const jobs: JobProgress[] = [];
    b.onJob((j) => jobs.push(j));
    const out = await b.finishMix("~/Music/MixIt/Recordings/MixIt 2026-11-26 21-04.wav", { kind: "streaming" });
    expect(out).toBe("~/Music/MixIt/Recordings/MixIt 2026-11-26 21-04 (finished).wav");
    await new Promise((r) => setTimeout(r, 500));
    const last = jobs.at(-1)!;
    expect(jobs.every((j) => j.kind === "finish")).toBe(true);
    expect(last.finished).toBe(true);
    expect(last.error).toBeNull();
    expect(last.message).toContain("streaming level");
  });

  it("offers each track the mix played once, to sound like", () => {
    const clip = (path: string | null, title: string, artist = "") => ({ track: { path, title, artist, hash: null, bpm: 124, key: null } });
    const project = { clips: [clip("/a.flac", "One", "Someone"), clip("/b.flac", "Two"), clip("/a.flac", "One", "Someone"), clip(null, "Gone")] } as unknown as MixProject;
    expect(finishReferences(project)).toEqual([
      { path: "/a.flac", title: "One · Someone" },
      { path: "/b.flac", title: "Two" },
    ]);
    expect(finishReferences(null)).toEqual([]);
  });
});
