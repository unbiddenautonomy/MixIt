// How much room a layout needs, and what to fold when a window is too small for it.
// Nothing here changes the layout: folds made to fit are worked out fresh for each window
// size, so growing the window again brings everything back as the person left it.
import { isFolded, stacksOf, type Env, type LayoutNode, type Place, type Stack, type UnitId } from "./model";
import { BAR_PX, HANDLE_PX, UNITS, enabled } from "./units";

/** Height of the tab row a stack shows when it holds more than one unit. */
export const TAB_PX = 24;

/** The hard minimum window sizes; below these a window scrolls instead of fitting. */
export const HARD_MIN = { main: { w: 1024, h: 640 }, other: { w: 480, h: 320 } };
export const hardMinFor = (win: string) => (win === "main" ? HARD_MIN.main : HARD_MIN.other);

type Opts = Pick<Env, "mode" | "decks" | "controller">;

/** The units of a stack that are drawn (decks C and D drop out with two decks). */
export function visiblePlaces(st: Stack, env: Pick<Env, "decks">): Place[] {
  return st.units.filter((p) => enabled(p.unit, env));
}

/** The tab a stack shows: its active one, or the first drawn one when that is disabled. */
export function shownPlace(st: Stack, env: Pick<Env, "decks">): Place | null {
  const a = st.units[st.active];
  if (a && enabled(a.unit, env)) return a;
  return visiblePlaces(st, env)[0] ?? null;
}

function stackFolded(st: Stack, env: Opts, auto: ReadonlySet<UnitId>): boolean {
  const p = shownPlace(st, env);
  return !!p && (isFolded(p, env.controller) || auto.has(p.unit));
}

/** The smallest size a node can take, in CSS pixels. A node with nothing to draw takes none. */
export function minSize(node: LayoutNode, env: Opts, auto: ReadonlySet<UnitId> = new Set()): { w: number; h: number } {
  if (node.kind === "stack") {
    const shown = visiblePlaces(node, env);
    if (!shown.length) return { w: 0, h: 0 };
    if (stackFolded(node, env, auto)) return { w: BAR_PX, h: BAR_PX };
    // The largest of its tabs, so switching tabs never changes what the window needs.
    let w = 0;
    let h = 0;
    for (const p of shown) {
      const m = UNITS[p.unit].min[env.mode];
      w = Math.max(w, m.w);
      h = Math.max(h, m.h);
    }
    return { w, h: h + (shown.length > 1 ? TAB_PX : 0) };
  }
  const kids = node.children.map((c) => minSize(c, env, auto)).filter((m) => m.w > 0 || m.h > 0);
  if (!kids.length) return { w: 0, h: 0 };
  const gaps = (kids.length - 1) * HANDLE_PX;
  if (node.dir === "row") return { w: kids.reduce((a, m) => a + m.w, 0) + gaps, h: Math.max(...kids.map((m) => m.h)) };
  return { w: Math.max(...kids.map((m) => m.w)), h: kids.reduce((a, m) => a + m.h, 0) + gaps };
}

export interface Fit {
  /** Units folded only because the window is too small. */
  autoFolded: Set<UnitId>;
  /** Still too big with everything foldable folded: the window scrolls. */
  scroll: boolean;
}

/**
 * Folds units, those with the highest fold priority first, until the tree fits the size,
 * then opens again whatever can stay open, so a too-narrow window doesn't keep folds that
 * only saved height. Units with fold priority 0 (decks A and B) never fold by themselves.
 */
export function fitTree(root: LayoutNode | undefined, given: { w: number; h: number }, env: Opts, hard: { w: number; h: number } = { w: 0, h: 0 }): Fit {
  const auto = new Set<UnitId>();
  // Below the hard minimum, lay out at the minimum and let the window scroll.
  const below = given.w < hard.w || given.h < hard.h;
  const size = { w: Math.max(given.w, hard.w), h: Math.max(given.h, hard.h) };
  if (!root) return { autoFolded: auto, scroll: below };
  const fits = (m: { w: number; h: number }) => m.w <= size.w && m.h <= size.h;
  let m = minSize(root, env, auto);
  if (fits(m)) return { autoFolded: auto, scroll: below };
  const candidates = stacksOf(root)
    .map((st, order) => ({ st, order }))
    .sort((a, b) => {
      const pa = shownPlace(a.st, env);
      const pb = shownPlace(b.st, env);
      return (pb ? UNITS[pb.unit].foldPriority : -1) - (pa ? UNITS[pa.unit].foldPriority : -1) || b.order - a.order;
    });
  // Fold in priority order until it fits. Folds aren't judged one at a time: when two rows
  // are both too wide, neither fold helps on its own.
  const order: UnitId[] = [];
  for (const { st } of candidates) {
    if (fits(m)) break;
    const p = shownPlace(st, env);
    if (!p || UNITS[p.unit].foldPriority === 0 || stackFolded(st, env, auto)) continue;
    auto.add(p.unit);
    order.push(p.unit);
    m = minSize(root, env, auto);
  }
  // If that got it to fit, open again (last folded first) everything that can stay open.
  // If it didn't, everything stays folded and the window scrolls.
  if (fits(m))
    for (const unit of [...order].reverse()) {
      auto.delete(unit);
      const next = minSize(root, env, auto);
      if (fits(next)) m = next;
      else auto.add(unit);
    }
  return { autoFolded: auto, scroll: below || !fits(m) };
}
