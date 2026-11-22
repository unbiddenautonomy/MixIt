// Smart playlists without the search language: rules ("Tempo between 120 and 128",
// "Tag is vocal", "Never played") that turn into a search and back, so a playlist made
// either way can be edited either way.
import { searchTerms } from "./search";

export type RuleField = "genre" | "artist" | "title" | "album" | "label" | "comment" | "bpm" | "key" | "energy" | "rating" | "year" | "tag" | "played" | "added" | "vocals";

export interface Rule {
  field: RuleField;
  op: string;
  a: string;
  b?: string;
}

export interface FieldSpec {
  label: string;
  ops: { op: string; label: string; values: 0 | 1 | 2; unit?: string }[];
  placeholder?: string;
}

const TEXT_OPS = [
  { op: "has", label: "contains", values: 1 as const },
  { op: "not", label: "does not contain", values: 1 as const },
];

export const FIELDS: Record<RuleField, FieldSpec> = {
  genre: { label: "Genre", ops: TEXT_OPS, placeholder: "house" },
  artist: { label: "Artist", ops: TEXT_OPS, placeholder: "name" },
  title: { label: "Title", ops: TEXT_OPS, placeholder: "remix" },
  album: { label: "Album", ops: TEXT_OPS },
  label: { label: "Label", ops: TEXT_OPS },
  comment: { label: "Comment", ops: TEXT_OPS },
  bpm: {
    label: "Tempo (BPM)",
    ops: [
      { op: "between", label: "is between", values: 2 },
      { op: "around", label: "mixes with", values: 1 },
      { op: "above", label: "is at least", values: 1 },
      { op: "below", label: "is at most", values: 1 },
    ],
    placeholder: "124",
  },
  key: {
    label: "Key",
    ops: [
      { op: "mixes", label: "mixes with", values: 1 },
      { op: "is", label: "is", values: 1 },
      { op: "not", label: "is not", values: 1 },
    ],
    placeholder: "8A",
  },
  energy: {
    label: "Energy",
    ops: [
      { op: "atleast", label: "is at least", values: 1 },
      { op: "atmost", label: "is at most", values: 1 },
      { op: "between", label: "is between", values: 2 },
    ],
    placeholder: "6",
  },
  rating: {
    label: "Rating",
    ops: [
      { op: "atleast", label: "is at least", values: 1, unit: "stars" },
      { op: "is", label: "is", values: 1, unit: "stars" },
    ],
    placeholder: "4",
  },
  year: {
    label: "Year",
    ops: [
      { op: "between", label: "is between", values: 2 },
      { op: "from", label: "is from", values: 1, unit: "on" },
      { op: "before", label: "is before", values: 1 },
    ],
    placeholder: "2020",
  },
  tag: {
    label: "Tag",
    ops: [
      { op: "has", label: "is", values: 1 },
      { op: "not", label: "is not", values: 1 },
    ],
    placeholder: "vocal",
  },
  played: {
    label: "Last played",
    ops: [
      { op: "never", label: "never", values: 0 },
      { op: "within", label: "in the last", values: 1, unit: "days" },
      { op: "notwithin", label: "not in the last", values: 1, unit: "days" },
    ],
    placeholder: "30",
  },
  vocals: {
    label: "Vocals",
    ops: [
      { op: "yes", label: "has singing", values: 0 },
      { op: "no", label: "is instrumental", values: 0 },
      { op: "atleast", label: "sings in at least", values: 1, unit: "% of the track" },
    ],
    placeholder: "30",
  },
  added: {
    label: "Added",
    ops: [
      { op: "within", label: "in the last", values: 1, unit: "days" },
      { op: "notwithin", label: "more than", values: 1, unit: "days ago" },
    ],
    placeholder: "14",
  },
};

export const SORTS: { key: string; label: string }[] = [
  { key: "", label: "Any order" },
  { key: "bpm", label: "Tempo, slow to fast" },
  { key: "-bpm", label: "Tempo, fast to slow" },
  { key: "energy", label: "Energy, calm first" },
  { key: "-energy", label: "Energy, highest first" },
  { key: "key", label: "Key" },
  { key: "-added", label: "Newest first" },
  { key: "-rating", label: "Best rated first" },
  { key: "played", label: "Least recently played first" },
  { key: "artist", label: "Artist" },
  { key: "random", label: "Shuffled" },
];

export interface Smart {
  rules: Rule[];
  sort: string;
  /** Words and terms the rules cannot show, kept as typed. */
  rest: string;
}

const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
const num = (v: string) => v.trim().replace(",", ".");

/** One rule as a search term, or null while it is incomplete. */
export function ruleTerm(r: Rule): string | null {
  const a = r.a.trim();
  const b = (r.b ?? "").trim();
  const n = (x: string) => x !== "" && Number.isFinite(Number(num(x)));
  switch (r.field) {
    case "genre":
    case "artist":
    case "title":
    case "album":
    case "label":
    case "comment":
    case "tag":
      if (!a) return null;
      return `${r.op === "not" ? "-" : ""}${r.field}:${quote(a)}`;
    case "bpm":
      if (r.op === "between") return n(a) && n(b) ? `bpm:${num(a)}-${num(b)}` : null;
      if (!n(a)) return null;
      return r.op === "around" ? `bpm:~${num(a)}` : r.op === "above" ? `bpm:>=${num(a)}` : `bpm:<=${num(a)}`;
    case "key":
      if (!/^\d{1,2}[ab]$|^\d{1,2}[dm]$|^[a-g][#b]?m?$/i.test(a)) return null;
      return r.op === "mixes" ? `key:~${a}` : r.op === "not" ? `-key:${a}` : `key:${a}`;
    case "energy":
      if (r.op === "between") return n(a) && n(b) ? `energy:${num(a)}-${num(b)}` : null;
      if (!n(a)) return null;
      return r.op === "atleast" ? `energy:${num(a)}+` : `energy:<=${num(a)}`;
    case "rating":
      if (!n(a)) return null;
      return r.op === "atleast" ? `rating:${num(a)}+` : `rating:${num(a)}`;
    case "year":
      if (r.op === "between") return n(a) && n(b) ? `year:${num(a)}-${num(b)}` : null;
      if (!n(a)) return null;
      return r.op === "from" ? `year:>=${num(a)}` : `year:<${num(a)}`;
    case "vocals":
      if (r.op === "yes" || r.op === "no") return `vocals:${r.op}`;
      return n(a) ? `vocals:${num(a)}+` : null;
    case "played":
      if (r.op === "never") return "played:never";
      if (!n(a)) return null;
      return r.op === "within" ? `played:<${num(a)}d` : `played:>${num(a)}d`;
    case "added":
      if (!n(a)) return null;
      return r.op === "within" ? `added:<${num(a)}d` : `added:>${num(a)}d`;
  }
}

/** The search a set of rules makes. */
export function toQuery(s: Smart): string {
  const parts = s.rules.map(ruleTerm).filter((t): t is string => !!t);
  if (s.rest.trim()) parts.push(s.rest.trim());
  if (s.sort) parts.push(`sort:${s.sort}`);
  return parts.join(" ");
}

const unq = (v: string) => v.replace(/^"|"$/g, "");

/** One search term as a rule, or null when no rule shows it. */
export function termRule(term: string): Rule | null {
  const neg = term.startsWith("-");
  const t = neg ? term.slice(1) : term;
  const m = t.match(/^([a-z]+):(.+)$/i);
  if (!m) return null;
  const field = m[1].toLowerCase();
  const v = unq(m[2]);
  let r: RegExpMatchArray | null;
  if (["genre", "artist", "title", "album", "label", "comment", "tag"].includes(field)) return { field: field as RuleField, op: neg ? "not" : "has", a: v };
  if (field === "key") {
    if (neg) return v.startsWith("~") ? null : { field: "key", op: "not", a: v };
    return v.startsWith("~") ? { field: "key", op: "mixes", a: v.slice(1) } : { field: "key", op: "is", a: v };
  }
  if (neg) return null;
  const NUM = "(\\d+(?:\\.\\d+)?)";
  if (field === "bpm") {
    if ((r = v.match(new RegExp(`^${NUM}-${NUM}$`)))) return { field: "bpm", op: "between", a: r[1], b: r[2] };
    if ((r = v.match(new RegExp(`^~${NUM}$`)))) return { field: "bpm", op: "around", a: r[1] };
    if ((r = v.match(new RegExp(`^>=${NUM}$`)))) return { field: "bpm", op: "above", a: r[1] };
    if ((r = v.match(new RegExp(`^<=${NUM}$`)))) return { field: "bpm", op: "below", a: r[1] };
    return null;
  }
  if (field === "energy") {
    if ((r = v.match(new RegExp(`^${NUM}\\+$`))) || (r = v.match(new RegExp(`^>=${NUM}$`)))) return { field: "energy", op: "atleast", a: r[1] };
    if ((r = v.match(new RegExp(`^<=${NUM}$`)))) return { field: "energy", op: "atmost", a: r[1] };
    if ((r = v.match(new RegExp(`^${NUM}-${NUM}$`)))) return { field: "energy", op: "between", a: r[1], b: r[2] };
    return null;
  }
  if (field === "rating") {
    if ((r = v.match(new RegExp(`^${NUM}\\+$`)))) return { field: "rating", op: "atleast", a: r[1] };
    if ((r = v.match(new RegExp(`^${NUM}$`)))) return { field: "rating", op: "is", a: r[1] };
    return null;
  }
  if (field === "year") {
    if ((r = v.match(new RegExp(`^${NUM}-${NUM}$`)))) return { field: "year", op: "between", a: r[1], b: r[2] };
    if ((r = v.match(new RegExp(`^>=${NUM}$`)))) return { field: "year", op: "from", a: r[1] };
    if ((r = v.match(new RegExp(`^<${NUM}$`)))) return { field: "year", op: "before", a: r[1] };
    return null;
  }
  if (field === "vocals" || field === "vocal" || field === "voice") {
    const w = v.toLowerCase();
    if (w === "yes" || w === "no") return { field: "vocals", op: w, a: "" };
    if ((r = v.match(new RegExp(`^${NUM}\\+$`)))) return { field: "vocals", op: "atleast", a: r[1] };
    return null;
  }
  if (field === "played" || field === "added") {
    if (field === "played" && v.toLowerCase() === "never") return { field: "played", op: "never", a: "" };
    if ((r = v.match(/^<(\d+)d$/))) return { field, op: "within", a: r[1] };
    if ((r = v.match(/^>(\d+)d$/))) return { field, op: "notwithin", a: r[1] };
    return null;
  }
  return null;
}

/** A search as rules; whatever no rule shows stays in `rest`. */
export function fromQuery(q: string): Smart {
  const rules: Rule[] = [];
  const rest: string[] = [];
  let sort = "";
  for (const term of searchTerms(q.trim())) {
    const s = term.match(/^(?:sort|order):(.+)$/i);
    if (s && SORTS.some((x) => x.key === s[1].toLowerCase())) {
      sort = s[1].toLowerCase();
      continue;
    }
    const r = termRule(term);
    if (r) rules.push(r);
    else rest.push(term);
  }
  return { rules, sort, rest: rest.join(" ") };
}

/** A fresh rule for a field, with its first operator. */
export function newRule(field: RuleField): Rule {
  return { field, op: FIELDS[field].ops[0].op, a: "", b: "" };
}
