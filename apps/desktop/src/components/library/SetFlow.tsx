// A playlist as a set: energy bars coloured by key, the tempo as a line, and a dot for
// every change of track that says how easy it is to mix. Rough changes offer tracks from
// the library that would bridge them, and the order can be smoothed in one click.
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { Activity, ArrowUpRight, Loader2, Plus, Shuffle, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../../backend";
import type { TrackRow } from "../../backend/types";
import { bpm as fmtBpm, clock, plural } from "../../lib/format";
import { keyColor } from "../../lib/keys";
import { bridges, flow, summary, type Bridge, type Grade, type Transition } from "../../lib/setFlow";
import { useLibrary } from "../../store/library";
import { refreshPlaylists, refreshRows } from "./data";

const KEY = "mixit.setFlow";

export const useSetFlow = create<{ open: boolean }>(() => {
  try {
    return { open: localStorage.getItem(KEY) === "1" };
  } catch {
    return { open: false };
  }
});

export function toggleSetFlow() {
  const open = !useSetFlow.getState().open;
  useSetFlow.setState({ open });
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    // The choice lasts for the session.
  }
}

export const GRADE_COLORS: Record<Grade, string> = { smooth: "#34d399", ok: "#fbbf24", rough: "#f43f5e" };
const GRADE_WORDS: Record<Grade, string> = { smooth: "smooth", ok: "takes care", rough: "rough" };

/** The toolbar button that shows or hides the flow over a playlist. */
export function SetFlowToggle() {
  const open = useSetFlow((s) => s.open);
  return (
    <button
      type="button"
      onClick={toggleSetFlow}
      title="Show how the set flows: energy, tempo and how well each track mixes into the next"
      className={clsx("flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]", open ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-white/[0.08] text-zinc-400 hover:text-zinc-100")}
      data-testid="set-flow-toggle"
    >
      <Activity size={12} /> Flow
    </button>
  );
}

export function SetFlow() {
  const open = useSetFlow((s) => s.open);
  const source = useLibrary((s) => s.source);
  const rows = useLibrary((s) => s.rows);
  const playlists = useLibrary((s) => s.playlists);
  if (!open || source.type !== "playlist" || rows.length < 2) return null;
  const pl = playlists.find((p) => p.id === source.id);
  return <Flow rows={rows} playlistId={source.id} editable={pl?.kind === "list"} />;
}

function Flow({ rows, playlistId, editable }: { rows: TrackRow[]; playlistId: number; editable: boolean }) {
  const ts = useMemo(() => flow(rows), [rows]);
  const sum = summary(ts);
  const total = rows.reduce((a, r) => a + r.duration, 0);
  const bpms = rows.map((r) => r.bpm).filter((b): b is number => !!b);
  const lo = Math.min(...bpms);
  const hi = Math.max(...bpms);
  const span = Math.max(4, hi - lo);
  const n = rows.length;
  const points = rows
    .map((r, i) => (r.bpm ? `${i + 0.5},${88 - ((r.bpm - lo) / span) * 70}` : null))
    .filter(Boolean)
    .join(" ");
  const selected = useLibrary((s) => s.selected);
  const [busy, setBusy] = useState(false);

  const order = async (energy: "steady" | "up") => {
    setBusy(true);
    try {
      await backend().orderPlaylist(playlistId, energy);
      await refreshRows();
      toast.success(energy === "up" ? "Ordered to build the energy" : "Ordered for smooth changes");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-white/[0.06] px-3 py-2" data-testid="set-flow">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="font-semibold text-zinc-200">Set flow</span>
        <span className="text-zinc-500">
          {plural(n, "track")} · {clock(total)}
          {bpms.length > 0 && ` · ${fmtBpm(lo)}–${fmtBpm(hi)} BPM`}
        </span>
        {(["smooth", "ok", "rough"] as Grade[]).map((g) => (
          <span key={g} className="flex items-center gap-1 text-zinc-400" data-testid={`flow-${g}`}>
            <span className="size-2 rounded-full" style={{ background: GRADE_COLORS[g] }} />
            {sum[g]} {GRADE_WORDS[g]}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {editable && (
            <>
              <button type="button" disabled={busy} onClick={() => void order("steady")} className="flex h-6 items-center gap-1 rounded-md border border-white/[0.08] px-2 text-zinc-300 hover:text-zinc-50 disabled:opacity-50" title="Reorder so each track mixes easily into the next (keys and tempos close together)">
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Shuffle size={11} />} Smooth the order
              </button>
              <button type="button" disabled={busy} onClick={() => void order("up")} className="flex h-6 items-center gap-1 rounded-md border border-white/[0.08] px-2 text-zinc-300 hover:text-zinc-50 disabled:opacity-50" title="Reorder to start calm and build up, keeping the changes smooth">
                <ArrowUpRight size={11} /> Build up
              </button>
            </>
          )}
          <button type="button" onClick={toggleSetFlow} aria-label="Hide the flow" className="flex size-6 items-center justify-center text-zinc-500 hover:text-zinc-100">
            <X size={12} />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="relative flex h-20" style={{ width: `max(100%, ${n * 24}px)` }}>
          {rows.map((r, i) => {
            const sel = selected.includes(r.id);
            const e = r.energy ?? 0;
            return (
              <div key={`${r.id}-${i}`} className="relative flex h-full flex-1 basis-0 flex-col justify-end px-[2px]">
                <button
                  type="button"
                  onClick={() => useLibrary.getState().set({ selected: [r.id], inspect: r.id })}
                  title={`${i + 1}. ${r.title} · ${r.artist}\n${fmtBpm(r.bpm)} BPM · ${r.key?.camelot ?? "key unknown"} · energy ${r.energy ?? "?"}`}
                  className={clsx("w-full rounded-t-sm transition-[filter]", sel ? "ring-1 ring-white" : "hover:brightness-125")}
                  style={{ height: `${Math.max(8, e * 9)}%`, background: keyColor(r.key, 0.75) }}
                  data-testid="flow-bar"
                />
                {i < n - 1 && <Dot t={ts[i]} a={r} b={rows[i + 1]} index={i} rows={rows} playlistId={playlistId} editable={editable} />}
              </div>
            );
          })}
          {points && (
            <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden>
              <polyline points={points} fill="none" stroke="rgba(250,250,250,0.85)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      </div>
      <div className="mt-0.5 flex gap-3 text-[10px] text-zinc-500">
        <span>Bars: energy, coloured by key</span>
        <span>Line: tempo</span>
        <span>Dots: how easily each track mixes into the next. Click a dot for details.</span>
      </div>
    </div>
  );
}

function Dot({ t, a, b, index, rows, playlistId, editable }: { t: Transition; a: TrackRow; b: TrackRow; index: number; rows: TrackRow[]; playlistId: number; editable: boolean }) {
  const [found, setFound] = useState<Bridge[] | null>(null);
  const [loading, setLoading] = useState(false);
  const findBridges = async () => {
    setLoading(true);
    try {
      const all = await backend().search("", 20000);
      setFound(bridges(a, b, all, new Set(rows.map((r) => r.id))));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };
  const insert = async (c: TrackRow) => {
    try {
      await backend().addToPlaylist(playlistId, [c.id]);
      await backend().reorderPlaylist(playlistId, [rows.length], index + 1);
      await refreshRows();
      void refreshPlaylists();
      toast.success(`Added ${c.title} between ${a.title} and ${b.title}`);
    } catch (e) {
      toast.error(String(e));
    }
  };
  return (
    <Popover.Root onOpenChange={(o) => !o && setFound(null)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Change ${index + 1} to ${index + 2}: ${GRADE_WORDS[t.grade]}`}
          className="absolute -right-[5px] bottom-0 z-10 size-[10px] rounded-full border border-zinc-950 hover:scale-125"
          style={{ background: GRADE_COLORS[t.grade] }}
          data-testid="flow-dot"
          data-grade={t.grade}
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={6} className="z-50 w-80 rounded-xl border border-white/10 bg-zinc-900 p-3 text-[12px] shadow-xl" data-testid="flow-popover">
          <div className="mb-1 text-zinc-400">
            <span className="text-zinc-100">{a.title}</span> into <span className="text-zinc-100">{b.title}</span>
          </div>
          <div className="mb-2 flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: GRADE_COLORS[t.grade] }} />
            <span className="font-medium text-zinc-200">{t.grade === "smooth" ? "Mixes smoothly" : t.grade === "ok" ? "Mixes with a little care" : "Hard to mix"}</span>
          </div>
          {t.reasons.length > 0 ? (
            <ul className="mb-2 list-disc pl-4 text-zinc-400">
              {t.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="mb-2 text-zinc-400">Keys fit, tempos are close and the energy moves gently.</p>
          )}
          {t.grade !== "smooth" && editable && (
            <>
              {found === null ? (
                <button type="button" onClick={() => void findBridges()} className="flex h-7 items-center gap-1.5 rounded-md bg-sky-400/15 px-2 text-sky-200 hover:bg-sky-400/25" data-testid="find-bridge">
                  {loading ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Find a track to go between them
                </button>
              ) : found.length === 0 ? (
                <p className="text-zinc-500">No track in your library fits between these two.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  <div className="text-[11px] text-zinc-500">Tracks that mix well with both:</div>
                  {found.map((f) => (
                    <div key={f.track.id} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-zinc-100">{f.track.title}</div>
                        <div className="truncate text-[10px] text-zinc-500">
                          {f.track.artist} · {fmtBpm(f.track.bpm)} · {f.track.key?.camelot}
                        </div>
                      </div>
                      <span className="size-1.5 rounded-full" style={{ background: GRADE_COLORS[f.into.grade] }} title={`In: ${GRADE_WORDS[f.into.grade]}`} />
                      <span className="size-1.5 rounded-full" style={{ background: GRADE_COLORS[f.out.grade] }} title={`Out: ${GRADE_WORDS[f.out.grade]}`} />
                      <button type="button" onClick={() => void insert(f.track)} className="rounded px-1.5 py-0.5 text-[11px] text-sky-300 hover:bg-sky-400/15" data-testid="insert-bridge">
                        Insert
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
