// Past sets: naming a session by its day, how long it ran, and its tracklist.
import type { HistoryEntry, SessionDto } from "../backend/types";
import { tracklistText } from "./tracklist";

/** "Tonight", "Last night", "Fri 14 Nov" or "14 Nov 2025", or the name it was given. */
export function setLabel(s: Pick<SessionDto, "name" | "firstPlayed">, now = Date.now()): string {
  if (s.name.trim() && !/^Session \d{4}-/.test(s.name)) return s.name.trim();
  const d = new Date(s.firstPlayed * 1000);
  const today = new Date(now);
  const days = Math.round((new Date(today).setHours(12, 0, 0, 0) - new Date(d).setHours(12, 0, 0, 0)) / 86_400_000);
  // A set that ran past midnight still belongs to the evening it started.
  const evening = d.getHours() >= 17 || d.getHours() < 5;
  if (days === 0) return evening ? "Tonight" : "Today";
  if (days === 1) return evening ? "Last night" : "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** Seconds from the first track starting to the last one ending (its length when known). */
export function setSeconds(entries: HistoryEntry[], durationOf: (id: number | null) => number | undefined = () => undefined): number {
  if (!entries.length) return 0;
  const last = entries[entries.length - 1];
  const tail = Math.min(durationOf(last.track_id) ?? 240, 600);
  return last.played_at - entries[0].played_at + tail;
}

/** "01. [0:00] Artist - Title" lines, timed from the first track. */
export function historyTracklist(entries: HistoryEntry[]): string {
  const start = entries[0]?.played_at ?? 0;
  return tracklistText(entries.map((e) => ({ at: e.played_at - start, title: e.title, artist: e.artist, heard: 0 })));
}
