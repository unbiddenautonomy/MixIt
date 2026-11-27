// The new layout across windows: where windows go on the screens (lib/layout/windows.ts),
// and the main window opening, moving and closing them and sharing the layout with them
// (store/layoutShare.ts), against a fake desktop with two screens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import type { Backend } from "../backend";
import type { WinPlace, WinReport, WindowMessage } from "../backend/types";
import { MAIN, findWin, placesOf, refOf, type Layout, type ScreenInfo } from "../lib/layout/model";
import { fromReport, placeOn, samePlace, screenName, screenOf, windowChanges, windowPlan, windowTitle, type WinSpec } from "../lib/layout/windows";

const laptop: ScreenInfo = { name: "Built-in Retina Display", x: 0, y: 0, width: 2880, height: 1800, scale: 2 };
const monitor: ScreenInfo = { name: "DELL U2720Q", x: 2880, y: -200, width: 3840, height: 2160, scale: 2 };
const twin: ScreenInfo = { name: "DELL U2720Q", x: 6720, y: -200, width: 3840, height: 2160, scale: 2 };

describe("where windows go", () => {
  it("fills, goes full screen or keeps its rectangle on its screen", () => {
    expect(placeOn(monitor, "full", false)).toEqual({ x: 2880, y: -200, w: 3840, h: 2160, fill: "max" });
    expect(placeOn(monitor, "full", true).fill).toBe("full");
    expect(placeOn(monitor, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, false)).toEqual({ x: 3840, y: 880, w: 1920, h: 1080, fill: "rect" });
  });

  it("reads a moved window back into the same place", () => {
    const place = placeOn(monitor, { x: 0.1, y: 0.2, w: 0.4, h: 0.5 }, false);
    const back = fromReport([laptop, monitor], { id: "w2", ...place, maximized: false, fullscreen: false })!;
    expect(back.screen).toBe(monitor);
    expect(samePlace(placeOn(back.screen, back.bounds, back.fullscreen), place)).toBe(true);
  });

  it("counts a window almost the size of its screen as filling it", () => {
    const r = fromReport([laptop], { id: "w2", x: 0, y: 50, w: 2880, h: 1700, maximized: false, fullscreen: false })!;
    expect(r.bounds).toBe("full");
  });

  it("finds the screen a window is on, even half off it", () => {
    expect(screenOf([laptop, monitor], { x: 2800, y: 0, w: 1000, h: 600 })).toBe(monitor);
    expect(screenOf([laptop, monitor], { x: -500, y: 100, w: 800, h: 600 })).toBe(laptop);
    expect(screenOf([laptop], { x: 9000, y: 9000, w: 10, h: 10 })).toBeNull();
  });

  it("opens, moves, renames and closes only what changed", () => {
    const a: WinSpec = { id: "w2", title: "A", place: { x: 0, y: 0, w: 10, h: 10, fill: "max" } };
    const b: WinSpec = { id: "w3", title: "B", place: { x: 5, y: 5, w: 900, h: 700, fill: "rect" } };
    const last = new Map([
      ["w2", a],
      ["w3", { ...b, place: { ...b.place, x: 6 } }],
    ]);
    expect(windowChanges([a, b], new Set(["w2", "w3"]), last)).toEqual({ open: [], move: [], retitle: [], close: [] });
    expect(windowChanges([{ ...a, title: "A2" }], new Set(["w2", "w3", "w9"]), last)).toEqual({ open: [], move: [], retitle: [{ ...a, title: "A2" }], close: ["w3", "w9"] });
    expect(windowChanges([a, { ...b, place: { ...b.place, w: 500 } }], new Set(["w3"]), last).open).toEqual([a]);
    expect(windowChanges([a, { ...b, place: { ...b.place, w: 500 } }], new Set(["w2", "w3"]), last).move.map((w) => w.id)).toEqual(["w3"]);
  });

  it("leaves out windows whose screen isn't connected, and tells identical screens apart", () => {
    const l: Layout = {
      version: 1,
      preset: "x",
      edited: false,
      nextWin: 4,
      windows: [
        { id: MAIN, screen: null, bounds: "full", fullscreen: false, page: "mix", pages: {} },
        { id: "w2", screen: refOf([laptop, monitor, twin], twin), bounds: "full", fullscreen: false, page: "library", pages: { library: { kind: "stack", units: [{ unit: "library", folded: { noController: false, controller: false } }], active: 0 } } },
        { id: "w3", screen: { name: "Projector", w: 1920, h: 1080, nth: 0 }, bounds: "full", fullscreen: false, page: "library", pages: {} },
      ],
    };
    const plan = windowPlan(l, [laptop, monitor, twin]);
    expect(plan.map((w) => w.id)).toEqual(["w2"]);
    expect(plan[0].place.x).toBe(twin.x);
    expect(windowTitle(l.windows[1])).toBe("MixIt · Window 2 · Library");
    expect(screenName([laptop, monitor, twin], twin)).toBe("Screen 3 (DELL U2720Q)");
  });
});

// ------------------------------------------------------------------ the main window

interface Desk {
  screens: ScreenInfo[];
  opened: { id: string; title: string; place: WinPlace }[];
  closed: string[];
  open: Set<string>;
  sent: WindowMessage[];
  failOpen: boolean;
  bus: ((m: WindowMessage) => void) | null;
  onClosed: ((id: string) => void) | null;
  onMoved: ((r: WinReport) => void) | null;
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function desktop(desk: Desk, url = "/") {
  vi.resetModules();
  window.history.replaceState(null, "", url);
  const b = {
    layoutsLoad: async () => null,
    layoutsSave: async () => undefined,
    screens: async () => ({ screens: desk.screens, main: desk.screens[0]?.name ?? null }),
    winOpen: async (id: string, title: string, place: WinPlace) => {
      if (desk.failOpen && id !== MAIN) throw new Error("no");
      desk.opened.push({ id, title, place });
      if (id !== MAIN) desk.open.add(id);
    },
    winClose: async (id: string) => {
      desk.closed.push(id);
      desk.open.delete(id);
      // The system says it's gone, as it does for any window.
      queueMicrotask(() => desk.onClosed?.(id));
    },
    winTitle: async () => undefined,
    winList: async () => [...desk.open],
    onWinClosed: (cb: (id: string) => void) => ((desk.onClosed = cb), () => (desk.onClosed = null)),
    onWinMoved: (cb: (r: WinReport) => void) => ((desk.onMoved = cb), () => (desk.onMoved = null)),
    broadcast: (m: WindowMessage) => desk.sent.push(m),
    onBroadcast: (cb: (m: WindowMessage) => void) => ((desk.bus = cb), () => (desk.bus = null)),
  } as unknown as Backend;
  (await import("../backend")).setBackendForTests(b);
  const app = await import("../store/app");
  app.useApp.setState({ settings: { layoutEngine: true, decks: 2, viewMode: "easy" } as never });
  const scr = await import("../lib/screens");
  scr.useScreens.setState({ supported: true, screens: desk.screens, main: desk.screens[0]?.name ?? null });
  const store = await import("../store/layout");
  const share = await import("../store/layoutShare");
  store.useLayout.setState({ size: { w: 1440, h: 860 } });
  return { store, share, scr, app };
}

const freshDesk = (): Desk => ({ screens: [laptop, monitor], opened: [], closed: [], open: new Set(), sent: [], failOpen: false, bus: null, onClosed: null, onMoved: null });
const lib = (l: Layout | null) => placesOf(l!, "library")[0]?.win.id;

describe("the main window's windows", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  async function started(desk = freshDesk()) {
    const t = await desktop(desk);
    await t.store.initLayout();
    const stop = t.share.startLayoutShare();
    await tick();
    return { ...t, desk, stop };
  }

  it("opens a window for a part sent to another screen, and brings it home when the window is closed", async () => {
    const { store, desk } = await started();
    const layout0 = store.useLayout.getState().layout!;
    // The first start on two screens moved nothing yet: everything is in the main window.
    if (layout0.windows.length > 1) for (const w of layout0.windows.slice(1)) store.layoutAct({ op: "close", win: w.id });
    await tick();
    desk.opened.length = 0;
    expect(store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) })).toBe(true);
    await tick();
    const w = desk.opened.find((o) => o.id !== MAIN)!;
    expect(w.place).toEqual({ x: monitor.x, y: monitor.y, w: monitor.width, h: monitor.height, fill: "max" });
    expect(w.title).toContain("Library");
    expect(lib(store.useLayout.getState().layout)).toBe(w.id);
    // The person closes it with its red button.
    desk.open.delete(w.id);
    desk.onClosed!(w.id);
    await tick();
    expect(lib(store.useLayout.getState().layout)).toBe(MAIN);
    expect(store.useLayout.getState().layout!.windows).toHaveLength(1);
  });

  it("remembers where the person moves a window, without moving it again", async () => {
    const { store, desk } = await started();
    store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick();
    const id = lib(store.useLayout.getState().layout)!;
    const before = desk.opened.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Dragged onto the laptop, then resized: only where it ends up counts.
    desk.onMoved!({ id, x: 100, y: 100, w: 900, h: 700, maximized: false, fullscreen: false });
    desk.onMoved!({ id, x: 288, y: 180, w: 1440, h: 900, maximized: false, fullscreen: false });
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    await tick(10);
    const w = findWin(store.useLayout.getState().layout!, id)!;
    expect(w.screen?.name).toBe(laptop.name);
    expect(w.bounds).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    expect(desk.opened.length).toBe(before);
  });

  it("brings a window's parts home when it can't open", async () => {
    const desk = freshDesk();
    desk.failOpen = true;
    const { store } = await started(desk);
    store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick(10);
    expect(lib(store.useLayout.getState().layout)).toBe(MAIN);
    expect(toast.warning).toHaveBeenCalled();
  });

  it("closes every window when the new layout is turned off, and reopens them when it's back on", async () => {
    const { store, desk, app } = await started();
    store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick();
    const id = lib(store.useLayout.getState().layout)!;
    app.useApp.setState({ settings: { layoutEngine: false, decks: 2, viewMode: "easy" } as never });
    await tick();
    expect(desk.open.has(id)).toBe(false);
    // Closed by MixIt, not the person: the layout keeps the window.
    expect(lib(store.useLayout.getState().layout)).toBe(id);
    app.useApp.setState({ settings: { layoutEngine: true, decks: 2, viewMode: "easy" } as never });
    await tick();
    expect(desk.open.has(id)).toBe(true);
  });

  it("adopts the windows left open by a reload and closes strays", async () => {
    const desk = freshDesk();
    desk.open = new Set(["w7"]);
    const { store } = await started(desk);
    await tick();
    const others = store.useLayout.getState().layout!.windows.slice(1).map((w) => w.id);
    expect(desk.closed).toContain("w7");
    for (const id of others) expect(desk.open.has(id)).toBe(true);
  });

  it("follows the screens: an unplugged screen's windows close, and come back with it", async () => {
    const { store, desk, scr } = await started();
    store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick();
    const id = lib(store.useLayout.getState().layout)!;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desk.screens = [laptop];
    scr.useScreens.setState({ screens: [laptop] });
    vi.advanceTimersByTime(store.SETTLE_MS + 10);
    vi.useRealTimers();
    await tick(10);
    expect(desk.open.has(id)).toBe(false);
    expect(lib(store.useLayout.getState().layout)).toBe(MAIN);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    desk.screens = [laptop, monitor];
    scr.useScreens.setState({ screens: [laptop, monitor] });
    vi.advanceTimersByTime(store.SETTLE_MS + 10);
    vi.useRealTimers();
    await tick(10);
    expect(lib(store.useLayout.getState().layout)).toBe(id);
    expect(desk.open.has(id)).toBe(true);
  });

  it("answers a window that asks for the layout, and runs or refuses what windows ask", async () => {
    const { store, desk } = await started();
    store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick();
    const id = lib(store.useLayout.getState().layout)!;
    desk.sent.length = 0;
    desk.bus!({ kind: "layout-hello", win: id });
    const answer = desk.sent.find((m) => m.kind === "layout") as Extract<WindowMessage, { kind: "layout" }>;
    expect(answer.layout).toEqual(store.useLayout.getState().layout);
    // A fold asked for by the window.
    desk.bus!({ kind: "layout-intent", id: "1", from: id, basedOn: answer.seq, op: { op: "fold", unit: "library", folded: true } });
    expect(placesOf(store.useLayout.getState().layout!, "library")[0].place.folded.noController).toBe(true);
    const after = desk.sent.filter((m) => m.kind === "layout") as Extract<WindowMessage, { kind: "layout" }>[];
    expect(after.at(-1)!.seq).toBeGreaterThan(answer.seq);
    // Something that can't be done is refused, to that window.
    desk.bus!({ kind: "layout-intent", id: "2", from: id, basedOn: 0, op: { op: "page", win: id, page: "arrange" } });
    expect(desk.sent.at(-1)).toMatchObject({ kind: "layout-refused", id: "2", to: id });
    desk.bus!({ kind: "layout-intent", id: "3", from: id, basedOn: 0, op: "junk" });
    expect(desk.sent.at(-1)).toMatchObject({ kind: "layout-refused", id: "3" });
    // A window that isn't in the layout is ignored.
    const n = desk.sent.length;
    desk.bus!({ kind: "layout-intent", id: "4", from: "w9", basedOn: 0, op: { op: "home", unit: "library" } });
    expect(desk.sent.length).toBe(n);
    expect(lib(store.useLayout.getState().layout)).toBe(id);
    // Sizes reported by windows are kept for the rules about what fits.
    desk.bus!({ kind: "layout-size", win: id, w: 1200, h: 800 });
    desk.bus!({ kind: "layout-size", win: id, w: Number.NaN, h: 800 });
    expect(store.useLayout.getState().sizes[id]).toEqual({ w: 1200, h: 800 });
  });

  it("undoes a send, but not once something else has changed", async () => {
    const { store, desk } = await started();
    const { token } = store.layoutChange({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick();
    const id = lib(store.useLayout.getState().layout)!;
    expect(id).not.toBe(MAIN);
    // The system putting the new window in place doesn't count as a change.
    desk.onMoved!({ id, x: monitor.x + 3, y: monitor.y + 40, w: 1700, h: 1000, maximized: false, fullscreen: false });
    await new Promise((r) => setTimeout(r, 450));
    await tick(10);
    expect(store.layoutUndo(token!)).toBeNull();
    await tick();
    expect(lib(store.useLayout.getState().layout)).toBe(MAIN);
    expect(desk.open.has(id)).toBe(false);
    expect(store.layoutUndo(token!)).toMatch(/can't be undone/);
    const second = store.layoutChange({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    store.layoutAct({ op: "fold", unit: "mixer", folded: true });
    expect(store.layoutUndo(second.token!)).toMatch(/changed since/);
  });

  it("gives a window's undoable change back to it with a token", async () => {
    const { store, desk } = await started();
    store.layoutAct({ op: "newWindow", unit: "library", screen: refOf([laptop, monitor], monitor) });
    await tick();
    const id = lib(store.useLayout.getState().layout)!;
    desk.bus!({ kind: "layout-intent", id: "7", from: id, basedOn: 0, op: { op: "home", unit: "library" }, undo: true });
    const done = desk.sent.at(-1) as Extract<WindowMessage, { kind: "layout-done" }>;
    expect(done).toMatchObject({ kind: "layout-done", id: "7", to: id });
    expect(lib(store.useLayout.getState().layout)).toBe(MAIN);
    desk.bus!({ kind: "layout-undo", from: id, token: done.token });
    expect(lib(store.useLayout.getState().layout)).toBe(id);
  });
});

describe("which windows need every frame", () => {
  it("rests a window showing only the library, or hidden", async () => {
    const { showsLive } = await import("../store/layoutShare");
    const { laptop: preset } = await import("../lib/layout/presets");
    const l = preset();
    l.windows.push({ id: "w2", screen: null, bounds: "full", fullscreen: false, page: "library", pages: { library: { kind: "split", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "stack", units: [{ unit: "sidebar", folded: { noController: false, controller: false } }], active: 0 }, { kind: "stack", units: [{ unit: "library", folded: { noController: false, controller: false } }, { unit: "tool.pads", folded: { noController: false, controller: false } }], active: 0 }] } } });
    expect(showsLive(l, "w2", false)).toBe(false);
    (l.windows[1].pages.library as { children: { active: number }[] }).children[1].active = 1;
    expect(showsLive(l, "w2", false)).toBe(true);
    expect(showsLive(l, "w2", true)).toBe(false);
    expect(showsLive(l, MAIN, false)).toBe(true);
  });
});

// ------------------------------------------------------------------ another window

describe("a layout window", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("draws only newer layouts and asks the main window for changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const desk = freshDesk();
    const { store, share, scr } = await desktop(desk, "/?win=w2");
    expect(scr.thisWin).toBe("w2");
    expect(scr.isMainWindow).toBe(false);
    const stop = share.startLayoutShare();
    expect(desk.sent[0]).toEqual({ kind: "layout-hello", win: "w2" });
    // Nobody answers: it asks again, then says it's waiting.
    vi.advanceTimersByTime(share.HELLO_RETRY_MS * 2 + 10);
    expect(desk.sent.filter((m) => m.kind === "layout-hello").length).toBe(3);
    expect(share.partState.waiting).toBe(true);
    const { laptop: preset } = await import("../lib/layout/presets");
    const a = preset();
    desk.bus!({ kind: "layout", seq: 5, layout: a });
    expect(store.useLayout.getState().layout).toEqual(a);
    expect(share.partState.waiting).toBe(false);
    // An older or repeated one never takes it back.
    desk.bus!({ kind: "layout", seq: 4, layout: { ...a, preset: "old" } });
    desk.bus!({ kind: "layout", seq: 5, layout: { ...a, preset: "again" } });
    desk.bus!({ kind: "layout", seq: 9, layout: "junk" });
    expect(store.useLayout.getState().layout!.preset).toBe(a.preset);
    // Its own changes go to the main window, never into its copy.
    store.layoutDo({ op: "fold", unit: "library", folded: true });
    expect(desk.sent.at(-1)).toMatchObject({ kind: "layout-intent", from: "w2", basedOn: 5, op: { op: "fold", unit: "library" } });
    expect(store.useLayout.getState().layout).toEqual(a);
    // An undoable one shows its note with Undo once the main window has made it.
    store.layoutDoUndoable({ op: "home", unit: "library" }, "Library moved to Window 1.");
    const asked = desk.sent.at(-1) as Extract<WindowMessage, { kind: "layout-intent" }>;
    expect(asked.undo).toBe(true);
    desk.bus!({ kind: "layout-done", id: asked.id, to: "w2", token: "u3" });
    const call = toast.message.mock.calls.find((c) => c[0] === "Library moved to Window 1.")!;
    (call[1] as { action: { onClick: () => void } }).action.onClick();
    expect(desk.sent.at(-1)).toEqual({ kind: "layout-undo", from: "w2", token: "u3" });
    desk.bus!({ kind: "layout-refused", id: "x", to: "w2", reason: "No room there." });
    expect(toast.message).toHaveBeenCalledWith("No room there.");
    // Its size goes to the main window.
    store.setLayoutSize(900, 600);
    vi.advanceTimersByTime(200);
    expect(desk.sent.at(-1)).toEqual({ kind: "layout-size", win: "w2", w: 900, h: 600 });
    stop();
    vi.useRealTimers();
  });
});
