// The layout's commands for shortcuts, the command palette and Ask MixIt
// (lib/layoutCommands.ts), against a fake desktop with two screens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import type { Backend } from "../backend";
import type { Settings, WinPlace, WindowMessage } from "../backend/types";
import { MAIN, isFolded, placesOf, type Layout, type ScreenInfo, type UnitId } from "../lib/layout/model";
import { understand } from "../lib/ask";
import { UNITS } from "../lib/layout/units";

const laptop: ScreenInfo = { name: "Built-in Retina Display", x: 0, y: 0, width: 2880, height: 1800, scale: 2 };
const monitor: ScreenInfo = { name: "DELL U2720Q", x: 2880, y: -200, width: 3840, height: 2160, scale: 2 };

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function desktop(screens: ScreenInfo[], settings: Partial<Settings> = { layoutEngine: true }) {
  vi.resetModules();
  window.history.replaceState(null, "", "/");
  const open = new Set<string>();
  const b = {
    layoutsLoad: async () => null,
    layoutsSave: async () => undefined,
    saveSettings: async (s: Settings) => s,
    screens: async () => ({ screens, main: screens[0]?.name ?? null }),
    winOpen: async (id: string, _t: string, _p: WinPlace) => void (id !== MAIN && open.add(id)),
    winClose: async (id: string) => void open.delete(id),
    winTitle: async () => undefined,
    winList: async () => [...open],
    onWinClosed: () => () => {},
    onWinMoved: () => () => {},
    broadcast: (_m: WindowMessage) => {},
    onBroadcast: () => () => {},
  } as unknown as Backend;
  (await import("../backend")).setBackendForTests(b);
  const app = await import("../store/app");
  app.useApp.setState({ settings: { decks: 2, viewMode: "easy", ...settings } as never });
  const scr = await import("../lib/screens");
  scr.useScreens.setState({ supported: true, screens, main: screens[0]?.name ?? null });
  const store = await import("../store/layout");
  const share = await import("../store/layoutShare");
  const cmd = await import("../lib/layoutCommands");
  store.useLayout.setState({ size: { w: 1440, h: 860 } });
  await store.initLayout();
  const stop = share.startLayoutShare();
  await tick();
  // Start from everything in the main window, whatever the first start on two screens chose.
  const l0 = store.useLayout.getState().layout!;
  for (const w of l0.windows.slice(1)) store.layoutAct({ op: "close", win: w.id });
  await tick();
  return { store, cmd, app, stop };
}

const winOf = (l: Layout | null, unit: UnitId) => placesOf(l!, unit)[0]?.win.id;
const lastNote = () => String(toast.message.mock.calls.at(-1)?.[0] ?? "");

describe("the layout's commands", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("sends a part to the other screen: a new window there first, then the one already there", async () => {
    const { store, cmd, stop } = await desktop([laptop, monitor]);
    cmd.sendToOtherScreen("library");
    const l1 = store.useLayout.getState().layout!;
    expect(l1.windows).toHaveLength(2);
    expect(winOf(l1, "library")).toBe(l1.windows[1].id);
    expect(lastNote()).toMatch(/^The library opened in a new window on Screen 2/);
    cmd.sendToOtherScreen("details");
    const l2 = store.useLayout.getState().layout!;
    expect(l2.windows).toHaveLength(2);
    expect(winOf(l2, "details")).toBe(l1.windows[1].id);
    // From the other screen, "the other screen" is the main one again.
    cmd.sendToOtherScreen("details");
    expect(winOf(store.useLayout.getState().layout, "details")).toBe(MAIN);
    cmd.bringHome("library");
    expect(winOf(store.useLayout.getState().layout, "library")).toBe(MAIN);
    cmd.bringHome("library");
    expect(lastNote()).toBe("The library is already in the main window.");
    stop();
  });

  it("says why when there's one screen, and opens a new window on it when asked", async () => {
    const { store, cmd, stop } = await desktop([laptop]);
    cmd.sendToOtherScreen("library");
    expect(lastNote()).toMatch(/one screen/);
    expect(store.useLayout.getState().layout!.windows).toHaveLength(1);
    cmd.openInNewWindow("library");
    expect(store.useLayout.getState().layout!.windows).toHaveLength(2);
    stop();
  });

  it("keeps folds apart for playing with and without a controller", async () => {
    const { store, cmd, app, stop } = await desktop([laptop]);
    const mixer = () => {
      const p = placesOf(store.useLayout.getState().layout!, "mixer")[0].place;
      return isFolded(p, !!app.useApp.getState().settings?.controllerConnected);
    };
    expect(mixer()).toBe(false);
    cmd.setController(true);
    await tick();
    expect(store.layoutEnv().controller).toBe(true);
    // The controller has the mixer's knobs, so it folds away by itself.
    expect(mixer()).toBe(true);
    cmd.foldPart("mixer", true);
    expect(lastNote()).toBe("The mixer is already folded away.");
    cmd.foldPart("mixer", false);
    expect(mixer()).toBe(false);
    cmd.foldPart("waves", true);
    cmd.setController(false);
    await tick();
    expect(mixer()).toBe(false);
    // What was folded with the controller stays with it.
    expect(isFolded(placesOf(store.useLayout.getState().layout!, "waves")[0].place, false)).toBe(false);
    cmd.setController(false);
    expect(lastNote()).toMatch(/already knows there's no DJ controller/);
    stop();
  });

  it("offers to turn the new layout on rather than doing nothing", async () => {
    const { store, cmd, app, stop } = await desktop([laptop], { layoutEngine: false });
    cmd.editLayout(true);
    expect(store.useLayout.getState().editing).toBe(false);
    const offer = toast.message.mock.calls.find((c) => String(c[0]).startsWith("Edit layout is part of the new layout"))!;
    (offer[1] as { action: { onClick: () => void } }).action.onClick();
    await tick();
    expect(app.useApp.getState().settings?.layoutEngine).toBe(true);
    expect(store.useLayout.getState().editing).toBe(true);
    stop();
  });

  it("goes back to the standard layout with Undo", async () => {
    const { store, cmd, stop } = await desktop([laptop]);
    cmd.foldPart("mixer", true);
    cmd.standardLayout();
    expect(isFolded(placesOf(store.useLayout.getState().layout!, "mixer")[0].place, false)).toBe(false);
    stop();
  });
});

describe("Ask MixIt and the layout", () => {
  it("only names parts that exist", async () => {
    const ctx = { registry: [], decks: [], playlists: [], genres: [], selected: null, soundSearch: true } as never;
    const sentences = ["move the library to the other screen", "open the pads in a new window", "fold the clock", "bring the guide back", "send deck c to the tv", "pop out the studio", "collapse the waveforms"];
    for (const s of sentences) {
      const u = understand(s, ctx);
      expect(u?.ask.kind, s).toBe("control");
      if (u?.ask.kind !== "control") continue;
      const id = u.ask.steps[0].id.replace(/:(?:on|off)$/, "").replace(/^layout\.\w+\./, "");
      expect(UNITS, s).toHaveProperty([id]);
    }
  });

  it("leaves sentences about the music alone", () => {
    const ctx = { registry: [], decks: [{ loaded: true, playing: true }, { loaded: true, playing: false }], playlists: [], genres: [], selected: null, soundSearch: true } as never;
    for (const s of ["bring the bass back in on deck b", "bring deck b back", "show the effects on deck a", "fold in the vocals"]) {
      const u = understand(s, ctx);
      const ids = u?.ask.kind === "control" ? u.ask.steps.map((x) => x.id).join(" ") : "";
      expect(ids, s).not.toMatch(/layout|controller/);
    }
  });
});
