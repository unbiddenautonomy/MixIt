// The track editor: fix the beat grid (type, tap or halve/double the tempo, put a bar
// start where the music starts, nudge, lock), name and colour cues, add markers, choose
// where the track starts, and turn a selected passage into a loop or a sampler pad.
// It edits the track on a deck, so the deck plays what you are looking at.
import * as Dialog from "@radix-ui/react-dialog";
import { Lock, LockOpen, Minus, Pause, Play, Plus, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import type { CueDto, DeckInfo, GridEdit, TrackDetail } from "../../backend/types";
import { tap } from "../../lib/actions";
import { beatsBetween, foldTempo, introEnd, snapToBeat, tapTempo } from "../../lib/editor";
import { clock, hex } from "../../lib/format";
import { beatsIn, drawWave, HOT_CUE_COLORS, pyramid, SECTION_COLORS, setupCanvas } from "../../lib/waveform";
import { useApp } from "../../store/app";
import { livePosition, useDeckTele, useTelemetry } from "../../store/telemetry";
import { Btn } from "../ui/Button";
import { DECK_COLORS, useWaveform } from "../deck/useWaveform";
import { loadOnDeck } from "../deck/Deck";

const ZOOMS = [2, 4, 8, 16, 32, 64];
const L = (deck: number) => String.fromCharCode(65 + deck);

type Selection = { a: number; b: number } | null;

const run = async (f: () => Promise<unknown>, ok?: string) => {
  try {
    await f();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
};

export function openEditor(deck: number) {
  if (!useApp.getState().decks[deck]) {
    toast.message(`Load a track on deck ${L(deck)} first.`);
    return;
  }
  useApp.getState().set({ editorDeck: deck });
}

/**
 * Opens the editor for a library track: on the deck that already has it, or loaded onto
 * the target deck (or any deck that is not playing).
 */
export async function editTrack(trackId: number) {
  const s = useApp.getState();
  const on = s.decks.findIndex((d) => d?.detail.track.id === trackId);
  if (on >= 0) return openEditor(on);
  const tele = useTelemetry.getState().t.decks;
  const count = s.settings?.decks ?? 2;
  const free = [s.targetDeck, ...Array.from({ length: count }, (_, i) => i)].find((i) => i < count && !tele[i]?.playing);
  if (free == null) {
    toast.warning("Every deck is playing. Pause one to edit this track.");
    return;
  }
  await loadOnDeck(free, trackId);
  if (useApp.getState().decks[free]?.detail.track.id === trackId) openEditor(free);
}

export function TrackEditor() {
  const deck = useApp((s) => s.editorDeck);
  const info = useApp((s) => (s.editorDeck != null ? s.decks[s.editorDeck] : null));
  const open = deck != null && !!info;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && useApp.getState().set({ editorDeck: null })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(760px,92vh)] w-[min(1180px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl"
          aria-describedby={undefined}
        >
          {open && <Editor deck={deck} info={info} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Editor({ deck, info }: { deck: number; info: DeckInfo }) {
  const d = info.detail;
  const [zoom, setZoom] = useState(2);
  const [sel, setSel] = useState<Selection>(null);
  const playing = useDeckTele(deck, (t) => t.playing);
  const pos = useDeckTele(deck, (t) => Math.floor(t.position * 10) / 10);
  const bar = d.beatPeriod > 0 ? Math.floor((pos - d.firstBeat) / d.beatPeriod / d.beatsPerBar) + 1 : 0;
  const jump = (beats: number) => backend().seek(deck, Math.max(0, livePosition(deck) + beats * (d.beatPeriod || 0.5)));

  // Space plays and pauses while the editor is open.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (e.target as HTMLElement)?.tagName === "INPUT") return;
      e.preventDefault();
      e.stopPropagation();
      tap(`deck.${L(deck)}.play`);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [deck]);

  return (
    <>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <span className="rounded px-1.5 text-[11px] font-bold text-zinc-950" style={{ background: DECK_COLORS[deck] }}>
          {L(deck)}
        </span>
        <Dialog.Title className="min-w-0 truncate text-base font-semibold text-zinc-50">
          Edit track: {d.track.title}
          {d.track.artist && <span className="font-normal text-zinc-400"> · {d.track.artist}</span>}
        </Dialog.Title>
        <span className="ml-auto font-mono text-xs text-zinc-400">
          {d.bpm ? `${d.bpm.toFixed(2)} BPM` : "no tempo"} · {d.key?.camelot ?? "no key"} · {clock(d.track.duration)}
        </span>
        <Dialog.Close className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
          <X size={16} />
        </Dialog.Close>
      </div>

      <div className="flex flex-col gap-2 px-5 pt-3">
        <Whole deck={deck} d={d} sel={sel} />
        <Detail deck={deck} d={d} seconds={ZOOMS[zoom]} sel={sel} setSel={setSel} />
        <div className="flex items-center gap-1.5">
          <Btn size="sm" onClick={() => jump(-d.beatsPerBar)} aria-label="Back one bar" title="Back one bar">
            <SkipBack size={12} />
          </Btn>
          <Btn size="sm" tone={playing ? "accent" : "default"} onClick={() => tap(`deck.${L(deck)}.play`)} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)">
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </Btn>
          <Btn size="sm" onClick={() => jump(d.beatsPerBar)} aria-label="Forward one bar" title="Forward one bar">
            <SkipForward size={12} />
          </Btn>
          <span className="ml-2 font-mono text-xs tabular-nums text-zinc-300">
            {clock(pos, true)} {d.analysed && bar > 0 && <span className="text-zinc-500">· bar {bar}</span>}
          </span>
          <span className="ml-3 text-[11px] text-zinc-500">Drag to move through the track. Shift-drag to select a passage (it snaps to beats).</span>
          <div className="ml-auto flex items-center gap-0.5 rounded-md bg-black/40 p-0.5 text-zinc-300">
            <button className="rounded p-1 hover:bg-white/10" onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} title="Zoom out" aria-label="Zoom out">
              <Minus size={12} />
            </button>
            <span className="w-8 text-center font-mono text-[10px]">{ZOOMS[zoom]}s</span>
            <button className="rounded p-1 hover:bg-white/10" onClick={() => setZoom((z) => Math.max(0, z - 1))} title="Zoom in" aria-label="Zoom in">
              <Plus size={12} />
            </button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-y-auto px-5 pb-5 pt-3 text-[13px]">
        <GridPanel deck={deck} d={d} />
        <CuePanel deck={deck} d={d} />
        <SelectionPanel deck={deck} d={d} sel={sel} setSel={setSel} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------- waveforms

function Whole({ deck, d, sel }: { deck: number; d: TrackDetail; sel: Selection }) {
  const wave = useWaveform(d.track.id);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const p = wave ? pyramid(wave) : null;
    const draw = () => {
      const c = ref.current;
      if (c) {
        const g = setupCanvas(c);
        const { width: W, height: H } = c.getBoundingClientRect();
        const dur = d.track.duration || 1;
        const x = (s: number) => (s / dur) * W;
        g.clearRect(0, 0, W, H);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(0, 0, W, H);
        if (p) drawWave(g, p, 0, dur, 0, Math.round(W), H - 6, { playhead: livePosition(deck), dimPlayed: true });
        for (const s of d.sections) {
          g.fillStyle = SECTION_COLORS[s.label] ?? "#52525b";
          g.fillRect(x(s.start) + 0.5, H - 4, Math.max(1, x(s.end) - x(s.start) - 1), 4);
        }
        if (sel) {
          g.fillStyle = "rgba(56,189,248,0.22)";
          g.fillRect(x(sel.a), 0, Math.max(1, x(sel.b) - x(sel.a)), H);
        }
        for (const cu of d.cues) {
          if (cu.role !== "hot" && cu.role !== "memory") continue;
          g.fillStyle = cu.role === "hot" ? hex(cu.color) : "#e4e4e7";
          g.fillRect(x(cu.seconds) - 1, 0, 2, H);
        }
        g.fillStyle = "#fafafa";
        g.fillRect(x(livePosition(deck)) - 1, 0, 2, H);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, d, wave, sel]);
  const seek = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    backend().seek(deck, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d.track.duration);
  };
  return (
    <canvas
      ref={ref}
      className="block h-12 w-full cursor-pointer rounded-lg"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seek(e);
      }}
      onPointerMove={(e) => e.buttons && seek(e)}
      aria-label="Whole track: click to jump"
    />
  );
}

function Detail({ deck, d, seconds, sel, setSel }: { deck: number; d: TrackDetail; seconds: number; sel: Selection; setSel: (s: Selection) => void }) {
  const wave = useWaveform(d.track.id);
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; pos: number; select: boolean; anchor: number } | null>(null);
  const view = useRef({ t0: 0, t1: 1 });

  useEffect(() => {
    let raf = 0;
    const p = wave ? pyramid(wave) : null;
    const draw = () => {
      const c = ref.current;
      if (c) {
        const g = setupCanvas(c);
        const { width: W, height: H } = c.getBoundingClientRect();
        const pos = drag.current && !drag.current.select ? drag.current.pos : livePosition(deck);
        const t0 = pos - seconds / 2;
        const t1 = pos + seconds / 2;
        view.current = { t0, t1 };
        const x = (s: number) => ((s - t0) / (t1 - t0)) * W;
        g.clearRect(0, 0, W, H);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(0, 0, W, H);
        const tele = useTelemetry.getState().t.decks[deck];
        if (tele.looping.end > tele.looping.start) {
          g.fillStyle = tele.looping.active ? "rgba(34,197,94,0.18)" : "rgba(161,161,170,0.10)";
          g.fillRect(x(tele.looping.start), 0, x(tele.looping.end) - x(tele.looping.start), H);
        }
        if (sel) {
          g.fillStyle = "rgba(56,189,248,0.22)";
          g.fillRect(x(sel.a), 0, x(sel.b) - x(sel.a), H);
          g.fillStyle = "#38bdf8";
          g.fillRect(x(sel.a) - 1, 0, 2, H);
          g.fillRect(x(sel.b) - 1, 0, 2, H);
        }
        if (p) drawWave(g, p, t0, t1, 0, Math.round(W), H - 14, {});
        // Grid with bar numbers.
        for (const [bt, k] of beatsIn(d, t0, t1)) {
          const bx = Math.round(x(bt)) + 0.5;
          const isBar = ((k % d.beatsPerBar) + d.beatsPerBar) % d.beatsPerBar === 0;
          const phrase = ((k % (d.beatsPerBar * 8)) + d.beatsPerBar * 8) % (d.beatsPerBar * 8) === 0;
          g.fillStyle = phrase ? "rgba(244,63,94,0.95)" : isBar ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.2)";
          g.fillRect(bx - (phrase ? 1 : 0.5), 0, phrase ? 2 : 1, H - 14);
          if (isBar && k >= 0) {
            g.font = "600 10px ui-sans-serif, system-ui";
            g.fillText(String(Math.floor(k / d.beatsPerBar) + 1), bx + 3, H - 3);
          }
        }
        // Cues and markers with their names.
        for (const cu of d.cues) {
          if (cu.seconds < t0 || cu.seconds > t1) continue;
          const cx = x(cu.seconds);
          if (cu.role === "hot" || cu.role === "memory") {
            const col = cu.role === "hot" ? hex(cu.color) : hex(cu.color, "#e4e4e7");
            g.fillStyle = col;
            g.fillRect(cx - 1, 0, 2, H - 14);
            const label = cu.role === "hot" ? `${(cu.slot ?? 0) + 1}${cu.label ? ` ${cu.label}` : ""}` : cu.label || "Marker";
            g.font = "700 10px ui-sans-serif, system-ui";
            const w = g.measureText(label).width + 8;
            g.beginPath();
            g.roundRect(cx, 0, w, 14, 3);
            g.fill();
            g.fillStyle = "#09090b";
            g.fillText(label, cx + 4, 10);
          }
        }
        if (tele.cue >= t0 && tele.cue <= t1) {
          const cx = x(tele.cue);
          g.fillStyle = "#f59e0b";
          g.beginPath();
          g.moveTo(cx - 6, H - 14);
          g.lineTo(cx + 6, H - 14);
          g.lineTo(cx, H - 22);
          g.fill();
        }
        g.fillStyle = "rgba(250,250,250,0.95)";
        g.fillRect(W / 2 - 1, 0, 2, H);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, d, wave, seconds, sel]);

  const timeAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { t0, t1 } = view.current;
    return t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
  };

  return (
    <canvas
      ref={ref}
      className="block h-40 w-full cursor-grab rounded-lg active:cursor-grabbing"
      style={{ touchAction: "none" }}
      aria-label="Track waveform with beat grid"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const select = e.shiftKey;
        const at = snapToBeat(d, timeAt(e));
        drag.current = { x: e.clientX, pos: livePosition(deck), select, anchor: at };
        if (select) setSel({ a: at, b: at });
      }}
      onPointerMove={(e) => {
        const g = drag.current;
        if (!g) return;
        if (g.select) {
          const t = snapToBeat(d, timeAt(e));
          setSel({ a: Math.min(g.anchor, t), b: Math.max(g.anchor, t) });
          return;
        }
        const W = (e.currentTarget as HTMLElement).getBoundingClientRect().width;
        g.pos = Math.max(0, Math.min(d.track.duration, g.pos - ((e.clientX - g.x) / W) * seconds));
        g.x = e.clientX;
      }}
      onPointerUp={(e) => {
        const g = drag.current;
        drag.current = null;
        if (!g) return;
        if (g.select) {
          if (sel && sel.b - sel.a < 0.05) setSel(null);
          return;
        }
        // A click without a drag jumps there; a drag moves the track under the play head.
        if (Math.abs(e.clientX - g.x) < 3 && Math.abs(g.pos - livePosition(deck)) < 0.01) backend().seek(deck, snapToBeat(d, timeAt(e)));
        else backend().seek(deck, g.pos);
      }}
    />
  );
}

// ---------------------------------------------------------------- panels

function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div>
        <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function GridPanel({ deck, d }: { deck: number; d: TrackDetail }) {
  const [bpmText, setBpmText] = useState(d.bpm ? d.bpm.toFixed(2) : "");
  const [taps, setTaps] = useState<number[]>([]);
  useEffect(() => setBpmText(d.bpm ? d.bpm.toFixed(2) : ""), [d.bpm]);
  const tapped = tapTempo(taps);
  const folded = tapped ? foldTempo(tapped, d.bpm) : null;
  const edit = (e: GridEdit, ok?: string) => run(() => backend().setGrid(deck, e), ok);
  const locked = d.gridLocked;
  return (
    <Panel title="Beat grid" hint="The lines over the waveform. When they sit on the kicks, Sync, loops and beat jumps land in time.">
      <div className="flex items-center gap-1.5">
        <label className="text-zinc-400" htmlFor="ed-bpm">
          Tempo
        </label>
        <input
          id="ed-bpm"
          className="w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-zinc-100 disabled:opacity-50"
          value={bpmText}
          disabled={locked}
          inputMode="decimal"
          onChange={(e) => setBpmText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && edit({ bpm: Number(bpmText) })}
        />
        <Btn size="sm" disabled={locked || !Number(bpmText) || Number(bpmText) === d.bpm} onClick={() => edit({ bpm: Number(bpmText) })}>
          Set
        </Btn>
        <Btn size="sm" disabled={locked || !d.bpm} onClick={() => edit({ bpm: (d.bpm ?? 0) / 2 })} title="The tempo is double what it should be">
          ÷2
        </Btn>
        <Btn size="sm" disabled={locked || !d.bpm} onClick={() => edit({ bpm: (d.bpm ?? 0) * 2 })} title="The tempo is half what it should be">
          ×2
        </Btn>
      </div>
      <div className="flex items-center gap-1.5">
        <Btn size="sm" disabled={locked} onPointerDown={() => setTaps((t) => [...t.slice(-16), performance.now() / 1000])} title="Tap along with the kick drum">
          Tap tempo
        </Btn>
        <span className="font-mono text-xs text-zinc-300">{folded ? `${folded.toFixed(2)} BPM` : taps.length ? `${Math.max(0, 4 - taps.length)} more taps` : "tap on each beat"}</span>
        {folded && (
          <Btn size="sm" tone="accent" disabled={locked} onClick={() => (edit({ bpm: folded }), setTaps([]))}>
            Use it
          </Btn>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn size="sm" disabled={locked} onClick={() => edit({ downbeatAt: livePosition(deck) }, "Bar 1 now starts at the play head")} title="Put the play head on the first kick of a bar, then press this">
          A bar starts here
        </Btn>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-zinc-500">Move grid (ms)</span>
        {[-10, -1, 1, 10].map((ms) => (
          <Btn key={ms} size="sm" disabled={locked} onClick={() => edit({ nudgeMs: ms })} title={`${Math.abs(ms)} ms ${ms < 0 ? "earlier" : "later"}`} aria-label={`Move grid ${Math.abs(ms)} ms ${ms < 0 ? "earlier" : "later"}`}>
            {ms > 0 ? `+${ms}` : `−${-ms}`}
          </Btn>
        ))}
      </div>
      <div className="mt-auto flex items-center gap-2">
        <Btn size="sm" tone={locked ? "accent" : "default"} onClick={() => edit({ locked: !locked }, locked ? "Grid unlocked" : "Grid locked: re-analysis keeps it")}>
          {locked ? <Lock size={12} /> : <LockOpen size={12} />} {locked ? "Locked" : "Lock grid"}
        </Btn>
        <span className="text-[11px] text-zinc-500">
          {d.constantGrid ? "Steady tempo" : "Tempo moves (live drummer)"}
          {d.analysed && ` · confidence ${Math.round(d.tempoConfidence * 100)}%`}
        </span>
      </div>
    </Panel>
  );
}

function CuePanel({ deck, d }: { deck: number; d: TrackDetail }) {
  const hot = d.cues.filter((c) => c.role === "hot" && c.slot != null);
  const memory = d.cues.filter((c) => c.role === "memory").sort((a, b) => a.seconds - b.seconds);
  const cuePoint = useDeckTele(deck, (t) => t.cue);
  const skip = introEnd(d);
  const at = () => snapToBeat(d, livePosition(deck));
  return (
    <Panel title="Cues and markers" hint="Hot cues are the numbered pads on the deck. Markers are named spots that only show on the waveform.">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-zinc-400">Starts at</span>
        <span className="font-mono text-zinc-100">{clock(cuePoint, true)}</span>
        <Btn size="sm" onClick={() => run(() => backend().setMainCue(deck, at()), "The track now starts here when loaded")}>
          Start here
        </Btn>
        {skip != null && (
          <Btn size="sm" onClick={() => run(() => backend().setMainCue(deck, skip), "Long intro skipped")} title="Start where the intro ends">
            Skip intro
          </Btn>
        )}
      </div>
      <div className="grid grid-cols-1 gap-1">
        {Array.from({ length: 8 }, (_, slot) => {
          const c = hot.find((x) => x.slot === slot);
          return <HotRow key={slot} deck={deck} slot={slot} cue={c ?? null} at={at} />;
        })}
      </div>
      <div className="flex items-center gap-1.5 border-t border-white/[0.06] pt-2">
        <span className="font-medium text-zinc-300">Markers</span>
        <Btn size="sm" className="ml-auto" onClick={() => run(() => backend().setMemoryCue(deck, at(), `Marker ${memory.length + 1}`))}>
          <Plus size={12} /> Add at play head
        </Btn>
      </div>
      {memory.length === 0 && <p className="text-[11px] text-zinc-500">No markers yet. Add one where the vocal comes in, or where you like to mix out.</p>}
      {memory.map((c) => (
        <MemoryRow key={c.seconds} deck={deck} cue={c} />
      ))}
    </Panel>
  );
}

function LabelInput({ value, placeholder, onSave }: { value: string; placeholder: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-zinc-100 placeholder:text-zinc-600 hover:border-white/10 focus:border-white/20 focus:bg-black/30 focus:outline-none"
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function HotRow({ deck, slot, cue, at }: { deck: number; slot: number; cue: CueDto | null; at: () => number }) {
  const color = cue?.color ?? HOT_CUE_COLORS[slot];
  const save = (p: { seconds?: number; label?: string; color?: number }) =>
    run(() => backend().setHotCue(deck, slot, p.seconds ?? cue?.seconds ?? at(), cue?.loopSeconds ?? null, p.color ?? color, p.label ?? cue?.label ?? ""));
  return (
    <div className={clsx("flex items-center gap-1.5 rounded-md px-1.5 py-0.5", cue ? "bg-white/[0.03]" : "opacity-70")}>
      <button
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold text-zinc-950"
        style={{ background: hex(color) }}
        title={cue ? "Change colour" : `Hot cue ${slot + 1}`}
        onClick={() => cue && save({ color: HOT_CUE_COLORS[(HOT_CUE_COLORS.indexOf(color) + 1) % HOT_CUE_COLORS.length] })}
      >
        {slot + 1}
      </button>
      {cue ? (
        <>
          <LabelInput value={cue.label} placeholder="Name it (Vocal, Drop…)" onSave={(label) => save({ label })} />
          <span className="font-mono text-[11px] text-zinc-500">
            {clock(cue.seconds, true)}
            {cue.loopSeconds ? " loop" : ""}
          </span>
          <button className="rounded px-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100" onClick={() => backend().seek(deck, cue.seconds)}>
            Go
          </button>
          <button className="rounded px-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100" onClick={() => save({ seconds: at() })} title="Move it to the play head">
            Move here
          </button>
          <button className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-red-300" onClick={() => run(() => backend().deleteHotCue(deck, slot))} aria-label={`Delete hot cue ${slot + 1}`}>
            <Trash2 size={12} />
          </button>
        </>
      ) : (
        <>
          <span className="flex-1 text-[11px] text-zinc-500">Empty</span>
          <button className="rounded px-1 text-[11px] text-zinc-300 hover:bg-white/10" onClick={() => save({ seconds: at() })}>
            Set at play head
          </button>
        </>
      )}
    </div>
  );
}

function MemoryRow({ deck, cue }: { deck: number; cue: CueDto }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-white/[0.03] px-1.5 py-0.5">
      <span className="h-3 w-1 rounded-full" style={{ background: hex(cue.color, "#e4e4e7") }} />
      <LabelInput value={cue.label} placeholder="Name" onSave={(label) => run(() => backend().setMemoryCue(deck, cue.seconds, label, cue.color))} />
      <span className="font-mono text-[11px] text-zinc-500">{clock(cue.seconds, true)}</span>
      <button className="rounded px-1 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100" onClick={() => backend().seek(deck, cue.seconds)}>
        Go
      </button>
      <button className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-red-300" onClick={() => run(() => backend().deleteMemoryCue(deck, cue.seconds))} aria-label="Delete marker">
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function SelectionPanel({ deck, d, sel, setSel }: { deck: number; d: TrackDetail; sel: Selection; setSel: (s: Selection) => void }) {
  const pads = useApp((s) => s.pads);
  const [pad, setPad] = useState(() => Math.max(0, pads.findIndex((p) => p.source.type === "empty")));
  const cues = d.cues.filter((c) => c.role === "hot");
  const free = Array.from({ length: 8 }, (_, i) => i).find((i) => !cues.some((c) => c.slot === i));
  const quick = (bars: number) => {
    const a = snapToBeat(d, livePosition(deck));
    setSel({ a, b: a + bars * d.beatsPerBar * (d.beatPeriod || 0.5) });
  };
  const beats = sel ? beatsBetween(d, sel.a, sel.b) : 0;
  return (
    <Panel title="Selected passage" hint="Shift-drag on the waveform, or pick a length from the play head. Then loop it, save it as a loop cue, or put it on a sampler pad.">
      <div className="flex items-center gap-1.5">
        <span className="text-zinc-400">From play head</span>
        {[1, 2, 4, 8].map((b) => (
          <Btn key={b} size="sm" onClick={() => quick(b)}>
            {b} bar{b > 1 ? "s" : ""}
          </Btn>
        ))}
      </div>
      {sel ? (
        <>
          <div className="font-mono text-xs text-zinc-200">
            {clock(sel.a, true)} to {clock(sel.b, true)} · {beats ? `${beats} beats` : `${(sel.b - sel.a).toFixed(2)} s`}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Btn size="sm" onClick={() => run(async () => (await backend().setLoop(deck, sel.a, sel.b, true), await backend().seek(deck, sel.a)))}>
              Loop it on the deck
            </Btn>
            <Btn
              size="sm"
              disabled={free === undefined}
              onClick={() => run(() => backend().setHotCue(deck, free!, sel.a, sel.b - sel.a, HOT_CUE_COLORS[free!], `Loop ${beats || ""}`.trim()), `Saved as loop cue ${free! + 1}`)}
            >
              Save as loop cue
            </Btn>
            <Btn size="sm" onClick={() => setSel(null)}>
              Clear
            </Btn>
          </div>
          <div className="flex items-center gap-1.5 border-t border-white/[0.06] pt-2">
            <span className="shrink-0 text-zinc-400">Pad</span>
            <select className="min-w-0 flex-1 truncate rounded-md border border-white/10 bg-black/30 px-1.5 py-1 text-zinc-100" value={pad} onChange={(e) => setPad(Number(e.target.value))} aria-label="Pad">
              {pads.map((p, i) => (
                <option key={i} value={i}>
                  {i + 1}: {p.name || "empty"}
                </option>
              ))}
            </select>
            <Btn
              size="sm"
              tone="accent"
              onClick={() =>
                run(async () => {
                  const p = await backend().samplerLoad(pad, { type: "track", trackId: d.track.id, start: sel.a, seconds: sel.b - sel.a });
                  useApp.setState((s) => ({ pads: s.pads.map((x, i) => (i === pad ? p : x)) }));
                }, `Pad ${pad + 1} now plays this passage in a loop`)
              }
              className="shrink-0"
            >
              Put on pad
            </Btn>
          </div>
        </>
      ) : (
        <p className="text-[11px] text-zinc-500">Nothing selected.</p>
      )}
    </Panel>
  );
}
