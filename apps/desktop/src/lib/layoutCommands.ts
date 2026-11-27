// The layout's commands for the registry and Ask MixIt: Edit layout, playing with a DJ
// controller, the standard layout, and moving one part to another screen, into a new
// window, back home or folded away. Each says in plain words why when it can't.
import { toast } from "sonner";
import { MAIN, MAX_WINDOWS, isFolded, orderedScreens, placesOf, refOf, resolveScreen, type Env, type ScreenInfo, type UnitId } from "./layout/model";
import { UNITS } from "./layout/units";
import { screenName, windowLabel } from "./layout/windows";
import { isMainWindow } from "./screens";
import { applyStandard, layoutDo, layoutDoUndoable, layoutEnv, mainScreenRef, multiWindow, setEditing, useLayout } from "../store/layout";
import { useApp } from "../store/app";
import { updateSettings } from "./appCommands";
import { runInMain } from "./windowSync";

const layoutOn = () => !!useApp.getState().settings?.layoutEngine;

/** True when the new layout is on; otherwise says so, with a button that turns it on and then does `then`. */
function needLayout(what: string, then: () => void): boolean {
  if (layoutOn()) return true;
  toast.message(`${what} is part of the new layout.`, {
    description: "It's a preview for now: Settings > Display > New layout.",
    action: {
      label: "Turn it on",
      onClick: () => {
        void updateSettings({ layoutEngine: true }).then(() => window.setTimeout(then, 0));
      },
    },
  });
  return false;
}

/** Edit layout mode on or off (`on` left out: the other way). */
export function editLayout(on?: boolean) {
  const want = on ?? !useLayout.getState().editing;
  if (want && !needLayout("Edit layout", () => setEditing(true))) return;
  setEditing(want);
}

/** Says whether a DJ controller is plugged in (MixIt can't tell by itself yet). */
export function setController(on?: boolean) {
  const s = useApp.getState().settings;
  if (!s) return;
  const want = on ?? !s.controllerConnected;
  if (want === !!s.controllerConnected) {
    toast.message(want ? "MixIt already knows you're playing with a DJ controller." : "MixIt already knows there's no DJ controller.");
    return;
  }
  void updateSettings({ controllerConnected: want });
  if (!layoutOn()) return;
  toast.message(want ? "Playing with a DJ controller" : "Playing without a DJ controller", {
    description: want
      ? "The mixer folds away, since your controller has its knobs. Open it with its arrow if you want it on screen too; MixIt remembers that for next time."
      : "The mixer is back on screen. What you fold now is kept apart from what you fold while the controller is plugged in.",
  });
}

/** The built-in layout for these screens, with Undo. */
export function standardLayout() {
  if (!needLayout("The standard layout", standardLayout)) return;
  if (!isMainWindow) return runInMain("app.layout_standard");
  applyStandard();
}

const nameOf = (unit: UnitId) => UNITS[unit].name;
const lower = (unit: UnitId) => (/^Deck [A-D]$/.test(nameOf(unit)) ? nameOf(unit) : nameOf(unit).toLowerCase());
const the = (unit: UnitId) => (/^Deck [A-D]$/.test(nameOf(unit)) ? nameOf(unit) : `the ${lower(unit)}`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Why moving parts between screens can't happen here, or null when it can. */
function screensProblem(): string | null {
  if (!multiWindow()) return "Parts can go on other screens in the MixIt app. Here there is one window.";
  if (layoutEnv().screens.length < 2) return "MixIt sees one screen. Plug in another, then try again.";
  return null;
}

/** The screen a window is on now (the main window: wherever the system put it), as one of `env.screens`. */
function screenOfWin(winId: string, env: Env): ScreenInfo | null {
  const { layout } = useLayout.getState();
  const w = layout?.windows.find((x) => x.id === winId);
  const ref = w?.screen ?? (winId === MAIN ? mainScreenRef(env) : null);
  return ref ? resolveScreen(env.screens, ref) : null;
}

/** Sends a part to a screen it isn't on: into the window there, or a new one. */
export function sendToOtherScreen(unit: UnitId) {
  if (!needLayout("Moving parts between screens", () => sendToOtherScreen(unit))) return;
  const why = screensProblem();
  if (why) return void toast.message(why);
  const { layout } = useLayout.getState();
  const env = layoutEnv();
  const at = layout && placesOf(layout, unit)[0];
  if (!layout || !at) return void toast.message(`${cap(the(unit))} isn't showing anywhere. Open it first, then move it.`);
  const here = screenOfWin(at.win.id, env);
  const target = orderedScreens(env.screens).find((s) => s !== here);
  if (!target) return void toast.message("MixIt sees one screen. Plug in another, then try again.");
  const there = layout.windows.find((w) => w.id !== at.win.id && screenOfWin(w.id, env) === target);
  const where = screenName(env.screens, target);
  if (there) {
    const away = !placesOf(layout, unit).some((f) => f.win.id === MAIN);
    layoutDoUndoable(there.id === MAIN && away ? { op: "home", unit } : { op: "send", unit, win: there.id }, `${cap(the(unit))} moved to ${windowLabel(layout, there.id, env.screens)} on ${where}.`);
  } else if (layout.windows.length >= MAX_WINDOWS) {
    toast.message(`MixIt can have up to ${MAX_WINDOWS} windows. Close one first, or send ${the(unit)} to one that's open from its ⋯ menu.`);
  } else layoutDoUndoable({ op: "newWindow", unit, screen: refOf(env.screens, target) }, `${cap(the(unit))} opened in a new window on ${where}.`);
}

/** Opens a part in a new window: on another screen when there is one, else on this one. */
export function openInNewWindow(unit: UnitId) {
  if (!needLayout("Opening parts in their own window", () => openInNewWindow(unit))) return;
  if (!multiWindow()) return void toast.message("Parts can open in their own window in the MixIt app. Here there is one window.");
  const { layout } = useLayout.getState();
  const env = layoutEnv();
  const at = layout && placesOf(layout, unit)[0];
  if (!layout || !at) return void toast.message(`${cap(the(unit))} isn't showing anywhere. Open it first, then move it.`);
  if (layout.windows.length >= MAX_WINDOWS) return void toast.message(`MixIt can have up to ${MAX_WINDOWS} windows. Close one first.`);
  const here = screenOfWin(at.win.id, env);
  const screens = orderedScreens(env.screens);
  const target = screens.find((s) => s !== here) ?? here ?? screens[0];
  if (!target) return void toast.message("MixIt doesn't know the screens yet. Try again in a moment.");
  layoutDoUndoable({ op: "newWindow", unit, screen: refOf(env.screens, target) }, `${cap(the(unit))} opened in a new window on ${screenName(env.screens, target)}.`);
}

/** Brings a part back to the main window, where it started. */
export function bringHome(unit: UnitId) {
  if (!needLayout("Moving parts between windows", () => bringHome(unit))) return;
  const { layout } = useLayout.getState();
  if (!layout) return;
  const places = placesOf(layout, unit);
  if (!places.length) return void toast.message(`${cap(the(unit))} isn't showing anywhere. Open it from its button.`);
  const inMain = places.find((f) => f.win.id === MAIN);
  if (inMain) {
    // Already home: "bring it back" then means open it, if it's folded away.
    if (isFolded(inMain.place, layoutEnv().controller)) return foldPart(unit, false);
    return void toast.message(`${cap(the(unit))} is already in the main window.`);
  }
  layoutDoUndoable({ op: "home", unit }, `${cap(the(unit))} is back in the main window.`);
}

/** Folds a part down to its name bar, or opens it again. */
export function foldPart(unit: UnitId, folded: boolean) {
  if (!needLayout("Folding parts away", () => foldPart(unit, folded))) return;
  const { layout } = useLayout.getState();
  if (!layout) return;
  const env = layoutEnv();
  const at = placesOf(layout, unit)[0];
  if (!at) return void toast.message(`${cap(the(unit))} isn't showing anywhere${folded ? ", so there's nothing to fold" : ". Open it from its button"}.`);
  if (isFolded(at.place, env.controller) === folded) return void toast.message(`${cap(the(unit))} is already ${folded ? "folded away" : "open"}.`);
  layoutDo({ op: "fold", unit, folded, where: { win: at.win.id, page: at.page } });
}
