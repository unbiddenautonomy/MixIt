// The built-in layouts. Standard is one for a laptop on its own and one for a laptop with
// a second screen; Controller, Prepare and Arrange each come in the same two shapes. All
// are plain data passed through `normalise`, so they keep the same rules as anything a
// person builds.
import { MAIN, defaultPerformanceScreen, orderedScreens, place, refOf, resolveScreen, split, stack, type Env, type Layout, type LayoutNode, type ScreenInfo, type ScreenRef, type UnitId } from "./model";
import { applyPreset } from "./ops";

/** Units that fold by themselves while a DJ controller is connected: it has these on it. */
const CONTROLLER_FOLDS: UnitId[] = ["mixer"];

/** The built-in layouts a person can pick. "standard" is Laptop on one screen and Laptop + screen on two. */
export type BuiltIn = "standard" | "controller" | "prepare" | "arrange";

export const BUILT_INS: { id: BuiltIn; name: string; what: string }[] = [
  { id: "standard", name: "Standard", what: "Waveforms, decks and mixer, with the library below (or on the other screen)." },
  { id: "controller", name: "Controller", what: "For a DJ controller: the mixer and pads folded away, big waveforms and library." },
  { id: "prepare", name: "Prepare", what: "For getting tracks ready: the library, track details and suggestions large, the decks small." },
  { id: "arrange", name: "Arrange", what: "Arrange large, with the library beside it." },
];

/** The name a layout's `preset` stands for, when it is a built-in one. */
export function builtInName(preset: string): string | null {
  if (preset === "laptop") return "Laptop";
  if (preset === "laptop+screen") return "Laptop + screen";
  return BUILT_INS.find((b) => b.id === preset && b.id !== "standard")?.name ?? null;
}

/** Folded in both folds: the Controller layout puts these away whether or not one is plugged in. */
const ALWAYS: UnitId[] = ["mixer", "tool.pads"];

const placer = (kind: BuiltIn) => (unit: UnitId) =>
  kind === "controller" && ALWAYS.includes(unit) ? place(unit, { noController: true, controller: true }) : place(unit, { controller: CONTROLLER_FOLDS.includes(unit) });

/** Tools, track details and the queues, sharing one column. Prepare gives track details a stack of its own above the rest. */
function sideColumn(kind: BuiltIn): LayoutNode {
  const p = placer(kind);
  const tools: UnitId[] = ["tool.pads", "tool.steps", "tool.effects", "tool.mic", "tool.record", "tool.make", "autodj", "suggestions", "studio", "guide", "clock"];
  if (kind === "prepare") return split("col", [stack(p("details")), stack(p("suggestions"), ...tools.filter((u) => u !== "suggestions").map(p))], [0.5, 0.5]);
  return stack(p("details"), ...tools.map(p));
}

/** Waveforms, then decks either side of the mixer. With four decks, C sits under A and D under B. */
function deckRow(kind: BuiltIn): LayoutNode {
  const p = placer(kind);
  return split("row", [split("col", [stack(p("deck.A")), stack(p("deck.C"))]), stack(p("mixer")), split("col", [stack(p("deck.B")), stack(p("deck.D"))])], [0.38, 0.24, 0.38]);
}

function performance(kind: BuiltIn, waveShare: number): LayoutNode {
  return split("col", [stack(placer(kind)("waves")), deckRow(kind)], [waveShare, 1 - waveShare]);
}

function browse(kind: BuiltIn): LayoutNode {
  const p = placer(kind);
  const sizes = kind === "prepare" ? [0.14, 0.48, 0.38] : [0.16, 0.56, 0.28];
  return split("row", [stack(p("sidebar")), stack(p("library")), sideColumn(kind)], sizes);
}

/** How much of one screen's height the waveforms, the decks and the library get. */
const ONE_SCREEN: Record<BuiltIn, [number, number, number]> = {
  standard: [0.14, 0.36, 0.5],
  controller: [0.24, 0.3, 0.46],
  prepare: [0.1, 0.3, 0.6],
  arrange: [0.14, 0.36, 0.5],
};

/** One screen: performance on top, the library and the side column below. */
export function laptop(kind: BuiltIn = "standard"): Layout {
  const p = placer(kind);
  const mix = split("col", [stack(p("waves")), deckRow(kind), browse(kind)], ONE_SCREEN[kind]);
  return {
    version: 1,
    preset: kind === "standard" ? "laptop" : kind,
    edited: false,
    nextWin: 2,
    windows: [
      {
        id: MAIN,
        screen: null,
        bounds: "full",
        fullscreen: false,
        page: kind === "arrange" ? "arrange" : "mix",
        pages: { mix, library: browse(kind), arrange: split("row", [stack(p("arrange")), stack(p("library"))], kind === "arrange" ? [0.66, 0.34] : [0.72, 0.28]) },
      },
    ],
  };
}

/** Two screens: the decks and mixer on the performance screen, the library and tools on the other. */
export function laptopAndScreen(perf: ScreenRef, other: ScreenRef, kind: BuiltIn = "standard"): Layout {
  const p = placer(kind);
  return {
    version: 1,
    preset: kind === "standard" ? "laptop+screen" : kind,
    edited: false,
    nextWin: 3,
    windows: [
      { id: MAIN, screen: perf, bounds: "full", fullscreen: false, page: kind === "arrange" ? "arrange" : "mix", pages: { mix: performance(kind, kind === "controller" ? 0.4 : 0.3), arrange: stack(p("arrange")) } },
      { id: "w2", screen: other, bounds: "full", fullscreen: false, page: "library", pages: { library: browse(kind) } },
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
export function presetFor(env: Env, opts: { performance?: ScreenRef | null; mainScreen?: string | null; kind?: BuiltIn } = {}): Layout {
  const kind = opts.kind ?? "standard";
  if (env.browser || env.screens.length < 2) return applyPreset(laptop(kind), env);
  const chosen = opts.performance ? resolveScreen(env.screens, opts.performance) : null;
  const perf = chosen ?? defaultPerformanceScreen(env.screens, opts.mainScreen ?? null);
  const other = perf && otherScreen(env.screens, perf);
  if (!perf || !other) return applyPreset(laptop(kind), env);
  return applyPreset(laptopAndScreen(refOf(env.screens, perf), refOf(env.screens, other), kind), env);
}
