// Counting the music the way a DJ does: which beat of the bar, which bar of the 8-bar
// phrase, and how long until the next part of the track (the drop, the breakdown).
import type { SectionDto, TrackDetail } from "../backend/types";

type Grid = Pick<TrackDetail, "analysed" | "constantGrid" | "beats" | "firstBeat" | "beatPeriod">;

/** The grid beat at `seconds` (0 = the first downbeat), with its fraction. */
export function beatAt(d: Grid, seconds: number): number | null {
  if (!d.analysed) return null;
  if (!d.constantGrid && d.beats.length > 1) {
    const b = d.beats;
    const b0 = Math.round((b[0] - d.firstBeat) / d.beatPeriod);
    if (seconds <= b[0]) return b0 + (seconds - b[0]) / (b[1] - b[0]);
    if (seconds >= b[b.length - 1]) return b0 + b.length - 1 + (seconds - b[b.length - 1]) / (b[b.length - 1] - b[b.length - 2]);
    let lo = 0;
    let hi = b.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (b[m] <= seconds) lo = m;
      else hi = m;
    }
    return b0 + lo + (seconds - b[lo]) / (b[hi] - b[lo]);
  }
  if (d.beatPeriod <= 0) return null;
  return (seconds - d.firstBeat) / d.beatPeriod;
}

export interface PhraseInfo {
  /** 0 .. beatsPerBar-1. */
  beatInBar: number;
  /** 1..8. */
  barInPhrase: number;
  /** Bars left in this phrase, counting this one. */
  barsLeftInPhrase: number;
  /** The next part of the track and how many bars until it starts. */
  next: { label: string; bars: number } | null;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function phraseInfo(d: Grid & { beatsPerBar: number; sections: SectionDto[] }, seconds: number): PhraseInfo | null {
  const beat = beatAt(d, seconds);
  if (beat == null) return null;
  const bpb = Math.max(1, d.beatsPerBar);
  const whole = Math.floor(beat + 1e-6);
  const bar = Math.floor(whole / bpb);
  const barInPhrase = mod(bar, 8) + 1;
  let next: PhraseInfo["next"] = null;
  for (const s of d.sections) {
    if (s.start <= seconds + 0.05) continue;
    const sb = beatAt(d, s.start);
    if (sb == null) continue;
    next = { label: s.label, bars: Math.max(1, Math.ceil((Math.round(sb) - whole) / bpb)) };
    break;
  }
  return { beatInBar: mod(whole, bpb), barInPhrase, barsLeftInPhrase: 9 - barInPhrase, next };
}
