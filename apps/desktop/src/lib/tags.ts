// Your own tags: words you put on tracks ("vocal", "peak time", "dark") to find them again
// by feel, moment or use. A few ready-made ones help you start; any word works.

/** Ready-made tags, grouped the way DJs tend to think about tracks. */
export const STARTER_TAGS: { name: string; category: string }[] = [
  { name: "Warm-up", category: "Moment" },
  { name: "Peak time", category: "Moment" },
  { name: "Closer", category: "Moment" },
  { name: "Vocal", category: "Vocals" },
  { name: "Instrumental", category: "Vocals" },
  { name: "Dark", category: "Vibe" },
  { name: "Uplifting", category: "Vibe" },
  { name: "Groovy", category: "Vibe" },
  { name: "Emotional", category: "Vibe" },
  { name: "Tool", category: "Use" },
  { name: "Long intro", category: "Use" },
];

/** The category a starter tag belongs to (empty for your own words). */
export function starterCategory(name: string): string {
  return STARTER_TAGS.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())?.category ?? "";
}

/** The search for tracks with this tag, quoted when it has spaces: `tag:"peak time"`. */
export function tagQuery(name: string): string {
  const n = name.replace(/"/g, "");
  return /\s/.test(n) ? `tag:"${n}"` : `tag:${n}`;
}

/** A steady colour for a tag without one of its own, from its name. */
export function tagHue(name: string): number {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

export function tagStyle(name: string, color: number | null | undefined): { background: string; color: string } {
  if (color != null) {
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    return { background: `${hex}33`, color: hex };
  }
  const h = tagHue(name);
  return { background: `hsla(${h}, 70%, 55%, 0.18)`, color: `hsl(${h}, 80%, 75%)` };
}

/** For several tracks: each tag with how many of them carry it, most common first. */
export function tagTally(ids: number[], rowTags: Record<number, string[]>): { name: string; count: number }[] {
  const m = new Map<string, { name: string; count: number }>();
  for (const id of ids) {
    for (const n of rowTags[id] ?? []) {
      const k = n.toLowerCase();
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { name: n, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Tag names that start with (then contain) what is typed, leaving out those already on. */
export function tagMatches(typed: string, known: string[], on: string[], limit = 6): string[] {
  const q = typed.trim().toLowerCase();
  const have = new Set(on.map((n) => n.toLowerCase()));
  const pool = [...new Map([...known, ...STARTER_TAGS.map((t) => t.name)].map((n) => [n.toLowerCase(), n])).values()].filter((n) => !have.has(n.toLowerCase()));
  if (!q) return pool.slice(0, limit);
  const starts = pool.filter((n) => n.toLowerCase().startsWith(q));
  const has = pool.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, limit);
}
