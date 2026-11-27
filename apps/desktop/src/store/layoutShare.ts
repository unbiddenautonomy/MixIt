// The new layout across windows (desktop app). The main window owns the layout: it opens,
// moves and closes the other windows to match it, and sends the whole layout, numbered, to
// every window each time it changes. Another window draws only a layout numbered higher than
// the last one it drew, and never changes its copy: it asks the main window (an intent),
// which checks the request against the layout as it is then. See lib/layout/sync.ts.
//
// The person moving or closing a window changes the layout too: a moved window remembers
// its new screen and place, and a closed one sends its parts back to the main window.
import { toast } from "sonner";
import { backend } from "../backend";
import type { WinReport, WindowMessage } from "../backend/types";
import { MAIN, findWin, resolveScreen, setupKey, type Layout } from "../lib/layout/model";
import type { Op } from "../lib/layout/ops";
import { isObj } from "../lib/layout/persist";
import { LayoutFeed } from "../lib/layout/sync";
import { fromReport, placeOn, windowChanges, windowNumber, windowPlan, type WinSpec } from "../lib/layout/windows";
import { isMainWindow, layoutScreens, refreshScreens, useScreens } from "../lib/screens";
import { useApp } from "./app";
import { ME, layoutChange, layoutHooks, layoutRun, layoutUndo, mainScreenRef, multiWindow, offerUndo, settling, useLayout } from "./layout";

/** How long a moved window must stay put before its new place is kept. */
const MOVE_SETTLE_MS = 400;
/** A layout window asks again this often while the main window hasn't answered. */
export const HELLO_RETRY_MS = 5000;

const engineOn = () => !!useApp.getState().settings?.layoutEngine;
const isOp = (x: unknown): x is Op => isObj(x) && typeof x.op === "string";

// ------------------------------------------------------------------ the main window

/** The real windows: which are open, and where each was last put or last seen. */
const open = new Set<string>();
const last = new Map<string, WinSpec>();
/** Windows MixIt is closing itself, so their closing isn't taken for the person's. */
const closing = new Set<string>();
let mainPlaced = "";
let busy = false;
let again = false;

/** Makes the real windows match the layout. One pass at a time; a change during a pass runs another. */
export async function reconcileWindows(): Promise<void> {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    do {
      again = false;
      await reconcileOnce();
    } while (again);
  } finally {
    busy = false;
  }
}

async function reconcileOnce() {
  const b = backend();
  if (!b.winOpen || !b.winClose) return;
  const layout = useLayout.getState().layout;
  const on = engineOn() && !!layout && multiWindow();
  const screens = layoutScreens();
  const want = on && layout ? windowPlan(layout, screens) : [];
  const ch = windowChanges(want, open, last);
  for (const id of ch.close) {
    closing.add(id);
    open.delete(id);
    last.delete(id);
    await b.winClose(id).catch(() => closing.delete(id));
  }
  for (const w of [...ch.open, ...ch.move]) {
    try {
      await b.winOpen(w.id, w.title, w.place);
      open.add(w.id);
      last.set(w.id, w);
    } catch (e) {
      console.error("[layout] window failed to open", w.id, e);
      // Its parts come back rather than vanish.
      if (findWin(useLayout.getState().layout!, w.id)) {
        layoutRun({ op: "close", win: w.id });
        toast.warning(`Window ${windowNumber(w.id)} couldn't open, so its parts are back in this window.`);
      }
    }
  }
  for (const w of ch.retitle) {
    await b.winTitle?.(w.id, w.title).catch(() => undefined);
    last.set(w.id, w);
  }
  // The main window goes to the screen the layout puts it on, once per change of that screen.
  const main = layout?.windows[0];
  const ref = on && main?.screen ? main.screen : null;
  const key = ref ? JSON.stringify(ref) : "";
  if (key !== mainPlaced) {
    mainPlaced = key;
    const s = ref ? resolveScreen(screens, ref) : null;
    const nowOn = useScreens.getState().main;
    const rawNow = useScreens.getState().screens.find((x) => x.name === nowOn);
    const already = s && rawNow && rawNow.x === s.x && rawNow.y === s.y;
    if (s && main && !already) await b.winOpen("main", "", placeOn(s, main.bounds, main.fullscreen)).catch(() => undefined);
  }
}

const moveTimers = new Map<string, number>();

/** The person moved or resized a window: once it stays put, the layout remembers where. */
function moved(r: WinReport) {
  window.clearTimeout(moveTimers.get(r.id));
  moveTimers.set(
    r.id,
    window.setTimeout(() => {
      moveTimers.delete(r.id);
      void keepMove(r);
    }, MOVE_SETTLE_MS),
  );
}

async function keepMove(r: WinReport) {
  if (!engineOn() || !multiWindow() || settling()) return;
  // A screen unplugged moves its windows by itself: that isn't the person's move, and the
  // layout for the old screens must keep them where they were.
  const before = setupKey(layoutScreens());
  await refreshScreens().catch(() => undefined);
  if (setupKey(layoutScreens()) !== before || settling()) return;
  const f = fromReport(layoutScreens(), r);
  if (!f) return;
  if (r.id !== MAIN) {
    const spec = last.get(r.id);
    if (spec) last.set(r.id, { ...spec, place: placeOn(f.screen, f.bounds, f.fullscreen) });
  } else mainPlaced = "";
  layoutRun({ op: "moved", win: r.id, screen: f.screen, bounds: f.bounds, fullscreen: f.fullscreen });
  if (r.id === MAIN) {
    const l = useLayout.getState().layout;
    mainPlaced = l?.windows[0].screen ? JSON.stringify(l.windows[0].screen) : "";
  }
}

/** The person closed a window (its red button): its parts go home, and it stays closed. */
function closed(id: string) {
  open.delete(id);
  last.delete(id);
  if (closing.delete(id)) return;
  const l = useLayout.getState().layout;
  if (l && findWin(l, id)) layoutRun({ op: "close", win: id });
}

function startMain(): () => void {
  const b = backend();
  const send = (m: WindowMessage) => b.broadcast?.(m);
  let seq = 0;
  const announce = (fresh: boolean) => {
    const layout = useLayout.getState().layout;
    if (!layout) return;
    if (fresh) seq++;
    send({ kind: "layout", seq, layout });
  };
  // After a reload the windows already open are adopted, then moved or closed to match.
  const adopted = (b.winList?.() ?? Promise.resolve([]))
    .then((ids) => ids.forEach((id) => open.add(id)))
    .catch(() => undefined)
    .then(() => reconcileWindows());

  const offs = [
    useLayout.subscribe((s, prev) => {
      if (s.layout === prev.layout) return;
      announce(true);
      void adopted.then(() => reconcileWindows());
    }),
    useApp.subscribe((s, prev) => {
      if (!!s.settings?.layoutEngine !== !!prev.settings?.layoutEngine) void adopted.then(() => reconcileWindows());
    }),
    useScreens.subscribe((s, prev) => {
      if (s.screens !== prev.screens || s.supported !== prev.supported) void adopted.then(() => reconcileWindows());
    }),
    b.onBroadcast?.((m) => {
      if (m.kind === "layout-hello") announce(false);
      else if (m.kind === "layout-intent") {
        const l = useLayout.getState().layout;
        if (!l || !findWin(l, m.from)) return;
        let op = isOp(m.op) ? m.op : null;
        // Another window doesn't know which screen this one is on.
        if (op?.op === "swap" && !op.mainAt) op = { ...op, mainAt: mainScreenRef() };
        if (!op) send({ kind: "layout-refused", id: m.id, to: m.from, reason: "MixIt didn't understand that." });
        else if (m.undo) {
          const { why, token } = layoutChange(op);
          if (why) send({ kind: "layout-refused", id: m.id, to: m.from, reason: why });
          else if (token) send({ kind: "layout-done", id: m.id, to: m.from, token });
        } else {
          const why = layoutRun(op);
          if (why) send({ kind: "layout-refused", id: m.id, to: m.from, reason: why });
        }
      } else if (m.kind === "layout-undo") {
        const why = layoutUndo(m.token);
        if (why) send({ kind: "layout-refused", id: m.token, to: m.from, reason: why });
      } else if (m.kind === "layout-size") {
        if (typeof m.win !== "string" || !Number.isFinite(m.w) || !Number.isFinite(m.h) || m.w <= 0 || m.h <= 0) return;
        const sizes = { ...useLayout.getState().sizes, [m.win]: { w: Math.min(m.w, 20000), h: Math.min(m.h, 20000) } };
        useLayout.setState({ sizes });
      }
    }),
    b.onWinClosed?.(closed),
    b.onWinMoved?.(moved),
  ];
  return () => {
    offs.forEach((f) => f?.());
    moveTimers.forEach((t) => window.clearTimeout(t));
    moveTimers.clear();
  };
}

// ------------------------------------------------------------------ another window

/** Units that move every frame (playheads, meters, levels). A window with none of them, or hidden, can be updated less often. */
const LIVE = (unit: string) => !["library", "sidebar", "details", "autodj", "suggestions", "guide"].includes(unit);

/** Whether this window shows anything that moves every frame. */
export function showsLive(layout: Layout | null, win: string, hidden: boolean): boolean {
  if (hidden || !layout) return !hidden;
  const w = findWin(layout, win);
  if (!w) return false;
  const root = w.pages[w.page];
  const stacks: { units: { unit: string }[]; active: number }[] = [];
  const walk = (n: typeof root) => {
    if (!n) return;
    if (n.kind === "stack") stacks.push(n);
    else n.children.forEach(walk);
  };
  walk(root);
  return stacks.some((st) => LIVE(st.units[Math.min(st.active, st.units.length - 1)]?.unit ?? "library"));
}

interface PartState {
  /** No layout from the main window yet, after asking twice. */
  waiting: boolean;
}
export const partState: PartState = { waiting: false };

function startPart(): () => void {
  const b = backend();
  const send = (m: WindowMessage) => b.broadcast?.(m);
  const feed = new LayoutFeed();
  let asked = 0;
  let helloTimer = 0;
  const hello = () => {
    if (feed.seq >= 0) return;
    asked++;
    if (asked > 2 && !partState.waiting) {
      partState.waiting = true;
      useLayout.setState({}); // draws "Waiting for the main window"
    }
    send({ kind: "layout-hello", win: ME });
    helloTimer = window.setTimeout(hello, HELLO_RETRY_MS);
  };
  let n = 0;
  /** Notes to show with Undo once the main window says the change is made. */
  const notes = new Map<string, string>();
  layoutHooks.ask = (op, note) => {
    const id = `${ME}-${Date.now()}-${n++}`;
    if (note) notes.set(id, note);
    send({ kind: "layout-intent", id, from: ME, basedOn: feed.seq, op, ...(note ? { undo: true } : {}) });
  };
  let sizeTimer = 0;
  let slow: boolean | null = null;
  const rate = () => {
    const want = !showsLive(useLayout.getState().layout, ME, document.visibilityState === "hidden");
    if (want === slow) return;
    slow = want;
    void b.telemetryRate?.(want).catch(() => undefined);
  };
  document.addEventListener("visibilitychange", rate);
  const offs = [
    useLayout.subscribe((s, prev) => {
      if (s.layout !== prev.layout) rate();
    }),
    b.onBroadcast?.((m) => {
      if (m.kind === "layout") {
        if (!isObj(m.layout) || !Array.isArray(m.layout.windows) || !feed.accept({ kind: "layout", seq: m.seq, layout: m.layout as unknown as Layout })) return;
        partState.waiting = false;
        window.clearTimeout(helloTimer);
        useLayout.setState({ layout: m.layout as unknown as Layout });
      } else if (m.kind === "layout-refused" && m.to === ME) {
        notes.delete(m.id);
        toast.message(m.reason);
      } else if (m.kind === "layout-done" && m.to === ME) {
        const note = notes.get(m.id);
        notes.delete(m.id);
        if (note) offerUndo(note, () => send({ kind: "layout-undo", from: ME, token: m.token }));
      }
    }),
    // Tells the main window this window's size, at most a few times a second.
    useLayout.subscribe((s, prev) => {
      if (s.size === prev.size) return;
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(() => send({ kind: "layout-size", win: ME, ...useLayout.getState().size }), 150);
    }),
  ];
  hello();
  send({ kind: "layout-size", win: ME, ...useLayout.getState().size });
  return () => {
    offs.forEach((f) => f?.());
    document.removeEventListener("visibilitychange", rate);
    window.clearTimeout(helloTimer);
    window.clearTimeout(sizeTimer);
    layoutHooks.ask = null;
  };
}

/** Starts sharing the layout between windows. Returns a stop function. */
export function startLayoutShare(): () => void {
  const b = backend();
  if (!b.broadcast || !b.onBroadcast) return () => undefined;
  return isMainWindow ? startMain() : startPart();
}

/** For tests: forgets the windows this module has seen. */
export function resetLayoutShareForTests() {
  open.clear();
  last.clear();
  closing.clear();
  mainPlaced = "";
  busy = false;
  again = false;
  partState.waiting = false;
}
