// The layout the main window is drawn from, while the new layout is switched on
// (Settings > Display > New layout). Every change goes through `layoutAct`, which runs one
// operation from lib/layout/ops.ts and saves the result.
//
// For now the layout has one window: parts can be folded, resized and switched between
// tabs, but not yet sent to other screens. The environment says "one window" (`browser`),
// so normalise brings every part into the main window, whatever a saved layout says.
//
// Saving: a layout is kept for each set of screens (lib/layout/book.ts), through the
// backend, half a second after the last change. A quick copy goes into browser storage at
// the same moment, so quitting inside that half second (or a failed write) loses nothing:
// at the next start the copy saved last wins.
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../backend";
import { emptyBook, lastUsed, newerOf, pickLayout, putLayout, readBook, type Book } from "../lib/layout/book";
import { loadLayout } from "../lib/layout/check";
import { MAIN, isFolded, placesOf, setupKey, type Env, type Layout, type PageId, type UnitId } from "../lib/layout/model";
import { isRefusal, normalise, run, type Op } from "../lib/layout/ops";
import { migrateOld, serialise } from "../lib/layout/persist";
import { presetFor } from "../lib/layout/presets";
import { thisPart, useScreens } from "../lib/screens";
import { toolHooks, useApp, type ToolTab } from "./app";

/** Where the first preview kept its one layout; moved into the book once. */
export const OLD_LAYOUT_KEY = "mixit.layout.v1";
/** The quick copy of the book in browser storage. */
export const QUICK_KEY = "mixit.layouts.quick";
const SAVE_DELAY_MS = 500;
/** How long to wait at start for the list of screens before going on without it. */
const SCREENS_WAIT_MS = 1500;

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

// ------------------------------------------------------------------ saving

let book: Book = emptyBook();
/** The set of screens the layout showing belongs to. */
let setup = "";
/** The saved layouts came from a newer MixIt: use them, never write over them. */
let readOnly = false;
let pending: Layout | null = null;
let saveTimer = 0;
let writing: Promise<void> = Promise.resolve();
let warned = false;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function save(layout: Layout) {
  pending = layout;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, SAVE_DELAY_MS);
}

/** Writes a waiting change now, under the screens it was made for. */
function flush() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  const layout = pending;
  pending = null;
  if (!layout) return;
  book = putLayout(book, setup, layout, Date.now());
  writeBook();
}

function writeBook() {
  if (readOnly) return;
  const text = serialise(book);
  try {
    storage()?.setItem(QUICK_KEY, text);
  } catch {
    /* the library copy is enough */
  }
  // One write at a time, in order, so an older layout can never land after a newer one.
  writing = writing
    .then(() => backend().layoutsSave(text))
    .catch(() => {
      if (warned) return;
      warned = true;
      toast.warning("MixIt couldn't save your layout. Your changes stay until you close MixIt.");
    });
}

function readQuick(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The screens' key once they are known (the desktop app), or "" (a browser, or no answer in time). */
async function screensKey(): Promise<string> {
  if (!backend().screens) return "";
  if (!useScreens.getState().supported)
    await new Promise<void>((done) => {
      const t = window.setTimeout(finish, SCREENS_WAIT_MS);
      const off = useScreens.subscribe((s) => s.supported && finish());
      function finish() {
        window.clearTimeout(t);
        off();
        done();
      }
    });
  return setupKey(useScreens.getState().screens);
}

/**
 * The layout to start with, for these screens: the one saved for them if it loads; else
 * the one used last with other screens; else the first preview's layout or today's
 * settings moved across; else the built-in one.
 */
function layoutFor(key: string, env: Env, first: boolean): Layout {
  const picked = pickLayout(book, key, env);
  book = picked.book;
  if (picked.layout) return picked.layout;
  if (picked.problem === "bad") toast.warning("Your saved layout for these screens couldn't be loaded. MixIt kept a copy and opened another one.");
  const other = lastUsed(book, key);
  if (other) {
    const r = pickLayout(book, other, env);
    book = r.book;
    if (r.layout) return r.layout;
  }
  if (!first) return useLayout.getState().layout ?? presetFor(env);
  const old = readQuick(OLD_LAYOUT_KEY);
  if (old) {
    const r = loadLayout(old, env);
    if (r.layout) return r.layout;
  }
  if (picked.problem) return presetFor(env);
  const app = useApp.getState();
  return migrateOld({ toolTab: readQuick("mixit.tools.tab"), toolSize: readQuick("mixit.tools.size"), libraryHeight: app.libraryHeight, windowHeight: window.innerHeight }, env);
}

let starting: Promise<void> | null = null;

/** Loads the layouts when the new layout is switched on (the main window only). */
export function initLayout(): Promise<void> {
  if (thisPart || useLayout.getState().layout) return Promise.resolve();
  starting ??= (async () => {
    const [text, key] = await Promise.all([backend().layoutsLoad().catch(() => null), screensKey()]);
    const lib = readBook(text);
    const r = newerOf(lib, readBook(readQuick(QUICK_KEY)));
    book = r.book;
    readOnly = r.problem === "newer";
    if (readOnly) toast.message("These layouts were made by a newer MixIt. You can change the layout, but it won't be saved.");
    else if (r.problem === "bad") toast.warning("Your saved layouts couldn't be read. MixIt kept a copy and opened the standard one.");
    if (!readOnly && lib.problem === "bad" && text) {
      // Kept in this browser's storage too: an unreadable book could be too large to keep in itself.
      try {
        storage()?.setItem(`${QUICK_KEY}.bad-${Date.now()}`, text);
      } catch {
        /* the copy inside the book is all there is */
      }
    }
    setup = key;
    let layout: Layout;
    try {
      layout = layoutFor(key, layoutEnv(), true);
    } catch {
      // Never a blank window: whatever went wrong, the built-in layout works.
      layout = presetFor(layoutEnv());
    }
    useLayout.setState({ layout });
    // Kept straight away, so the moved-across layout is what the next start finds.
    book = putLayout(book, setup, layout, Date.now());
    writeBook();
  })().finally(() => {
    starting = null;
    // The screens may have changed while loading.
    const s = useScreens.getState();
    if (s.supported) switchSetup(setupKey(s.screens));
  });
  return starting;
}

/** A different set of screens: keeps what was there under the old one and brings back theirs. */
function switchSetup(key: string) {
  if (thisPart || starting || key === setup || !useLayout.getState().layout) return;
  flush();
  setup = key;
  const before = useLayout.getState().layout;
  const layout = layoutFor(key, layoutEnv(), false);
  if (layout !== before) useLayout.setState({ layout });
  book = putLayout(book, setup, layout, Date.now());
  writeBook();
}

useScreens.subscribe((s, prev) => {
  if (s.screens !== prev.screens) switchSetup(setupKey(s.screens));
});

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
  save(next);
  flush();
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
    if (pending) flush();
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
