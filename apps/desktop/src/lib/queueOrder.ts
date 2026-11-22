// Putting a queue in an order that mixes well: every change of track as easy as it can be
// (keys that fit, small tempo steps, no energy cliffs), with the energy going the way the
// listener asked. Pure, so the ordering is testable.
import type { TrackRow } from "../backend/types";
import { transition, type Grade } from "./setFlow";

export type EnergyAim = "steady" | "up" | "down";

const GRADE_COST: Record<Grade, number> = { smooth: 0, ok: 3, rough: 12 };

/** How hard the change from `a` into `b` is (lower is easier). */
export function changeCost(a: TrackRow, b: TrackRow, aim: EnergyAim = "steady"): number {
  const t = transition(a, b);
  let c = GRADE_COST[t.grade] + Math.abs(t.tempoPct ?? 0) / 2;
  if (t.energyDelta != null) {
    if (aim === "up") c += t.energyDelta < 0 ? -t.energyDelta * 1.5 : 0;
    else if (aim === "down") c += t.energyDelta > 0 ? t.energyDelta * 1.5 : 0;
    else c += Math.abs(t.energyDelta) * 0.5;
  }
  return c;
}

export function orderCost(rows: TrackRow[], aim: EnergyAim = "steady"): number {
  let c = 0;
  for (let i = 1; i < rows.length; i++) c += changeCost(rows[i - 1], rows[i], aim);
  return c;
}

/**
 * The queue in the easiest order to mix. `from` is the track playing now (the first change
 * is out of it), or null; the first `keep` tracks stay where they are (the next track may
 * already be loaded). Greedy from the start, then improved by reversing stretches (2-opt)
 * while that helps. Small queues (up to 8 free tracks) are solved exactly.
 */
export function bestOrder(rows: TrackRow[], aim: EnergyAim = "steady", from: TrackRow | null = null, keep = 0): TrackRow[] {
  const fixed = rows.slice(0, keep);
  const free = rows.slice(keep);
  if (free.length < 2) return rows.slice();
  const head = [...(from ? [from] : []), ...fixed];
  const cost = (order: TrackRow[]) => orderCost([...head, ...order], aim);
  let best: TrackRow[];
  if (free.length <= 8) {
    best = free;
    let bestCost = cost(free);
    const used = new Array(free.length).fill(false);
    const path: TrackRow[] = [];
    const walk = (sofar: number) => {
      if (sofar >= bestCost) return;
      if (path.length === free.length) {
        bestCost = sofar;
        best = path.slice();
        return;
      }
      const prev = path.length ? path[path.length - 1] : (head[head.length - 1] ?? null);
      for (let i = 0; i < free.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        path.push(free[i]);
        walk(sofar + (prev ? changeCost(prev, free[i], aim) : 0));
        path.pop();
        used[i] = false;
      }
    };
    walk(0);
    return [...fixed, ...best];
  }
  // Greedy: always the easiest next change.
  const left = free.slice();
  best = [];
  let prev: TrackRow | null = head[head.length - 1] ?? null;
  if (!prev) {
    // No track before: start from the one whose easiest way on is cheapest.
    let i0 = 0;
    let c0 = Infinity;
    left.forEach((a, i) => {
      const c = Math.min(...left.filter((b) => b !== a).map((b) => changeCost(a, b, aim)));
      if (c < c0) [i0, c0] = [i, c];
    });
    prev = left.splice(i0, 1)[0];
    best.push(prev);
  }
  while (left.length) {
    let bi = 0;
    for (let i = 1; i < left.length; i++) if (changeCost(prev!, left[i], aim) < changeCost(prev!, left[bi], aim)) bi = i;
    prev = left.splice(bi, 1)[0];
    best.push(prev);
  }
  // 2-opt: reverse any stretch that makes the whole easier, until nothing does.
  let c = cost(best);
  for (let pass = 0, better = true; better && pass < 50; pass++) {
    better = false;
    for (let i = 0; i < best.length - 1; i++)
      for (let j = i + 1; j < best.length; j++) {
        const trial = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const tc = cost(trial);
        if (tc < c - 1e-9) {
          best = trial;
          c = tc;
          better = true;
        }
      }
  }
  return [...fixed, ...best];
}
