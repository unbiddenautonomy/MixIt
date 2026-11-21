// The step sequencer: one row of squares per pad. A lit square plays that pad on that
// step, in time with the music (the engine places every hit to the sample).
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { ChevronDown, Play, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { tap } from "../../lib/actions";
import { hex } from "../../lib/format";
import { useApp } from "../../store/app";
import {
  DRUM_KIT,
  PAGE,
  PRESETS,
  applyPreset,
  clearPattern,
  doublePattern,
  missingSounds,
  setFollow,
  setPage,
  setSequencerOn,
  setStep,
  setStepBeats,
  setSteps,
  setSwing,
  shiftRow,
  useSequencer,
  type Preset,
} from "../../store/sequencer";
import { useTelemetry } from "../../store/telemetry";
import { Segmented } from "../ui/Button";
import { Knob } from "../ui/Knob";
import { loadPad } from "./SamplerPanel";

const STEP_OPTIONS = [8, 16, 32, 64];
const RATE_OPTIONS = [
  { value: 0.5, label: "1/8", title: "Each square is an eighth note: two per beat" },
  { value: 0.25, label: "1/16", title: "Each square is a sixteenth note: four per beat" },
  { value: 0.125, label: "1/32", title: "Each square is a thirty-second note: eight per beat, for fast rolls" },
];

const lengthText = (beats: number) => (beats >= 4 ? `${beats / 4} bar${beats > 4 ? "s" : ""}` : `${beats} beat${beats === 1 ? "" : "s"}`);

const padKits = () => useApp.getState().pads.map((p) => (p.source.type === "kit" ? p.source.id : null));

export async function loadDrumKit() {
  await Promise.all(DRUM_KIT.map((id, pad) => loadPad(pad, { type: "kit", id })));
  toast.success("A drum kit is on the pads: kick, snare, clap, hi-hats, rim, tom and shaker");
}

function startPreset(p: Preset) {
  const missing = missingSounds(p, padKits());
  const filled = applyPreset(p, padKits());
  if (missing.length > 0) {
    toast(filled ? `Some sounds of "${p.name}" are not on a pad` : `"${p.name}" needs drum sounds on the pads`, {
      description: "Load the drum kit to hear the whole pattern. It replaces the sounds on the pads.",
      action: {
        label: "Load drum kit",
        onClick: () => void loadDrumKit().then(() => applyPreset(p, padKits())),
      },
    });
  }
}

/** Paints squares while the pointer is held down, so a row can be filled in one drag. */
const paint = { active: false, value: true };

function Cell({ pad, step, on, now, color, beatStart }: { pad: number; step: number; on: boolean; now: boolean; color: string; beatStart: boolean }) {
  return (
    <button
      type="button"
      aria-label={`Pad ${pad + 1}, step ${step + 1}`}
      aria-pressed={on}
      data-step={step}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        paint.active = true;
        paint.value = !on;
        setStep(pad, step, !on);
      }}
      onPointerEnter={() => paint.active && setStep(pad, step, paint.value)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setStep(pad, step, !on);
        }
      }}
      className={clsx("h-[15px] min-w-0 flex-1 rounded-[3px] border transition-colors duration-75", beatStart && step > 0 && "ml-[3px]", now ? "border-white/70" : "border-transparent")}
      style={{ background: on ? (now ? color : `${color}cc`) : now ? "rgba(255,255,255,0.16)" : beatStart ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.05)" }}
    />
  );
}

function Row({ pad, page, steps, perBeat, playing }: { pad: number; page: number; steps: number; perBeat: number; playing: number }) {
  const p = useApp((s) => s.pads[pad]);
  const row = useSequencer((s) => s.pads[pad]);
  const color = hex(p?.color ?? 0x64748b);
  const empty = !p || p.source.type === "empty";
  const from = page * PAGE;
  const count = Math.min(PAGE, steps - from);
  return (
    <div className={clsx("group flex items-center gap-1", empty && "opacity-40")}>
      <button
        type="button"
        title={empty ? "This pad is empty: put a sound on it in the Pads tab" : `Play ${p.name}. Right-click for more`}
        onClick={() => !empty && tap(`sampler.pad.${pad + 1}`)}
        onContextMenu={(e) => {
          e.preventDefault();
          clearPattern(pad);
        }}
        className="flex w-[64px] shrink-0 items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px] text-zinc-300 hover:bg-white/[0.06]"
      >
        <span className="size-2 shrink-0 rounded-full" style={{ background: empty ? "transparent" : color, border: empty ? "1px dashed #52525b" : undefined }} />
        <span className="truncate">{empty ? `Pad ${pad + 1}` : p.name}</span>
      </button>
      <div className="flex min-w-0 flex-1 gap-[2px]">
        {Array.from({ length: count }, (_, i) => {
          const s = from + i;
          return <Cell key={s} pad={pad} step={s} on={!!row[s]} now={s === playing} color={color} beatStart={perBeat > 0 && i % perBeat === 0} />;
        })}
      </div>
      <div className="hidden w-[22px] shrink-0 flex-col group-hover:flex">
        <button type="button" title="Move this row one step earlier" onClick={() => shiftRow(pad, -1)} className="h-[9px] text-[8px] leading-none text-zinc-500 hover:text-zinc-200">
          ◀
        </button>
        <button type="button" title="Move this row one step later" onClick={() => shiftRow(pad, 1)} className="h-[9px] text-[8px] leading-none text-zinc-500 hover:text-zinc-200">
          ▶
        </button>
      </div>
      <span className="w-[22px] shrink-0 group-hover:hidden" />
    </div>
  );
}

export function Sequencer() {
  const on = useSequencer((s) => s.on);
  const steps = useSequencer((s) => s.steps);
  const stepBeats = useSequencer((s) => s.stepBeats);
  const swing = useSequencer((s) => s.swing);
  const page = useSequencer((s) => s.page);
  const follow = useSequencer((s) => s.follow);
  const padCount = useApp((s) => s.pads.length);
  const playing = useTelemetry((s) => (on ? (s.t.sequencerStep ?? -1) : -1));
  const pages = Math.ceil(steps / PAGE);
  const perBeat = Math.round(1 / stepBeats);

  // Follow the playhead across pages.
  const lastPage = useRef(page);
  useEffect(() => {
    if (!follow || playing < 0) return;
    const p = Math.floor(playing / PAGE);
    if (p !== lastPage.current && p < pages) {
      lastPage.current = p;
      useSequencer.setState({ page: p });
    }
  }, [playing, follow, pages]);
  useEffect(() => {
    lastPage.current = page;
  }, [page]);

  useEffect(() => {
    const up = () => (paint.active = false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" data-testid="sequencer">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={on ? "Stop the sequencer" : "Play the sequencer"}
          title={on ? "Stop the pattern" : "Play the pattern in time with the music (or on its own at the current tempo)"}
          onClick={() => setSequencerOn(!on)}
          className={clsx("flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold transition-colors", on ? "bg-[var(--accent)] text-black" : "bg-white/10 text-zinc-100 hover:bg-white/15")}
        >
          {on ? <Square size={11} /> : <Play size={11} />}
          {on ? "Stop" : "Play"}
        </button>
        <Segmented value={stepBeats} onChange={setStepBeats} options={RATE_OPTIONS} />
        <div className="ml-auto flex items-center gap-1" title="Swing pushes every second square a little later, for a looser, bouncier groove">
          <Knob value={swing} min={0} max={0.5} def={0} size={22} onChange={setSwing} />
          <span className="w-[30px] text-[10px] tabular-nums text-zinc-400">{Math.round(swing * 200)}%</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Number of steps"
          value={steps}
          onChange={(e) => setSteps(Number(e.target.value))}
          className="h-6 shrink-0 rounded-md border border-white/10 bg-black/30 px-1 text-[11px] text-zinc-200"
          title={`How many squares the pattern has before it repeats (now ${lengthText(steps * stepBeats)})`}
        >
          {STEP_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} steps
            </option>
          ))}
        </select>
        {pages > 1 && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Pattern page">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPage(i)}
                title={`Show steps ${i * PAGE + 1} to ${Math.min(steps, (i + 1) * PAGE)}`}
                className={clsx("relative h-6 w-5 rounded-md text-[10px] tabular-nums", i === page ? "bg-white/15 text-zinc-50" : "text-zinc-400 hover:text-zinc-200")}
              >
                {i + 1}
                {playing >= 0 && Math.floor(playing / PAGE) === i && <span className="absolute bottom-0.5 left-1/2 size-1 -translate-x-1/2 rounded-full bg-[var(--accent)]" />}
              </button>
            ))}
            <label className="ml-0.5 flex items-center gap-1 text-[10px] text-zinc-400" title="Turn the page with the playhead">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--accent)]" />
              Follow
            </label>
          </div>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="ml-auto flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-white/10 px-1.5 text-[11px] text-zinc-300 hover:bg-white/[0.06]">
              Patterns <ChevronDown size={11} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu max-w-[260px]">
              <DropdownMenu.Label className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">Start from a pattern</DropdownMenu.Label>
              {PRESETS.map((p) => (
                <DropdownMenu.Item key={p.id} className="menu-item flex-col items-start" onSelect={() => startPreset(p)}>
                  <span>{p.name}</span>
                  <span className="text-[10px] leading-snug text-zinc-500">{p.help}</span>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-white/10" />
              <DropdownMenu.Item className="menu-item" disabled={steps * 2 > 64} onSelect={doublePattern}>
                Double the pattern (copy it after itself)
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => clearPattern()}>
                Clear all squares
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => void loadDrumKit()}>
                Load a drum kit onto the pads
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className="flex flex-col gap-[3px] select-none" onPointerLeave={() => (paint.active = false)}>
        {Array.from({ length: padCount }, (_, i) => (
          <Row key={i} pad={i} page={page} steps={steps} perBeat={perBeat} playing={playing} />
        ))}
        <div className="flex gap-1 pl-[68px] pr-[26px]">
          <div className="flex flex-1 gap-[2px]">
            {Array.from({ length: Math.min(PAGE, steps - page * PAGE) }, (_, i) => {
              const s = page * PAGE + i;
              const beatStart = perBeat > 0 && i % perBeat === 0;
              return (
                <span key={s} className={clsx("min-w-0 flex-1 text-center text-[8px] tabular-nums", beatStart && i > 0 && "ml-[3px]", s === playing ? "text-[var(--accent)]" : "text-zinc-600")}>
                  {beatStart ? Math.floor((s * stepBeats) % 4) + 1 : ""}
                </span>
              );
            })}
          </div>
        </div>
      </div>
      <p className="text-[11px] leading-snug text-zinc-400">
        Tap squares to place a pad's sound on that step, or drag across a row. The pattern loops in time with the playing track, so it always lands on the beat. Click a pad name to hear it; right-click it to clear its row.
      </p>
    </div>
  );
}
