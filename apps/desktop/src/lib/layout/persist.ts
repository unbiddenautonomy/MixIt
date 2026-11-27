// Saving and loading layouts, and moving today's window settings across once.
//
// Loading never trusts what it reads: it rebuilds every object field by field, drops what
// it doesn't know, and runs `normalise`. A layout from a newer version of MixIt is left
// alone (and not overwritten), because this version can't know what it means.
import { LAYOUT_VERSION, MAIN, PAGE_IDS, findWin, isRefusal, orderedScreens, placesOf, refOf, stacksOf, type Env, type Folded, type Layout, type LayoutNode, type PageId, type Place, type Rect01, type Refusal, type ScreenRef, type UnitId, type Win } from "./model";
import { activate, fold, newWindow, normalise, resize, send } from "./ops";
import { laptop } from "./presets";
import { isUnitId } from "./units";

/** The file layouts are kept in. A newer version writes a file of its own, so going back never loses it. */
export const LAYOUT_FILE = `layouts.v${LAYOUT_VERSION}.json`;

const MAX_TEXT = 256 * 1024;
const MAX_VIEW = 4 * 1024;
const MAX_NODES = 512;

/** Writes a layout with its keys in a fixed order, so the same layout always gives the same text. */
export function serialise(value: unknown): string {
  const sorted = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sorted);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const v = (x as Record<string, unknown>)[k];
        if (v !== undefined) out[k] = sorted(v);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(sorted(value));
}

export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function asFolded(x: unknown): Folded {
  if (typeof x === "boolean") return { noController: x, controller: x };
  if (isObj(x)) return { noController: x.noController === true, controller: x.controller === true };
  return { noController: false, controller: false };
}

function asPlace(x: unknown): Place | null {
  if (!isObj(x) || !isUnitId(x.unit)) return null;
  const p: Place = { unit: x.unit, folded: asFolded(x.folded) };
  if (x.mirror === true) p.mirror = true;
  if (isObj(x.view)) {
    try {
      const text = JSON.stringify(x.view);
      if (text.length <= MAX_VIEW) p.view = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* dropped */
    }
  }
  return p;
}

function asNode(x: unknown, budget: { left: number }, depth = 0): LayoutNode | null {
  if (!isObj(x) || depth > 16 || --budget.left < 0) return null;
  if (x.kind === "stack" && Array.isArray(x.units)) {
    const units = x.units.map(asPlace).filter((p): p is Place => !!p);
    return { kind: "stack", units, active: num(x.active) ? Math.trunc(x.active) : 0 };
  }
  if (x.kind === "split" && (x.dir === "row" || x.dir === "col") && Array.isArray(x.children)) {
    const kids: LayoutNode[] = [];
    const sizes: number[] = [];
    const given = Array.isArray(x.sizes) ? x.sizes : [];
    x.children.forEach((c, i) => {
      const n = asNode(c, budget, depth + 1);
      if (!n) return;
      kids.push(n);
      sizes.push(num(given[i]) ? given[i] : NaN);
    });
    return { kind: "split", dir: x.dir, children: kids, sizes };
  }
  return null;
}

function asScreen(x: unknown): ScreenRef | null {
  if (!isObj(x) || typeof x.name !== "string" || !num(x.w) || !num(x.h)) return null;
  return { name: x.name.slice(0, 200), w: x.w, h: x.h, nth: num(x.nth) && x.nth >= 0 ? Math.trunc(x.nth) : 0 };
}

function asBounds(x: unknown): Rect01 | "full" {
  if (isObj(x) && num(x.x) && num(x.y) && num(x.w) && num(x.h)) return { x: x.x, y: x.y, w: x.w, h: x.h };
  return "full";
}

function asWin(x: unknown, budget: { left: number }): Win | null {
  if (!isObj(x) || typeof x.id !== "string" || x.id.length > 16) return null;
  const pages: Win["pages"] = {};
  if (isObj(x.pages))
    for (const page of PAGE_IDS) {
      const n = asNode(x.pages[page], budget);
      if (n) pages[page] = n;
    }
  return {
    id: x.id,
    screen: asScreen(x.screen),
    bounds: asBounds(x.bounds),
    fullscreen: x.fullscreen === true,
    pages,
    page: PAGE_IDS.includes(x.page as PageId) ? (x.page as PageId) : "mix",
  };
}

export type Loaded = { layout: Layout; problem?: undefined } | { layout: null; problem: "newer" | "bad"; detail: string };

/** Reads a saved layout (text or already-parsed JSON) and brings it within the rules. */
export function parseLayout(input: unknown, env: Env): Loaded {
  let data = input;
  if (typeof input === "string") {
    if (input.length > MAX_TEXT) return { layout: null, problem: "bad", detail: "too large" };
    try {
      data = JSON.parse(input);
    } catch {
      return { layout: null, problem: "bad", detail: "not JSON" };
    }
  }
  if (!isObj(data)) return { layout: null, problem: "bad", detail: "not an object" };
  if (num(data.version) && data.version > LAYOUT_VERSION) return { layout: null, problem: "newer", detail: `version ${data.version}` };
  if (data.version !== LAYOUT_VERSION) return { layout: null, problem: "bad", detail: `version ${String(data.version)}` };
  if (!Array.isArray(data.windows)) return { layout: null, problem: "bad", detail: "no windows" };
  const budget = { left: MAX_NODES };
  const windows = data.windows
    .slice(0, 16)
    .map((w) => asWin(w, budget))
    .filter((w): w is Win => !!w);
  if (budget.left < 0) return { layout: null, problem: "bad", detail: "too many parts" };
  const layout: Layout = {
    version: 1,
    preset: typeof data.preset === "string" ? data.preset.slice(0, 100) : "laptop",
    edited: data.edited === true,
    nextWin: num(data.nextWin) ? Math.trunc(data.nextWin) : 2,
    windows,
  };
  return { layout: normalise(layout, env) };
}

// ------------------------------------------------------------------ today's settings

/** What today's screens.ts and the tools panel remember, for one set of screens. */
export interface OldSettings {
  /** Which screen (by name) the library and the tools panel are on; missing means the main window. */
  placement?: { library?: string; tools?: string };
  /** `mixit.tools.tab`: pads, steps, effects, inputs or recording. */
  toolTab?: string | null;
  /** `mixit.tools.size`: closed, docked or full. */
  toolSize?: string | null;
  /** The library's height on the Mix screen, in pixels. */
  libraryHeight?: number | null;
  /** The main window's height then, to turn the library's height into a share. */
  windowHeight?: number;
  /** The screen the main window is on. */
  mainScreen?: string | null;
}

const OLD_TOOL: Record<string, UnitId> = { pads: "tool.pads", steps: "tool.steps", effects: "tool.effects", inputs: "tool.mic", recording: "tool.record" };
const TOOLS: UnitId[] = ["tool.pads", "tool.steps", "tool.effects", "tool.mic", "tool.record"];
/** What today's library window shows besides the track list. */
const LIBRARY_PART: UnitId[] = ["sidebar", "details", "autodj", "suggestions"];

/** Top bar height today, taken off the window before sharing out the rest. */
const TOP_BAR_PX = 47;

/**
 * Turns today's settings into a layout: the one-screen layout, with the library and the
 * tools panel in windows of their own where they are today. Anything that doesn't fit
 * (a screen that isn't connected, a value out of range) is skipped, never guessed.
 */
export function migrateOld(old: OldSettings, env: Env): Layout {
  let l = normalise(laptop(), env);
  const step = (next: Layout | Refusal) => {
    if (!isRefusal(next)) l = next;
  };
  const screenFor = (name: string | undefined) => {
    if (!name || env.browser || name === old.mainScreen) return null;
    const s = orderedScreens(env.screens).find((x) => x.name === name);
    return s ? refOf(env.screens, s) : null;
  };
  const windowOn = (ref: ScreenRef) => l.windows.find((w) => w.id !== MAIN && w.screen?.name === ref.name && w.screen.nth === ref.nth) ?? null;

  const lib = screenFor(old.placement?.library);
  if (lib) {
    step(newWindow(l, env, "library", lib));
    const w = windowOn(lib);
    if (w) for (const u of LIBRARY_PART) step(send(l, env, u, w.id, "library"));
  }
  const tools = screenFor(old.placement?.tools);
  if (tools) {
    const there = windowOn(tools);
    if (there) for (const u of TOOLS) step(send(l, env, u, there.id));
    else {
      step(newWindow(l, env, "tool.pads", tools));
      const w = windowOn(tools);
      if (w) for (const u of TOOLS.slice(1)) step(send(l, env, u, w.id, w.page));
    }
  }

  const tab = old.toolTab ? OLD_TOOL[old.toolTab] : undefined;
  if (tab) for (const f of placesOf(l, tab)) step(activate(l, env, tab, { win: f.win.id, page: f.page }));
  if (old.toolSize === "closed") step(fold(l, env, tab ?? "tool.pads", true));

  // The library's height becomes its share of the Mix page, when the Mix page is still the built-in one.
  const h = old.windowHeight ?? env.sizes[MAIN]?.h;
  const mix = findWin(l, MAIN)?.pages.mix;
  if (num(old.libraryHeight) && num(h) && h > TOP_BAR_PX + 200 && mix?.kind === "split" && mix.dir === "col") {
    const i = mix.children.findIndex((c) => stacksOf(c).some((s) => s.units.some((p) => p.unit === "library")));
    if (i >= 0) {
      const share = Math.max(0.15, Math.min(0.8, old.libraryHeight / (h - TOP_BAR_PX)));
      const rest = mix.sizes.reduce((a, s, j) => (j === i ? a : a + s), 0);
      const sizes = mix.sizes.map((s, j) => (j === i ? share : rest > 0 ? (s / rest) * (1 - share) : (1 - share) / (mix.sizes.length - 1)));
      step(resize(l, env, MAIN, "mix", [], sizes));
    }
  }
  return { ...l, edited: false, preset: "laptop" };
}
