// How a set flows from track to track: whether each change of track is easy to mix (keys
// that fit, tempos close enough, no sudden energy cliff), and which tracks from the
// library could sit between two that do not go together.
import type { TrackRow } from "../backend/types";
import { compatibility, keyFromIndex, type Compat } from "./keys";

export type Grade = "smooth" | "ok" | "rough";

export interface Transition {
  key: Compat | null;
  /** Tempo change to match the next track (percent, after doubling or halving), when both are known. */
  tempoPct: number | null;
  energyDelta: number | null;
  grade: Grade;
  /** What makes it harder, in plain words (empty when smooth). */
  reasons: string[];
}

/** The tempo change from `a` to `b` in percent, allowing double and half time. */
export function tempoChange(a: number | null, b: number | null): number | null {
  if (!a || !b) return null;
  const best = [b, b * 2, b / 2].reduce((m, r) => (Math.abs(r / a - 1) < Math.abs(m / a - 1) ? r : m));
  return (best / a - 1) * 100;
}

const RANK: Record<Grade, number> = { smooth: 0, ok: 1, rough: 2 };
const worse = (a: Grade, b: Grade): Grade => (RANK[a] >= RANK[b] ? a : b);

export function transition(a: TrackRow, b: TrackRow): Transition {
  const reasons: string[] = [];
  let grade: Grade = "smooth";
  const key = a.key && b.key ? compatibility(keyFromIndex(a.key.index), keyFromIndex(b.key.index)) : null;
  if (key === "clash") {
    grade = "rough";
    reasons.push(`Keys clash (${a.key!.camelot} to ${b.key!.camelot})`);
  } else if (key === "shift") {
    grade = worse(grade, "ok");
    reasons.push(`Keys fit after a key shift (${a.key!.camelot} to ${b.key!.camelot})`);
  }
  const tempoPct = tempoChange(a.bpm, b.bpm);
  if (tempoPct != null) {
    const d = Math.abs(tempoPct);
    if (d > 8) {
      grade = "rough";
      reasons.push(`Tempo jumps ${Math.round(d)}%`);
    } else if (d > 4) {
      grade = worse(grade, "ok");
      reasons.push(`Tempo changes ${Math.round(d)}%`);
    }
  }
  const energyDelta = a.energy != null && b.energy != null ? b.energy - a.energy : null;
  if (energyDelta != null && Math.abs(energyDelta) >= 4) {
    grade = worse(grade, "ok");
    reasons.push(energyDelta > 0 ? "Energy leaps up" : "Energy drops sharply");
  }
  return { key, tempoPct, energyDelta, grade, reasons };
}

export function flow(rows: TrackRow[]): Transition[] {
  return rows.slice(1).map((b, i) => transition(rows[i], b));
}

export function summary(ts: Transition[]): Record<Grade, number> {
  const s: Record<Grade, number> = { smooth: 0, ok: 0, rough: 0 };
  for (const t of ts) s[t.grade]++;
  return s;
}

export interface Bridge {
  track: TrackRow;
  into: Transition;
  out: Transition;
  score: number;
}

/**
 * Tracks that could go between `a` and `b`: both changes at worst "ok". The best have
 * smooth changes on both sides, a tempo between the two and an energy that steps
 * from one to the other.
 */
export function bridges(a: TrackRow, b: TrackRow, library: TrackRow[], exclude: Set<number>, limit = 5): Bridge[] {
  const out: Bridge[] = [];
  for (const c of library) {
    if (exclude.has(c.id) || c.id === a.id || c.id === b.id || c.missing || !c.key || !c.bpm) continue;
    const into = transition(a, c);
    const next = transition(c, b);
    if (into.grade === "rough" || next.grade === "rough") continue;
    let score = RANK[into.grade] + RANK[next.grade];
    score += (Math.abs(into.tempoPct ?? 0) + Math.abs(next.tempoPct ?? 0)) / 8;
    if (a.energy != null && b.energy != null && c.energy != null) {
      const lo = Math.min(a.energy, b.energy);
      const hi = Math.max(a.energy, b.energy);
      score += c.energy < lo ? (lo - c.energy) / 3 : c.energy > hi ? (c.energy - hi) / 3 : 0;
    }
    score -= c.rating * 0.05;
    out.push({ track: c, into, out: next, score });
  }
  return out.sort((x, y) => x.score - y.score).slice(0, limit);
}
