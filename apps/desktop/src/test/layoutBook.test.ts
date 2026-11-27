// Keeping layouts: the book of layouts per set of screens (lib/layout/book.ts), and the
// store that loads and saves it (store/layout.ts) against a backend that can fail.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import type { Backend } from "../backend";
import { MAX_BOOK_TEXT, MAX_SETUPS, emptyBook, lastUsed, newerOf, pickLayout, putLayout, readBook } from "../lib/layout/book";
import { MAIN, placesOf, type Env, type Layout, type ScreenInfo } from "../lib/layout/model";
import { fold } from "../lib/layout/ops";
import { serialise } from "../lib/layout/persist";
import { laptop } from "../lib/layout/presets";
import { normalise } from "../lib/layout/ops";

const env: Env = { screens: [], sizes: { [MAIN]: { w: 1440, h: 860 } }, mode: "easy", decks: 2, controller: false, browser: true };
const base = (): Layout => normalise(laptop(), env);
const folded = (l: Layout, unit: Parameters<typeof placesOf>[1]) => placesOf(l, unit)[0]?.place.folded.noController;

describe("the book of layouts", () => {
  it("starts empty and reads back what it wrote", () => {
    expect(readBook(null)).toEqual({ book: emptyBook() });
    expect(readBook("")).toEqual({ book: emptyBook() });
    const b = putLayout(emptyBook(), "Built-in@2880x1800", base(), 5);
    const again = readBook(serialise(b));
    expect(again.problem).toBeUndefined();
    expect(serialise(again.book)).toBe(serialise(b));
    expect(pickLayout(again.book, "Built-in@2880x1800", env).layout).toEqual(base());
  });

  it("sets unreadable text aside instead of losing it", () => {
    for (const text of ["{not json", "[1,2]", '"x"', '{"version":0}', '{"setups":{}}']) {
      const r = readBook(text);
      expect(r.problem).toBe("bad");
      expect(r.book.setups).toEqual({});
      expect(r.book.setAside).toEqual([expect.objectContaining({ key: "*", layout: text })]);
    }
  });

  it("leaves a newer book alone", () => {
    const r = readBook(JSON.stringify({ version: 2, saved: 9, setups: { a: { layout: {}, used: 1 } } }));
    expect(r.problem).toBe("newer");
    // Whatever the other copy says, the newer book's "don't write" wins.
    expect(newerOf(readBook(serialise(putLayout(emptyBook(), "a", base(), 1))), r).problem).toBe("newer");
  });

  it("skips damaged entries but keeps the good ones", () => {
    const good = putLayout(emptyBook(), "good", base(), 3);
    const text = JSON.stringify({ ...good, setups: { ...good.setups, noLayout: { used: 1 }, notObj: 5, ["x".repeat(5000)]: { layout: {}, used: 1 } } });
    const r = readBook(text);
    expect(Object.keys(r.book.setups)).toEqual(["good"]);
  });

  it("sets aside a layout that can't be used, so the next save can't overwrite it", () => {
    let b = putLayout(emptyBook(), "home", base(), 1);
    b = { ...b, setups: { ...b.setups, home: { layout: { version: 1, windows: "nope" }, used: 1 } } };
    const p = pickLayout(b, "home", env);
    expect(p.layout).toBeNull();
    expect(p.problem).toBe("bad");
    expect(p.book.setups.home).toBeUndefined();
    expect(p.book.setAside.at(-1)).toMatchObject({ key: "home", layout: { version: 1, windows: "nope" } });
    // Saving afterwards keeps the set-aside copy.
    const after = putLayout(p.book, "home", base(), 2);
    expect(after.setAside).toHaveLength(1);
  });

  it("forgets the setup used longest ago, never the one being saved", () => {
    let b = emptyBook();
    for (let i = 0; i < MAX_SETUPS + 5; i++) b = putLayout(b, `s${i}`, base(), 100 + i);
    expect(Object.keys(b.setups)).toHaveLength(MAX_SETUPS);
    expect(b.setups.s0).toBeUndefined();
    expect(b.setups[`s${MAX_SETUPS + 4}`]).toBeDefined();
    // Saving one with an old clock still keeps it.
    b = putLayout(b, "late", base(), 0);
    expect(b.setups.late).toBeDefined();
  });

  it("stays under the size the backend keeps", () => {
    let b = emptyBook();
    const big = { ...base(), preset: "p".repeat(90) };
    b = { ...b, setAside: [{ key: "*", layout: "z".repeat(MAX_BOOK_TEXT), at: 0, why: "" }] };
    b = putLayout(b, "now", big, 1);
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(MAX_BOOK_TEXT);
    expect(b.setups.now).toBeDefined();
  });

  it("counts saves, and the copy saved last wins", () => {
    const a = putLayout(emptyBook(), "x", base(), 1);
    const b = putLayout(a, "x", base(), 2);
    expect(b.saved).toBe(a.saved + 1);
    expect(newerOf({ book: a }, { book: b }).book).toBe(b);
    expect(newerOf({ book: b }, { book: a }).book).toBe(b);
    expect(newerOf({ book: a }, { book: a }).book).toBe(a);
  });

  it("knows which setup was used last", () => {
    let b = putLayout(emptyBook(), "a", base(), 5);
    b = putLayout(b, "b", base(), 9);
    b = putLayout(b, "c", base(), 7);
    expect(lastUsed(b)).toBe("b");
    expect(lastUsed(b, "b")).toBe("c");
    expect(lastUsed(emptyBook())).toBeNull();
  });
});

// ------------------------------------------------------------------ the store

const laptopScreen: ScreenInfo = { name: "Built-in Retina Display", x: 0, y: 0, width: 2880, height: 1800, scale: 2 };
const monitor: ScreenInfo = { name: "DELL U2720Q", x: 2880, y: 0, width: 3840, height: 2160, scale: 2 };

interface Fake {
  text: string | null;
  writes: string[];
  fail: boolean;
}

async function start(fake: Fake, screens: ScreenInfo[] | null = [laptopScreen]) {
  vi.resetModules();
  const b = {
    layoutsLoad: async () => fake.text,
    layoutsSave: async (t: string) => {
      if (fake.fail) throw new Error("disk full");
      fake.text = t;
      fake.writes.push(t);
    },
    ...(screens ? { screens: async () => ({ screens, main: screens[0]?.name ?? null }) } : {}),
  } as unknown as Backend;
  (await import("../backend")).setBackendForTests(b);
  const scr = await import("../lib/screens");
  if (screens) scr.useScreens.setState({ supported: true, screens, main: screens[0]?.name ?? null });
  const store = await import("../store/layout");
  await store.initLayout();
  return { store, scr };
}

/** Writes what's waiting, as closing the window does, and lets the write finish. */
async function flushed() {
  window.dispatchEvent(new Event("beforeunload"));
  await new Promise((r) => setTimeout(r, 0));
}

describe("loading and saving layouts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => localStorage.clear());

  it("moves today's settings across on the first start and keeps the result", async () => {
    const fake: Fake = { text: null, writes: [], fail: false };
    const { store } = await start(fake);
    expect(store.useLayout.getState().layout).not.toBeNull();
    await flushed();
    expect(fake.writes.length).toBeGreaterThan(0);
    const book = readBook(fake.text).book;
    expect(Object.keys(book.setups)).toEqual(["Built-in Retina Display@2880x1800"]);
  });

  it("brings back a saved layout and saves changes to it", async () => {
    const saved = fold(base(), env, "mixer", true, { win: MAIN, page: "mix" }) as Layout;
    const fake: Fake = { text: serialise(putLayout(emptyBook(), "Built-in Retina Display@2880x1800", saved, 1)), writes: [], fail: false };
    const { store } = await start(fake);
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(true);
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: { win: MAIN, page: "mix" } });
    await flushed();
    const back = pickLayout(readBook(fake.text).book, "Built-in Retina Display@2880x1800", env);
    expect(folded(back.layout!, "mixer")).toBe(false);
  });

  it("takes the quick copy when the library's write never landed", async () => {
    const old = putLayout(emptyBook(), "Built-in Retina Display@2880x1800", base(), 1);
    const newer = putLayout(old, "Built-in Retina Display@2880x1800", fold(base(), env, "mixer", true, { win: MAIN, page: "mix" }) as Layout, 2);
    localStorage.setItem("mixit.layouts.quick", serialise(newer));
    const { store } = await start({ text: serialise(old), writes: [], fail: false });
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(true);
  });

  it("warns once when saving fails, and keeps the change in the quick copy", async () => {
    const fake: Fake = { text: null, writes: [], fail: true };
    const { store } = await start(fake);
    await flushed();
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: { win: MAIN, page: "mix" } });
    await flushed();
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: { win: MAIN, page: "mix" } });
    await flushed();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(readBook(localStorage.getItem("mixit.layouts.quick")).book.saved).toBeGreaterThanOrEqual(3);
  });

  it("keeps an unreadable book and opens the standard layout", async () => {
    const fake: Fake = { text: "{broken", writes: [], fail: false };
    const { store } = await start(fake);
    expect(store.useLayout.getState().layout).not.toBeNull();
    expect(toast.warning).toHaveBeenCalled();
    expect(Object.keys(localStorage).some((k) => k.startsWith("mixit.layouts.quick.bad-"))).toBe(true);
    await flushed();
    expect(readBook(fake.text).book.setAside[0]).toMatchObject({ key: "*", layout: "{broken" });
  });

  it("never writes over layouts from a newer MixIt", async () => {
    const text = JSON.stringify({ version: 2, setups: {} });
    const fake: Fake = { text, writes: [], fail: false };
    const { store } = await start(fake);
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: { win: MAIN, page: "mix" } });
    await flushed();
    expect(fake.writes).toEqual([]);
    expect(fake.text).toBe(text);
    expect(localStorage.getItem("mixit.layouts.quick")).toBeNull();
    expect(toast.message).toHaveBeenCalled();
  });

  it("moves the first preview's layout into the book", async () => {
    localStorage.setItem("mixit.layout.v1", serialise(fold(base(), env, "mixer", true, { win: MAIN, page: "mix" })));
    const { store } = await start({ text: null, writes: [], fail: false });
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(true);
  });

  it("keeps a layout for each set of screens", async () => {
    const fake: Fake = { text: null, writes: [], fail: false };
    const { store, scr } = await start(fake);
    const mix = { win: MAIN, page: "mix" as const };
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    vi.useFakeTimers();
    const plug = (screens: ScreenInfo[]) => {
      scr.useScreens.setState({ screens });
      // Nothing happens until the screens have stayed the same for a moment.
      vi.advanceTimersByTime(store.SETTLE_MS - 10);
      vi.advanceTimersByTime(10);
    };
    // A monitor comes: it starts from the layout in use (one window here).
    plug([laptopScreen, monitor]);
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(true);
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: mix });
    // Unplugged: the laptop's own layout comes back, then the monitor's when it returns.
    plug([laptopScreen]);
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(true);
    plug([monitor, laptopScreen]);
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(false);
    // Unplugged and back within the settle time: nothing changes.
    scr.useScreens.setState({ screens: [laptopScreen] });
    vi.advanceTimersByTime(500);
    plug([monitor, laptopScreen]);
    expect(folded(store.useLayout.getState().layout!, "mixer")).toBe(false);
    vi.useRealTimers();
    await flushed();
    expect(Object.keys(readBook(fake.text).book.setups).sort()).toEqual(["Built-in Retina Display@2880x1800", "Built-in Retina Display@2880x1800|DELL U2720Q@3840x2160"]);
  });

  it("goes on without screens when they don't answer, and in a browser", async () => {
    const { store } = await start({ text: null, writes: [], fail: false }, null);
    expect(store.useLayout.getState().layout).not.toBeNull();
  });
});
