// Auto DJ in the UI: the queue page in the library (controls, what plays now and next and
// why, the queue and a log of what Auto DJ did) and a strip on the mixer while it runs.
import clsx from "clsx";
import { ArrowDown, ArrowUp, Bot, GitMerge, Headphones, Info, ListX, Loader2, Pause, Play, Shuffle, SkipForward, Square, Trash2, X, Zap } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { TrackRow } from "../../backend/types";
import { useDropTarget } from "../../lib/dnd";
import { countdown, transitionName, type Style } from "../../lib/autodj";
import { clock } from "../../lib/format";
import { keyLabel } from "../../lib/keys";
import { useTransition } from "../../lib/transition";
import { useApp } from "../../store/app";
import { clearQueue, mixNow, moveInQueue, removeFromQueue, secondsToMix, skipNext, startAutoDj, stopAutoDj, useAutoDj, enqueue } from "../../store/autodj";
import { useLibrary } from "../../store/library";
import { addBridge, bridgeChoices, orderQueue } from "../../store/queueFlow";
import { flow, summary, transition, type Grade } from "../../lib/setFlow";
import { hearNext, hearPair, seekMix, stopMix, toggleMix, useRehearse } from "../../store/rehearse";
import { previewPosition } from "../library/PreviewBar";
import { setupCanvas } from "../../lib/waveform";
import { useTelemetry } from "../../store/telemetry";
import { DECK_COLORS } from "../deck/useWaveform";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";

const STYLES: { value: Style; label: string }[] = [
  { value: "auto", label: "Pick for each mix" },
  { value: "blend", label: "Blend" },
  { value: "bassSwap", label: "Bass swap" },
  { value: "filterFade", label: "Filter fade" },
  { value: "echoOut", label: "Echo out" },
  { value: "cut", label: "Cut" },
];

const L = (d: number) => String.fromCharCode(65 + d);

/** Adds library tracks (by id) to the queue. */
export function enqueueIds(ids: number[], where: "end" | "next" = "end") {
  const rows = useLibrary.getState().rows;
  const sug = useLibrary.getState().suggestions.map((s) => s.track);
  const byId = new Map([...rows, ...sug].map((r) => [r.id, r]));
  enqueue(ids.map((i) => byId.get(i)).filter((r): r is TrackRow => !!r), where);
}

export function AutoDjView() {
  const phase = useAutoDj((s) => s.phase);
  const queue = useAutoDj((s) => s.queue);
  const drop = useDropTarget("autodj-queue", { label: "Add to Auto DJ", tracks: (ids) => enqueueIds(ids) });
  // The change out of the track waiting (or playing) into the queue's first.
  const start = useAutoDj((s) => (s.next ? s.next.track : s.phase !== "off" && s.current !== null ? (useApp.getState().decks[s.current]?.detail.track ?? null) : null));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" {...drop.props}>
      <Controls />
      <div className="grid gap-3 p-3 lg:grid-cols-[1fr_18rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {phase !== "off" && <NowNext />}
          <section className={clsx("rounded-xl border border-white/[0.06] bg-black/20", drop.over && "ring-1 ring-sky-400")}>
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Queue</div>
              <span className="font-mono text-[10px] text-zinc-500">{queue.length}</span>
              <span className="font-mono text-[10px] text-zinc-500">{clock(queue.reduce((a, t) => a + t.duration, 0))}</span>
              <FlowSummary />
              {queue.length > 1 && (
                <button
                  type="button"
                  className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                  onClick={() => orderQueue()}
                  title="Reorder the queue so every change is as easy to mix as it can be (keys that fit, small tempo steps), with the energy going the way you chose"
                  data-testid="queue-order"
                >
                  <Shuffle size={12} /> Best order
                </button>
              )}
              {queue.length > 0 && (
                <button type="button" className={clsx(queue.length > 1 ? "" : "ml-auto", "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100")} onClick={clearQueue}>
                  <ListX size={12} /> Clear
                </button>
              )}
            </div>
            <RehearsalBar />
            {queue.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs leading-relaxed text-zinc-500">
                Drag tracks here, or right-click tracks in the library and choose <b className="text-zinc-300">Add to Auto DJ</b>.
                <br />A playlist's menu has <b className="text-zinc-300">Play with Auto DJ</b>.
              </div>
            ) : (
              <ol>
                {start && <MixLink a={start} b={queue[0]} i={-1} />}
                {queue.map((t, i) => (
                  <Fragment key={t.id}>
                    <QueueRow t={t} i={i} last={i === queue.length - 1} />
                    {i < queue.length - 1 && <MixLink a={t} b={queue[i + 1]} i={i} />}
                  </Fragment>
                ))}
              </ol>
            )}
          </section>
        </div>
        <Log />
      </div>
    </div>
  );
}

function Controls() {
  const phase = useAutoDj((s) => s.phase);
  const options = useAutoDj((s) => s.options);
  const keepGoing = useAutoDj((s) => s.keepGoing);
  const energy = useAutoDj((s) => s.energy);
  const set = (p: Partial<typeof options>) => useAutoDj.getState().set({ options: { ...useAutoDj.getState().options, ...p } });
  const on = phase !== "off";
  return (
    <div className="flex flex-wrap items-end gap-3 border-b border-white/[0.06] p-3" style={{ ["--accent" as string]: "#38bdf8", ["--accent-ink" as string]: "#bae6fd" }}>
      <div className="flex items-center gap-2">
        <Bot size={18} className="text-sky-300" />
        <div>
          <div className="text-sm font-semibold text-zinc-100">Auto DJ</div>
          <div className="max-w-xs text-[11px] leading-snug text-zinc-400">Mixes the queue for you on decks A and B, and tells you what it does and why.</div>
        </div>
      </div>
      <Ctl id="app.autodj" side="bottom">
        <Btn tone={on ? "danger" : "accent"} onClick={() => (on ? stopAutoDj() : void startAutoDj())}>
          {on ? <Square size={12} /> : <Play size={12} />}
          {on ? "Stop Auto DJ" : "Start Auto DJ"}
        </Btn>
      </Ctl>
      <Field label="Transitions" hint="Pick for each mix chooses from the tracks' tempo, key, energy and bass.">
        <select value={options.style} onChange={(e) => set({ style: e.target.value as Style })} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Transitions">
          {STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Length" hint="Fit the music uses the outro and intro the tracks have.">
        <select
          value={String(options.length)}
          onChange={(e) => set({ length: e.target.value === "auto" ? "auto" : Number(e.target.value) })}
          className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none"
          aria-label="Length"
        >
          <option value="auto">Fit the music</option>
          {[8, 16, 32, 64].map((b) => (
            <option key={b} value={b}>
              {b} beats
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-center gap-1.5 text-[11px] text-zinc-300" title="Shifts the next track's key by a semitone or two (with key lock) when the keys would clash.">
        <input type="checkbox" checked={options.keyMatch} onChange={(e) => set({ keyMatch: e.target.checked })} />
        Fix clashing keys
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-zinc-300" title="When the queue runs out, Auto DJ picks tracks that mix well from your library.">
        <input type="checkbox" checked={keepGoing} onChange={(e) => useAutoDj.getState().set({ keepGoing: e.target.checked })} />
        Keep going with suggestions
      </label>
      {keepGoing && (
        <Segmented
          value={energy}
          onChange={(v) => useAutoDj.getState().set({ energy: v })}
          options={[
            { value: "down", label: "Calmer" },
            { value: "steady", label: "Steady" },
            { value: "up", label: "Build up" },
          ]}
        />
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

function NowNext() {
  const current = useAutoDj((s) => s.current);
  const next = useAutoDj((s) => s.next);
  const phase = useAutoDj((s) => s.phase);
  const info = useApp((s) => (current !== null ? s.decks[current] : null));
  const notation = useApp((s) => s.settings?.keyNotation ?? "camelot");
  const wait = useTelemetry((s) => {
    const x = secondsToMix(s.t);
    return x === null ? null : Math.round(x);
  });
  const progress = useTransition((s) => (s.running ? Math.round(s.running.progress * 100) : null));
  return (
    <section className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3" style={{ borderColor: current !== null ? `${DECK_COLORS[current]}55` : undefined }}>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Now playing{current !== null && ` · deck ${L(current)}`}</div>
        {info ? (
          <>
            <div className="mt-1 truncate text-sm font-semibold text-zinc-100">{info.detail.track.title}</div>
            <div className="truncate text-xs text-zinc-400">
              {info.detail.track.artist} · {info.detail.bpm?.toFixed(1) ?? "?"} BPM · {keyLabel(info.detail.key, notation)}
            </div>
          </>
        ) : (
          <div className="mt-1 text-xs text-zinc-500">Starting…</div>
        )}
      </div>
      <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3" style={{ borderColor: next ? `${DECK_COLORS[next.deck]}55` : undefined }}>
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Next{next && ` · deck ${L(next.deck)}`}
          {phase === "waiting" && wait !== null && <span className="ml-auto font-mono normal-case tracking-normal text-sky-300">mixing in {countdown(wait)}</span>}
          {phase === "mixing" && progress !== null && <span className="ml-auto font-mono normal-case tracking-normal text-sky-300">mixing {progress}%</span>}
        </div>
        {next ? (
          <>
            <div className="mt-1 truncate text-sm font-semibold text-zinc-100">{next.track.title}</div>
            <div className="truncate text-xs text-zinc-400">
              {next.track.artist} · {next.detail.bpm?.toFixed(1) ?? "?"} BPM · {keyLabel(next.detail.key, notation)}
              {next.plan.keyShift !== 0 && ` (${next.plan.keyShift > 0 ? "+" : ""}${next.plan.keyShift})`}
            </div>
            <div className="mt-2 text-xs font-medium text-sky-200">{next.plan.summary}</div>
            <ul className="mt-1 space-y-0.5 text-[11px] leading-snug text-zinc-400">
              {next.plan.reasons.map((r) => (
                <li key={r} className="flex gap-1.5">
                  <Info size={11} className="mt-0.5 shrink-0 text-zinc-500" />
                  {r}
                </li>
              ))}
            </ul>
            {phase === "waiting" && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Btn size="sm" onClick={() => void mixNow()}>
                  <Zap size={12} /> Mix now
                </Btn>
                <Btn size="sm" tone="ghost" onClick={() => void hearNext()} title="Play this mix in your headphones first, the way Auto DJ will do it" data-testid="hear-next">
                  <Headphones size={12} /> Hear it first
                </Btn>
                <Btn size="sm" tone="ghost" onClick={() => void skipNext()}>
                  <SkipForward size={12} /> Skip this track
                </Btn>
              </div>
            )}
          </>
        ) : (
          <div className="mt-1 text-xs text-zinc-500">{phase === "ending" ? "Nothing queued. The mix ends with this track." : "Loading…"}</div>
        )}
      </div>
    </section>
  );
}

function QueueRow({ t, i, last }: { t: TrackRow; i: number; last: boolean }) {
  const notation = useApp((s) => s.settings?.keyNotation ?? "camelot");
  return (
    <li className="group relative flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 text-xs last:border-b-0 hover:bg-white/[0.03]">
      <span className="w-5 text-right font-mono text-[10px] text-zinc-500">{i + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-zinc-100">{t.title}</div>
        <div className="truncate text-[11px] text-zinc-500">{t.artist}</div>
      </div>
      <span className="w-12 text-right font-mono text-[11px] text-zinc-400">{t.bpm?.toFixed(1) ?? "–"}</span>
      <span className="w-8 text-right font-mono text-[11px] text-zinc-400">{keyLabel(t.key, notation)}</span>
      <span className="w-10 text-right font-mono text-[11px] text-zinc-500">{clock(t.duration)}</span>
      <div className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <IconBtn label="Move up" disabled={i === 0} onClick={() => moveInQueue(i, i - 1)}>
          <ArrowUp size={12} />
        </IconBtn>
        <IconBtn label="Move down" disabled={last} onClick={() => moveInQueue(i, i + 1)}>
          <ArrowDown size={12} />
        </IconBtn>
        <IconBtn label="Remove" onClick={() => removeFromQueue(i)}>
          <Trash2 size={12} />
        </IconBtn>
      </div>
    </li>
  );
}

const GRADE: Record<Grade, { dot: string; label: string }> = {
  smooth: { dot: "bg-emerald-400", label: "Smooth change" },
  ok: { dot: "bg-amber-400", label: "Needs care" },
  rough: { dot: "bg-rose-500", label: "Rough change" },
};

/** How many changes in the queue are smooth, need care or are rough. */
function FlowSummary() {
  const queue = useAutoDj((s) => s.queue);
  const start = useAutoDj((s) => s.next?.track ?? null);
  const rows = start ? [start, ...queue] : queue;
  if (rows.length < 2) return null;
  const s = summary(flow(rows));
  return (
    <span className="flex items-center gap-2 text-[10px] text-zinc-500" title="How easy each change of track is to mix" data-testid="queue-flow">
      {(["smooth", "ok", "rough"] as const).map((g) =>
        s[g] ? (
          <span key={g} className="flex items-center gap-1">
            <span className={clsx("size-1.5 rounded-full", GRADE[g].dot)} />
            {s[g]} {g === "ok" ? "need care" : g}
          </span>
        ) : null,
      )}
    </span>
  );
}

/** The change from `a` into `b`: how easy it is and why, hear it, or fill a rough one. */
function MixLink({ a, b, i }: { a: TrackRow; b: TrackRow; i: number }) {
  const t = transition(a, b);
  const key = `${a.id}-${b.id}`;
  const hearing = useRehearse((s) => s.key === key);
  const g = GRADE[t.grade];
  const why = t.reasons.length ? t.reasons.map((r, k) => (k ? r.charAt(0).toLowerCase() + r.slice(1) : r)).join(", ") : "Keys fit, tempos close, energy flows";
  const library = useLibrary((s) => s.rows);
  const queueLen = useAutoDj((s) => s.queue.length);
  const bridge = useMemo(() => (t.grade === "rough" ? bridgeChoices(i, 1)[0] : undefined), [a.id, b.id, t.grade, library, queueLen]);
  return (
    <li className="flex items-center gap-2 border-b border-white/[0.04] bg-black/10 py-0.5 pl-9 pr-3 text-[10px] text-zinc-500" data-testid={`mix-link-${i}`} data-grade={t.grade}>
      <span className={clsx("size-1.5 shrink-0 rounded-full", g.dot)} />
      <span className="min-w-0 flex-1 truncate" title={why}>
        <span className="text-zinc-400">{g.label}</span>
        {t.reasons.length > 0 && `: ${why.charAt(0).toLowerCase()}${why.slice(1)}`}
      </span>
      {bridge && (
        <button
          type="button"
          onClick={() => addBridge(i, bridge.track)}
          title={`Put ${bridge.track.title} in between: it goes well with both tracks`}
          className="flex shrink-0 items-center gap-1 rounded px-1 text-rose-200 hover:bg-white/10"
          data-testid={`bridge-${i}`}
        >
          <GitMerge size={10} /> Add {bridge.track.title} between
        </button>
      )}
      <button
        type="button"
        onClick={() => (hearing ? stopMix() : void hearPair(a, b))}
        title={hearing ? "Stop hearing this mix" : `Hear the mix into ${b.title} in your headphones, the way Auto DJ will do it`}
        aria-label={hearing ? "Stop hearing this mix" : `Hear the mix into ${b.title}`}
        className={clsx("flex shrink-0 items-center gap-1 rounded px-1", hearing ? "text-sky-200" : "text-zinc-400 hover:bg-white/10 hover:text-zinc-100")}
        data-testid={`hear-mix-${i}`}
      >
        <Headphones size={10} /> {hearing ? "Hearing" : "Hear this mix"}
      </button>
    </li>
  );
}

/** The mix being heard: play and pause, where it is (the transition marked), jump to the mix. */
function RehearsalBar() {
  const key = useRehearse((s) => s.key);
  const status = useRehearse((s) => s.status);
  const title = useRehearse((s) => s.title);
  const summary = useRehearse((s) => s.summary);
  const mixAt = useRehearse((s) => s.mixAt);
  const playing = useTelemetry((s) => !!s.t.preview?.playing);
  if (key === null) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-white/[0.06] bg-sky-400/[0.06] px-3 py-2" data-testid="rehearsal-bar">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleMix}
          disabled={status !== "ready"}
          aria-label={playing ? "Pause the mix" : "Play the mix"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-400 text-zinc-950 hover:brightness-110 disabled:opacity-60"
        >
          {status === "loading" ? <Loader2 size={14} className="animate-spin" /> : playing ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
        </button>
        <Headphones size={14} className="shrink-0 text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-zinc-100">{title}</div>
          <div className="truncate text-[11px] text-zinc-400">{status === "loading" ? "Preparing the mix…" : `${summary}, as Auto DJ will play it`}</div>
        </div>
        <Btn size="sm" tone="ghost" disabled={status !== "ready"} onClick={() => seekMix(Math.max(0, mixAt - 4))} title="Jump to a few seconds before the transition starts">
          Jump to the mix
        </Btn>
        <button type="button" onClick={stopMix} aria-label="Stop hearing the mix" title="Stop and close" className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100">
          <X size={14} />
        </button>
      </div>
      <MixStrip />
    </div>
  );
}

function MixStrip() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      const s = useRehearse.getState();
      if (c) {
        const g = setupCanvas(c);
        const r = c.getBoundingClientRect();
        const dur = s.duration || Math.max(1, s.mixEnd + 8);
        g.clearRect(0, 0, r.width, r.height);
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(0, r.height / 2 - 1, r.width, 2);
        // The transition: where both tracks play.
        g.fillStyle = "rgba(56,189,248,0.35)";
        const x0 = (s.mixAt / dur) * r.width;
        g.fillRect(x0, 2, Math.max(2, ((s.mixEnd - s.mixAt) / dur) * r.width), r.height - 4);
        if (s.status === "ready") {
          const x = (previewPosition() / dur) * r.width;
          g.fillStyle = "#fafafa";
          g.fillRect(x - 0.75, 0, 1.5, r.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  const seekAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekMix(((e.clientX - r.left) / r.width) * useRehearse.getState().duration);
  };
  return (
    <canvas
      ref={ref}
      className="h-5 w-full cursor-pointer rounded"
      aria-label="Where the mix is: the blue part is the transition. Click to jump."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekAt(e);
      }}
      data-testid="rehearsal-strip"
    />
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-zinc-100 disabled:opacity-30">
      {children}
    </button>
  );
}

function Log() {
  const log = useAutoDj((s) => s.log);
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-xl border border-white/[0.06] bg-black/20">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
        What Auto DJ did
      </button>
      {open && (
        <ol className="max-h-80 space-y-1.5 overflow-y-auto p-3 text-[11px] leading-snug text-zinc-400">
          {log.length === 0 && <li className="text-zinc-500">Start Auto DJ and each step appears here, newest first.</li>}
          {log.map((e) => (
            <li key={`${e.at}-${e.text}`} className="flex gap-2">
              <span className="shrink-0 font-mono text-[10px] text-zinc-600">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Shown in place of "Mix it" on the mixer while Auto DJ runs. */
export function AutoDjStrip() {
  const phase = useAutoDj((s) => s.phase);
  const next = useAutoDj((s) => s.next);
  const wait = useTelemetry((s) => {
    const x = secondsToMix(s.t);
    return x === null ? null : Math.round(x);
  });
  const progress = useTransition((s) => (s.running ? Math.round(s.running.progress * 100) : null));
  const open = () => {
    useApp.getState().set({ workspace: "library" });
    useLibrary.getState().set({ source: { type: "autodj" } });
  };
  const text =
    phase === "mixing" && next
      ? `${transitionName(next.plan.kind)} into ${next.track.title}${progress !== null ? ` · ${progress}%` : ""}`
      : phase === "waiting" && next
        ? `${next.plan.summary} into ${next.track.title}${wait !== null ? ` in ${countdown(wait)}` : ""}`
        : phase === "ending"
          ? "Last track: add more to keep going"
          : "Loading the next track…";
  return (
    <div className="flex items-center gap-2 rounded-xl border border-sky-400/30 bg-sky-400/10 px-2 py-1.5">
      <Bot size={14} className="shrink-0 text-sky-300" />
      <button type="button" onClick={open} className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-zinc-100 hover:underline" title="Open the Auto DJ queue">
        Auto DJ: {text}
      </button>
      {phase === "waiting" && (
        <Btn size="sm" tone="ghost" onClick={() => void mixNow()} aria-label="Mix now">
          <Zap size={12} />
        </Btn>
      )}
      <Btn size="sm" tone="ghost" onClick={stopAutoDj} aria-label="Stop Auto DJ">
        <Square size={11} />
      </Btn>
    </div>
  );
}
