import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import type { JobProgress } from "../backend/types";
import { madeTrack } from "../components/library/MakeTrackDialog";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Make a track (src-tauri make.rs talks to ACE-Step; the demo plays it out).
describe("make a track", () => {
  it("is set up on request, then makes a track into the library", async () => {
    const b = new DemoBackend();
    const jobs: JobProgress[] = [];
    b.onJob((j) => jobs.push(j));
    const r = { description: "warm deep house with a rolling bassline", lyrics: "", bpm: 122, key: "A minor", seconds: 180, name: "" };
    expect((await b.makeStatus()).installed).toBe(false);
    await expect(b.makeTrack(r)).rejects.toThrow(/Set up/);
    await b.makeInstall();
    await wait(800);
    expect(jobs.at(-1)?.finished).toBe(true);
    expect((await b.makeStatus()).installed).toBe(true);
    await b.makeTrack(r);
    await wait(1000);
    const done = jobs.at(-1)!;
    expect(done.kind).toBe("make");
    const made = madeTrack(done.message);
    expect(made?.path).toMatch(/Made\/warm deep house with a rolling\.wav$/);
    const row = (await b.search("")).find((t) => t.id === made?.trackId);
    expect(row?.title).toBe("warm deep house with a rolling");
    expect(row?.bpm).toBe(122);
  });

  it("reads only a made track from the job's message", () => {
    expect(madeTrack('{"trackId":7,"path":"/m/a.wav"}')).toEqual({ trackId: 7, path: "/m/a.wav" });
    expect(madeTrack("The track maker is set up.")).toBeNull();
    expect(madeTrack('{"trackId":"7"}')).toBeNull();
  });
});
