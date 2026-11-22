// The performance pads under each deck: hot cues, loops, beat jump, the slicer, rolls,
// FX and (Pro) the beat grid tools.
import clsx from "clsx";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Repeat, X } from "lucide-react";
import { backend } from "../../backend";
import type { CueDto } from "../../backend/types";
import { choose, press, release, setOn, tap } from "../../lib/actions";
import { clock, hex } from "../../lib/format";
import { beatsIn, HOT_CUE_COLORS } from "../../lib/waveform";
import { JUMP_LABELS, LOOP_LABELS, ROLL_BEATS, SLICE_BARS, useApp, usePro } from "../../store/app";
import { livePosition, useDeckTele } from "../../store/telemetry";
import { ActionBtn, Btn } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { FxUnit } from "./FxUnit";

type Tab = "cues" | "loop" | "jump" | "slicer" | "roll" | "fx" | "grid";

export function Pads({ deck, compact = false }: { deck: number; compact?: boolean }) {
  const pro = usePro();
  const tab = useApp((s) => s.padTabs[deck]) as Tab;
  const setTab = (t: Tab) => useApp.getState().set({ padTabs: useApp.getState().padTabs.map((x, i) => (i === deck ? t : x)) });
  const tabs: { id: Tab; label: string }[] = [
    { id: "cues", label: "Hot cues" },
    { id: "loop", label: "Loop" },
    { id: "jump", label: "Jump" },
    { id: "slicer", label: "Slicer" },
    { id: "roll", label: "Roll" },
    { id: "fx", label: "FX" },
    ...(pro ? [{ id: "grid" as Tab, label: "Grid" }] : []),
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : "cues";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-0.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={clsx(
              "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors",
              current === t.id ? "bg-white/10 text-zinc-50" : "text-zinc-500 hover:text-zinc-200",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {current === "cues" && <HotCues deck={deck} compact={compact} />}
      {current === "loop" && <Loops deck={deck} pro={pro} />}
      {current === "jump" && <Jump deck={deck} />}
      {current === "slicer" && <Slicer deck={deck} compact={compact} />}
      {current === "roll" && <Rolls deck={deck} compact={compact} />}
      {current === "fx" && <FxUnit unit={deck} />}
      {current === "grid" && <Grid deck={deck} />}
    </div>
  );
}

/** Nearest beat to `t` when quantize is on. */
export function quantized(deck: number, t: number): number {
  const { decks, mixer } = useApp.getState();
  const d = decks[deck]?.detail;
  if (!mixer.quantize || !d?.analysed) return t;
  const near = beatsIn(d, t - d.beatPeriod, t + d.beatPeriod);
  let best = t;
  let dist = Infinity;
  for (const [b] of near) {
    if (Math.abs(b - t) < dist) {
      dist = Math.abs(b - t);
      best = b;
    }
  }
  return best;
}

function HotCues({ deck, compact }: { deck: number; compact: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const cues = useApp((s) => s.decks[deck]?.detail.cues);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  const bySlot: (CueDto | undefined)[] = Array.from({ length: 8 }, (_, i) => cues?.find((c) => c.role === "hot" && c.slot === i));
  return (
    <div className={clsx("grid gap-1", compact ? "grid-cols-8" : "grid-cols-4")}>
      {bySlot.map((c, i) => {
        const id = `deck.${L}.hotcue.${i + 1}`;
        const color = c ? hex(c.color, hex(HOT_CUE_COLORS[i])) : undefined;
        return (
          <Ctl key={i} id={id} explain={c ? "Jumps here instantly. Right-click or Shift-click to delete." : "Click to save this spot (on the beat when quantize is on)."}>
            <button
              type="button"
              disabled={!loaded}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (e.shiftKey && c) {
                  backend().deleteHotCue(deck, i);
                  return;
                }
                if (!c) {
                  backend().setHotCue(deck, i, quantized(deck, livePosition(deck)), null, HOT_CUE_COLORS[i]);
                  return;
                }
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                press(id);
              }}
              onPointerUp={() => c && release(id)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (c) backend().deleteHotCue(deck, i);
              }}
              className={clsx(
                "relative flex h-9 w-full min-w-0 flex-col items-start justify-center overflow-hidden rounded-lg border px-2 text-left transition active:scale-[0.97] disabled:opacity-40",
                c ? "border-transparent text-zinc-950" : "border-white/[0.08] bg-white/[0.03] text-zinc-500 hover:bg-white/[0.07]",
              )}
              style={c ? { background: color, boxShadow: `0 0 14px -6px ${color}` } : undefined}
            >
              <span className="text-[11px] font-bold leading-none">{c?.label || i + 1}</span>
              {c && !compact && (
                <span className="font-mono text-[9px] leading-tight opacity-70">
                  {clock(c.seconds, true)}
                  {c.loopSeconds ? <Repeat size={8} className="ml-1 inline" /> : null}
                </span>
              )}
            </button>
          </Ctl>
        );
      })}
    </div>
  );
}

function Loops({ deck, pro }: { deck: number; pro: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const size = useApp((s) => s.mixer.loopSize[deck]);
  const active = useDeckTele(deck, (d) => d.looping.active);
  const beats = useDeckTele(deck, (d) => d.looping.beats);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  const sizes = pro ? LOOP_LABELS.map((l, i) => [l, i] as const) : LOOP_LABELS.map((l, i) => [l, i] as const).filter(([, i]) => i >= 4 && i <= 9);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {sizes.map(([label, i]) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              choose(`deck.${L}.loop.size`, i);
              if (!active) setOn(`deck.${L}.loop.auto`, true);
            }}
            className={clsx(
              "h-7 min-w-9 rounded-md border px-1.5 font-mono text-[11px] transition-colors",
              size === i ? (active ? "border-transparent bg-[var(--accent)] text-zinc-950" : "border-[var(--accent)]/50 text-[var(--accent-ink)]") : "border-white/[0.08] text-zinc-400 hover:bg-white/[0.06]",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Ctl id={`deck.${L}.loop.auto`}>
          <Btn size="sm" active={active} disabled={!loaded} onClick={() => setOn(`deck.${L}.loop.auto`, !active)}>
            <Repeat size={12} /> {active ? `${fmtBeats(beats)} on` : "Loop"}
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.loop.halve`}>
          <Btn size="sm" onClick={() => tap(`deck.${L}.loop.halve`)}>
            ½
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.loop.double`}>
          <Btn size="sm" onClick={() => tap(`deck.${L}.loop.double`)}>
            ×2
          </Btn>
        </Ctl>
        {pro && (
          <>
            <Ctl id={`deck.${L}.loop.in`}>
              <Btn size="sm" onClick={() => tap(`deck.${L}.loop.in`)}>
                In
              </Btn>
            </Ctl>
            <Ctl id={`deck.${L}.loop.out`}>
              <Btn size="sm" onClick={() => tap(`deck.${L}.loop.out`)}>
                Out
              </Btn>
            </Ctl>
            <Ctl id={`deck.${L}.loop.reloop`}>
              <Btn size="sm" onClick={() => tap(`deck.${L}.loop.reloop`)}>
                Reloop
              </Btn>
            </Ctl>
            <Ctl id={`deck.${L}.loop.roll`}>
              <ActionBtn id={`deck.${L}.loop.roll`} size="sm">
                Roll
              </ActionBtn>
            </Ctl>
            <Ctl id={`deck.${L}.loop.move_back`}>
              <Btn size="sm" onClick={() => tap(`deck.${L}.loop.move_back`)} aria-label="Move loop back">
                <ChevronLeft size={12} />
              </Btn>
            </Ctl>
            <Ctl id={`deck.${L}.loop.move_fwd`}>
              <Btn size="sm" onClick={() => tap(`deck.${L}.loop.move_fwd`)} aria-label="Move loop forward">
                <ChevronRight size={12} />
              </Btn>
            </Ctl>
          </>
        )}
      </div>
    </div>
  );
}

function fmtBeats(b: number): string {
  if (b <= 0) return "";
  if (b >= 1) return `${Math.round(b)} beat${Math.round(b) === 1 ? "" : "s"}`;
  return `1/${Math.round(1 / b)}`;
}

function Jump({ deck }: { deck: number }) {
  const L = String.fromCharCode(65 + deck);
  const size = useApp((s) => s.mixer.jumpSize[deck]);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Ctl id={`deck.${L}.beatjump.back`}>
        <Btn disabled={!loaded} onClick={() => tap(`deck.${L}.beatjump.back`)} aria-label="Jump back">
          <ChevronsLeft size={14} />
        </Btn>
      </Ctl>
      {JUMP_LABELS.map((label, i) => (
        <button
          key={i}
          type="button"
          onClick={() => choose(`deck.${L}.beatjump.size`, i)}
          className={clsx(
            "h-8 min-w-9 rounded-md border px-1.5 font-mono text-[11px]",
            size === i ? "border-[var(--accent)]/60 text-[var(--accent-ink)]" : "border-white/[0.08] text-zinc-400 hover:bg-white/[0.06]",
          )}
        >
          {label}
        </button>
      ))}
      <Ctl id={`deck.${L}.beatjump.fwd`}>
        <Btn disabled={!loaded} onClick={() => tap(`deck.${L}.beatjump.fwd`)} aria-label="Jump forward">
          <ChevronsRight size={14} />
        </Btn>
      </Ctl>
      <span className="ml-1 text-[10px] text-zinc-500">beats</span>
    </div>
  );
}

function Grid({ deck }: { deck: number }) {
  const L = String.fromCharCode(65 + deck);
  const info = useApp((s) => s.decks[deck]);
  const d = info?.detail;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Ctl id={`deck.${L}.grid.set_downbeat`} label="Set downbeat" explain="Moves the grid so the first beat of a bar lands where the play head is.">
          <Btn size="sm" onClick={() => tap(`deck.${L}.grid.set_downbeat`)}>
            Downbeat here
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.grid.halve`} label="Half tempo" explain="Halves the tempo, for when MixIt counted twice as many beats as the music has.">
          <Btn size="sm" onClick={() => tap(`deck.${L}.grid.halve`)}>
            ½ BPM
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.grid.double`} label="Double tempo" explain="Doubles the tempo, for when MixIt counted only every other beat.">
          <Btn size="sm" onClick={() => tap(`deck.${L}.grid.double`)}>
            ×2 BPM
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.grid.nudge_back`} label="Grid earlier" explain="Moves the beat lines a little earlier, so they sit exactly on the kicks.">
          <Btn size="sm" onClick={() => tap(`deck.${L}.grid.nudge_back`)} aria-label="Grid earlier">
            <ChevronLeft size={12} />
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.grid.nudge_fwd`} label="Grid later" explain="Moves the beat lines a little later, so they sit exactly on the kicks.">
          <Btn size="sm" onClick={() => tap(`deck.${L}.grid.nudge_fwd`)} aria-label="Grid later">
            <ChevronRight size={12} />
          </Btn>
        </Ctl>
      </div>
      {d && (
        <div className="flex flex-wrap gap-x-3 font-mono text-[10px] text-zinc-500">
          <span>{d.constantGrid ? "constant grid" : "warped grid"}</span>
          <span>confidence {Math.round(d.tempoConfidence * 100)}%</span>
          {d.driftMs > 0 && <span>drift {d.driftMs.toFixed(1)} ms</span>}
          {d.bpmCandidates.length > 1 && <span>alt {d.bpmCandidates.slice(1, 3).map((b) => b.toFixed(1)).join(", ")}</span>}
          {d.tuningCents !== 0 && <span>tuning {d.tuningCents > 0 ? "+" : ""}{d.tuningCents.toFixed(0)}¢</span>}
        </div>
      )}
    </div>
  );
}

export function EjectButton({ deck }: { deck: number }) {
  const L = String.fromCharCode(65 + deck);
  const playing = useDeckTele(deck, (d) => d.playing);
  return (
    <Ctl id={`deck.${L}.eject`}>
      <Btn
        size="sm"
        tone="ghost"
        disabled={playing}
        onClick={() => {
          tap(`deck.${L}.eject`);
          useApp.setState((s) => ({ decks: s.decks.map((x, i) => (i === deck ? null : x)) }));
        }}
        aria-label="Eject"
      >
        <X size={12} />
      </Btn>
    </Ctl>
  );
}

/** Which of the 8 slices the track is in now (or -1), for lighting the pad. */
function useSliceNow(deck: number, beats: number): number {
  return useDeckTele(deck, (d) => (d.loaded && d.playing ? Math.floor((((d.beat % beats) + beats) % beats) / (beats / 8)) : -1));
}

function Slicer({ deck, compact }: { deck: number; compact: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const size = useApp((s) => s.mixer.sliceSize[deck] ?? 1);
  const bars = SLICE_BARS[size] ?? 2;
  const now = useSliceNow(deck, bars * 4);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  return (
    <div className="flex flex-col gap-1">
      <div className={clsx("grid gap-1", compact ? "grid-cols-8" : "grid-cols-4")}>
        {Array.from({ length: 8 }, (_, i) => (
          <Ctl key={i} id={`deck.${L}.slice.${i + 1}`}>
            <ActionBtn
              id={`deck.${L}.slice.${i + 1}`}
              size={compact ? "sm" : "md"}
              disabled={!loaded}
              className={clsx("w-full font-mono", now === i && "!border-[var(--accent)]/70 !bg-[var(--accent)]/15")}
              aria-label={`Slice ${i + 1}`}
            >
              {i + 1}
            </ActionBtn>
          </Ctl>
        ))}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <Ctl id={`deck.${L}.slice.size`}>
          <span className="flex gap-0.5">
            {SLICE_BARS.map((b, i) => (
              <button
                key={b}
                type="button"
                onClick={() => choose(`deck.${L}.slice.size`, i)}
                className={clsx("rounded px-1.5 py-0.5 font-mono", i === size ? "bg-white/15 text-zinc-100" : "hover:text-zinc-200")}
              >
                {b} bar{b > 1 ? "s" : ""}
              </button>
            ))}
          </span>
        </Ctl>
        <span className="truncate">Hold a pad to play that slice in time; let go and the track carries on.</span>
      </div>
    </div>
  );
}

function Rolls({ deck, compact }: { deck: number; compact: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  return (
    <div className="flex flex-col gap-1">
      <div className={clsx("grid gap-1", compact ? "grid-cols-8" : "grid-cols-4")}>
        {ROLL_BEATS.map((b, i) => (
          <Ctl key={i} id={`deck.${L}.roll.${i + 1}`}>
            <ActionBtn id={`deck.${L}.roll.${i + 1}`} size={compact ? "sm" : "md"} disabled={!loaded} className="w-full font-mono" aria-label={`Roll ${fmtBeats(b)}`}>
              {b >= 1 ? b : `1/${Math.round(1 / b)}`}
            </ActionBtn>
          </Ctl>
        ))}
      </div>
      <div className="text-[11px] text-zinc-500">Hold to stutter the beat (numbers are beats). Short rolls build tension before a drop.</div>
    </div>
  );
}
