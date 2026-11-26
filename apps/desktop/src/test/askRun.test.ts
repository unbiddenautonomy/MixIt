import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoBackend } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { buildSetOpenedWith } from "../components/library/BuildSetDialog";
import { understand } from "../lib/ask";
import { askContext, runAsk } from "../lib/askRun";
import { useApp } from "../store/app";
import { useLibrary } from "../store/library";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));

describe("doing what Ask MixIt understood", () => {
  beforeEach(async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    const info = await b.appInfo();
    useApp.getState().set({ registry: info.registry, settings: info.settings });
    useLibrary.getState().set({ playlists: await b.playlists(), rows: await b.search("") });
  });

  it("moves the controls it names", async () => {
    const u = understand("mute the vocals on deck b", askContext())!;
    expect(u.say).toBe("Deck B: mute the vocals");
    await runAsk(u);
    expect(useApp.getState().mixer.stems[1].mute[0]).toBe(true);
    await runAsk(understand("cut the bass on deck a", askContext())!);
    expect(useApp.getState().mixer.channels[0].low).toBe(-26);
  });

  it("searches the library", async () => {
    await runAsk(understand("find instrumentals around 124 bpm", askContext())!);
    const lib = useLibrary.getState();
    expect(useApp.getState().workspace).toBe("library");
    expect(lib.source).toEqual({ type: "all" });
    expect(lib.query).toBe("bpm:~124 vocals:no");
  });

  it("shows what to play next, the way the energy should go", async () => {
    await runAsk(understand("something with more energy", askContext())!);
    expect(useLibrary.getState().source).toEqual({ type: "suggest" });
    expect(useLibrary.getState().energy).toBe("up");
  });

  it("opens Build a set with the settings asked for, before building", async () => {
    await runAsk(understand("build a 90 minute peak time set with no vocals", askContext())!);
    expect(buildSetOpenedWith()?.plan).toEqual({ minutes: 90, shape: "peak", vocals: "instrumental" });
  });

  it("runs the palette's own commands", async () => {
    const run = vi.fn();
    await runAsk(understand("analyse my tracks", askContext())!, run);
    expect(run).toHaveBeenCalledWith("x.analyse");
  });
});
