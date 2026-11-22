// Plain words for where a track has singing or rapping (from analysis).
import { clock } from "./format";

/** "Instrumental", "A little singing", "Singing in about 40%" … or null if not known. */
export function vocalLabel(pct: number | null | undefined): string | null {
  if (pct == null) return null;
  if (pct < 5) return "Instrumental";
  if (pct < 15) return "A little singing";
  return `Singing in about ${Math.round(pct / 5) * 5}%`;
}

/** Where the voice comes in, for the inspector: "from 0:45, 3 parts". */
export function vocalWhere(regions: [number, number][] | undefined): string {
  if (!regions?.length) return "";
  const parts = regions.length === 1 ? "one part" : `${regions.length} parts`;
  return `first at ${clock(regions[0][0])}, ${parts}`;
}
