// The layout's windows as the system sees them: where each one goes on the desktop, and
// what to open, move and close to get from the windows that are open to the ones the
// layout has. Plain functions of the layout and the screens, so tests can check them with
// made-up screens; store/layoutWindows.ts applies them to real windows.
import { PAGE_IDS, findWin, orderedScreens, resolveScreen, stacksOf, type Layout, type Rect01, type ScreenInfo, type Win } from "./model";
import type { WinPlace, WinReport } from "../../backend/types";
import { UNITS } from "./units";

export type { WinPlace, WinReport };

export interface WinSpec {
  id: string;
  title: string;
  place: WinPlace;
}

/** Window 2, Window 3...: the number people see. The main window is Window 1. */
export function windowNumber(id: string): number {
  const m = /^w(\d+)$/.exec(id);
  return m ? Number(m[1]) : 1;
}

/** What a window holds, in a few words: "Library, Sidebar" or "Library and 3 more". */
export function windowHolds(win: Win): string {
  const names: string[] = [];
  for (const page of PAGE_IDS) for (const st of stacksOf(win.pages[page])) for (const p of st.units) if (!p.mirror && !names.includes(UNITS[p.unit].name)) names.push(UNITS[p.unit].name);
  if (!names.length) return "empty";
  return names.length <= 2 ? names.join(", ") : `${names[0]} and ${names.length - 1} more`;
}

export function windowTitle(win: Win): string {
  return `MixIt · Window ${windowNumber(win.id)} · ${windowHolds(win)}`;
}

/** A window's place on its screen. */
export function placeOn(screen: ScreenInfo, bounds: Rect01 | "full", fullscreen: boolean): WinPlace {
  if (fullscreen) return { x: screen.x, y: screen.y, w: screen.width, h: screen.height, fill: "full" };
  if (bounds === "full") return { x: screen.x, y: screen.y, w: screen.width, h: screen.height, fill: "max" };
  return {
    x: Math.round(screen.x + bounds.x * screen.width),
    y: Math.round(screen.y + bounds.y * screen.height),
    w: Math.round(bounds.w * screen.width),
    h: Math.round(bounds.h * screen.height),
    fill: "rect",
  };
}

/** The windows other than the main one, each on the screen it remembers. Windows whose screen isn't connected are left out. */
export function windowPlan(layout: Layout, screens: ScreenInfo[]): WinSpec[] {
  const out: WinSpec[] = [];
  for (const w of layout.windows.slice(1)) {
    const s = w.screen ? resolveScreen(screens, w.screen) : null;
    if (s) out.push({ id: w.id, title: windowTitle(w), place: placeOn(s, w.bounds, w.fullscreen) });
  }
  return out;
}

/** The screen a window is on: the one holding its middle, else the one it overlaps most. */
export function screenOf(screens: ScreenInfo[], r: { x: number; y: number; w: number; h: number }): ScreenInfo | null {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const list = orderedScreens(screens);
  const inside = list.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height);
  if (inside) return inside;
  let best: ScreenInfo | null = null;
  let area = 0;
  for (const s of list) {
    const w = Math.min(r.x + r.w, s.x + s.width) - Math.max(r.x, s.x);
    const h = Math.min(r.y + r.h, s.y + s.height) - Math.max(r.y, s.y);
    if (w > 0 && h > 0 && w * h > area) {
      area = w * h;
      best = s;
    }
  }
  return best;
}

/** What a report means for the layout: the screen, and the bounds as fractions of it. */
export function fromReport(screens: ScreenInfo[], r: WinReport): { screen: ScreenInfo; bounds: Rect01 | "full"; fullscreen: boolean } | null {
  const screen = screenOf(screens, r);
  if (!screen) return null;
  if (r.fullscreen || r.maximized) return { screen, bounds: "full", fullscreen: r.fullscreen };
  // A window almost the size of its screen counts as filling it (the system leaves room for menus and docks).
  if (r.w >= screen.width * 0.97 && r.h >= screen.height * 0.9) return { screen, bounds: "full", fullscreen: false };
  const bounds = { x: (r.x - screen.x) / screen.width, y: (r.y - screen.y) / screen.height, w: r.w / screen.width, h: r.h / screen.height };
  return { screen, bounds, fullscreen: false };
}

/** Two places that differ by no more than rounding. */
export function samePlace(a: WinPlace, b: WinPlace): boolean {
  if (a.fill !== b.fill) return false;
  if (a.fill !== "rect") return a.x === b.x && a.y === b.y;
  return Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2;
}

export interface WinChanges {
  open: WinSpec[];
  move: WinSpec[];
  retitle: WinSpec[];
  close: string[];
}

/**
 * What to do to the real windows. `open` lists the windows open now; `last` is where each
 * was last put (or last reported to be), so a window already in place isn't moved again.
 */
export function windowChanges(want: WinSpec[], open: ReadonlySet<string>, last: ReadonlyMap<string, WinSpec>): WinChanges {
  const out: WinChanges = { open: [], move: [], retitle: [], close: [] };
  const ids = new Set(want.map((w) => w.id));
  for (const id of open) if (!ids.has(id)) out.close.push(id);
  for (const w of want) {
    const was = last.get(w.id);
    if (!open.has(w.id)) out.open.push(w);
    else if (!was || !samePlace(was.place, w.place)) out.move.push(w);
    else if (was.title !== w.title) out.retitle.push(w);
  }
  out.close.sort();
  return out;
}

/** The window a unit is in, for "Window 2" labels. */
export function windowLabel(layout: Layout, id: string, screens: ScreenInfo[]): string {
  const w = findWin(layout, id);
  const n = windowNumber(id);
  if (!w || !w.screen) return `Window ${n}`;
  const s = resolveScreen(screens, w.screen);
  const nth = s ? orderedScreens(screens).indexOf(s) + 1 : 0;
  return nth ? `Window ${n} (Screen ${nth})` : `Window ${n}`;
}

/** A screen's name as people read it: "Screen 2 (DELL U2720Q)". */
export function screenName(screens: ScreenInfo[], s: ScreenInfo): string {
  const n = orderedScreens(screens).indexOf(s) + 1;
  const name = s.name && !/^\\\\\.\\DISPLAY\d+$/i.test(s.name) && !/^monitor ?#?\d*$/i.test(s.name) && s.name !== "Screen" ? ` (${s.name})` : "";
  return `Screen ${n}${name}`;
}
