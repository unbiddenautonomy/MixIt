// Small pure helpers for the track editor: tap tempo, beat snapping and the "skip the
// intro" start point.
import type { TrackDetail } from "../backend/types";

/**
 * Tempo from tap times (seconds, oldest first): the median interval of the last eight
 * taps, so one late or early tap does not throw it off. Null until four taps, or after a
 * pause of over 2 seconds (which starts a new count).
 */
export function tapTempo(taps: number[]): number | null {
  let start = taps.length - 1;
  while (start > 0 && taps[start] - taps[start - 1] < 2) start--;
  const recent = taps.slice(Math.max(start, taps.length - 9));
  if (recent.length < 4) return null;
  const gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)];
  const bpm = 60 / mid;
  return bpm >= 40 && bpm <= 250 ? Math.round(bpm * 100) / 100 : null;
}

/** Folds a tapped tempo into the octave closest to the analysed one (taps on half beats). */
export function foldTempo(tapped: number, near: number | null): number {
  if (!near || near <= 0) return tapped;
  let b = tapped;
  while (b / near > 1.4) b /= 2;
  while (near / b > 1.4) b *= 2;
  return Math.round(b * 100) / 100;
}

/** The grid beat time nearest `t` (seconds), for snapping. Falls back to `t` unanalysed. */
export function snapToBeat(d: TrackDetail, t: number, every = 1): number {
  if (!d.analysed || d.beatPeriod <= 0) return t;
  if (!d.constantGrid && d.beats.length) {
    let best = d.beats[0];
    for (const b of d.beats) if (Math.abs(b - t) < Math.abs(best - t)) best = b;
    return best;
  }
  const k = Math.round((t - d.firstBeat) / d.beatPeriod / every) * every;
  return d.firstBeat + k * d.beatPeriod;
}

/** Number of beats between two times on the track's grid. */
export function beatsBetween(d: TrackDetail, a: number, b: number): number {
  if (!d.analysed || d.beatPeriod <= 0) return 0;
  return Math.round(((b - a) / d.beatPeriod) * 100) / 100;
}

/** Where the music gets going: the first section after the intro (or null). */
export function introEnd(d: TrackDetail): number | null {
  const s = d.sections;
  if (s.length < 2) return null;
  const i = s.findIndex((x, k) => k > 0 && x.label !== "Intro");
  return i > 0 ? s[i].start : null;
}
