// Tempo glide: after a mix the new track plays at the old one's tempo (it was synced to
// it). Left there, a whole set stays stretched to the first track's speed, with every
// track a little off its own sound. A DJ lets the tempo drift back, too slowly for a
// dancer to notice. Pure, so the ramp is testable.

/** How fast the tempo moves: percent of the speed per bar (0.5% every 8 bars). */
export const GLIDE_PCT_PER_BAR = 0.0625;

/** Below this difference from its own tempo (percent) a track is left alone. */
export const GLIDE_MIN_PCT = 0.2;

/**
 * The tempo fader for a deck that started at fader `start` (rate 1 + start × range) and has
 * glided for `bars` bars toward its own tempo (fader 0). Never overshoots.
 */
export function glideFader(start: number, range: number, bars: number, pctPerBar = GLIDE_PCT_PER_BAR): number {
  if (range <= 0) return 0;
  const rate0 = 1 + start * range;
  const moved = (Math.max(0, bars) * pctPerBar) / 100;
  const rate = rate0 > 1 ? Math.max(1, rate0 - moved) : Math.min(1, rate0 + moved);
  return (rate - 1) / range;
}

/** Bars the glide takes from fader `start` (how long until the track is at its own tempo). */
export function glideBars(start: number, range: number, pctPerBar = GLIDE_PCT_PER_BAR): number {
  return Math.ceil((Math.abs(start * range) * 100) / pctPerBar - 1e-9);
}
