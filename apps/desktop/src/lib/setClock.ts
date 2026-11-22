// The set clock: when your set ends (you are on until 2 AM, or for an hour), how much
// time is left, and whether the tracks on the decks fit in it. Kept on this computer only.
import { create } from "zustand";
import { clock } from "./format";

const KEY = "mixit.setClock.v1";

function load(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > Date.now() ? v : null;
  } catch {
    return null;
  }
}

export const useSetClock = create<{ endsAt: number | null }>(() => ({ endsAt: load() }));

/** Ends the set `minutes` from now, at the clock time `at` ("02:00", today or after midnight), or never (null). */
export function setSetEnd(end: { minutes: number } | { at: string } | null, now = Date.now()): void {
  let endsAt: number | null = null;
  if (end && "minutes" in end) endsAt = now + end.minutes * 60_000;
  else if (end && "at" in end) endsAt = endAt(end.at, now);
  useSetClock.setState({ endsAt });
  try {
    if (endsAt) localStorage.setItem(KEY, String(endsAt));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: the clock still runs for this session */
  }
}

/** The next moment the wall clock reads `hhmm` ("23:30", "2:00"), or null if it is not a time. */
export function endAt(hhmm: string, now = Date.now()): number | null {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(hhmm);
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Seconds left in the set (negative once it is over), or null with no clock set. */
export function setSecondsLeft(endsAt: number | null, now = Date.now()): number | null {
  return endsAt == null ? null : (endsAt - now) / 1000;
}

/** "42:10 left", "Over by 1:05". */
export function setLeftLabel(secs: number): string {
  return secs >= 0 ? `${clock(secs)} left` : `Over by ${clock(-secs)}`;
}

/** Whole minutes of set left, rounded to five (for Build a set), or null. */
export function setMinutesLeft(endsAt: number | null, now = Date.now()): number | null {
  const s = setSecondsLeft(endsAt, now);
  return s == null || s < 300 ? null : Math.max(5, Math.round(s / 300) * 5);
}
