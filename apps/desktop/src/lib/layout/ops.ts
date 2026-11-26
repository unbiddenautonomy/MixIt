// Every change to a layout. Each operation is a pure function: it copies the layout,
// changes the copy, runs `normalise`, and returns the result or a Refusal in plain words.
// Nothing here talks to the engine, so no layout change can touch the music.
import { minSize } from "./fit";
import {
  MAIN,
  MAX_DEPTH,
  MAX_MIRRORS,
  MAX_WINDOWS,
  PAGE_IDS,
  UNIT_IDS,
  clone,
  depthOf,
  findWin,
  isRefusal,
  placesOf,
  rectsOf,
  refOf,
  refuse,
  resolveScreen,
  split,
  stack,
  stacksOf,
  type Env,
  type Layout,
  type LayoutNode,
  type PageId,
  type Place,
  type Rect01,
  type Refusal,
  type ScreenInfo,
  type ScreenRef,
  type Split,
  type Stack,
  type UnitId,
  type Win,
} from "./model";
import { HANDLE_PX, UNITS, isControl, isUnitId, minOf, pageFor, required, type Side } from "./units";

export type Result = Layout | Refusal;

/** The smallest share a split gives any child, so no area collapses to nothing. */
const MIN_SHARE = 0.02;
/** A window size to plan with when the window hasn't reported one yet. */
const FALLBACK_SIZE = { w: 1280, h: 800 };

const sizeOf = (env: Env, win: string) => env.sizes[win] ?? FALLBACK_SIZE;

// ------------------------------------------------------------------ tree surgery (on copies)

/** Fixes a list of shares: anything not a positive number gets an even share, then all add up to 1. */
export function fixSizes(sizes: number[], n: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => sizes[i]);
  // Shares that are already fine are kept to the last digit, so fixing twice changes nothing.
  const sum0 = raw.reduce((a, b) => a + (b ?? NaN), 0);
  if (raw.every((s) => typeof s === "number" && Number.isFinite(s) && s >= MIN_SHARE) && Math.abs(sum0 - 1) <= 1e-9) return raw;
  const good = raw.filter((s): s is number => typeof s === "number" && Number.isFinite(s) && s > 0);
  const fill = good.length ? good.reduce((a, b) => a + b, 0) / good.length : 1;
  const fixed = raw.map((s) => (typeof s === "number" && Number.isFinite(s) && s > 0 ? s : fill));
  // Lift tiny shares to the floor, taking the difference from the others in proportion.
  const total = fixed.reduce((a, b) => a + b, 0);
  let shares = fixed.map((s) => s / total);
  // Scaling the others down can push one of them under the floor too, so repeat until none is.
  const floor = n * MIN_SHARE < 1 ? MIN_SHARE : 1 / n;
  const low = shares.map(() => false);
  for (let pass = 0; pass < n && shares.some((s, i) => !low[i] && s < floor); pass++) {
    shares.forEach((s, i) => {
      if (s < floor) low[i] = true;
    });
    const lowTotal = low.filter(Boolean).length * floor;
    const highTotal = shares.reduce((a, s, i) => (low[i] ? a : a + s), 0);
    shares = shares.map((s, i) => (low[i] ? floor : highTotal > 0 ? (s / highTotal) * (1 - lowTotal) : (1 - lowTotal) / Math.max(1, n - low.filter(Boolean).length)));
  }
  // Make them add up to exactly 1, putting any rounding on the largest.
  const sum = shares.reduce((a, b) => a + b, 0);
  const big = shares.indexOf(Math.max(...shares));
  shares[big] += 1 - sum;
  return shares;
}

/** Drops empty stacks, replaces one-child splits by their child, merges a split into a parent going the same way, fixes shares. */
export function collapse(node: LayoutNode | undefined | null): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "stack") {
    if (!node.units.length) return null;
    if (!Number.isInteger(node.active) || node.active < 0 || node.active >= node.units.length) node.active = Math.max(0, Math.min(node.units.length - 1, Math.trunc(node.active) || 0));
    return node;
  }
  const kids: { node: LayoutNode; share: number }[] = [];
  node.children.forEach((c, i) => {
    const k = collapse(c);
    if (k) kids.push({ node: k, share: node.sizes[i] });
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0].node;
  const shares = fixSizes(
    kids.map((k) => k.share),
    kids.length,
  );
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  kids.forEach((k, i) => {
    if (k.node.kind === "split" && k.node.dir === node.dir) {
      k.node.children.forEach((c, j) => {
        children.push(c);
        sizes.push(shares[i] * (k.node as Split).sizes[j]);
      });
    } else {
      children.push(k.node);
      sizes.push(shares[i]);
    }
  });
  return { kind: "split", dir: node.dir, children, sizes: fixSizes(sizes, children.length) };
}

/** Squashes anything deeper than the limit into one stack of tabs. */
function capDepth(node: LayoutNode, left: number): LayoutNode {
  if (node.kind === "stack") return node;
  if (left <= 1) {
    const st = stack();
    st.units = stacksOf(node).flatMap((s) => s.units);
    return st;
  }
  node.children = node.children.map((c) => capDepth(c, left - 1));
  return node;
}

/** Removes a unit's places from a tree (mirrors too when asked). Returns the first place removed. */
function removeFrom(node: LayoutNode | undefined, unit: UnitId, which: "own" | "mirror" | "all"): Place | null {
  let first: Place | null = null;
  for (const st of stacksOf(node)) {
    const keep: Place[] = [];
    st.units.forEach((p, i) => {
      const hit = p.unit === unit && (which === "all" || (which === "mirror") === !!p.mirror);
      if (!hit) return keep.push(p);
      first ??= p;
      if (i < st.active) st.active--;
    });
    st.units = keep;
    if (st.active >= keep.length) st.active = Math.max(0, keep.length - 1);
  }
  return first;
}

function parentOf(root: LayoutNode, target: LayoutNode): { parent: Split; index: number } | null {
  if (root.kind === "stack") return null;
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i] === target) return { parent: root, index: i };
    const deeper = parentOf(root.children[i], target);
    if (deeper) return deeper;
  }
  return null;
}

function stackWith(root: LayoutNode | undefined, unit: UnitId): Stack | null {
  return stacksOf(root).find((s) => s.units.some((p) => p.unit === unit)) ?? null;
}

/**
 * Puts `p` beside the stack holding `target` (or into it, as a tab). Returns the new root,
 * or null when the target isn't in this tree. A placement that would go deeper than the
 * limit becomes a tab instead.
 */
export function insertBeside(root: LayoutNode, target: UnitId, side: Side, p: Place, share = 0.5): LayoutNode | null {
  const st = stackWith(root, target);
  if (!st) return null;
  const asTab = () => {
    st.units.push(p);
    st.active = st.units.length - 1;
    return root;
  };
  if (side === "tab") return asTab();
  const dir = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "above";
  const fresh = stack(p);
  const at = parentOf(root, st);
  let next: LayoutNode;
  if (at && at.parent.dir === dir) {
    const own = at.parent.sizes[at.index];
    at.parent.children.splice(before ? at.index : at.index + 1, 0, fresh);
    at.parent.sizes.splice(at.index, 1, ...(before ? [own * share, own * (1 - share)] : [own * (1 - share), own * share]));
    next = root;
  } else {
    const pair = split(dir, before ? [fresh, st] : [st, fresh], before ? [share, 1 - share] : [1 - share, share]);
    if (!at) next = pair;
    else {
      at.parent.children[at.index] = pair;
      next = root;
    }
  }
  if (depthOf(next) > MAX_DEPTH) {
    // Undo and make it a tab: find the fresh stack and take it out again.
    removeFrom(next, p.unit, p.mirror ? "mirror" : "own");
    const fixed = collapse(next) ?? stack();
    const again = stackWith(fixed, target);
    if (!again) return null;
    again.units.push(p);
    again.active = again.units.length - 1;
    return fixed;
  }
  return next;
}

/** Adds a stack at the right-hand end of a tree. */
function appendRight(root: LayoutNode | undefined, p: Place, share: number): LayoutNode {
  if (!root) return stack(p);
  if (root.kind === "split" && root.dir === "row") {
    root.sizes = root.sizes.map((s) => s * (1 - share));
    root.children.push(stack(p));
    root.sizes.push(share);
    return root;
  }
  return split("row", [root, stack(p)], [1 - share, share]);
}

/** Sends a place to its unit's home in the main window. Home always exists, because the main window always does. */
export function placeAtHome(layout: Layout, p: Place) {
  const main = layout.windows[0];
  const home = UNITS[p.unit].home;
  const root = main.pages[home.page];
  if (!root) {
    main.pages[home.page] = stack(p);
    return;
  }
  for (const a of home.anchors) {
    const anchored = stackWith(root, a.unit);
    if (!anchored || !anchored.units.some((x) => x.unit === a.unit && !x.mirror)) continue;
    const next = insertBeside(root, a.unit, a.side, p, a.side === "left" || a.side === "right" ? 0.3 : 0.4);
    if (next) {
      main.pages[home.page] = next;
      return;
    }
  }
  main.pages[home.page] = appendRight(root, p, 0.25);
}

// ------------------------------------------------------------------ normalise

const clampBounds = (b: Rect01 | "full"): Rect01 | "full" => {
  if (b === "full" || !b || typeof b !== "object") return "full";
  if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) return "full";
  const w = Math.max(0.2, Math.min(1, b.w));
  const h = Math.max(0.2, Math.min(1, b.h));
  return { x: Math.max(0, Math.min(1 - w, b.x)), y: Math.max(0, Math.min(1 - h, b.y)), w, h };
};

const winNumber = (id: string) => (/^w(\d+)$/.exec(id) ? Number(/^w(\d+)$/.exec(id)![1]) : 0);

/**
 * Brings any layout back within the rules: the main window first, windows only on
 * connected screens, each control in one window, mirrors only of views, every unit
 * somewhere, required controls on a Mix page, and tidy trees. Works on (and returns) a copy.
 */
export function normalise(input: Layout, env: Env): Layout {
  const l = clone(input);

  // 1. Windows: the main one first and only once, the others on screens that are connected.
  const seen = new Set<string>();
  let main: Win | undefined;
  const others: Win[] = [];
  for (const w of l.windows) {
    if (!w || typeof w.id !== "string" || seen.has(w.id)) continue;
    seen.add(w.id);
    if (w.id === MAIN) main = w;
    else others.push(w);
  }
  main ??= { id: MAIN, screen: null, bounds: "full", fullscreen: false, pages: {}, page: "mix" };
  if (main.screen && !resolveScreen(env.screens, main.screen)) main.screen = null;
  const kept = env.browser ? [] : others.filter((w) => w.screen && resolveScreen(env.screens, w.screen)).slice(0, MAX_WINDOWS - 1);
  l.windows = [main, ...kept];
  for (const w of l.windows) {
    w.bounds = clampBounds(w.bounds);
    w.fullscreen = !!w.fullscreen;
    if (!PAGE_IDS.includes(w.page)) w.page = "mix";
    for (const key of Object.keys(w.pages)) if (!PAGE_IDS.includes(key as PageId)) delete w.pages[key as PageId];
  }

  // 2. Places: known units only; each unit once per page; a control in one window; mirrors only of views, never beside their original.
  for (const w of l.windows) for (const page of PAGE_IDS) for (const st of stacksOf(w.pages[page])) st.units = st.units.filter((p) => p && isUnitId(p.unit));
  for (const unit of UNIT_IDS) {
    const all = l.windows.flatMap((w) => PAGE_IDS.flatMap((page) => stacksOf(w.pages[page]).flatMap((st) => st.units.filter((p) => p.unit === unit).map((p) => ({ w, page, st, p })))));
    if (!all.length) continue;
    const info = UNITS[unit];
    let owner = all.find((x) => !x.p.mirror)?.w;
    if (!owner) {
      // Only mirrors left: the first window showing it becomes its own.
      owner = all[0].w;
      for (const x of all) if (x.w === owner) delete x.p.mirror;
    }
    const mirrorWins: Win[] = [];
    const perPage = new Set<string>();
    for (const x of all) {
      const pageKey = `${x.w.id}/${x.page}`;
      let drop = perPage.has(pageKey);
      if (!drop && x.w !== owner) {
        if (!x.p.mirror && info.mirrorable) x.p.mirror = true;
        if (!info.mirrorable) drop = true;
        else if (!mirrorWins.includes(x.w)) {
          if (mirrorWins.length >= MAX_MIRRORS) drop = true;
          else mirrorWins.push(x.w);
        }
      }
      if (!drop && x.w === owner && x.p.mirror) delete x.p.mirror;
      if (drop) x.st.units = x.st.units.filter((p) => p !== x.p);
      else perPage.add(pageKey);
    }
  }

  // 3. Required controls must be on a Mix page; one that isn't goes home.
  for (const unit of UNIT_IDS) {
    if (!required(unit, env)) continue;
    const own = placesOf(l, unit);
    if (own.length && !own.some((f) => f.page === "mix")) for (const f of own) f.stack.units = f.stack.units.filter((p) => p !== f.place);
  }

  // 4. Tidy trees, then send every unit that has no place of its own home.
  const tidy = () => {
    for (const w of l.windows)
      for (const page of PAGE_IDS) {
        const root = collapse(w.pages[page]);
        if (root) w.pages[page] = depthOf(root) > MAX_DEPTH ? (collapse(capDepth(root, MAX_DEPTH)) ?? undefined) : root;
        else delete w.pages[page];
      }
  };
  tidy();
  for (const unit of UNIT_IDS) if (!placesOf(l, unit).length) placeAtHome(l, stack(unit).units[0]);
  tidy();

  // 5. A window with nothing left closes; one showing a page it no longer has shows another.
  l.windows = l.windows.filter((w, i) => i === 0 || Object.keys(w.pages).length > 0);
  for (const w of l.windows.slice(1)) if (!w.pages[w.page]) w.page = PAGE_IDS.find((p) => w.pages[p])!;

  l.version = 1;
  l.edited = !!l.edited;
  if (typeof l.preset !== "string") l.preset = "laptop";
  l.nextWin = Math.max(2, Number.isInteger(l.nextWin) ? l.nextWin : 2, ...l.windows.map((w) => winNumber(w.id) + 1));
  return l;
}

// ------------------------------------------------------------------ operations

const changed = (l: Layout) => ({ ...l, edited: true });

/** Takes a unit out of every window but `keepIn` (its own places; mirrors stay). Returns one removed place, to keep its fold and view. */
function takeOut(l: Layout, unit: UnitId, keepIn: Win | null, keepPage?: PageId): Place | null {
  let got: Place | null = null;
  for (const w of l.windows) {
    for (const page of PAGE_IDS) {
      if (w === keepIn && page !== keepPage) continue;
      const p = removeFrom(w.pages[page], unit, "own");
      got ??= p;
    }
  }
  return got;
}

/** The largest stack on a page at the window's size, to take a new tab. */
function largestStack(root: LayoutNode, size: { w: number; h: number }): Stack {
  const rects = rectsOf(root, size.w, size.h);
  let best: Stack | null = null;
  let area = -1;
  for (const st of stacksOf(root)) {
    const r = rects.get(st)!;
    if (r.w * r.h > area) {
      area = r.w * r.h;
      best = st;
    }
  }
  return best!;
}

/** Puts a place onto a page: beside everything when there's room for it, else as a tab in the largest area. */
function addToPage(env: Env, win: Win, page: PageId, p: Place) {
  const root = win.pages[page];
  if (!root) {
    win.pages[page] = stack(p);
    return;
  }
  const size = sizeOf(env, win.id);
  const need = minSize(root, env).w + HANDLE_PX + minOf(p.unit, env).w;
  if (need <= size.w) {
    win.pages[page] = appendRight(root, p, Math.max(0.25, Math.min(0.5, minOf(p.unit, env).w / size.w)));
    return;
  }
  const st = largestStack(root, size);
  st.units.push(p);
  st.active = st.units.length - 1;
}

const freshPlace = (unit: UnitId, from: Place | null): Place => ({
  unit,
  folded: from ? { ...from.folded } : { noController: false, controller: false },
  ...(from?.view ? { view: from.view } : {}),
});

/** Sends a unit to a window, onto the page it's showing (required controls always onto Mix). */
export function send(layout: Layout, env: Env, unit: UnitId, winId: string, page?: PageId): Result {
  if (env.browser && winId !== MAIN) return refuse("This version of MixIt has one window.");
  const l = clone(layout);
  const win = findWin(l, winId);
  if (!win) return refuse("That window is closed now.");
  let pg = page ?? win.page;
  if (required(unit, env) && pg !== "mix") pg = "mix";
  if (placesOf(l, unit).some((f) => f.win.id === winId && f.page === pg)) return layout;
  // A move within the same window leaves the unit's other pages alone.
  const from = takeOut(l, unit, win, pg) ?? placesOf(l, unit)[0]?.place ?? null;
  removeFrom(win.pages[pg], unit, "mirror");
  const p = freshPlace(unit, from);
  if (winId === MAIN && UNITS[unit].home.page === pg) placeAtHome(l, p);
  else addToPage(env, win, pg, p);
  return normalise(changed(l), env);
}

/** Sends a unit back to its default place in the main window. */
export function sendHome(layout: Layout, env: Env, unit: UnitId): Result {
  const l = clone(layout);
  const from = takeOut(l, unit, null);
  placeAtHome(l, freshPlace(unit, from));
  return normalise(changed(l), env);
}

export interface Target {
  win: string;
  page: PageId;
  unit: UnitId;
}

/** Docks a unit beside another (or into its stack as a tab). Refused when the window couldn't fit the result. */
export function placeUnit(layout: Layout, env: Env, unit: UnitId, target: Target, side: Side): Result {
  if (unit === target.unit) return layout;
  const l = clone(layout);
  const win = findWin(l, target.win);
  const root = win?.pages[target.page];
  if (!win || !root || !stackWith(root, target.unit)) return refuse("That spot isn't there any more.");
  if (required(unit, env) && target.page !== "mix") return refuse(`${UNITS[unit].name} has to stay on the Mix page.`);
  const already = stackWith(root, target.unit)!;
  if (side === "tab" && already.units.some((p) => p.unit === unit && !p.mirror)) return layout;
  const size = sizeOf(env, win.id);
  const fitsIn = (n: LayoutNode) => {
    const m = minSize(n, env);
    return m.w <= size.w && m.h <= size.h;
  };
  const before = fitsIn(root);
  const from = takeOut(l, unit, win, undefined);
  // takeOut kept the target window whole; take it off the target page too.
  const onPage = removeFrom(win.pages[target.page], unit, "all");
  const tidied = collapse(win.pages[target.page]);
  if (!tidied || !stackWith(tidied, target.unit)) return refuse("That spot isn't there any more.");
  const next = insertBeside(tidied, target.unit, side, freshPlace(unit, from ?? onPage));
  if (!next) return refuse("That spot isn't there any more.");
  win.pages[target.page] = next;
  if (before && !fitsIn(next)) return refuse("There isn't room for it there. Try it as a tab, or make the window bigger.");
  return normalise(changed(l), env);
}

/** Opens a new window on a screen, holding the unit. */
export function newWindow(layout: Layout, env: Env, unit: UnitId, screen: ScreenRef): Result {
  if (env.browser) return refuse("This version of MixIt has one window.");
  if (layout.windows.length >= MAX_WINDOWS) return refuse(`MixIt can have up to ${MAX_WINDOWS} windows. Close one first, or send this to a window that's already open.`);
  if (!resolveScreen(env.screens, screen)) return refuse("That screen isn't connected any more.");
  const l = clone(layout);
  const from = takeOut(l, unit, null);
  const page = required(unit, env) ? "mix" : pageFor(unit);
  const id = `w${l.nextWin}`;
  l.nextWin++;
  l.windows.push({ id, screen, bounds: "full", fullscreen: false, pages: { [page]: stack(freshPlace(unit, from)) }, page });
  return normalise(changed(l), env);
}

/** Closes a window that isn't the main one; its units go home, keeping their folds. */
export function closeWindow(layout: Layout, env: Env, winId: string): Result {
  if (winId === MAIN) return refuse("Closing the main window quits MixIt.");
  const win = findWin(layout, winId);
  if (!win) return layout;
  const l = clone(layout);
  const gone = l.windows.find((w) => w.id === winId)!;
  l.windows = l.windows.filter((w) => w !== gone);
  const done = new Set<UnitId>();
  for (const page of PAGE_IDS)
    for (const st of stacksOf(gone.pages[page]))
      for (const p of st.units) {
        if (p.mirror || done.has(p.unit)) continue;
        done.add(p.unit);
        // A view mirrored elsewhere is already somewhere: normalise makes that copy its own.
        if (!isControl(p.unit) && placesOf(l, p.unit, true).length) continue;
        placeAtHome(l, freshPlace(p.unit, p));
      }
  return normalise(changed(l), env);
}

/** Folds or opens a unit, for playing with or without a controller as things are now. */
export function fold(layout: Layout, env: Env, unit: UnitId, folded: boolean, where?: { win: string; page: PageId }): Result {
  const l = clone(layout);
  const key = env.controller ? "controller" : "noController";
  let hit = false;
  for (const f of placesOf(l, unit, true)) {
    if (where && (f.win.id !== where.win || f.page !== where.page)) continue;
    f.place.folded[key] = folded;
    hit = true;
  }
  if (!hit) return layout;
  return normalise(changed(l), env);
}

/** Shows a unit's tab in its stack. */
export function activate(layout: Layout, env: Env, unit: UnitId, where: { win: string; page: PageId }): Result {
  const l = clone(layout);
  const f = placesOf(l, unit, true).find((x) => x.win.id === where.win && x.page === where.page);
  if (!f) return layout;
  f.stack.active = f.index;
  return normalise(l, env);
}

/** Finds a split by its path of child indexes from the page's root. */
export function splitAt(root: LayoutNode | undefined, path: number[]): Split | null {
  let n = root;
  for (const i of path) {
    if (!n || n.kind !== "split") return null;
    n = n.children[i];
  }
  return n && n.kind === "split" ? n : null;
}

/** Drags a split handle: the new shares, held to each child's minimum where the window allows. */
export function resize(layout: Layout, env: Env, winId: string, page: PageId, path: number[], sizes: number[]): Result {
  const l = clone(layout);
  const win = findWin(l, winId);
  const root = win?.pages[page];
  const sp = splitAt(root, path);
  if (!win || !root || !sp || sizes.length !== sp.children.length) return layout;
  const length = (() => {
    const rect = rectsOf(root, sizeOf(env, winId).w, sizeOf(env, winId).h).get(sp)!;
    return (sp.dir === "row" ? rect.w : rect.h) - (sp.children.length - 1) * HANDLE_PX;
  })();
  let shares = fixSizes(sizes, sp.children.length);
  if (length > 0) {
    const mins = sp.children.map((c) => {
      const m = minSize(c, env);
      return (sp.dir === "row" ? m.w : m.h) / length;
    });
    const total = mins.reduce((a, b) => a + b, 0);
    if (total >= 1) shares = fixSizes(mins, mins.length);
    else {
      // Raise each child below its minimum, taking the difference from those with room to spare.
      for (let pass = 0; pass < sp.children.length; pass++) {
        const short = shares.map((s, i) => Math.max(0, mins[i] - s));
        const need = short.reduce((a, b) => a + b, 0);
        if (need <= 1e-12) break;
        const spare = shares.map((s, i) => (short[i] > 0 ? 0 : Math.max(0, s - mins[i])));
        const spareTotal = spare.reduce((a, b) => a + b, 0);
        if (spareTotal <= 0) break;
        shares = shares.map((s, i) => (short[i] > 0 ? mins[i] : s - (spare[i] / spareTotal) * need));
      }
      shares = fixSizes(shares, shares.length);
    }
  }
  sp.sizes = shares;
  return normalise(changed(l), env);
}

/** Shows a view unit in another window too. */
export function mirror(layout: Layout, env: Env, unit: UnitId, winId: string): Result {
  const info = UNITS[unit];
  if (!info.mirrorable) return refuse(`${info.name} can only be in one place. Only views like the waveforms can be shown twice.`);
  if (env.browser) return refuse("This version of MixIt has one window.");
  const l = clone(layout);
  const win = findWin(l, winId);
  if (!win) return refuse("That window is closed now.");
  const owner = placesOf(l, unit)[0]?.win;
  if (owner === win) return refuse(`${info.name} is already in this window.`);
  const all = placesOf(l, unit, true);
  if (all.some((f) => f.win === win && f.page === win.page)) return layout;
  const mirrorWins = new Set(all.filter((f) => f.place.mirror).map((f) => f.win.id));
  if (!mirrorWins.has(winId) && mirrorWins.size >= MAX_MIRRORS) return refuse(`${info.name} is already shown in ${MAX_MIRRORS} other windows.`);
  addToPage(env, win, win.page, { unit, folded: { noController: false, controller: false }, mirror: true });
  return normalise(changed(l), env);
}

/** Stops showing a mirrored view in a window. */
export function unmirror(layout: Layout, env: Env, unit: UnitId, winId: string): Result {
  const l = clone(layout);
  const win = findWin(l, winId);
  if (!win) return layout;
  let hit = false;
  for (const page of PAGE_IDS) hit = !!removeFrom(win.pages[page], unit, "mirror") || hit;
  return hit ? normalise(changed(l), env) : layout;
}

/** Switches a window between Mix, Library and Arrange. A page whose units are elsewhere shows where they went. */
export function showPage(layout: Layout, env: Env, winId: string, page: PageId): Result {
  const l = clone(layout);
  const win = findWin(l, winId);
  if (!win) return refuse("That window is closed now.");
  if (winId !== MAIN && !win.pages[page]) return refuse("That window doesn't have that page.");
  win.page = page;
  return normalise(l, env);
}

/** The system moved a window (the person dragged it to another screen, or resized it). */
export function windowMoved(layout: Layout, env: Env, winId: string, screen: ScreenInfo | null, bounds: Rect01 | "full", fullscreen: boolean): Result {
  const l = clone(layout);
  const win = findWin(l, winId);
  if (!win) return layout;
  win.screen = screen ? refOf(env.screens, screen) : winId === MAIN ? null : win.screen;
  win.bounds = bounds;
  win.fullscreen = fullscreen;
  return normalise(l, env);
}

/** Replaces the whole layout with a preset, fitted to the screens there are now. */
export function applyPreset(preset: Layout, env: Env): Layout {
  return normalise({ ...preset, edited: false }, env);
}

// ------------------------------------------------------------------ one entry point for intents

/** An operation as data, so a part window can ask the main window for it. */
export type Op =
  | { op: "send"; unit: UnitId; win: string; page?: PageId }
  | { op: "home"; unit: UnitId }
  | { op: "place"; unit: UnitId; target: Target; side: Side }
  | { op: "newWindow"; unit: UnitId; screen: ScreenRef }
  | { op: "close"; win: string }
  | { op: "fold"; unit: UnitId; folded: boolean; where?: { win: string; page: PageId } }
  | { op: "activate"; unit: UnitId; where: { win: string; page: PageId } }
  | { op: "resize"; win: string; page: PageId; path: number[]; sizes: number[] }
  | { op: "mirror"; unit: UnitId; win: string }
  | { op: "unmirror"; unit: UnitId; win: string }
  | { op: "page"; win: string; page: PageId };

export function run(layout: Layout, env: Env, o: Op): Result {
  switch (o.op) {
    case "send":
      return send(layout, env, o.unit, o.win, o.page);
    case "home":
      return sendHome(layout, env, o.unit);
    case "place":
      return placeUnit(layout, env, o.unit, o.target, o.side);
    case "newWindow":
      return newWindow(layout, env, o.unit, o.screen);
    case "close":
      return closeWindow(layout, env, o.win);
    case "fold":
      return fold(layout, env, o.unit, o.folded, o.where);
    case "activate":
      return activate(layout, env, o.unit, o.where);
    case "resize":
      return resize(layout, env, o.win, o.page, o.path, o.sizes);
    case "mirror":
      return mirror(layout, env, o.unit, o.win);
    case "unmirror":
      return unmirror(layout, env, o.unit, o.win);
    case "page":
      return showPage(layout, env, o.win, o.page);
  }
}

export { isRefusal };
