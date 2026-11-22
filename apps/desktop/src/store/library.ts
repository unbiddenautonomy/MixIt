import { create } from "zustand";
import type { LibraryStats, PlaylistDto, SuggestionRow, TrackRow } from "../backend/types";

export type Source = { type: "all" } | { type: "playlist"; id: number } | { type: "history" } | { type: "suggest" } | { type: "autodj" } | { type: "care" };

export type SortKey = "title" | "artist" | "bpm" | "key" | "energy" | "duration" | "rating" | "genre" | "addedAt" | "playCount" | null;

interface LibraryState {
  source: Source;
  query: string;
  rows: TrackRow[];
  loading: boolean;
  selected: number[];
  anchor: number | null;
  sort: SortKey;
  sortDir: 1 | -1;
  playlists: PlaylistDto[];
  stats: LibraryStats | null;
  suggestions: SuggestionRow[];
  suggestFor: number | null;
  energy: "steady" | "up" | "down";
  inspect: number | null;
  /** Library care: missing tracks and groups of duplicates (null until checked). */
  missing: TrackRow[] | null;
  duplicates: TrackRow[][] | null;
  set: (p: Partial<LibraryState>) => void;
}

export const useLibrary = create<LibraryState>((set) => ({
  source: { type: "all" },
  query: "",
  rows: [],
  loading: false,
  selected: [],
  anchor: null,
  sort: null,
  sortDir: 1,
  playlists: [],
  stats: null,
  suggestions: [],
  suggestFor: null,
  energy: "steady",
  inspect: null,
  missing: null,
  duplicates: null,
  set: (p) => set(p),
}));

export function sortRows(rows: TrackRow[], key: SortKey, dir: 1 | -1): TrackRow[] {
  if (!key) return rows;
  const v = (t: TrackRow): number | string => {
    switch (key) {
      case "key":
        return t.key ? Number(t.key.camelot.slice(0, -1)) * 2 + (t.key.camelot.endsWith("B") ? 1 : 0) : 999;
      case "bpm":
        return t.bpm ?? 0;
      case "energy":
        return t.energy ?? 0;
      case "title":
      case "artist":
      case "genre":
        return t[key].toLowerCase();
      default:
        return t[key] as number;
    }
  };
  return [...rows].sort((a, b) => {
    const x = v(a);
    const y = v(b);
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
}
