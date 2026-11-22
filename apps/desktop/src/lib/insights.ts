// What a collection looks like: tempos, keys, energy, genres, plays and what was added
// when, with plain-language notes on gaps and habits. Computed from the track rows, so
// it works the same on every backend.
import type { TrackRow } from "../backend/types";

export interface Bucket {
  /** The search that lists these tracks. */
  query: string;
  label: string;
  count: number;
}

export interface Insights {
  tracks: number;
  seconds: number;
  analysed: number;
  missing: number;
  neverPlayed: number;
  unrated: number;
  /** Tempo in 2-BPM steps, from the slowest to the fastest common tempo. */
  tempo: Bucket[];
  /** The 8-BPM window holding the most tracks (null when too few have a tempo). */
  sweetSpot: { from: number; to: number; share: number } | null;
  /** Camelot keys "1A".."12B" with counts. */
  keys: Record<string, number>;
  /** Energy 1..10. */
  energy: Bucket[];
  genres: Bucket[];
  /** Tracks added per month, the last 12 months, oldest first. */
  added: Bucket[];
  mostPlayed: TrackRow[];
  notes: string[];
}

const DAY = 86_400;

function months(now: number): { start: number; label: string; query: string }[] {
  const d = new Date(now * 1000);
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ start: m.getTime() / 1000, label: m.toLocaleDateString(undefined, { month: "short" }), query: "" });
  }
  return out;
}

const camelotKeys = (): string[] => Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

/** Camelot neighbours: same number other letter, and one either side with the same letter. */
export function camelotNeighbours(k: string): string[] {
  const n = Number(k.slice(0, -1));
  const l = k.slice(-1);
  const wrap = (x: number) => ((x + 11) % 12) + 1;
  return [`${n}${l === "A" ? "B" : "A"}`, `${wrap(n - 1)}${l}`, `${wrap(n + 1)}${l}`];
}

export function insights(rows: TrackRow[], now = Date.now() / 1000): Insights {
  const tracks = rows.length;
  const seconds = rows.reduce((a, r) => a + (r.duration || 0), 0);
  const analysed = rows.filter((r) => r.analysis === "done").length;
  const missing = rows.filter((r) => r.missing).length;
  const neverPlayed = rows.filter((r) => r.playCount === 0).length;
  const unrated = rows.filter((r) => !r.rating).length;

  // Tempo.
  const bpms = rows.map((r) => r.bpm).filter((b): b is number => b != null && b >= 40 && b <= 220);
  const tempo: Bucket[] = [];
  let sweetSpot: Insights["sweetSpot"] = null;
  if (bpms.length) {
    const sorted = [...bpms].sort((a, b) => a - b);
    // Leave out the slowest and fastest 2% so one odd track does not stretch the chart.
    const lo = Math.floor(sorted[Math.floor(sorted.length * 0.02)] / 2) * 2;
    const hi = Math.ceil((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] + 0.001) / 2) * 2;
    for (let b = lo; b < Math.max(hi, lo + 2); b += 2) {
      const count = bpms.filter((x) => x >= b && x < b + 2).length;
      tempo.push({ query: `bpm:${b}-${b + 1.99}`, label: `${b}`, count });
    }
    if (bpms.length >= 10) {
      let best = { from: 0, n: -1 };
      for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (j < sorted.length && sorted[j] < sorted[i] + 8) j++;
        if (j - i > best.n) best = { from: sorted[i], n: j - i };
      }
      const from = Math.floor(best.from);
      sweetSpot = { from, to: from + 8, share: best.n / bpms.length };
    }
  }

  // Keys.
  const keys: Record<string, number> = Object.fromEntries(camelotKeys().map((k) => [k, 0]));
  for (const r of rows) if (r.key && r.key.camelot in keys) keys[r.key.camelot]++;

  // Energy.
  const energy: Bucket[] = Array.from({ length: 10 }, (_, i) => ({ query: `energy:${i + 1}`, label: String(i + 1), count: rows.filter((r) => r.energy === i + 1).length }));

  // Genres.
  const g = new Map<string, number>();
  for (const r of rows) {
    const name = r.genre.trim();
    if (name) g.set(name, (g.get(name) ?? 0) + 1);
  }
  const genres = [...g.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, count]) => ({ query: `genre:"${name}"`, label: name, count }));
  const noGenre = rows.filter((r) => !r.genre.trim()).length;

  // Added per month.
  const ms = months(now);
  const added: Bucket[] = ms.map((m, i) => {
    const end = ms[i + 1]?.start ?? Infinity;
    const count = rows.filter((r) => r.addedAt >= m.start && r.addedAt < end).length;
    const ageDays = Math.max(1, Math.ceil((now - m.start) / DAY));
    return { query: i === ms.length - 1 ? `added:<${ageDays}d` : "", label: m.label, count };
  });

  const mostPlayed = rows
    .filter((r) => r.playCount > 0)
    .sort((a, b) => b.playCount - a.playCount || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))
    .slice(0, 8);

  // Notes in plain words.
  const notes: string[] = [];
  if (tracks === 0) notes.push("Your library is empty. Add a music folder to see what it holds.");
  if (sweetSpot && sweetSpot.share >= 0.4)
    notes.push(`${Math.round(sweetSpot.share * 100)}% of your music sits between ${sweetSpot.from} and ${sweetSpot.to} BPM, so most tracks mix with each other at a small tempo change.`);
  const keyed = Object.values(keys).reduce((a, b) => a + b, 0);
  if (keyed >= 24) {
    const thin = Object.entries(keys)
      .filter(([, n]) => n <= Math.max(1, keyed * 0.01))
      .map(([k]) => k);
    if (thin.length >= 3 && thin.length < 24) notes.push(`Few tracks in ${thin.slice(0, 4).join(", ")}${thin.length > 4 ? "…" : ""}: a mix that drifts there has fewer next tracks in key. A key shift on the deck helps.`);
    const top = Object.entries(keys).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / keyed >= 0.12) notes.push(`${top[0]} is your most common key (${top[1]} tracks). Its neighbours ${camelotNeighbours(top[0]).join(", ")} mix with it.`);
  }
  if (tracks && neverPlayed / tracks >= 0.3) notes.push(`${neverPlayed} tracks (${Math.round((neverPlayed / tracks) * 100)}%) have never been played. Search played:never to dig them out.`);
  if (tracks && analysed < tracks) notes.push(`${tracks - analysed} tracks still need analysing for tempo, key and energy.`);
  if (missing) notes.push(`${missing} tracks point to files that are not there. Fix library can find them.`);
  if (tracks >= 20 && noGenre / tracks >= 0.2) notes.push(`${noGenre} tracks have no genre. Adding one makes suggestions and searches better.`);
  const highE = energy.slice(7).reduce((a, b) => a + b.count, 0);
  const lowE = energy.slice(0, 3).reduce((a, b) => a + b.count, 0);
  const withE = energy.reduce((a, b) => a + b.count, 0);
  if (withE >= 20 && lowE / withE < 0.08) notes.push("You have few calm tracks (energy 1 to 3). Warm-up sets and breathers need some.");
  else if (withE >= 20 && highE / withE < 0.08) notes.push("You have few peak tracks (energy 8 to 10) for the top of a set.");

  return { tracks, seconds, analysed, missing, neverPlayed, unrated, tempo, sweetSpot, keys, energy, genres, added, mostPlayed, notes };
}
