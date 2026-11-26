// The layout the main window is drawn from, while the new layout is switched on
// (Settings > Display > New layout). Every change goes through `layoutAct`, which runs one
// operation from lib/layout/ops.ts and saves the result.
//
// For now the layout has one window: parts can be folded, resized and switched between
// tabs, but not yet sent to other screens. The environment says "one window" (`browser`),
// so normalise brings every part into the main window, whatever a saved layout says.
import { toast } from "sonner";
import { create } from "zustand";
import { loadLayout } from "../lib/layout/check";
import { MAIN, isFolded, placesOf, type Env, type Layout, type PageId, type UnitId } from "../lib/layout/model";
import { isRefusal, normalise, run, type Op } from "../lib/layout/ops";
import { migrateOld, serialise } from "../lib/layout/persist";
import { presetFor } from "../lib/layout/presets";
import { toolHooks, useApp, type ToolTab } from "./app";

/** Where the layout is kept until saving moves into the library's settings file. */
export const LAYOUT_KEY = "mixit.layout.v1";
const SAVE_DELAY_MS = 500;

interface LayoutState {
  layout: Layout | null;
  /** The main window's layout area, in CSS pixels. */
  size: { w: number; h: number };
}

export const useLayout = create<LayoutState>(() => ({ layout: null, size: { w: 1280, h: 760 } }));

/** What the operations need to know: built from the settings and the window's size. */
export function layoutEnv(): Env {
  const app = useApp.getState();
  const s = app.settings;
  return {
    screens: [],
    sizes: { [MAIN]: useLayout.getState().size },
    mode: s?.viewMode === "pro" ? "pro" : "easy",
    decks: (s?.decks ?? 2) > 2 ? 4 : 2,
    controller: false,
    // One window for now (see the note at the top).
    browser: true,
  };
}

let saveTimer = 0;
function save(layout: Layout) {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveNow(layout), SAVE_DELAY_MS);
}

function saveNow(layout: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, serialise(layout));
  } catch {
    /* not remembered: storage full or blocked */
  }
}

function readOld(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The layout to start with: the saved one if it loads, else today's settings moved
 * across, else the built-in one. A saved layout that can't be read is set aside, not
 * overwritten, so nothing is lost while we find out why.
 */
export function startLayout(): Layout {
  const env = layoutEnv();
  const text = readOld(LAYOUT_KEY);
  if (text) {
    const r = loadLayout(text, env);
    if (r.layout) return r.layout;
    try {
      localStorage.setItem(`${LAYOUT_KEY}.bad-${Date.now()}`, text);
    } catch {
      /* not kept */
    }
    if (r.problem === "newer") toast.message("This layout was made by a newer MixIt, so the standard one is showing.");
    else toast.warning("Your layout couldn't be loaded, so MixIt opened the standard one.");
    return presetFor(env);
  }
  const app = useApp.getState();
  return migrateOld({ toolTab: readOld("mixit.tools.tab"), toolSize: readOld("mixit.tools.size"), libraryHeight: app.libraryHeight, windowHeight: window.innerHeight }, env);
}

/** Loads the layout when the new layout is switched on. */
export function initLayout() {
  if (!useLayout.getState().layout) useLayout.setState({ layout: startLayout() });
}

/** Runs one layout operation. A refusal is shown in plain words and changes nothing. */
export function layoutAct(op: Op): boolean {
  const { layout } = useLayout.getState();
  if (!layout) return false;
  const next = run(layout, layoutEnv(), op);
  if (isRefusal(next)) {
    toast.message(next.reason);
    return false;
  }
  if (next !== layout) {
    useLayout.setState({ layout: next });
    save(next);
  }
  return true;
}

/** Back to the built-in layout. */
export function resetLayout() {
  const next = presetFor(layoutEnv());
  useLayout.setState({ layout: next });
  saveNow(next);
}

/** The layout area changed size. Only the size changes: folds made to fit are worked out when drawing. */
export function setLayoutSize(w: number, h: number) {
  const { size } = useLayout.getState();
  if (Math.abs(size.w - w) < 1 && Math.abs(size.h - h) < 1) return;
  useLayout.setState({ size: { w, h } });
}

/** Keeps the saved page in step with the workspace tabs in the top bar. */
export function showLayoutPage(page: PageId) {
  const { layout } = useLayout.getState();
  if (layout && layout.windows[0].page !== page) layoutAct({ op: "page", win: MAIN, page });
}

// Two or four decks, or Easy and Pro, change what is required and how big things must be.
useApp.subscribe((s, prev) => {
  if (s.settings?.decks === prev.settings?.decks && s.settings?.viewMode === prev.settings?.viewMode) return;
  const { layout } = useLayout.getState();
  if (!layout) return;
  const next = normalise(layout, layoutEnv());
  if (serialise(next) !== serialise(layout)) {
    useLayout.setState({ layout: next });
    save(next);
  }
});

// Save straight away when the window closes, rather than lose the last half second.
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", () => {
    const { layout } = useLayout.getState();
    if (layout && saveTimer) saveNow(layout);
  });

const TOOL_UNIT: Record<ToolTab, UnitId> = { pads: "tool.pads", steps: "tool.steps", effects: "tool.effects", inputs: "tool.mic", recording: "tool.record" };

// The Pads button, the palette and shortcuts open tools through openTool; with the new
// layout on, that shows the tool's part (its tab, opened if folded) on the Mix page.
toolHooks.open = (tab, toggle) => {
  const app = useApp.getState();
  const { layout } = useLayout.getState();
  if (!app.settings?.layoutEngine || !layout) return false;
  const unit = TOOL_UNIT[tab];
  const where = placesOf(layout, unit).find((f) => f.win.id === MAIN && f.page === "mix") ?? placesOf(layout, unit).find((f) => f.win.id === MAIN);
  if (!where) return false;
  const env = layoutEnv();
  const showing = app.workspace === where.page && where.stack.units[where.stack.active] === where.place && !isFolded(where.place, env.controller);
  const at = { win: MAIN, page: where.page };
  if (toggle && showing) layoutAct({ op: "fold", unit, folded: true, where: at });
  else {
    layoutAct({ op: "activate", unit, where: at });
    layoutAct({ op: "fold", unit, folded: false, where: at });
    if (app.workspace !== where.page) app.set({ workspace: where.page });
  }
  // Remembered as today, so turning the new layout off keeps the last tool.
  try {
    localStorage.setItem("mixit.tools.tab", tab);
  } catch {
    /* not remembered */
  }
  useApp.getState().set({ toolTab: tab });
  return true;
};
