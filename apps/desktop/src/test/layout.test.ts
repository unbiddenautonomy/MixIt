import { describe, expect, it } from "vitest";
import { check, loadLayout } from "../lib/layout/check";
import { fitTree, minSize } from "../lib/layout/fit";
import { MAIN, allPlaces, defaultPerformanceScreen, findWin, placesOf, refOf, resolveScreen, setupKey, split, stack, stacksOf, type Env, type Layout, type ScreenInfo, type UnitId } from "../lib/layout/model";
import { closeWindow, collapse, fixSizes, fold, isRefusal, mirror, newWindow, normalise, placeUnit, resize, send, sendHome, showPage, windowMoved, type Result } from "../lib/layout/ops";
import { migrateOld, parseLayout, serialise } from "../lib/layout/persist";
import { BUILT_INS, builtInName, laptop, presetFor } from "../lib/layout/presets";
import { LayoutFeed, LayoutWriter } from "../lib/layout/sync";
import { setupKey as oldSetupKey } from "../lib/screens";

const scr = (name: string, x: number, y = 0, width = 1920, height = 1080, scale = 1): ScreenInfo => ({ name, x, y, width, height, scale });
const laptopScreen = scr("Built-in Retina Display", 0, 0, 2940, 1912, 2);
const dell = scr("DELL U2720Q", 2940, 0, 3840, 2160, 1.5);
const projector = scr("EPSON PJ", -1920);

const env = (over: Partial<Env> = {}): Env => ({
  screens: [laptopScreen],
  sizes: { [MAIN]: { w: 1470, h: 956 }, w2: { w: 2560, h: 1400 }, w3: { w: 1920, h: 1050 } },
  mode: "easy",
  decks: 2,
  controller: false,
  browser: false,
  ...over,
});
const two = env({ screens: [laptopScreen, dell] });

/** The layout an operation gave, failing the test if it was refused or broke a rule. */
function ok(r: Result, e: Env): Layout {
  if (isRefusal(r)) throw new Error(`refused: ${r.reason}`);
  expect(check(r, e)).toEqual([]);
  return r;
}
const where = (l: Layout, unit: UnitId) => placesOf(l, unit).map((f) => `${f.win.id}/${f.page}`);

describe("layout presets", () => {
  it("every built-in layout keeps the rules on one, two and three screens, with two or four decks", () => {
    const three = env({ screens: [laptopScreen, dell, projector] });
    for (const b of BUILT_INS)
      for (const e of [env(), two, three, env({ browser: true }), env({ decks: 4, mode: "pro" }), env({ screens: two.screens, controller: true })]) {
        const l = presetFor(e, { kind: b.id });
        expect(check(l, e, { roundTrip: true }), `${b.id} on ${e.screens.length} screens`).toEqual([]);
        expect(builtInName(l.preset), b.id).toBeTruthy();
        expect(l.edited).toBe(false);
      }
  });

  it("Controller folds the mixer and pads both ways, Arrange opens on Arrange, Prepare gives track details room", () => {
    for (const e of [env(), two]) {
      const c = presetFor(e, { kind: "controller" });
      for (const u of ["mixer", "tool.pads"] as UnitId[]) expect(placesOf(c, u)[0].place.folded, u).toEqual({ noController: true, controller: true });
      expect(placesOf(c, "waves")[0].place.folded.noController).toBe(false);
      expect(presetFor(e, { kind: "arrange" }).windows[0].page).toBe("arrange");
      const p = presetFor(e, { kind: "prepare" });
      // Track details sit in a stack of their own, not as a tab among the tools.
      expect(placesOf(p, "details")[0].stack.units.map((x) => x.unit)).toEqual(["details"]);
      expect(placesOf(presetFor(e), "details")[0].stack.units.length).toBeGreaterThan(1);
    }
    expect(presetFor(two, { kind: "prepare" }).preset).toBe("prepare");
    expect(presetFor(two).preset).toBe("laptop+screen");
    expect(builtInName("laptop+screen")).toBe("Laptop + screen");
    expect(builtInName("p123")).toBeNull();
  });

  it("the laptop layout fits 13-inch and 15-inch laptops, and never folds the decks or mixer to do it", () => {
    // The area under the top bar, as the app gives it to the layout (measured in the browser).
    const area = (w: number, h: number) => ({ w: w - 16, h: h - 112 });
    for (const [w, h] of [
      [1280, 800],
      [1440, 900],
      [1470, 956],
      [1710, 1112],
    ])
      for (const mode of ["easy", "pro"] as const)
        for (const decks of [2, 4] as const) {
          const size = area(w, h);
          const e = env({ sizes: { [MAIN]: size }, mode, decks });
          const l = presetFor(e);
          const what = `${w}×${h} ${mode} ${decks} decks`;
          expect(check(l, e), what).toEqual([]);
          const fit = fitTree(l.windows[0].pages.mix, size, e);
          expect(fit.scroll, what).toBe(false);
          for (const u of ["deck.A", "deck.B", "mixer"] as UnitId[]) expect(fit.autoFolded.has(u), `${what}: ${u}`).toBe(false);
          // Today's parts already fit the two target laptops with two decks and nothing folded.
          // (The rebuilt mixer and deck strip will make 1280×800 fit too.)
          if (decks === 2 && w >= 1470) expect([...fit.autoFolded], what).toEqual([]);
        }
  });

  it("with two screens, the decks stay on the laptop unless the person picks the other screen", () => {
    const l = presetFor(two);
    expect(check(l, two)).toEqual([]);
    expect(l.windows.map((w) => w.screen?.name)).toEqual([laptopScreen.name, dell.name]);
    expect(where(l, "mixer")).toEqual(["main/mix"]);
    expect(where(l, "library")).toEqual(["w2/library"]);
    const picked = presetFor(two, { performance: refOf(two.screens, dell) });
    expect(picked.windows.map((w) => w.screen?.name)).toEqual([dell.name, laptopScreen.name]);
  });

  it("finds the laptop's own screen by name, else the main window's screen", () => {
    expect(defaultPerformanceScreen([dell, laptopScreen], null)?.name).toBe(laptopScreen.name);
    expect(defaultPerformanceScreen([dell, projector], dell.name)?.name).toBe(dell.name);
    expect(defaultPerformanceScreen([dell, projector], null)?.name).toBe(projector.name);
    expect(defaultPerformanceScreen([], null)).toBeNull();
  });

  it("keeps today's key for a set of screens, so layouts already saved still match", () => {
    expect(setupKey([laptopScreen, dell])).toBe(oldSetupKey([dell, laptopScreen]));
  });

  it("tells two identical monitors apart by where they are", () => {
    const left = scr("DELL", 0);
    const right = scr("DELL", 1920);
    const both = [right, left];
    expect(refOf(both, left).nth).toBe(0);
    expect(refOf(both, right).nth).toBe(1);
    expect(resolveScreen(both, refOf(both, right))).toBe(right);
    expect(resolveScreen([left], refOf(both, right))).toBeNull();
  });
});

describe("layout operations", () => {
  it("sends the library to the other screen and back to its place", () => {
    const l0 = presetFor(env());
    const l1 = ok(newWindow(l0, two, "library", refOf(two.screens, dell)), two);
    expect(where(l1, "library")).toEqual(["w2/library"]);
    // It left every page of the main window, not just the one showing.
    expect(findWin(l1, MAIN)!.pages.library).toBeDefined(); // the sidebar and side column are still there
    expect(stacksOf(findWin(l1, MAIN)!.pages.arrange).flatMap((s) => s.units.map((p) => p.unit))).toEqual(["arrange"]);
    const l2 = ok(send(l1, two, "library", MAIN), two);
    expect(where(l2, "library")).toEqual(["main/mix"]);
    expect(l2.windows.length).toBe(1); // the emptied window closed
    // Home is right of the sidebar.
    const row = stacksOf(findWin(l2, MAIN)!.pages.mix);
    const iSide = row.findIndex((s) => s.units.some((p) => p.unit === "sidebar"));
    expect(row[iSide + 1].units[0].unit).toBe("library");
  });

  it("sending the same thing twice changes nothing", () => {
    const l1 = ok(newWindow(presetFor(env()), two, "library", refOf(two.screens, dell)), two);
    expect(send(l1, two, "library", "w2")).toBe(l1);
  });

  it("puts a deck sent to a library page on that window's Mix page instead", () => {
    const l1 = ok(newWindow(presetFor(env()), two, "library", refOf(two.screens, dell)), two);
    const l2 = ok(send(l1, two, "deck.A", "w2", "library"), two);
    expect(where(l2, "deck.A")).toEqual(["w2/mix"]);
  });

  it("closing a window sends its units home and keeps their folds", () => {
    let l = ok(newWindow(presetFor(env()), two, "tool.effects", refOf(two.screens, dell)), two);
    l = ok(fold(l, two, "tool.effects", true), two);
    l = ok(closeWindow(l, two, "w2"), two);
    expect(where(l, "tool.effects")).toEqual(["main/mix"]);
    expect(placesOf(l, "tool.effects")[0].place.folded.noController).toBe(true);
    expect(isRefusal(closeWindow(l, two, MAIN))).toBe(true);
    expect(closeWindow(l, two, "w9")).toBe(l);
  });

  it("an unplugged screen's units come home, and nothing is lost", () => {
    const l1 = presetFor(two);
    const alone = env();
    const l2 = normalise(l1, alone);
    expect(check(l2, alone)).toEqual([]);
    expect(l2.windows.length).toBe(1);
    expect(where(l2, "library").length).toBeGreaterThan(0);
  });

  it("mirrors views only, never into their own window, and at most twice", () => {
    const three = env({ screens: [laptopScreen, dell, projector] });
    let l = presetFor(three);
    expect(isRefusal(mirror(l, three, "mixer", "w2"))).toBe(true);
    expect(isRefusal(mirror(l, three, "waves", MAIN))).toBe(true);
    l = ok(mirror(l, three, "waves", "w2"), three);
    expect(placesOf(l, "waves", true).map((f) => `${f.win.id}:${!!f.place.mirror}`)).toEqual(["main:false", "w2:true"]);
    l = ok(newWindow(l, three, "clock", refOf(three.screens, projector)), three);
    l = ok(mirror(l, three, "waves", "w3"), three);
    // Sending a view to a window that shows its mirror makes that copy its own.
    const moved = ok(send(l, three, "waves", "w2"), three);
    expect(where(moved, "waves")).toEqual(["w2/library"]);
  });

  it("refuses a fifth window and any second window in the browser", () => {
    const four = env({ screens: [laptopScreen, dell, projector, scr("LG", 6780)] });
    let l = presetFor(four);
    l = ok(newWindow(l, four, "clock", refOf(four.screens, projector)), four);
    l = ok(newWindow(l, four, "guide", refOf(four.screens, four.screens[3])), four);
    expect(l.windows.length).toBe(4);
    expect(isRefusal(newWindow(l, four, "tool.mic", refOf(four.screens, dell)))).toBe(true);
    const web = env({ browser: true });
    expect(isRefusal(newWindow(presetFor(web), web, "library", refOf([laptopScreen], laptopScreen)))).toBe(true);
    expect(isRefusal(newWindow(presetFor(two), two, "library", refOf([projector], projector)))).toBe(true);
  });

  it("docks beside another unit, and refuses a spot the window has no room for", () => {
    const e = env();
    const l = presetFor(e);
    const docked = ok(placeUnit(l, e, "tool.pads", { win: MAIN, page: "mix", unit: "library" }, "left"), e);
    const stacks = stacksOf(findWin(docked, MAIN)!.pages.mix);
    const i = stacks.findIndex((s) => s.units[0].unit === "tool.pads");
    expect(stacks[i + 1].units[0].unit).toBe("library");
    // Arrange under the mixer would make the deck row taller than a 15-inch screen.
    const r = placeUnit(l, e, "arrange", { win: MAIN, page: "mix", unit: "mixer" }, "below");
    expect(isRefusal(r) ? r.reason : "placed").toMatch(/room/);
    expect(isRefusal(placeUnit(l, e, "deck.A", { win: MAIN, page: "library", unit: "library" }, "left"))).toBe(true);
  });

  it("keeps folds apart for playing with and without a controller", () => {
    const withC = env({ controller: true });
    const l = presetFor(withC);
    // The built-in layout folds the on-screen mixer when a controller is there.
    expect(placesOf(l, "mixer")[0].place.folded).toEqual({ noController: false, controller: true });
    const opened = ok(fold(l, withC, "mixer", false), withC);
    expect(placesOf(opened, "mixer")[0].place.folded).toEqual({ noController: false, controller: false });
  });

  it("a split handle can't squeeze a unit below its smallest size", () => {
    const e = env();
    const l = presetFor(e);
    const r = ok(resize(l, e, MAIN, "mix", [], [0.01, 0.01, 0.98]), e);
    const mix = findWin(r, MAIN)!.pages.mix;
    if (mix?.kind !== "split") throw new Error("expected a split");
    const usable = 956 - 2 * 4;
    expect(mix.sizes[0] * usable).toBeGreaterThanOrEqual(60 - 1e-6);
    expect(mix.sizes[1] * usable).toBeGreaterThanOrEqual(260 - 1e-6);
  });

  it("the main window can show a page whose units are elsewhere; a part window can't", () => {
    const l = presetFor(two);
    const r = ok(showPage(l, two, MAIN, "library"), two);
    expect(r.windows[0].page).toBe("library");
    expect(isRefusal(showPage(l, two, "w2", "arrange"))).toBe(true);
  });

  it("a unit keeps its fold and view state when it moves", () => {
    let l = presetFor(two);
    const lib = placesOf(l, "library")[0];
    lib.place.view = { scroll: 1234 };
    l = ok(fold(l, two, "library", true), two);
    l = ok(send(l, two, "library", MAIN), two);
    const moved = placesOf(l, "library")[0].place;
    expect(moved.view).toEqual({ scroll: 1234 });
    expect(moved.folded.noController).toBe(true);
  });

  it("sending to a page a window doesn't have yet gives it that page", () => {
    const l = ok(send(presetFor(two), two, "arrange", "w2", "arrange"), two);
    expect(where(l, "arrange")).toEqual(["w2/arrange"]);
    // Within one window a unit can sit on several pages; moving it to another page there keeps the rest.
    const m = ok(send(presetFor(two), two, "tool.mic", "w2", "arrange"), two);
    expect(where(m, "tool.mic")).toEqual(["w2/library", "w2/arrange"]);
  });

  it("follows a window the person drags to another screen", () => {
    const l = ok(windowMoved(presetFor(two), two, "w2", laptopScreen, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, false), two);
    expect(l.windows[1].screen?.name).toBe(laptopScreen.name);
    // Bounds that spill off the screen are pulled back onto it.
    const off = ok(windowMoved(l, two, "w2", dell, { x: 0.9, y: -0.4, w: 0.5, h: 2 }, false), two);
    expect(off.windows[1].bounds).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("of two identical monitors, a window on the one unplugged lands on the other", () => {
    const left = scr("DELL", 2940);
    const right = scr("DELL", 4860);
    const e = env({ screens: [laptopScreen, left, right] });
    let l = presetFor(e);
    l = ok(newWindow(l, e, "clock", refOf(e.screens, right)), e);
    const after = env({ screens: [laptopScreen, right] });
    const n = normalise(l, after);
    expect(check(n, after)).toEqual([]);
    expect(n.windows.every((w) => !w.screen || resolveScreen(after.screens, w.screen))).toBe(true);
  });

  it("back to its default place, from anywhere", () => {
    let l = ok(newWindow(presetFor(env()), two, "mixer", refOf(two.screens, dell)), two);
    l = ok(sendHome(l, two, "mixer"), two);
    expect(where(l, "mixer")).toEqual(["main/mix"]);
  });
});

describe("normalise", () => {
  it("is idempotent", () => {
    const l = presetFor(two);
    expect(serialise(normalise(l, two))).toBe(serialise(l));
  });

  it("repairs a broken layout instead of showing it", () => {
    const e = env();
    const bad = {
      ...laptop(),
      windows: [
        { id: "w5", screen: { name: "Gone", w: 1, h: 1, nth: 0 }, bounds: "full", fullscreen: false, pages: { mix: stack("tool.mic") }, page: "mix" },
        {
          id: MAIN,
          screen: null,
          bounds: { x: -3, y: 0.9, w: 5, h: Number.NaN },
          fullscreen: false,
          page: "nope",
          pages: {
            mix: split("col", [
              stack(), // empty
              split("col", [stack("mixer")]), // one child, same direction
              split("row", [stack("deck.A", "deck.A"), stack({ unit: "mixer", folded: { noController: false, controller: false }, mirror: true })], [Number.NaN, -1]),
              split("row", [split("col", [split("row", [split("col", [split("row", [stack("library"), stack("sidebar")])])])])]),
            ]),
          },
        },
      ],
    } as unknown as Layout;
    const l = normalise(bad, e);
    expect(check(l, e)).toEqual([]);
    expect(l.windows.length).toBe(1);
    expect(where(l, "mixer")).toEqual(["main/mix"]);
    expect(allPlaces(l).filter((f) => f.place.unit === "deck.A").length).toBe(1);
    expect(l.windows[0].page).toBe("mix");
  });

  it("brings a required deck onto a Mix page when four decks are switched on", () => {
    const e2 = env({ decks: 2 });
    let l = presetFor(e2);
    // With two decks, C may live anywhere: put it on the Library page only.
    l = ok(send(l, e2, "deck.C", MAIN, "library"), e2);
    l = ok(sendHome(l, e2, "deck.C"), e2);
    const e4 = env({ decks: 4 });
    expect(check(normalise(l, e4), e4)).toEqual([]);
  });

  it("fixes shares so they are positive and add up to one", () => {
    const s = fixSizes([Number.NaN, 0, 3, 1e-9], 4);
    expect(s.every((x) => x > 0)).toBe(true);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(collapse(split("row", [stack(), stack()]))).toBeNull();
  });
});

describe("fitting a window", () => {
  it("folds the side column before the decks when a window is too narrow", () => {
    const e = env();
    const mix = presetFor(e).windows[0].pages.mix!;
    const fit = fitTree(mix, { w: 700, h: 900 }, e);
    // Both rows are too wide: the side column and the mixer fold, the decks and library stay open.
    expect([...fit.autoFolded].sort()).toEqual(["details", "mixer"]);
    expect(fit.scroll).toBe(false);
    // 960 px fits two decks as they are; four decks make the mixer wider, and only that row gives way.
    expect([...fitTree(mix, { w: 960, h: 900 }, e).autoFolded]).toEqual([]);
    const four = env({ decks: 4 });
    expect([...fitTree(presetFor(four).windows[0].pages.mix!, { w: 960, h: 1200 }, four).autoFolded]).toEqual(["mixer"]);
  });

  it("never folds a unit the person opened from its bar, even if the window has to scroll", () => {
    const e = env();
    const mix = presetFor(e).windows[0].pages.mix!;
    const small = { w: 1264, h: 500 };
    expect(fitTree(mix, small, e).autoFolded.has("waves")).toBe(true);
    const kept = fitTree(mix, small, e, undefined, new Set<UnitId>(["waves"]));
    expect(kept.autoFolded.has("waves")).toBe(false);
  });

  it("scrolls rather than cutting off when nothing more can fold", () => {
    const e = env();
    const mix = presetFor(e).windows[0].pages.mix!;
    // Decks never fold by themselves, so a window narrower than two decks can't fit.
    const fit = fitTree(mix, { w: 500, h: 900 }, e);
    expect(fit.scroll).toBe(true);
    expect(minSize(mix, e, fit.autoFolded).w).toBeGreaterThan(500);
    // Below the hard minimum the main window always scrolls, laid out at the minimum.
    const small = fitTree(mix, { w: 900, h: 600 }, e, { w: 1024, h: 640 });
    expect(small.scroll).toBe(true);
  });
});

describe("saving and loading", () => {
  it("loads back exactly what was saved", () => {
    const l = presetFor(two);
    const text = serialise(l);
    const back = loadLayout(text, two);
    expect(back.layout && serialise(back.layout)).toBe(text);
  });

  it("leaves a newer version's layout alone, and refuses garbage whole", () => {
    expect(parseLayout(JSON.stringify({ version: 2, windows: [] }), env()).problem).toBe("newer");
    for (const junk of ["", "{", "null", "[]", '{"version":1}', '{"version":"1","windows":[]}', serialise(laptop()).slice(0, 200)]) expect(parseLayout(junk, env()).layout, junk).toBeNull();
  });

  it("repairs what it can read: unknown units dropped, missing ones home", () => {
    const l = laptop();
    const text = serialise(l).replace(/"tool\.mic"/g, '"tool.theremin"');
    const back = loadLayout(text, env());
    expect(back.layout).not.toBeNull();
    expect(where(back.layout!, "tool.mic")).toEqual(["main/mix"]);
  });

  it("refuses a layout with thousands of parts", () => {
    const deep = { version: 1, windows: [{ id: MAIN, pages: { mix: split("row", Array.from({ length: 2000 }, () => stack("clock"))) } }] };
    expect(parseLayout(JSON.stringify(deep), env()).problem).toBe("bad");
  });
});

describe("moving today's settings across", () => {
  it("keeps the library and tools on the screen they were on, with the same tab", () => {
    const l = migrateOld({ placement: { library: dell.name, tools: dell.name }, toolTab: "effects", toolSize: "closed", mainScreen: laptopScreen.name }, two);
    expect(check(l, two)).toEqual([]);
    expect(l.windows.length).toBe(2);
    expect(where(l, "library")).toEqual(["w2/library"]);
    expect(where(l, "sidebar")).toEqual(["w2/library"]);
    expect(where(l, "tool.effects")).toEqual(["w2/library"]);
    const fx = placesOf(l, "tool.effects")[0];
    expect(fx.stack.units[fx.stack.active].unit).toBe("tool.effects");
    expect(fx.place.folded.noController).toBe(true);
    expect(l.edited).toBe(false);
  });

  it("turns the library's height into its share of the Mix page", () => {
    const big = env({ sizes: { [MAIN]: { w: 1694, h: 976 } } });
    const l = migrateOld({ libraryHeight: 380, windowHeight: 1112 }, big);
    const mix = l.windows[0].pages.mix;
    if (mix?.kind !== "split") throw new Error("expected a split");
    expect(mix.sizes[2]).toBeCloseTo(380 / (1112 - 47), 2);
    // A height the decks above can't make room for is held to what they need.
    const small = migrateOld({ libraryHeight: 700, windowHeight: 956 }, env());
    const m2 = small.windows[0].pages.mix;
    if (m2?.kind !== "split") throw new Error("expected a split");
    expect(m2.sizes[2]).toBeLessThan(700 / (956 - 47));
  });

  it("skips a screen that isn't connected, and a part on the main window's own screen", () => {
    const l = migrateOld({ placement: { library: "Gone", tools: laptopScreen.name }, mainScreen: laptopScreen.name }, two);
    expect(l.windows.length).toBe(1);
    expect(check(l, two)).toEqual([]);
  });
});

describe("keeping windows in step", () => {
  it("a window draws only newer layouts, so a late message can't roll it back", () => {
    const w = new LayoutWriter(presetFor(two));
    const feed = new LayoutFeed();
    const first = w.current;
    const a = w.apply({ op: "fold", unit: "mixer", folded: true }, two);
    const b = w.apply({ op: "fold", unit: "waves", folded: true }, two);
    if (!("sent" in a) || !("sent" in b)) throw new Error("expected changes");
    expect(feed.accept(b.sent)).toBe(true);
    expect(feed.accept(a.sent)).toBe(false); // arrived late
    expect(feed.accept(b.sent)).toBe(false); // repeated
    expect(feed.accept(first)).toBe(false);
  });

  it("judges each request against the layout as it is now", () => {
    const w = new LayoutWriter(presetFor(two));
    // Two windows both ask; the second asks about a window the first closed.
    expect("sent" in w.apply({ op: "close", win: "w2" }, two)).toBe(true);
    expect(w.apply({ op: "send", unit: "mixer", win: "w2" }, two)).toEqual({ refused: "That window is closed now." });
    expect(w.apply({ op: "close", win: "w2" }, two)).toEqual({ unchanged: true });
    // Folding what is already folded changes nothing either, so nothing is sent.
    expect("sent" in w.apply({ op: "fold", unit: "waves", folded: true }, two)).toBe(true);
    expect(w.apply({ op: "fold", unit: "waves", folded: true }, two)).toEqual({ unchanged: true });
    expect(w.current.seq).toBe(2);
  });
});
