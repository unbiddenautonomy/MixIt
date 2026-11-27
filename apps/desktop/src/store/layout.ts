// The layout the main window is drawn from, while the new layout is switched on
// (Settings > Display > New layout). Every change goes through `layoutAct`, which runs one
// operation from lib/layout/ops.ts and saves the result.
//
// In the desktop app the layout can have windows on other screens: the main window owns
// the layout, and store/layoutShare.ts opens the other windows and keeps them drawing the
// same one. A browser (or the app before it knows the screens) has one window, and
// normalise brings every part into it, whatever a saved layout says.
//
// Saving: a layout is kept for each set of screens (lib/layout/book.ts), through the
// backend, half a second after the last change. A quick copy goes into browser storage at
// the same moment, so quitting inside that half second (or a failed write) loses nothing:
// at the next start the copy saved last wins.
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../backend";
import { addPreset, emptyBook, lastUsed, newerOf, pickLayout, putLayout, readBook, removePreset, renamePreset, type Book } from "../lib/layout/book";
import { loadLayout } from "../lib/layout/check";
import { MAIN, isFolded, orderedScreens, placesOf, refOf, resolveScreen, setupKey, type Env, type Layout, type PageId, type ScreenRef, type UnitId } from "../lib/layout/model";
import { isRefusal, normalise, run, type Op } from "../lib/layout/ops";
import { migrateOld, serialise } from "../lib/layout/persist";
import { presetFor } from "../lib/layout/presets";
import { isMainWindow, layoutScreens, thisWin, useScreens } from "../lib/screens";
import { toolHooks, useApp, type ToolTab } from "./app";

/** Where the first preview kept its one layout; moved into the book once. */
export const OLD_LAYOUT_KEY = "mixit.layout.v1";
/** The quick copy of the book in browser storage. */
export const QUICK_KEY = "mixit.layouts.quick";
const SAVE_DELAY_MS = 500;
/** How long to wait at start for the list of screens before going on without it. */
const SCREENS_WAIT_MS = 1500;
/** How long the screens must stay the same before the layout follows them (macOS reports a wake one screen at a time). */
export const SETTLE_MS = 3000;

interface LayoutState {
  layout: Layout | null;
  /** Edit layout mode: parts are moved by dragging their tabs, and ⌘Z undoes layout steps. The main window decides it for every window. */
  editing: boolean;
  /** Steps that Undo and Redo can take in Edit layout mode. */
  canUndo: boolean;
  canRedo: boolean;
  /** The layouts saved under a name (the main window only). */
  presets: { id: string; name: string; setup: string }[];
  /** This window's layout area, in CSS pixels. */
  size: { w: number; h: number };
  /** The other windows' sizes, as they report them (the main window only). */
  sizes: Record<string, { w: number; h: number }>;
}

export const useLayout = create<LayoutState>(() => ({ layout: null, editing: false, canUndo: false, canRedo: false, presets: [], size: { w: 1280, h: 760 }, sizes: {} }));

/** This window's id in the layout. */
export const ME = thisWin ?? MAIN;

/** Windows can be opened on other screens: the desktop app, once it knows the screens. */
export function multiWindow(): boolean {
  try {
    return !!backend().winOpen && useScreens.getState().supported && useScreens.getState().screens.length > 0;
  } catch {
    return false;
  }
}

/** What the operations need to know: built from the settings, the screens and the windows' sizes. */
export function layoutEnv(): Env {
  const app = useApp.getState();
  const s = app.settings;
  const st = useLayout.getState();
  const multi = multiWindow();
  return {
    screens: multi ? layoutScreens() : [],
    sizes: { ...st.sizes, [ME]: st.size },
    mode: s?.viewMode === "pro" ? "pro" : "easy",
    decks: (s?.decks ?? 2) > 2 ? 4 : 2,
    controller: false,
    browser: !multi,
  };
}

/** The screen the main window is on, by the layout's name for it. */
export function mainScreenRef(env: Env = layoutEnv()) {
  const name = useScreens.getState().main;
  const s = name ? layoutScreens().find((_, i) => useScreens.getState().screens[i]?.name === name) : null;
  return s && env.screens.length ? refOf(env.screens, s) : null;
}

/** The built-in layout for these screens. */
function builtIn(env: Env): Layout {
  const main = mainScreenRef(env);
  return presetFor(env, { mainScreen: main?.name ?? null });
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
  return setupKey(layoutScreens());
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
  if (!first) {
    // A set of screens seen for the first time: with one window, keep what's showing; with
    // windows on screens, the built-in layout for them (the note after says where things went).
    const now = useLayout.getState().layout;
    return env.browser && now ? normalise(now, env) : builtIn(env);
  }
  const old = readQuick(OLD_LAYOUT_KEY);
  if (old) {
    const r = loadLayout(old, env);
    if (r.layout) return r.layout;
  }
  if (picked.problem) return builtIn(env);
  const app = useApp.getState();
  return migrateOld({ toolTab: readQuick("mixit.tools.tab"), toolSize: readQuick("mixit.tools.size"), libraryHeight: app.libraryHeight, windowHeight: window.innerHeight }, env);
}

/** A loaded layout opens on the page the top bar shows, not the one it was saved on. */
function onShownPage(layout: Layout): Layout {
  const page = useApp.getState().workspace as PageId;
  if (layout.windows[0].page === page) return layout;
  return { ...layout, windows: [{ ...layout.windows[0], page }, ...layout.windows.slice(1)] };
}

let starting: Promise<void> | null = null;

/** Loads the layouts when the new layout is switched on (the main window only). */
export function initLayout(): Promise<void> {
  if (!isMainWindow || useLayout.getState().layout) return Promise.resolve();
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
      layout = builtIn(layoutEnv());
    }
    useLayout.setState({ layout: onShownPage(layout) });
    showPresets();
    // Kept straight away, so the moved-across layout is what the next start finds.
    book = putLayout(book, setup, layout, Date.now());
    writeBook();
  })().finally(() => {
    starting = null;
    // The screens may have changed while loading.
    if (useScreens.getState().supported) screensChanged();
  });
  return starting;
}

let settleTimer = 0;
/** The screens are changing and the layout hasn't followed yet: moves the system makes to windows now aren't the person's. */
export const settling = () => settleTimer !== 0;

/** The screens changed: once they have stayed the same for a moment, the layout follows. */
function screensChanged() {
  if (!isMainWindow) return;
  window.clearTimeout(settleTimer);
  const key = setupKey(layoutScreens());
  if (key === setup) {
    settleTimer = 0;
    return;
  }
  // The waiting change belongs to the screens it was made on.
  flush();
  settleTimer = window.setTimeout(() => {
    settleTimer = 0;
    switchSetup(setupKey(layoutScreens()));
  }, SETTLE_MS);
}

/** A different set of screens: keeps what was there under the old one and brings back theirs. */
function switchSetup(key: string) {
  if (!isMainWindow || starting || key === setup || !useLayout.getState().layout) return;
  flush();
  // An older layout can point at a screen that's gone.
  forget();
  const seen = key in book.setups;
  setup = key;
  const before = useLayout.getState().layout;
  const env = layoutEnv();
  const layout = layoutFor(key, env, false);
  if (layout !== before) useLayout.setState({ layout: onShownPage(layout) });
  book = putLayout(book, setup, layout, Date.now());
  writeBook();
  if (!seen && !env.browser && env.screens.length > 1) tellWhereThingsWent(layout, env);
}

/** The first time a set of screens is seen: where the decks went, and a way to put them on another screen. */
function tellWhereThingsWent(layout: Layout, env: Env) {
  const list = orderedScreens(env.screens);
  const at = layout.windows[0].screen ?? mainScreenRef(env);
  const perf = at ? resolveScreen(env.screens, at) : null;
  if (!perf) return;
  const n = list.indexOf(perf) + 1;
  const other = list.find((s) => s !== perf);
  if (!other || !at) return;
  const b: ScreenRef = refOf(env.screens, other);
  toast.message(`The decks are on Screen ${n}, and the library is on Screen ${list.indexOf(other) + 1}.`, {
    description: "You can swap them now, or later from the ⋯ menu on any part.",
    duration: 15_000,
    action: { label: "Swap screens", onClick: () => layoutAct({ op: "swap", a: at, b, mainAt: mainScreenRef() }) },
  });
}

useScreens.subscribe((s, prev) => {
  if (s.screens !== prev.screens || s.supported !== prev.supported) screensChanged();
});

/** Runs one layout operation in the main window. Returns why it was turned down, or null. */
export function layoutRun(op: Op): string | null {
  const { layout } = useLayout.getState();
  if (!layout) return "The layout isn't ready yet.";
  let next;
  try {
    next = run(layout, layoutEnv(), op);
  } catch (e) {
    console.error("[layout] operation failed", op, e);
    return "That didn't work, so nothing changed.";
  }
  if (isRefusal(next)) return next.reason;
  // Many operations return a copy even when nothing changed; only a real change is drawn and saved.
  if (next !== layout && serialise(next) !== serialise(layout)) {
    // A window the system moved isn't a step to undo.
    if (useLayout.getState().editing && op.op !== "moved") remember(layout);
    useLayout.setState({ layout: next });
    save(next);
  }
  return null;
}

// ------------------------------------------------------------------ Edit layout mode

/** Layouts before each step taken in Edit layout mode, and those undone. */
let past: Layout[] = [];
let future: Layout[] = [];
const HISTORY = 50;

function remember(before: Layout) {
  past.push(before);
  if (past.length > HISTORY) past.shift();
  future = [];
  useLayout.setState({ canUndo: true, canRedo: false });
}

function forget() {
  past = [];
  future = [];
  useLayout.setState({ canUndo: false, canRedo: false });
}

/** Set by layoutShare: asks the main window to switch Edit layout mode or take a step. */
export const editHooks: { ask: ((m: { on: boolean } | { step: "undo" | "redo" }) => void) | null } = { ask: null };

/** Turns Edit layout mode on or off, for every window. Leaving it clears the steps to undo. */
export function setEditing(on: boolean) {
  if (!isMainWindow) return editHooks.ask?.({ on });
  if (useLayout.getState().editing === on) return;
  forget();
  useLayout.setState({ editing: on });
}

/** Undoes or redoes one step in Edit layout mode. */
export function editStep(step: "undo" | "redo") {
  if (!isMainWindow) return editHooks.ask?.({ step });
  const now = useLayout.getState().layout;
  const from = step === "undo" ? past : future;
  const to = step === "undo" ? future : past;
  const target = from.pop();
  if (!now || !target) return;
  to.push(now);
  const next = normalise(target, layoutEnv());
  useLayout.setState({ layout: next, canUndo: past.length > 0, canRedo: future.length > 0 });
  save(next);
}

// ------------------------------------------------------------------ saved layouts

function showPresets() {
  useLayout.setState({ presets: book.presets.map((p) => ({ id: p.id, name: p.name, setup: p.setup })) });
}

/** Saves the layout showing under a name. Returns why not, or null. */
export function savePreset(name: string): string | null {
  const layout = useLayout.getState().layout;
  if (!layout) return "The layout isn't ready yet.";
  if (readOnly) return "These layouts were made by a newer MixIt, so nothing can be saved here.";
  const next = addPreset(book, name, { ...layout, edited: false }, setup, Date.now());
  if ("full" in next) return "You have 20 saved layouts already. Delete one first.";
  book = next;
  writeBook();
  showPresets();
  return null;
}

export function deletePreset(id: string) {
  book = removePreset(book, id);
  writeBook();
  showPresets();
}

export function renameSavedPreset(id: string, name: string) {
  book = renamePreset(book, id, name);
  writeBook();
  showPresets();
}

/** Applies a saved layout (undoable). Parts meant for screens that aren't connected come to this window. */
export function applySavedPreset(id: string): string | null {
  const p = book.presets.find((x) => x.id === id);
  if (!p) return "That saved layout is gone.";
  const r = loadLayout(p.layout, layoutEnv());
  if (!r.layout) return "That saved layout couldn't be read.";
  const { why, token } = layoutChange({ op: "preset", layout: { ...r.layout, preset: p.id } });
  if (why) return why;
  if (token) offerUndo(`Switched to "${p.name}".`, () => layoutUndo(token));
  return null;
}

/** Applies the built-in layout for these screens (undoable). */
export function applyStandard() {
  const { why, token } = layoutChange({ op: "preset", layout: builtIn(layoutEnv()) });
  if (why) toast.message(why);
  else if (token) offerUndo("Switched to the standard layout.", () => layoutUndo(token));
}

/** Runs one layout operation. A refusal is shown in plain words and changes nothing. */
export function layoutAct(op: Op): boolean {
  const why = layoutRun(op);
  if (why) toast.message(why);
  return !why;
}

/** Hands an operation to whoever owns the layout: run here in the main window, asked for from any other. */
export const layoutHooks: { ask: ((op: Op, note?: string) => void) | null } = { ask: null };
export function layoutDo(op: Op) {
  if (isMainWindow) layoutAct(op);
  else layoutHooks.ask?.(op);
}

// ------------------------------------------------------------------ undo

/** Changes that can be undone, newest last: what the layout was before and became after. */
const undos = new Map<string, { before: Layout; after: string }>();
let undoCount = 0;
const UNDO_KEEP = 10;
/** The layout without where its windows sit on their screens: the system moving a new window into place isn't a change that blocks undo. */
const shape = (l: Layout) => serialise({ ...l, windows: l.windows.map((w) => ({ ...w, bounds: "full", fullscreen: false })) });

/** Runs an operation that the person can undo (a send, a new window, a swap). Returns why not, or a token for `layoutUndo`. */
export function layoutChange(op: Op): { why: string | null; token: string | null } {
  const before = useLayout.getState().layout;
  const why = layoutRun(op);
  const after = useLayout.getState().layout;
  if (why || !before || !after || after === before) return { why, token: null };
  const token = `u${++undoCount}`;
  undos.set(token, { before, after: shape(after) });
  while (undos.size > UNDO_KEEP) undos.delete(undos.keys().next().value!);
  return { why: null, token };
}

/** Puts the layout back as it was before a change. Refused once anything else has changed since. */
export function layoutUndo(token: string): string | null {
  const u = undos.get(token);
  const now = useLayout.getState().layout;
  if (!u || !now) return "That can't be undone any more.";
  if (shape(now) !== u.after) return "The layout has changed since, so that can't be undone.";
  undos.delete(token);
  const back = normalise(u.before, layoutEnv());
  useLayout.setState({ layout: back });
  save(back);
  return null;
}

/** An undoable change from a menu, wherever it was clicked: shows `note` with Undo for a few seconds. */
export function layoutDoUndoable(op: Op, note: string) {
  if (!isMainWindow) return layoutHooks.ask?.(op, note);
  const { why, token } = layoutChange(op);
  if (why) toast.message(why);
  else if (token) offerUndo(note, () => layoutUndo(token));
}

export function offerUndo(note: string, undo: () => string | null | void) {
  toast.message(note, {
    duration: 6000,
    action: {
      label: "Undo",
      onClick: () => {
        const why = undo();
        if (why) toast.message(why);
      },
    },
  });
}

/** Back to the built-in layout. */
export function resetLayout() {
  const next = builtIn(layoutEnv());
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
  // Only the main window changes the layout; the others get the result.
  if (!isMainWindow) return;
  if (!s.settings?.layoutEngine && prev.settings?.layoutEngine) setEditing(false);
  if (s.settings?.decks === prev.settings?.decks && s.settings?.viewMode === prev.settings?.viewMode) return;
  const { layout } = useLayout.getState();
  if (!layout) return;
  const next = normalise(layout, layoutEnv());
  if (serialise(next) !== serialise(layout)) {
    useLayout.setState({ layout: next });
    save(next);
  }
});

// The main window's page can be changed from another window (a tool opened there): the top bar follows.
useLayout.subscribe((s, prev) => {
  if (!isMainWindow || !s.layout || s.layout === prev.layout) return;
  const page = s.layout.windows[0].page;
  if (page !== prev.layout?.windows[0].page && useApp.getState().workspace !== page) useApp.getState().set({ workspace: page });
});

// Save straight away when the window closes, rather than lose the last half second.
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", () => {
    if (pending) flush();
  });

const TOOL_UNIT: Record<ToolTab, UnitId> = { pads: "tool.pads", steps: "tool.steps", effects: "tool.effects", inputs: "tool.mic", recording: "tool.record" };

// The Pads button, the palette and shortcuts open tools through openTool; with the new
// layout on, that shows the tool's part (its tab, opened if folded), in this window if it
// is here, else wherever it is.
toolHooks.open = (tab, toggle) => {
  const app = useApp.getState();
  const { layout } = useLayout.getState();
  if (!app.settings?.layoutEngine || !layout) return false;
  const unit = TOOL_UNIT[tab];
  const places = placesOf(layout, unit);
  const where = places.find((f) => f.win.id === ME && f.page === "mix") ?? places.find((f) => f.win.id === ME) ?? places.find((f) => f.page === "mix") ?? places[0];
  if (!where) return false;
  const env = layoutEnv();
  const ownPage = where.win.id === MAIN && isMainWindow ? app.workspace : where.win.page;
  const showing = ownPage === where.page && where.stack.units[where.stack.active] === where.place && !isFolded(where.place, env.controller);
  const at = { win: where.win.id, page: where.page };
  if (toggle && showing) layoutDo({ op: "fold", unit, folded: true, where: at });
  else {
    layoutDo({ op: "activate", unit, where: at });
    layoutDo({ op: "fold", unit, folded: false, where: at });
    if (ownPage !== where.page) {
      if (where.win.id === MAIN && isMainWindow) app.set({ workspace: where.page });
      else layoutDo({ op: "page", win: where.win.id, page: where.page });
    }
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
