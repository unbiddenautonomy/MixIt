// The saved layouts: one for each set of screens MixIt has been used with ("the laptop
// alone", "the laptop and the monitor at home"), so plugging the same screens in again
// brings back the layout made for them. The book is what gets written, as one piece of
// text, through the backend (the library's settings in the app, browser storage in the
// browser).
//
// Reading never throws and never loses anything: a layout that can't be read is set aside
// inside the book rather than overwritten, and a book written by a newer MixIt is not
// written over at all.
import { isObj } from "./persist";
import { loadLayout } from "./check";
import type { Env, Layout } from "./model";

export const BOOK_VERSION = 1;
/** Sets of screens remembered. The one used longest ago goes first when there are more. */
export const MAX_SETUPS = 24;
/** Layouts that couldn't be read, kept for finding out why. */
export const MAX_SET_ASIDE = 4;
/** What the backend will keep (the same cap as the app's `layouts_set`), less room to spare. */
export const MAX_BOOK_TEXT = 900 * 1024;
const MAX_KEY = 2000;

export interface Setup {
  /** As it was saved; read through `loadLayout` before use. */
  layout: unknown;
  /** When it was last used (ms), to choose which to forget. */
  used: number;
}

export interface SetAside {
  key: string;
  layout: unknown;
  at: number;
  why: string;
}

export interface Book {
  version: 1;
  /** Counts up with every save, so the newer of two copies can be told apart. */
  saved: number;
  setups: Record<string, Setup>;
  setAside: SetAside[];
}

export const emptyBook = (): Book => ({ version: 1, saved: 0, setups: {}, setAside: [] });

export interface ReadBook {
  book: Book;
  /** "newer": written by a newer MixIt, so it must not be saved over. "bad": unreadable, set aside. */
  problem?: "newer" | "bad";
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Reads the saved text. Nothing saved yet gives an empty book. */
export function readBook(text: string | null | undefined): ReadBook {
  if (text == null || text === "") return { book: emptyBook() };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { book: aside(emptyBook(), "*", text, 0, "not JSON"), problem: "bad" };
  }
  if (!isObj(data)) return { book: aside(emptyBook(), "*", text, 0, "not an object"), problem: "bad" };
  if (num(data.version) && data.version > BOOK_VERSION) return { book: emptyBook(), problem: "newer" };
  if (data.version !== BOOK_VERSION) return { book: aside(emptyBook(), "*", text, 0, `version ${String(data.version)}`), problem: "bad" };
  const book = emptyBook();
  book.saved = num(data.saved) && data.saved >= 0 ? Math.trunc(data.saved) : 0;
  if (isObj(data.setups))
    for (const [key, v] of Object.entries(data.setups)) {
      if (key.length > MAX_KEY || !isObj(v) || !("layout" in v)) continue;
      book.setups[key] = { layout: v.layout, used: num(v.used) ? v.used : 0 };
    }
  if (Array.isArray(data.setAside))
    for (const v of data.setAside.slice(-MAX_SET_ASIDE))
      if (isObj(v) && typeof v.key === "string") book.setAside.push({ key: v.key.slice(0, MAX_KEY), layout: v.layout, at: num(v.at) ? v.at : 0, why: typeof v.why === "string" ? v.why.slice(0, 500) : "" });
  return { book: trim(book, null) };
}

/** Of two copies of the book (the library's and the quick one), the one saved last. Ties go to the first. */
export function newerOf(a: ReadBook, b: ReadBook): ReadBook {
  if (a.problem === "newer") return a;
  if (b.problem === "newer") return b;
  return b.book.saved > a.book.saved ? b : a;
}

export type Picked =
  /** The layout saved for these screens. */
  | { layout: Layout; from: "saved"; book: Book; problem?: undefined }
  /** Nothing saved for these screens (or it couldn't be read, and is now set aside). */
  | { layout: null; from: "none"; book: Book; problem?: "newer" | "bad" };

/** The layout saved for a set of screens, brought within the rules for `env`. */
export function pickLayout(book: Book, key: string, env: Env): Picked {
  const entry = book.setups[key];
  if (!entry) return { layout: null, from: "none", book };
  const r = loadLayout(entry.layout, env);
  if (r.layout) return { layout: r.layout, from: "saved", book };
  // Set aside, not dropped: the next save can't overwrite what we couldn't read.
  const next = aside(withoutSetup(book, key), key, entry.layout, entry.used, r.detail);
  return { layout: null, from: "none", book: next, problem: r.problem };
}

/** The setup used most recently, other than `key`: where a new set of screens starts from. */
export function lastUsed(book: Book, except?: string): string | null {
  let best: string | null = null;
  for (const [k, v] of Object.entries(book.setups)) if (k !== except && (best === null || v.used > book.setups[best].used)) best = k;
  return best;
}

/** The book with `layout` kept for `key`. Old setups are forgotten past the caps; `key` itself never is. */
export function putLayout(book: Book, key: string, layout: Layout, now: number): Book {
  const next: Book = { ...book, saved: book.saved + 1, setups: { ...book.setups, [key]: { layout, used: now } } };
  return trim(next, key);
}

function withoutSetup(book: Book, key: string): Book {
  const setups = { ...book.setups };
  delete setups[key];
  return { ...book, setups };
}

function aside(book: Book, key: string, layout: unknown, at: number, why: string): Book {
  return { ...book, setAside: [...book.setAside, { key, layout, at, why }].slice(-MAX_SET_ASIDE) };
}

/** Keeps the book within its caps: setups by count, then everything by size, oldest first. */
function trim(book: Book, keep: string | null): Book {
  let b = book;
  const oldest = () => {
    let k: string | null = null;
    for (const [key, v] of Object.entries(b.setups)) if (key !== keep && (k === null || v.used < b.setups[k].used)) k = key;
    return k;
  };
  while (Object.keys(b.setups).length > MAX_SETUPS) {
    const k = oldest();
    if (k === null) break;
    b = withoutSetup(b, k);
  }
  while (JSON.stringify(b).length > MAX_BOOK_TEXT) {
    if (b.setAside.length) b = { ...b, setAside: b.setAside.slice(1) };
    else {
      const k = oldest();
      if (k === null) break;
      b = withoutSetup(b, k);
    }
  }
  return b;
}
