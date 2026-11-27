// "Build a set": MixIt picks tracks for the time you have, with the energy moving the way
// you choose (warm-up, build, peak, journey, cool-down) and every change of track mixable.
// You see the set and its energy against the shape, try another, then keep it as a playlist.
import { setMinutesLeft, useSetClock } from "../../lib/setClock";
import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { Bot, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../../backend";
import type { SetShape, TrackRow, VocalPlan } from "../../backend/types";
import { bpm as fmtBpm, clock, inkColor, plural } from "../../lib/format";
import { keyColor, keyLabel } from "../../lib/keys";
import { transition } from "../../lib/setFlow";
import { SET_SHAPES, shapeTarget } from "../../lib/setShapes";
import { useApp, useNotation } from "../../store/app";
import { setQueue } from "../../store/autodj";
import { useLibrary } from "../../store/library";
import { Btn, Segmented } from "../ui/Button";
import { refreshPlaylists, refreshRows, rowsById } from "./data";
import type { SetPlan } from "../../lib/ask";

interface Req {
  seed: TrackRow | null;
  playlist: number | null;
  /** Settings to start with (from Ask MixIt). */
  plan?: SetPlan;
}

const useBuild = create<{ req: Req | null }>(() => ({ req: null }));

/** What the set builder was opened with (null while closed). */
export const buildSetOpenedWith = () => useBuild.getState().req;

/** Opens the set builder, starting with `seed` or choosing from `playlist` when given,
 *  or with the settings a typed request asked for (`plan`). */
export function openBuildSet(opts: { seed?: TrackRow | null; playlist?: number | null; plan?: SetPlan } = {}) {
  const plan = opts.plan;
  useBuild.setState({ req: { seed: opts.seed ?? null, playlist: opts.playlist ?? plan?.playlist ?? null, plan } });
  // The opening track the plan names, once its row is at hand.
  if (plan?.seed != null && !opts.seed) {
    void rowsById([plan.seed]).then(([row]) => {
      const req = useBuild.getState().req;
      if (row && req?.plan === plan) useBuild.setState({ req: { ...req, seed: row } });
    });
  }
}

export function BuildSetHost() {
  const req = useBuild((s) => s.req);
  return req ? <Builder req={req} /> : null;
}

const VOCAL_PLANS: { value: VocalPlan; label: string; title: string }[] = [
  { value: "any", label: "Any", title: "Singing or not, whatever mixes best" },
  { value: "breathe", label: "Give them room", title: "Never three singing tracks in a row: an instrumental now and then lets the voices breathe" },
  { value: "instrumental", label: "Instrumentals only", title: "Only tracks without singing, to talk or sing over" },
];

const LENGTHS: [number, string][] = [
  [30, "30 min"],
  [60, "1 hour"],
  [90, "1½ hours"],
  [120, "2 hours"],
];

/** The shape as a small line, energy 1..10 bottom to top. */
function ShapeLine({ shape, w = 64, h = 22 }: { shape: SetShape; w?: number; h?: number }) {
  const pts = Array.from({ length: 33 }, (_, i) => {
    const t = i / 32;
    return `${(t * w).toFixed(1)},${(h - ((shapeTarget(shape, t, 6) - 1) / 9) * h).toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="overflow-visible">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Builder({ req }: { req: Req }) {
  const playlists = useLibrary((s) => s.playlists);
  const notation = useNotation();
  // With a set clock running, the time you have left (in the lengths offered).
  const [minutes, setMinutes] = useState(() => {
    if (req.plan?.minutes) return req.plan.minutes;
    const left = setMinutesLeft(useSetClock.getState().endsAt);
    return left == null ? 60 : LENGTHS.reduce((best, [m]) => (Math.abs(m - left) < Math.abs(best - left) ? m : best), 60);
  });
  const [shape, setShape] = useState<SetShape>(req.plan?.shape ?? "build");
  const [from, setFrom] = useState<number | "all">(req.playlist ?? "all");
  const [query, setQuery] = useState(req.plan?.query ?? "");
  const [seed, setSeed] = useState<TrackRow | null>(req.seed);
  useEffect(() => {
    if (req.seed) setSeed(req.seed);
  }, [req.seed]);
  const [variety, setVariety] = useState(0);
  const [vocals, setVocals] = useState<VocalPlan>(req.plan?.vocals ?? "any");
  const [set, setSet] = useState<TrackRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const shapeInfo = SET_SHAPES.find((s) => s.id === shape)!;

  const close = () => useBuild.setState({ req: null });

  const build = async (v = variety) => {
    setBusy(true);
    try {
      const rows = await backend().buildSet({ query: query.trim(), playlist: from === "all" ? null : from, minutes, shape, seed: seed?.id ?? null, variety: v, vocals });
      setSet(rows);
      setName(`${shapeInfo.label}, ${minutes} min`);
      if (!rows.length) toast.message("No set could be built", { description: "Nothing analysed matches. Analyse your tracks first, or choose from more of them." });
    } catch (e) {
      toast.error(`Could not build the set: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // A new choice makes the old set stale.
  useEffect(() => setSet(null), [minutes, shape, from, query, seed, vocals]);

  const heard = set ? set.reduce((a, r) => a + r.duration * 0.8, 0) : 0;
  const rough = useMemo(() => (set ? set.slice(1).filter((r, i) => transition(set[i], r).grade === "rough").length : 0), [set]);

  /** Hands the set to Auto DJ: the queue becomes this set, ready to start or rehearse. */
  const playIt = () => {
    if (!set?.length) return;
    setQueue(set);
    useApp.getState().set({ workspace: "library" });
    useLibrary.getState().set({ source: { type: "autodj" } });
    toast.success(`${plural(set.length, "track")} in the Auto DJ queue`, { description: "Press Start to let Auto DJ mix them, or Rehearse the set to hear every change first." });
    close();
  };

  const save = async () => {
    if (!set?.length || !name.trim()) return;
    try {
      const id = await backend().createPlaylist(name.trim(), "list", { tracks: set.map((r) => r.id) });
      await refreshPlaylists();
      useLibrary.getState().set({ source: { type: "playlist", id }, sort: null });
      refreshRows();
      toast.success(`Saved “${name.trim()}”`, { description: `${plural(set.length, "track")}, about ${Math.round(heard / 60)} minutes when mixed.` });
      close();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const lists = playlists.filter((p) => p.kind !== "folder");

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[90vh] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-5 text-sm shadow-2xl" data-testid="build-set-dialog">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-zinc-50">Build a set</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-relaxed text-zinc-400">MixIt picks tracks to fill the time you have, with the energy moving the way you choose and every change of track easy to mix.</Dialog.Description>
            </div>
            <Dialog.Close className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">How long</span>
              <Segmented value={minutes} onChange={setMinutes} options={LENGTHS.map(([m, label]) => ({ value: m, label, title: `${m} minutes` }))} />
            </label>
            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">
              <span className="shrink-0 text-zinc-500">From</span>
              <select value={String(from)} onChange={(e) => setFrom(e.target.value === "all" ? "all" : Number(e.target.value))} className="input h-8 min-w-0 flex-1" aria-label="Choose tracks from">
                <option value="all">Your whole collection</option>
                {lists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.count})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" role="radiogroup" aria-label="How the energy moves">
            {SET_SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={shape === s.id}
                onClick={() => setShape(s.id)}
                title={s.about}
                data-testid={`shape-${s.id}`}
                className={clsx("flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[11px] transition-colors", shape === s.id ? "border-sky-400/60 bg-sky-400/10 text-sky-200" : "border-white/[0.07] bg-white/[0.02] text-zinc-400 hover:border-white/20 hover:text-zinc-200")}
              >
                <ShapeLine shape={s.id} />
                <span className="text-center leading-tight">{s.label}</span>
              </button>
            ))}
          </div>
          <p className="-mt-1 text-[11px] text-zinc-500">{shapeInfo.about}</p>

          <label className="flex items-center gap-2 text-xs" data-testid="set-vocals">
            <span className="text-zinc-500">Singing</span>
            <Segmented value={vocals} onChange={setVocals} options={VOCAL_PLANS} />
          </label>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 text-zinc-500">Only tracks matching</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="optional, like genre:house or bpm:120-128" className="input h-8 min-w-0 flex-1 font-mono text-[11px]" aria-label="Only tracks matching" />
            </label>
            <span className="flex items-center gap-1.5 text-zinc-500">
              Opens with
              {seed ? (
                <span className="flex max-w-56 items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-zinc-200">
                  <span className="truncate">{seed.title}</span>
                  <button type="button" onClick={() => setSeed(null)} aria-label="Let MixIt choose the opener" className="text-zinc-500 hover:text-zinc-100">
                    <X size={11} />
                  </button>
                </span>
              ) : (
                <span className="text-zinc-300">a track MixIt chooses</span>
              )}
            </span>
          </div>

          {set && set.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-black/20 p-3" data-testid="built-set">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="font-medium text-zinc-100">{plural(set.length, "track")}</span>
                <span className="text-zinc-400">about {Math.round(heard / 60)} min when mixed</span>
                <span className={clsx("ml-auto", rough ? "text-amber-300" : "text-emerald-300")}>{rough ? `${plural(rough, "change")} to take care with` : "Every change mixes smoothly"}</span>
              </div>
              <EnergyChart set={set} shape={shape} heard={heard} hover={hover} setHover={setHover} />
              <ol className="max-h-56 overflow-y-auto text-xs">
                {set.map((r, i) => (
                  <li key={r.id} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={clsx("grid grid-cols-[22px_1fr_56px_40px_34px_42px] items-center gap-2 rounded px-1 py-1", hover === i && "bg-white/[0.05]")}>
                    <span className="text-right font-mono text-[11px] text-zinc-600">{i + 1}</span>
                    <span className="min-w-0 truncate">
                      <span className="text-zinc-100">{r.title}</span>
                      <span className="text-zinc-500"> · {r.artist}</span>
                    </span>
                    <span className="text-right font-mono tabular-nums text-zinc-300">{fmtBpm(r.bpm)}</span>
                    <span className="text-center font-mono text-[11px] font-semibold" style={{ color: inkColor(keyColor(r.key)) }}>
                      {keyLabel(r.key, notation)}
                    </span>
                    <span className="text-right font-mono text-zinc-400" title="Energy">
                      {r.energy ?? "–"}
                    </span>
                    <span className="text-right font-mono text-zinc-500">{clock(r.duration)}</span>
                  </li>
                ))}
              </ol>
              <label className="flex items-center gap-2 text-xs">
                <span className="shrink-0 text-zinc-500">Save as</span>
                <input value={name} onChange={(e) => setName(e.target.value)} className="input h-8 flex-1" aria-label="Playlist name" />
              </label>
            </div>
          )}

          <div className="flex items-center gap-2">
            {set && set.length > 0 && (
              <Btn
                onClick={() => {
                  const v = variety + 1;
                  setVariety(v);
                  void build(v);
                }}
                disabled={busy}
                title="Another set from the same choices"
                data-testid="build-again"
              >
                <RefreshCw size={12} /> Try another
              </Btn>
            )}
            <div className="ml-auto flex gap-2">
              <Btn onClick={close}>Cancel</Btn>
              {set && set.length > 0 ? (
                <>
                  <Btn onClick={() => void save()} disabled={!name.trim()} data-testid="build-save">
                    Save as playlist
                  </Btn>
                  <Btn tone="accent" onClick={playIt} title="Put this set in the Auto DJ queue, in this order, so Auto DJ can mix it or you can rehearse it first" data-testid="build-autodj">
                    <Bot size={12} /> Play with Auto DJ
                  </Btn>
                </>
              ) : (
                <Btn tone="accent" onClick={() => void build()} disabled={busy} data-testid="build-go">
                  {busy && <Loader2 size={12} className="animate-spin" />} Build the set
                </Btn>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Each track's energy as a bar across the time it plays, under the shape's line. */
function EnergyChart({ set, shape, heard, hover, setHover }: { set: TrackRow[]; shape: SetShape; heard: number; hover: number | null; setHover: (i: number | null) => void }) {
  const W = 640;
  const H = 72;
  const y = (e: number) => H - ((e - 1) / 9) * (H - 4);
  const steady = set[0]?.energy ?? 6;
  let at = 0;
  const bars = set.map((r) => {
    const w = (r.duration * 0.8) / heard;
    const b = { x: at * W, w: w * W, e: r.energy };
    at += w;
    return b;
  });
  const line = Array.from({ length: 65 }, (_, i) => `${((i / 64) * W).toFixed(1)},${y(shapeTarget(shape, i / 64, steady)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[72px] w-full" role="img" aria-label="Energy of each track against the chosen shape" onMouseLeave={() => setHover(null)}>
      {[3, 6, 9].map((e) => (
        <line key={e} x1={0} x2={W} y1={y(e)} y2={y(e)} stroke="currentColor" className="text-white/[0.06]" strokeWidth={1} />
      ))}
      {bars.map((b, i) => (
        <g key={i} onMouseEnter={() => setHover(i)}>
          <rect x={b.x} y={0} width={b.w} height={H} fill="transparent" />
          {b.e != null && <rect x={b.x + 1} y={y(b.e)} width={Math.max(1, b.w - 2)} height={H - y(b.e)} rx={2} className={hover === i ? "fill-sky-300" : "fill-sky-400/55"} />}
        </g>
      ))}
      <polyline points={line} fill="none" stroke="currentColor" className="text-zinc-200" strokeWidth={2} strokeDasharray="4 3" strokeLinejoin="round" />
    </svg>
  );
}
