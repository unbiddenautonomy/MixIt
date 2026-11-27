// Your collection at a glance: how big it is, where its tempos and keys sit, its energy
// and genres, what gets played and what was added, with notes on gaps. Every bar opens
// the tracks it counts.
import clsx from "clsx";
import { Lightbulb } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend } from "../../backend";
import type { TrackRow } from "../../backend/types";
import { type Bucket, insights } from "../../lib/insights";
import { plural } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { refreshRows } from "./data";

/** Shows the Collection filtered by a search. */
function open(query: string) {
  if (!query) return;
  useLibrary.getState().set({ source: { type: "all" }, query, selected: [], anchor: null });
  void refreshRows();
}

function hours(s: number) {
  const h = s / 3600;
  return h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`;
}

export function InsightsView() {
  const [rows, setRows] = useState<TrackRow[] | null>(null);
  const version = useLibrary((s) => s.stats?.tracks ?? 0);
  useEffect(() => {
    let live = true;
    backend()
      .search("")
      .then((r) => live && setRows(r))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [version]);
  const data = useMemo(() => (rows ? insights(rows) : null), [rows]);
  if (!data) return <div className="flex flex-1 items-center justify-center text-xs text-zinc-500">Reading your collection…</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="insights">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        <Tile label="Tracks" value={data.tracks.toLocaleString()} />
        <Tile label="Music" value={hours(data.seconds)} hint="to play end to end" />
        <Tile label="Analysed" value={data.tracks ? `${Math.round((data.analysed / data.tracks) * 100)}%` : "–"} />
        <Tile label="Never played" value={data.neverPlayed.toLocaleString()} onClick={() => open("played:never")} />
        <Tile label="Unrated" value={data.unrated.toLocaleString()} onClick={() => open("rating:0")} />
        <Tile label="Missing files" value={data.missing.toLocaleString()} tone={data.missing ? "warn" : undefined} onClick={data.missing ? () => useLibrary.getState().set({ source: { type: "care" } }) : undefined} />
      </div>

      {data.notes.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3" data-testid="insight-notes">
          {data.notes.map((n) => (
            <p key={n} className="flex gap-2 text-[12px] leading-snug text-zinc-300">
              <Lightbulb size={13} className="mt-0.5 shrink-0 text-amber-300" />
              {n}
            </p>
          ))}
        </section>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Tempo" sub={data.sweetSpot ? `Most tracks: ${data.sweetSpot.from}–${data.sweetSpot.to} BPM` : "BPM, in steps of 2"}>
          <Bars buckets={data.tempo} unit="BPM" every={Math.ceil(data.tempo.length / 10)} />
        </Card>
        <Card title="Keys" sub="The Camelot wheel: neighbours mix in key">
          <KeyWheel keys={data.keys} />
        </Card>
        <Card title="Energy" sub="1 is calm, 10 is peak time">
          <Bars buckets={data.energy} unit="energy" />
        </Card>
        <Card title="Added" sub="Tracks added each month, the last year">
          <Bars buckets={data.added} unit="added" />
        </Card>
        <Card title="Genres" sub={data.genres.length ? `Top ${data.genres.length}` : "No genres yet"}>
          <Ranked buckets={data.genres} />
        </Card>
        <Card title="Most played" sub={data.mostPlayed.length ? "Your go-to tracks" : "Nothing played yet"}>
          <ol className="flex flex-col gap-0.5">
            {data.mostPlayed.map((r, i) => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] hover:bg-white/[0.05]" onClick={() => open(`"${r.title}"`)}>
                  <span className="w-4 text-right font-mono text-[11px] text-zinc-500">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-200">
                    {r.title}
                    {r.artist && <span className="text-zinc-500"> · {r.artist}</span>}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-400">{plural(r.playCount, "play")}</span>
                </button>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}

function Tile({ label, value, hint, tone, onClick }: { label: string; value: string; hint?: string; tone?: "warn"; onClick?: () => void }) {
  const C = onClick ? "button" : "div";
  return (
    <C type={onClick ? "button" : undefined} onClick={onClick} className={clsx("flex flex-col rounded-xl border border-white/[0.06] bg-zinc-900/50 px-3 py-2 text-left", onClick && "hover:border-white/15")} data-testid="insight-tile">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={clsx("text-xl font-semibold tabular-nums", tone === "warn" ? "text-amber-300" : "text-zinc-50")}>{value}</span>
      {hint && <span className="text-[11px] text-zinc-500">{hint}</span>}
    </C>
  );
}

function Card({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
        <span className="text-[11px] text-zinc-500">{sub}</span>
      </div>
      {children}
    </section>
  );
}

/** Columns from a baseline, one hue; hovering names the bar, clicking lists its tracks. */
function Bars({ buckets, unit, every = 1 }: { buckets: Bucket[]; unit: string; every?: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const [hover, setHover] = useState<number | null>(null);
  if (!buckets.length || buckets.every((b) => b.count === 0)) return <p className="py-6 text-center text-[11px] text-zinc-500">Nothing to show yet.</p>;
  const h = hover != null ? buckets[hover] : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="h-4 text-[11px] text-zinc-300">{h ? `${h.label}${unit === "BPM" ? " BPM" : ""}: ${plural(h.count, "track")}` : ""}</div>
      <div className="flex h-28 items-end gap-[2px] border-b border-white/10" onMouseLeave={() => setHover(null)}>
        {buckets.map((b, i) => (
          <button
            key={`${b.label}-${i}`}
            type="button"
            className="group flex h-full min-w-0 flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => open(b.query)}
            disabled={!b.query || b.count === 0}
            aria-label={`${b.label} ${unit}: ${plural(b.count, "track")}`}
            data-testid="insight-bar"
          >
            <span className={clsx("w-full rounded-t-[4px] transition-colors", hover === i ? "bg-sky-300" : "bg-sky-500/70")} style={{ height: `${b.count ? Math.max(2, (b.count / max) * 100) : 0}%` }} />
          </button>
        ))}
      </div>
      <div className="flex gap-[2px]">
        {buckets.map((b, i) => (
          <span key={`${b.label}-${i}`} className="relative h-3 min-w-0 flex-1">
            {i % every === 0 && <span className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] text-zinc-500">{b.label}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function Ranked({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <ol className="flex flex-col gap-1">
      {buckets.map((b) => (
        <li key={b.label}>
          <button type="button" className="flex w-full items-center gap-2 rounded px-1 text-left text-[12px] hover:bg-white/[0.05]" onClick={() => open(b.query)}>
            <span className="w-28 shrink-0 truncate text-zinc-200">{b.label}</span>
            <span className="relative h-2.5 flex-1">
              <span className="absolute inset-y-0 left-0 rounded-r-[4px] bg-sky-500/70" style={{ width: `${(b.count / max) * 100}%` }} />
            </span>
            <span className="w-10 text-right font-mono text-[11px] text-zinc-400">{b.count}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The Camelot wheel: minor keys (A) inside, major (B) outside, shaded by how many tracks. */
function KeyWheel({ keys }: { keys: Record<string, number> }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...Object.values(keys));
  const total = Object.values(keys).reduce((a, b) => a + b, 0);
  const cx = 110;
  const cy = 110;
  const ring = (n: number, inner: number, outer: number) => {
    // 12 at the top, numbers clockwise; 2px gaps between cells.
    const a0 = ((n % 12) * 30 - 15 - 90) * (Math.PI / 180) + 0.012;
    const a1 = ((n % 12) * 30 + 15 - 90) * (Math.PI / 180) - 0.012;
    const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    return `M ${p(inner, a0)} L ${p(outer, a0)} A ${outer} ${outer} 0 0 1 ${p(outer, a1)} L ${p(inner, a1)} A ${inner} ${inner} 0 0 0 ${p(inner, a0)} Z`;
  };
  const label = (n: number, r: number) => {
    const a = ((n % 12) * 30 - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };
  const cells = Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) => [
    { k: `${n}A`, path: ring(n, 46, 76), at: label(n, 61) },
    { k: `${n}B`, path: ring(n, 78, 108), at: label(n, 93) },
  ]);
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 220 220" className="h-52 w-52 shrink-0" role="img" aria-label="Tracks per key on the Camelot wheel" onMouseLeave={() => setHover(null)}>
        {cells.map((c) => {
          const n = keys[c.k] ?? 0;
          const t = n / max;
          return (
            <g key={c.k} className="cursor-pointer" onMouseEnter={() => setHover(c.k)} onClick={() => n && open(`key:${c.k}`)} data-testid="insight-key">
              <path d={c.path} fill={n ? `rgba(56, 189, 248, ${0.12 + t * 0.8})` : "color-mix(in srgb, var(--color-zinc-500) 12%, transparent)"} stroke={hover === c.k ? "var(--color-sky-300)" : "transparent"} strokeWidth={1.5} />
              <text x={c.at.x} y={c.at.y} textAnchor="middle" dominantBaseline="central" className="pointer-events-none select-none" fontSize="9" fill={t > 0.55 ? "#082f49" : "var(--color-zinc-400)"}>
                {c.k}
              </text>
            </g>
          );
        })}
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize="18" fontWeight="600" fill="var(--color-zinc-100)">
          {hover ? (keys[hover] ?? 0) : total}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill="var(--color-zinc-400)">
          {hover ? `tracks in ${hover}` : "tracks with a key"}
        </text>
      </svg>
      <p className="text-[11px] leading-snug text-zinc-400">
        Inside are minor keys (A), outside major (B). Keys next to each other, or straight across, mix without clashing. Darker cells hold more of your tracks. Click one to list them.
      </p>
    </div>
  );
}
