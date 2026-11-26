// The built-in layouts: one for a laptop on its own, and one for a laptop with a second
// screen. Both are plain data passed through `normalise`, so they keep the same rules as
// anything a person builds.
import { MAIN, defaultPerformanceScreen, orderedScreens, place, refOf, resolveScreen, split, stack, type Env, type Layout, type LayoutNode, type ScreenInfo, type ScreenRef, type UnitId } from "./model";
import { applyPreset } from "./ops";

/** Units that fold by themselves while a DJ controller is connected: it has these on it. */
const CONTROLLER_FOLDS: UnitId[] = ["mixer"];

const p = (unit: UnitId) => place(unit, { controller: CONTROLLER_FOLDS.includes(unit) });

/** Tools, track details and the queues, sharing one column. */
const sideColumn = () => stack(p("details"), p("tool.pads"), p("tool.steps"), p("tool.effects"), p("tool.mic"), p("tool.record"), p("tool.make"), p("autodj"), p("suggestions"), p("studio"), p("guide"), p("clock"));

/** Waveforms, then decks either side of the mixer. With four decks, C sits under A and D under B. */
const deckRow = (): LayoutNode =>
  split("row", [split("col", [stack(p("deck.A")), stack(p("deck.C"))]), stack(p("mixer")), split("col", [stack(p("deck.B")), stack(p("deck.D"))])], [0.38, 0.24, 0.38]);

function performance(waveShare: number): LayoutNode {
  return split("col", [stack(p("waves")), deckRow()], [waveShare, 1 - waveShare]);
}

const browse = (): LayoutNode => split("row", [stack(p("sidebar")), stack(p("library")), sideColumn()], [0.16, 0.56, 0.28]);

/** One screen: performance on top, the library and the side column below. */
export function laptop(): Layout {
  const mix = split("col", [stack(p("waves")), deckRow(), browse()], [0.14, 0.36, 0.5]);
  return {
    version: 1,
    preset: "laptop",
    edited: false,
    nextWin: 2,
    windows: [
      {
        id: MAIN,
        screen: null,
        bounds: "full",
        fullscreen: false,
        page: "mix",
        pages: { mix, library: browse(), arrange: split("row", [stack(p("arrange")), stack(p("library"))], [0.72, 0.28]) },
      },
    ],
  };
}

/** Two screens: the decks and mixer on the performance screen, the library and tools on the other. */
export function laptopAndScreen(perf: ScreenRef, other: ScreenRef): Layout {
  return {
    version: 1,
    preset: "laptop+screen",
    edited: false,
    nextWin: 3,
    windows: [
      { id: MAIN, screen: perf, bounds: "full", fullscreen: false, page: "mix", pages: { mix: performance(0.3), arrange: stack(p("arrange")) } },
      { id: "w2", screen: other, bounds: "full", fullscreen: false, page: "library", pages: { library: browse() } },
    ],
  };
}

/** The other screen in a two-screen layout: the largest one that isn't the performance screen. */
function otherScreen(screens: ScreenInfo[], perf: ScreenInfo): ScreenInfo | null {
  const rest = orderedScreens(screens).filter((s) => s !== perf);
  return rest.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

/**
 * The built-in layout for the screens there are now. `performance` is the screen the person
 * chose for the decks, if they have; otherwise it is the laptop's own screen.
 */
export function presetFor(env: Env, opts: { performance?: ScreenRef | null; mainScreen?: string | null } = {}): Layout {
  if (env.browser || env.screens.length < 2) return applyPreset(laptop(), env);
  const chosen = opts.performance ? resolveScreen(env.screens, opts.performance) : null;
  const perf = chosen ?? defaultPerformanceScreen(env.screens, opts.mainScreen ?? null);
  const other = perf && otherScreen(env.screens, perf);
  if (!perf || !other) return applyPreset(laptop(), env);
  return applyPreset(laptopAndScreen(refOf(env.screens, perf), refOf(env.screens, other)), env);
}
