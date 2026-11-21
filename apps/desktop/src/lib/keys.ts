// Musical keys: Camelot wheel maths and colours (mirrors crates/mixit-core/src/key.rs).
import type { KeyDto } from "../backend/types";

const NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
// Camelot number for each tonic: major (B) and minor (A).
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const MINOR_CAMELOT = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

export interface Key {
  tonic: number; // 0..11
  minor: boolean;
}

export function keyFromIndex(i: number): Key {
  return { tonic: i % 12, minor: i >= 12 };
}

export function keyIndex(k: Key): number {
  return k.tonic + (k.minor ? 12 : 0);
}

export function camelot(k: Key): { n: number; letter: "A" | "B" } {
  return { n: (k.minor ? MINOR_CAMELOT : MAJOR_CAMELOT)[k.tonic], letter: k.minor ? "A" : "B" };
}

export function fromCamelot(n: number, letter: "A" | "B"): Key {
  const table = letter === "A" ? MINOR_CAMELOT : MAJOR_CAMELOT;
  return { tonic: table.indexOf(n), minor: letter === "A" };
}

export function keyDto(k: Key): KeyDto {
  const c = camelot(k);
  const ok = ((c.n + 4) % 12) + 1;
  return {
    index: keyIndex(k),
    camelot: `${c.n}${c.letter}`,
    openKey: `${ok}${k.minor ? "m" : "d"}`,
    name: `${NAMES[k.tonic]}${k.minor ? "m" : ""}`,
  };
}

export function transpose(k: Key, semitones: number): Key {
  return { tonic: (((k.tonic + Math.round(semitones)) % 12) + 12) % 12, minor: k.minor };
}

/** Steps around the wheel (0–6), plus one for a change of letter. */
export function camelotDistance(a: Key, b: Key): number {
  const ca = camelot(a);
  const cb = camelot(b);
  const d = Math.abs(ca.n - cb.n);
  const steps = Math.min(d, 12 - d);
  return steps + (ca.letter === cb.letter ? 0 : 1);
}

export function compatible(a: Key, b: Key): boolean {
  const ca = camelot(a);
  const cb = camelot(b);
  if (ca.letter === cb.letter) {
    const d = Math.abs(ca.n - cb.n);
    return Math.min(d, 12 - d) <= 1;
  }
  return ca.n === cb.n;
}

/** Smallest shift (|s| ≤ max) that makes `k` compatible with `target`. */
export function bestShift(k: Key, target: Key, max = 2): number | null {
  let best: number | null = null;
  for (let s = -max; s <= max; s++) {
    if (compatible(transpose(k, s), target) && (best === null || Math.abs(s) < Math.abs(best))) best = s;
  }
  return best;
}

export type Compat = "same" | "match" | "boost" | "shift" | "clash";

export function compatibility(a: Key, b: Key): Compat {
  if (a.tonic === b.tonic && a.minor === b.minor) return "same";
  if (compatible(a, b)) return "match";
  const ca = camelot(a);
  const cb = camelot(b);
  if (ca.letter === cb.letter && (cb.n - ca.n + 12) % 12 === 2) return "boost";
  if (bestShift(b, a, 2) !== null) return "shift";
  return "clash";
}

/** The colour of a Camelot position, around the wheel like the Mixed In Key wheel. */
export function keyColor(k: KeyDto | Key | null | undefined, alpha = 1): string {
  if (!k) return `hsla(0, 0%, 55%, ${alpha})`;
  const key = "index" in k ? keyFromIndex(k.index) : k;
  const c = camelot(key);
  const hue = ((c.n - 1) * 30 + 150) % 360;
  const light = c.letter === "A" ? 62 : 72;
  return `hsla(${hue}, 72%, ${light}%, ${alpha})`;
}

export function keyLabel(k: KeyDto | null | undefined, notation: "camelot" | "openKey" | "standard"): string {
  if (!k) return "–";
  return notation === "camelot" ? k.camelot : notation === "openKey" ? k.openKey : k.name;
}

export function shiftedKey(k: KeyDto | null | undefined, semitones: number): KeyDto | null {
  if (!k) return null;
  return keyDto(transpose(keyFromIndex(k.index), semitones));
}
