// The rules every layout keeps. `check` lists what's wrong, in words a test failure can
// show; an empty list means the layout is fine. Operations run `normalise`, and tests run
// `check` after every step of thousands of random sequences.
import { fitTree, hardMinFor, minSize } from "./fit";
import { MAIN, MAX_DEPTH, MAX_MIRRORS, MAX_WINDOWS, PAGE_IDS, UNIT_IDS, allPlaces, depthOf, placesOf, resolveScreen, type Env, type Layout, type LayoutNode } from "./model";
import { parseLayout, serialise, type Loaded } from "./persist";
import { UNITS, isUnitId, required } from "./units";

function treeProblems(node: LayoutNode, where: string, out: string[]) {
  if (node.kind === "stack") {
    if (!node.units.length) out.push(`${where}: empty stack`);
    if (!Number.isInteger(node.active) || node.active < 0 || node.active >= node.units.length) out.push(`${where}: active tab ${node.active} out of range`);
    return;
  }
  if (node.children.length < 2) out.push(`${where}: split with ${node.children.length} children`);
  if (node.sizes.length !== node.children.length) out.push(`${where}: ${node.sizes.length} sizes for ${node.children.length} children`);
  if (!node.sizes.every((s) => Number.isFinite(s) && s > 0)) out.push(`${where}: a size isn't a positive number`);
  const sum = node.sizes.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) out.push(`${where}: sizes add up to ${sum}`);
  node.children.forEach((c, i) => {
    if (c.kind === "split" && c.dir === node.dir) out.push(`${where}/${i}: split inside a split going the same way`);
    treeProblems(c, `${where}/${i}`, out);
  });
}

export function check(layout: Layout, env: Env, opts: { roundTrip?: boolean } = {}): string[] {
  const out: string[] = [];
  const all = allPlaces(layout);

  // 1. Reachable controls.
  for (const unit of UNIT_IDS)
    if (required(unit, env) && !placesOf(layout, unit).some((f) => f.page === "mix")) out.push(`${unit} is on no Mix page`);

  // 2. One place for controls; mirrors only of views.
  for (const unit of UNIT_IDS) {
    const own = placesOf(layout, unit);
    const wins = new Set(own.map((f) => f.win.id));
    if (wins.size > 1) out.push(`${unit} is in ${wins.size} windows`);
    const mirrors = all.filter((f) => f.place.unit === unit && f.place.mirror);
    if (mirrors.length && !UNITS[unit].mirrorable) out.push(`${unit} can't be mirrored`);
    if (mirrors.some((f) => wins.has(f.win.id))) out.push(`${unit} is mirrored in its own window`);
    if (new Set(mirrors.map((f) => f.win.id)).size > MAX_MIRRORS) out.push(`${unit} has too many mirrors`);
  }
  const perPage = new Set<string>();
  for (const f of all) {
    const key = `${f.win.id}/${f.page}/${f.place.unit}`;
    if (perPage.has(key)) out.push(`${f.place.unit} twice on ${f.win.id} ${f.page}`);
    perPage.add(key);
  }

  // 3. Well-formed trees.
  for (const w of layout.windows)
    for (const page of PAGE_IDS) {
      const root = w.pages[page];
      if (!root) continue;
      treeProblems(root, `${w.id}/${page}`, out);
      if (depthOf(root) > MAX_DEPTH) out.push(`${w.id}/${page} is ${depthOf(root)} levels deep`);
    }
  for (const key of layout.windows.flatMap((w) => Object.keys(w.pages))) if (!PAGE_IDS.includes(key as never)) out.push(`unknown page ${key}`);

  // 4. Known units only, and every unit somewhere.
  for (const f of all) if (!isUnitId(f.place.unit)) out.push(`unknown unit ${String(f.place.unit)}`);
  for (const unit of UNIT_IDS) if (!placesOf(layout, unit).length) out.push(`${unit} is nowhere`);

  // 5. Valid windows.
  if (layout.windows[0]?.id !== MAIN) out.push("the first window isn't the main one");
  const ids = layout.windows.map((w) => w.id);
  if (new Set(ids).size !== ids.length) out.push("two windows share an id");
  if (layout.windows.length > MAX_WINDOWS) out.push(`${layout.windows.length} windows`);
  if (env.browser && layout.windows.length > 1) out.push("more than one window in the browser");
  for (const w of layout.windows) {
    if (w.id !== MAIN && (!w.screen || !resolveScreen(env.screens, w.screen))) out.push(`${w.id} is on no connected screen`);
    if (w.id !== MAIN && !Object.keys(w.pages).length) out.push(`${w.id} is empty`);
    if (w.id !== MAIN && !w.pages[w.page]) out.push(`${w.id} shows a page it doesn't have`);
    const n = /^w(\d+)$/.exec(w.id);
    if (w.id !== MAIN && !n) out.push(`window id ${w.id}`);
    if (n && Number(n[1]) >= layout.nextWin) out.push(`${w.id} isn't below nextWin ${layout.nextWin}`);
    if (w.bounds !== "full") {
      const b = w.bounds;
      if (!(b.w > 0 && b.h > 0 && b.x >= 0 && b.y >= 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9)) out.push(`${w.id} is partly off its screen`);
    }
  }

  // 6. Fits or says so.
  for (const w of layout.windows) {
    const size = env.sizes[w.id];
    if (!size) continue;
    for (const page of PAGE_IDS) {
      const root = w.pages[page];
      const fit = fitTree(root, size, env, hardMinFor(w.id));
      if (size.w < hardMinFor(w.id).w || size.h < hardMinFor(w.id).h) {
        if (!fit.scroll) out.push(`${w.id}/${page} is below the hard minimum but doesn't scroll`);
      } else if (root && !fit.scroll) {
        const m = minSize(root, env, fit.autoFolded);
        if (m.w > size.w || m.h > size.h) out.push(`${w.id}/${page} says it fits but needs ${m.w}×${m.h}`);
      }
    }
  }

  // 7. Round trip.
  if (opts.roundTrip === false) return out;
  const text = serialise(layout);
  const back = parseLayout(text, env);
  if (!back.layout) out.push(`doesn't load back: ${back.problem}`);
  else if (serialise(back.layout) !== text) out.push("loads back different");

  return out;
}

/**
 * Loads a saved layout for use: parsed, brought within the rules, and checked. A layout
 * that still breaks a rule after that is refused whole, never shown in part.
 */
export function loadLayout(input: unknown, env: Env): Loaded {
  const r = parseLayout(input, env);
  if (!r.layout) return r;
  const problems = check(r.layout, env, { roundTrip: false });
  return problems.length ? { layout: null, problem: "bad", detail: problems.join("; ") } : r;
}
