// Thousands of random layout operations over random screens, sizes and settings, checking
// every rule after every step. A failure prints its seed; MIXIT_LAYOUT_SEED replays it and
// MIXIT_LAYOUT_RUNS runs more sequences (like the engine's soak test).
import { describe, expect, it } from "vitest";
import { check } from "../lib/layout/check";
import { MAIN, PAGE_IDS, UNIT_IDS, refOf, type Env, type Layout, type PageId, type ScreenInfo, type UnitId } from "../lib/layout/model";
import { isRefusal, normalise, run, type Op } from "../lib/layout/ops";
import { parseLayout, serialise } from "../lib/layout/persist";
import { presetFor } from "../lib/layout/presets";
import type { Side } from "../lib/layout/units";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCREENS: ScreenInfo[] = [
  { name: "Built-in Retina Display", x: 0, y: 0, width: 2940, height: 1912, scale: 2 },
  { name: "DELL U2720Q", x: 2940, y: 0, width: 3840, height: 2160, scale: 1.5 },
  { name: "DELL U2720Q", x: 6780, y: 0, width: 3840, height: 2160, scale: 1.5 },
  { name: "EPSON PJ", x: -1920, y: 0, width: 1920, height: 1080, scale: 1 },
];
const SIDES: Side[] = ["tab", "left", "right", "above", "below"];

function sequence(seed: number, steps: number) {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const randomSize = () => ({ w: Math.round(400 + r() * 3200), h: Math.round(300 + r() * 1900) });
  const randomEnv = (): Env => {
    const count = 1 + Math.floor(r() * SCREENS.length);
    const screens = [SCREENS[0], ...SCREENS.slice(1).filter(() => r() < 0.6)].slice(0, count);
    const sizes: Env["sizes"] = { [MAIN]: r() < 0.5 ? pick([{ w: 1280, h: 800 }, { w: 1470, h: 956 }, { w: 1710, h: 1112 }]) : randomSize() };
    for (let i = 2; i < 12; i++) sizes[`w${i}`] = randomSize();
    return { screens, sizes, mode: r() < 0.5 ? "easy" : "pro", decks: r() < 0.5 ? 2 : 4, controller: r() < 0.3, browser: r() < 0.1 };
  };
  let env = randomEnv();
  let layout: Layout = presetFor(env);
  const log: string[] = [`env ${JSON.stringify(env)}`];

  const randomOp = (): Op => {
    const unit: UnitId = pick(UNIT_IDS);
    const win = r() < 0.15 ? `w${Math.floor(r() * 10)}` : pick(layout.windows).id;
    const page: PageId = pick(PAGE_IDS);
    const kind = Math.floor(r() * 11);
    switch (kind) {
      case 0:
        return { op: "send", unit, win, page: r() < 0.5 ? page : undefined };
      case 1:
        return { op: "home", unit };
      case 2: {
        const w = pick(layout.windows);
        const pg = pick(PAGE_IDS);
        return { op: "place", unit, target: { win: w.id, page: pg, unit: pick(UNIT_IDS) }, side: pick(SIDES) };
      }
      case 3: {
        const s = r() < 0.9 ? pick(env.screens) : SCREENS[3];
        return { op: "newWindow", unit, screen: refOf(r() < 0.9 ? env.screens : SCREENS, s) };
      }
      case 4:
        return { op: "close", win };
      case 5:
        return { op: "fold", unit, folded: r() < 0.6 };
      case 6:
        return { op: "activate", unit, where: { win, page } };
      case 7: {
        const n = 2 + Math.floor(r() * 3);
        const path = Array.from({ length: Math.floor(r() * 3) }, () => Math.floor(r() * 3));
        return { op: "resize", win, page, path, sizes: Array.from({ length: n }, () => (r() < 0.1 ? Number.NaN : r() * 2 - 0.2)) };
      }
      case 8:
        return { op: "mirror", unit, win };
      case 9:
        return { op: "unmirror", unit, win };
      default:
        return { op: "page", win, page };
    }
  };

  for (let i = 0; i < steps; i++) {
    const roll = r();
    let what: string;
    if (roll < 0.08) {
      // The world changes: screens plugged or unplugged, a window resized, Easy/Pro, decks, a controller.
      env = { ...randomEnv(), browser: env.browser };
      layout = normalise(layout, env);
      what = `env ${JSON.stringify(env)}`;
    } else if (roll < 0.1) {
      layout = presetFor(env);
      what = "preset";
    } else {
      const op = randomOp();
      const next = run(layout, env, op);
      what = `${JSON.stringify(op)} → ${isRefusal(next) ? `refused (${next.reason})` : next === layout ? "unchanged" : "ok"}`;
      if (isRefusal(next)) {
        expect(next.reason.length, `seed ${seed} step ${i}: a refusal says why`).toBeGreaterThan(0);
      } else layout = next;
    }
    log.push(what);
    const problems = check(layout, env);
    if (problems.length) {
      throw new Error(`seed ${seed} step ${i} broke the rules:\n  ${problems.join("\n  ")}\nlast steps:\n  ${log.slice(-6).join("\n  ")}`);
    }
    // normalise changes nothing in a layout that keeps the rules.
    const text = serialise(layout);
    if (serialise(normalise(layout, env)) !== text) throw new Error(`seed ${seed} step ${i}: normalise isn't idempotent after ${what}`);
    const back = parseLayout(text, env);
    if (!back.layout || serialise(back.layout) !== text) throw new Error(`seed ${seed} step ${i}: doesn't load back`);
  }
}

describe("random layout sequences", () => {
  // Vitest runs in Node; the app's types don't include Node's, so reach for it plainly.
  const vars = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const fixed = vars.MIXIT_LAYOUT_SEED;
  const runs = Number(vars.MIXIT_LAYOUT_RUNS ?? 80);
  it(fixed ? `replays seed ${fixed}` : `${runs} sequences of 60 steps keep every rule`, () => {
    if (fixed) return sequence(Number(fixed), 60);
    for (let seed = 1; seed <= runs; seed++) sequence(seed, 60);
  }, 60_000 + runs * 200);
});
