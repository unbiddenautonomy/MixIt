// Parts of the main screen on other screens. The library and the tools panel can each
// move to a window of their own on any connected screen: drag the part's move button out
// of the window and let go over another screen, or pick "Move to screen N" from its menu.
//
// Where each part is gets remembered for each set of screens ("laptop alone", "laptop
// and the monitor at home", "laptop and the club's projector") and comes back by itself
// when the same screens are connected. A part whose screen is unplugged comes straight
// back into the main window; the music never stops, because every window drives the
// same engine.
//
// The rules here are plain functions of the screen list, so tests can check them with
// made-up screens; `useScreens` and the functions after it apply them to real windows.
import { create } from "zustand";
import { backend } from "../backend";
import { useApp } from "../store/app";

const newLayoutOn = () => !!useApp.getState().settings?.layoutEngine;
import type { Screen } from "../backend/types";

export type { Screen };

export type Part = "library" | "tools";
export const PARTS: Part[] = ["library", "tools"];
export const PART_NAMES: Record<Part, string> = { library: "Library", tools: "Tools panel" };


/** Which screen each part is on, by screen name. A part not listed is in the main window. */
export type Placement = Partial<Record<Part, string>>;

/** Names a set of screens, so a layout can be remembered for it. Order does not matter. */
export function setupKey(screens: Screen[]): string {
  return screens
    .map((s) => `${s.name}@${s.width}x${s.height}`)
    .sort()
    .join("|");
}

/** Screens numbered as people count them: left to right, then top to bottom. */
export function ordered(screens: Screen[]): Screen[] {
  return [...screens].sort((a, b) => a.x - b.x || a.y - b.y);
}

/** "Screen 2 (DELL U2720Q)": the number, and the system's name when it has a useful one. */
export function screenLabel(screens: Screen[], s: Screen): string {
  const n = ordered(screens).findIndex((x) => x.name === s.name) + 1;
  const name = s.name && !/^\\\\\.\\DISPLAY\d+$/i.test(s.name) && !/^monitor ?#?\d*$/i.test(s.name) ? ` (${s.name})` : "";
  return `Screen ${n}${name}`;
}

/** The screen a point (physical pixels) is on. */
export function screenAt(screens: Screen[], x: number, y: number): Screen | null {
  return screens.find((s) => x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height) ?? null;
}

/** Splits a placement into the parts whose screen is still connected and those that must come back. */
export function reconcile(placement: Placement, screens: Screen[], main: string | null): { keep: Placement; back: Part[] } {
  const keep: Placement = {};
  const back: Part[] = [];
  for (const p of PARTS) {
    const on = placement[p];
    if (!on) continue;
    // A part on the main window's own screen belongs in the main window.
    if (screens.some((s) => s.name === on) && on !== main) keep[p] = on;
    else back.push(p);
  }
  return { keep, back };
}

/** Where to put each part for a set of screens: the layout remembered for it, if any still fits. */
export function layoutFor(saved: Record<string, Placement>, screens: Screen[], main: string | null): Placement {
  return reconcile(saved[setupKey(screens)] ?? {}, screens, main).keep;
}

const LAYOUTS = "mixit.screens";

export function loadLayouts(): Record<string, Placement> {
  try {
    return JSON.parse(localStorage.getItem(LAYOUTS) ?? "{}") as Record<string, Placement>;
  } catch {
    return {};
  }
}

function saveLayout(screens: Screen[], placement: Placement) {
  try {
    const all = loadLayouts();
    all[setupKey(screens)] = placement;
    localStorage.setItem(LAYOUTS, JSON.stringify(all));
  } catch {
    /* not remembered */
  }
}

// ------------------------------------------------------------------ live windows

/** The part this window shows, when it is a part's own window. */
export const thisPart: Part | null = (() => {
  try {
    const p = new URLSearchParams(window.location.search).get("part");
    return PARTS.includes(p as Part) ? (p as Part) : null;
  } catch {
    return null;
  }
})();

interface ScreensState {
  /** Windows can be opened (the desktop app). */
  supported: boolean;
  screens: Screen[];
  /** The screen the main window is on. */
  main: string | null;
  placement: Placement;
}

export const useScreens = create<ScreensState>(() => ({ supported: false, screens: [], main: null, placement: {} }));

/** The screens a part can move to: every screen but the one it is on. */
export function targetsFor(part: Part, s: ScreensState = useScreens.getState()): Screen[] {
  const on = s.placement[part] ?? s.main;
  return ordered(s.screens).filter((x) => x.name !== on);
}

/** Moves a part to a screen, or back into the main window (null, or the main window's screen). */
export async function movePart(part: Part, screen: Screen | null) {
  const b = backend();
  if (thisPart) {
    // Only the main window moves windows; a part window asks it to.
    b.broadcast?.({ kind: "move", part, screen: screen?.name ?? null });
    return;
  }
  const s = useScreens.getState();
  const placement = { ...s.placement };
  if (!screen || screen.name === s.main) {
    delete placement[part];
    useScreens.setState({ placement });
    await b.closePart?.(part);
  } else {
    placement[part] = screen.name;
    useScreens.setState({ placement });
    await b.openPart?.(part, screen);
  }
  saveLayout(s.screens, placement);
}

/** Moves a part to the screen under the pointer (after dragging it out of the window). */
export async function movePartToPointer(part: Part) {
  const at = await backend().screenAtPointer?.();
  if (!at) return;
  const s = useScreens.getState();
  const on = s.placement[part] ?? s.main;
  if (at.name !== on) await movePart(part, s.screens.find((x) => x.name === at.name) ?? at);
}

/** Reads the screens again and applies what changed: unplugged screens give their parts back, a known set of screens gets its layout. */
export async function refreshScreens(first = false) {
  const b = backend();
  if (!b.screens) return;
  const { screens, main } = await b.screens();
  if (thisPart) {
    // A part window only lists the screens for its menu; `main` is the screen it is on.
    useScreens.setState({ supported: true, screens, main: null, placement: main ? { [thisPart]: main } : {} });
    return;
  }
  const before = useScreens.getState();
  const changed = setupKey(screens) !== setupKey(before.screens);
  useScreens.setState({ supported: true, screens, main });
  if (!changed && !first) return;
  const { keep, back } = reconcile(before.placement, screens, main);
  for (const p of back) await b.closePart?.(p);
  // A set of screens seen before gets its layout back. The new layout (a preview) has one
  // window for now, so while it is on every part stays in the main window; the placement
  // saved for these screens is left alone and comes back when it is turned off.
  const want = newLayoutOn() ? {} : { ...keep, ...layoutFor(loadLayouts(), screens, main) };
  useScreens.setState({ placement: want });
  for (const p of PARTS) {
    const on = want[p];
    const sc = on ? screens.find((x) => x.name === on) : null;
    if (sc && (first || before.placement[p] !== on)) await b.openPart?.(p, sc);
    else if (!on && before.placement[p]) await b.closePart?.(p);
  }
}

/** Starts watching the screens; the main window also moves parts as they change. Returns a stop function. */
export function watchScreens(): () => void {
  const b = backend();
  if (!b.screens) return () => undefined;
  void refreshScreens(true).catch(() => undefined);
  if (thisPart) {
    const t = window.setInterval(() => void refreshScreens().catch(() => undefined), 5000);
    return () => window.clearInterval(t);
  }
  // The system has no "screen plugged in" event the app can hear, so look every two seconds.
  const timer = window.setInterval(() => void refreshScreens().catch(() => undefined), 2000);
  const offClosed = b.onPartClosed?.((part) => {
    const s = useScreens.getState();
    if (!s.placement[part as Part]) return;
    const placement = { ...s.placement };
    delete placement[part as Part];
    useScreens.setState({ placement });
    saveLayout(s.screens, placement);
  });
  const offBus = b.onBroadcast?.((m) => {
    if (m.kind !== "move") return;
    const s = useScreens.getState();
    void movePart(m.part as Part, m.screen ? (s.screens.find((x) => x.name === m.screen) ?? null) : null);
  });
  return () => {
    window.clearInterval(timer);
    offClosed?.();
    offBus?.();
  };
}
