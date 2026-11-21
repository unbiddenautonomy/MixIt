import { create } from "zustand";
import type { HistoryEntry, LibraryStats, PlaylistDto, SessionDto, SuggestionRow, TagDto, TrackRow } from "../backend/types";

export type Source = { type: "all" } | { type: "playlist"; id: number } | { type: "history"; session?: number } | { type: "suggest" } | { type: "autodj" } | { type: "care" } | { type: "insights" } | { type: "tag"; name: string } | { type: "similar"; id: number; title: string };

export type SortKey = "title" | "artist" | "bpm" | "key" | "energy" | "duration" | "rating" | "genre" | "addedAt" | "playCount" | "album" | "label" | "comment" | "year" | "lastPlayed" | "lufs" | null;

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
  /** For "Sounds like": how alike each row sounds to the chosen track (0..1). */
  matches: Record<number, number>;
  energy: "steady" | "up" | "down";
  inspect: number | null;
  /** Library care: missing tracks and groups of duplicates (null until checked). */
  missing: TrackRow[] | null;
  duplicates: TrackRow[][] | null;
  /** Your own tags with their counts, and the tags of the rows on show. */
  tags: TagDto[];
  rowTags: Record<number, string[]>;
  /** Past sets (newest first), this session's id, and the plays behind the history on show. */
  sessions: SessionDto[];
  currentSession: number | null;
  historyEntries: HistoryEntry[];
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
  matches: {},
  energy: "steady",
  inspect: null,
  missing: null,
  duplicates: null,
  tags: [],
  rowTags: {},
  sessions: [],
  currentSession: null,
  historyEntries: [],
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
      case "album":
      case "label":
      case "comment":
        return t[key].toLowerCase();
      case "year":
      case "lastPlayed":
      case "lufs":
        return t[key] ?? -Infinity;
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
