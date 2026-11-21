// Tidying track details: titles and artists from file names, stray spaces and
// underscores, download-site junk, "ft." spellings, SHOUTING or all-lowercase names, and
// genres spelled several ways. Every rule proposes changes; nothing is applied here.
import type { TrackEdit, TrackRow } from "../backend/types";

export type TidyField = "title" | "artist" | "album" | "genre" | "label";

export interface TidyOptions {
  /** Fill an empty title or artist (or a title that is just the file name) from "Artist - Title" file names. */
  fromFileName: boolean;
  /** Trim and collapse spaces; underscores to spaces. */
  spaces: boolean;
  /** Take out web addresses, "[Free Download]", "Out now" and leading track numbers. */
  junk: boolean;
  /** "ft.", "Ft", "featuring" and "Feat." all become "feat.". */
  feat: boolean;
  /** Names in ALL CAPS or all lowercase get capitals where words start. */
  caps: boolean;
  /** Drop "(Original Mix)" from titles. */
  originalMix: boolean;
  /** One spelling for each genre: the one most of your library uses. */
  genres: boolean;
}

export const DEFAULT_TIDY: TidyOptions = { fromFileName: true, spaces: true, junk: true, feat: true, caps: true, originalMix: false, genres: true };

export const TIDY_RULES: { key: keyof TidyOptions; label: string; about: string }[] = [
  { key: "fromFileName", label: "Fill in from file names", about: "An empty title or artist is read from a file named like “Artist - Title.mp3”." },
  { key: "spaces", label: "Tidy spaces", about: "Takes out doubled and stray spaces, and turns underscores into spaces." },
  { key: "junk", label: "Take out clutter", about: "Web addresses, “[Free Download]”, “Out now” and track numbers at the start of a title." },
  { key: "feat", label: "One way to write “feat.”", about: "“ft.”, “Ft”, “featuring” and “Feat.” all become “feat.”." },
  { key: "caps", label: "Fix SHOUTING and lowercase", about: "Names written all in capitals or all in small letters get a capital at the start of each word." },
  { key: "originalMix", label: "Drop “(Original Mix)”", about: "Most tracks are the original mix; the label only makes titles longer." },
  { key: "genres", label: "One spelling per genre", about: "“deep house”, “Deep house” and “DEEP HOUSE” become the spelling most of your library uses." },
];

export interface TidyChange {
  id: number;
  field: TidyField;
  before: string;
  after: string;
}

const SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "vs", "vs.", "feat.", "with", "x"]);

/** Capitals where words start, small joining words kept small (but not the first word). */
export function titleCase(s: string): string {
  let first = true;
  return s.replace(/[\p{L}\p{N}][\p{L}\p{N}'’.]*/gu, (w) => {
    const lower = w.toLowerCase();
    const out = !first && SMALL.has(lower) ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    first = false;
    return out;
  });
}

const hasLetters = (s: string) => /\p{L}/u.test(s);
/** Written in capitals only (at least two letters) or small letters only. */
export function shouting(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && (letters === letters.toUpperCase() || letters === letters.toLowerCase()) && letters.toUpperCase() !== letters.toLowerCase();
}

export function tidySpaces(s: string): string {
  let out = s;
  if (!/\s/.test(out.trim()) && /_/.test(out)) out = out.replace(/_+/g, " ");
  out = out.replace(/_{2,}/g, " ");
  out = out.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\[\s+/g, "[").replace(/\s+\]/g, "]").replace(/\s+,/g, ",");
  return out.trim();
}

const JUNK = [
  /[[(]\s*(?:free\s*(?:download|dl)|out\s*now|preview|promo(?:\s*only)?|exclusive)\s*[\])]/gi,
  /[[(]?\s*(?:https?:\/\/)?(?:www\.)[^\s\])]+\s*[\])]?/gi,
  /[[(]?\s*(?:https?:\/\/)[^\s\])]+\s*[\])]?/gi,
  /\s+-\s+copy$/i,
];

export function dropJunk(s: string, field: TidyField): string {
  let out = s;
  for (const re of JUNK) out = out.replace(re, " ");
  // Leading track numbers on titles: "01 - Title", "01. Title", "A1 Title".
  if (field === "title") out = out.replace(/^\s*(?:\d{1,3}|[A-D]\d)\s*(?:[-.)_]\s*|\s+)(?=\p{L})/u, "");
  return out.replace(/\s+/g, " ").replace(/\s*-\s*$/, "").trim();
}

export function normaliseFeat(s: string): string {
  return s.replace(/(^|[\s([])(?:featuring|feat|ft)\.?(?=\s)/gi, "$1feat.");
}

export function dropOriginalMix(s: string): string {
  return s.replace(/\s*[([]\s*original(?:\s+mix)?\s*[)\]]/i, "").trim();
}

/** "Artist - Title" from a file path ("01 Artist - Title (Remix).mp3"). */
export function parseFileName(path: string): { artist: string; title: string } | null {
  const stem = (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]{1,5}$/, "");
  let s = tidySpaces(stem.includes(" ") ? stem : stem.replace(/_+/g, " "));
  s = s.replace(/^\s*(?:\d{1,3}|[A-D]\d)\s*(?:[-.)_]\s*|\s+)(?=\p{L})/u, "");
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s);
  if (!m) return null;
  const artist = m[1].trim();
  const title = m[2].trim();
  if (!hasLetters(artist) || !hasLetters(title)) return null;
  return { artist, title };
}

const stemOf = (path: string) => (path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]{1,5}$/, "");

/** The spelling most rows use for each genre (by its lowercase form). */
export function genreSpellings(rows: Pick<TrackRow, "genre">[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const g = tidySpaces(r.genre ?? "");
    if (!g) continue;
    const k = g.toLowerCase();
    const m = counts.get(k) ?? new Map<string, number>();
    m.set(g, (m.get(g) ?? 0) + 1);
    counts.set(k, m);
  }
  const out = new Map<string, string>();
  for (const [k, m] of counts) {
    // Most used; on a tie a spelling with capitals beats a shouting or lowercase one.
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || Number(shouting(a[0])) - Number(shouting(b[0])) || a[0].localeCompare(b[0]))[0][0];
    out.set(k, shouting(best) ? titleCase(best) : best);
  }
  return out;
}

/** The changes the chosen rules make to `rows`. `library` (all rows) sets the genre spellings. */
export function tidyChanges(rows: TrackRow[], opts: TidyOptions, library: TrackRow[] = rows): TidyChange[] {
  const genres = opts.genres ? genreSpellings(library) : null;
  const out: TidyChange[] = [];
  for (const r of rows) {
    const next: Record<TidyField, string> = { title: r.title ?? "", artist: r.artist ?? "", album: r.album ?? "", genre: r.genre ?? "", label: r.label ?? "" };
    if (opts.fromFileName) {
      const parsed = parseFileName(r.path);
      const stem = stemOf(r.path);
      if (parsed) {
        if (!next.title.trim() || next.title.trim() === stem) next.title = parsed.title;
        if (!next.artist.trim()) next.artist = parsed.artist;
      }
    }
    for (const f of ["title", "artist", "album", "label", "genre"] as TidyField[]) {
      let v = next[f];
      if (opts.spaces) v = tidySpaces(v);
      if (opts.junk && f !== "genre") v = dropJunk(v, f);
      if (opts.feat && (f === "title" || f === "artist")) v = normaliseFeat(v);
      if (opts.originalMix && f === "title") v = dropOriginalMix(v);
      // Short one-word artists in capitals are usually meant that way (MGMT, ABBA).
      const acronym = f === "artist" && !/\s/.test(v) && v.length <= 5 && v === v.toUpperCase();
      if (opts.caps && f !== "genre" && !acronym && shouting(v) && v.replace(/[^\p{L}]/gu, "").length > 3) v = titleCase(v);
      if (f === "genre" && genres && v) v = genres.get(tidySpaces(v).toLowerCase()) ?? v;
      next[f] = v;
    }
    for (const f of ["title", "artist", "album", "genre", "label"] as TidyField[]) {
      const before = (r[f] ?? "") as string;
      if (next[f] !== before && next[f].trim()) out.push({ id: r.id, field: f, before, after: next[f] });
    }
  }
  return out;
}

/** The chosen changes as one edit per track. */
export function editsFor(changes: TidyChange[]): Map<number, TrackEdit> {
  const out = new Map<number, TrackEdit>();
  for (const c of changes) {
    const e = out.get(c.id) ?? {};
    e[c.field] = c.after;
    out.set(c.id, e);
  }
  return out;
}
