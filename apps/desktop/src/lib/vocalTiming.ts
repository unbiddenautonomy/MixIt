// Mixing around the singing: a transition that starts while the outgoing track is mid-verse
// puts two voices on top of each other, or cuts a line in half. When the vocal ends (or has
// not started yet) a few bars away, starting there instead keeps every line whole.

/** Seconds of singing in `regions` between `a` and `b` (seconds). */
export function vocalOverlap(regions: [number, number][] | undefined, a: number, b: number): number {
  if (!regions?.length || b <= a) return 0;
  return regions.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
}

export interface ClearStartInput {
  /** Where the outgoing track sings (seconds). */
  regions: [number, number][] | undefined;
  /** Track seconds at a beat of the outgoing track. */
  secondsAt: (beat: number) => number;
  /** The start the transition would use otherwise (a beat on a bar line). */
  candidate: number;
  /** Length of the transition in beats. */
  beats: number;
  beatsPerBar: number;
  /** The transition must end by this beat (the end of the music). */
  endBeat: number;
  /** The earliest beat it may start (now, or the candidate when it may only move later). */
  earliest: number;
  /** How far from the candidate to look, in beats (default two phrases). */
  maxMove?: number;
}

export interface ClearStart {
  start: number;
  /** Whether it moved off the candidate to get clear of the singing. */
  moved: boolean;
  /** Seconds of outgoing singing the transition would have run over at the candidate. */
  before: number;
}

/** Less than this much singing under a transition counts as clear (a breath, a last word). */
const CLEAR_S = 0.75;

/**
 * The bar-line start nearest `candidate` (phrase starts first) where the outgoing track does
 * not sing for the whole transition, within `maxMove` beats, never before `earliest` and
 * finishing by `endBeat`. When the candidate is already clear, or nothing nearby is, the
 * candidate stays (the mid dip then keeps two voices apart).
 */
export function vocalClearStart(o: ClearStartInput): ClearStart {
  const bpb = Math.max(1, o.beatsPerBar);
  const phrase = bpb * 8;
  const len = Math.max(o.beats, bpb);
  const over = (start: number) => vocalOverlap(o.regions, o.secondsAt(start), o.secondsAt(start + len));
  const before = over(o.candidate);
  if (before < CLEAR_S) return { start: o.candidate, moved: false, before };
  const reach = o.maxMove ?? phrase * 2;
  let best: { start: number; score: number } | null = null;
  for (let k = -Math.floor(reach / bpb); k <= Math.floor(reach / bpb); k++) {
    const start = o.candidate + k * bpb;
    if (k === 0 || start < o.earliest - 1e-6 || start + len > o.endBeat + 1e-6) continue;
    if (over(start) >= CLEAR_S) continue;
    // Whole phrases away first (builds and drops still line up), then the nearest bar,
    // later before earlier.
    const onPhrase = (k * bpb) % phrase === 0;
    const score = (onPhrase ? 0 : 1000) + Math.abs(k * bpb) + (k < 0 ? 0.5 : 0);
    if (!best || score < best.score) best = { start, score };
  }
  return best ? { start: best.start, moved: true, before } : { start: o.candidate, moved: false, before };
}
