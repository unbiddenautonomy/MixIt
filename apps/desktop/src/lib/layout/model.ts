// The layout as data: which windows exist, which screen each is on, and how each window's
// pages are divided into splits and tab stacks of units. Plain types and pure helpers,
// with no React, DOM or backend, so every rule can be tested with made-up screens.
//
// Only the main window changes the layout (see sync.ts), every change goes through an
// operation in ops.ts, and `check` in check.ts says whether a layout keeps the rules.

export const UNIT_IDS = [
  "waves",
  "deck.A",
  "deck.B",
  "deck.C",
  "deck.D",
  "mixer",
  "library",
  "sidebar",
  "details",
  "autodj",
  "suggestions",
  "tool.pads",
  "tool.steps",
  "tool.effects",
  "tool.mic",
  "tool.record",
  "tool.make",
  "studio",
  "arrange",
  "guide",
  "clock",
] as const;
export type UnitId = (typeof UNIT_IDS)[number];

export const PAGE_IDS = ["mix", "library", "arrange"] as const;
export type PageId = (typeof PAGE_IDS)[number];

/** Whether a unit is folded, kept apart for playing with and without a DJ controller. */
export interface Folded {
  noController: boolean;
  controller: boolean;
}

/** One unit in one stack. */
export interface Place {
  unit: UnitId;
  folded: Folded;
  /** A second copy of a view unit in another window. Control units are never mirrored. */
  mirror?: boolean;
  /** Small view state that travels with the unit (scroll position and the like). */
  view?: Record<string, unknown>;
}

/** Units sharing one area as tabs. */
export interface Stack {
  kind: "stack";
  units: Place[];
  active: number;
}

/** An area divided in a row (side by side) or a column (one above the other). */
export interface Split {
  kind: "split";
  dir: "row" | "col";
  children: LayoutNode[];
  /** Each child's share, adding up to 1. */
  sizes: number[];
}

export type LayoutNode = Split | Stack;

/** Fractions of a screen, so the same layout fits another resolution. */
export interface Rect01 {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A screen as a layout remembers it. Two identical monitors share a name and size, so
 * `nth` says which of them it is, counting left to right.
 */
export interface ScreenRef {
  name: string;
  w: number;
  h: number;
  nth: number;
}

export interface Win {
  /** "main", or "w2", "w3"... never reused while the layout lives. */
  id: string;
  /** null: wherever the system put it (the main window only). */
  screen: ScreenRef | null;
  bounds: Rect01 | "full";
  fullscreen: boolean;
  pages: Partial<Record<PageId, LayoutNode>>;
  /** The page showing. It may name a page the window doesn't have; that page shows where its units went. */
  page: PageId;
}

export interface Layout {
  version: 1;
  /** "laptop", "laptop+screen", or a saved preset's id. */
  preset: string;
  /** Changed since the preset was applied: shows "(changed)" until saved or reset. */
  edited: boolean;
  /** windows[0] is always the main window. */
  windows: Win[];
  /** The number the next new window gets, so window numbers are never reused. */
  nextWin: number;
}

export const LAYOUT_VERSION = 1;
export const MAIN = "main";
export const MAX_DEPTH = 4;
export const MAX_MIRRORS = 2;
export const MAX_WINDOWS = 4;

/** A screen as the system reports it (physical pixels). Same shape as the backend's `Screen`. */
export interface ScreenInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** What an operation needs to know beyond the layout itself. */
export interface Env {
  screens: ScreenInfo[];
  /** Each open window's inner size in its own CSS pixels, by window id. */
  sizes: Record<string, { w: number; h: number }>;
  mode: "easy" | "pro";
  decks: 2 | 4;
  controller: boolean;
  /** The browser version: one window, no Send to or New window. */
  browser: boolean;
}

/** An operation that was turned down, with the reason in plain words. */
export interface Refusal {
  refused: true;
  reason: string;
}

export const refuse = (reason: string): Refusal => ({ refused: true, reason });
export const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && (x as Refusal).refused === true;

// ------------------------------------------------------------------ small builders

export const open = (): Folded => ({ noController: false, controller: false });
export const place = (unit: UnitId, folded: Partial<Folded> = {}): Place => ({ unit, folded: { ...open(), ...folded } });
export const stack = (...units: (UnitId | Place)[]): Stack => ({
  kind: "stack",
  units: units.map((u) => (typeof u === "string" ? place(u) : u)),
  active: 0,
});
export function split(dir: "row" | "col", children: LayoutNode[], sizes?: number[]): Split {
  return { kind: "split", dir, children, sizes: sizes ?? children.map(() => 1 / children.length) };
}

export const isFolded = (p: Place, controller: boolean) => (controller ? p.folded.controller : p.folded.noController);

/** A deep copy. Layouts are small, so operations copy and then change the copy. */
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ------------------------------------------------------------------ walking the tree

export interface Found {
  win: Win;
  page: PageId;
  stack: Stack;
  index: number;
  place: Place;
}

/** Every stack in a tree, in reading order. */
export function stacksOf(node: LayoutNode | undefined): Stack[] {
  if (!node) return [];
  if (node.kind === "stack") return [node];
  return node.children.flatMap(stacksOf);
}

/** Every place of every unit in the layout. */
export function allPlaces(layout: Layout): Found[] {
  const out: Found[] = [];
  for (const win of layout.windows)
    for (const page of PAGE_IDS)
      for (const st of stacksOf(win.pages[page])) st.units.forEach((p, index) => out.push({ win, page, stack: st, index, place: p }));
  return out;
}

/** Where a unit is, mirrors left out unless asked for. */
export function placesOf(layout: Layout, unit: UnitId, mirrors = false): Found[] {
  return allPlaces(layout).filter((f) => f.place.unit === unit && (mirrors || !f.place.mirror));
}

/** The window holding a unit's own (not mirrored) places, if any. */
export function windowOf(layout: Layout, unit: UnitId): Win | null {
  return placesOf(layout, unit)[0]?.win ?? null;
}

export function findWin(layout: Layout, id: string): Win | null {
  return layout.windows.find((w) => w.id === id) ?? null;
}

export function depthOf(node: LayoutNode | undefined): number {
  if (!node) return 0;
  if (node.kind === "stack") return 1;
  return 1 + Math.max(0, ...node.children.map(depthOf));
}

/** The pixel rectangle of every node, for a window of the given size. Handles are left out: they are thin. */
export function rectsOf(node: LayoutNode, w: number, h: number): Map<LayoutNode, { w: number; h: number }> {
  const out = new Map<LayoutNode, { w: number; h: number }>();
  const walk = (n: LayoutNode, nw: number, nh: number) => {
    out.set(n, { w: nw, h: nh });
    if (n.kind === "split") n.children.forEach((c, i) => walk(c, n.dir === "row" ? nw * n.sizes[i] : nw, n.dir === "col" ? nh * n.sizes[i] : nh));
  };
  walk(node, w, h);
  return out;
}

// ------------------------------------------------------------------ screens

/** Screens numbered as people count them: left to right, then top to bottom. */
export function orderedScreens(screens: ScreenInfo[]): ScreenInfo[] {
  return [...screens].sort((a, b) => a.x - b.x || a.y - b.y);
}

/** How a layout remembers a screen. */
export function refOf(screens: ScreenInfo[], s: ScreenInfo): ScreenRef {
  const same = orderedScreens(screens).filter((x) => x.name === s.name && x.width === s.width && x.height === s.height);
  const nth = Math.max(0, same.findIndex((x) => x.x === s.x && x.y === s.y));
  return { name: s.name, w: s.width, h: s.height, nth };
}

/** The connected screen a remembered one means, or null when it isn't connected. */
export function resolveScreen(screens: ScreenInfo[], ref: ScreenRef): ScreenInfo | null {
  const same = orderedScreens(screens).filter((x) => x.name === ref.name && x.width === ref.w && x.height === ref.h);
  return same[ref.nth] ?? null;
}

export const sameScreen = (a: ScreenRef | null, b: ScreenRef | null) =>
  !!a && !!b && a.name === b.name && a.w === b.w && a.h === b.h && a.nth === b.nth;

/** Names a set of screens, so a layout can be remembered for it. The same key as today's screens.ts. */
export function setupKey(screens: ScreenInfo[]): string {
  return screens
    .map((s) => `${s.name}@${s.width}x${s.height}`)
    .sort()
    .join("|");
}

/** The laptop's own screen, by the names macOS, Windows and Linux give it. */
export function isBuiltIn(s: ScreenInfo): boolean {
  return /built-?in|color lcd|\blvds|\bedp/i.test(s.name);
}

/**
 * The screen the decks and mixer go on when nobody has said: the laptop's own screen,
 * or (lid closed, or a desktop) the screen the main window is on, or the first one.
 */
export function defaultPerformanceScreen(screens: ScreenInfo[], mainScreen: string | null): ScreenInfo | null {
  const list = orderedScreens(screens);
  return list.find(isBuiltIn) ?? list.find((s) => s.name === mainScreen) ?? list[0] ?? null;
}
