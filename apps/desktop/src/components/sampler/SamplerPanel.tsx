// The sampler pads and the master effects, in a panel beside the library. Pads play
// sounds on top of the mix: the built-in kit (air horn, riser, drum loop...), any audio
// file, a whole library track, or a loop captured from a deck.
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import clsx from "clsx";
import { Check, ChevronDown, Hand, Loader2, MoreHorizontal, Play, Repeat, Square, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../../backend";
import type { PadInfo, PadPatch, PadSource } from "../../backend/types";
import { press, release, setValue, shortcutLabel, tap } from "../../lib/actions";
import { hex } from "../../lib/format";
import { beatsIn } from "../../lib/waveform";
import { DECK_LETTERS, MASTER_FX, useApp, usePro } from "../../store/app";
import { livePosition, useTelemetry } from "../../store/telemetry";
import { useDropTarget } from "../../lib/dnd";
import { FxUnit } from "../deck/FxUnit";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Knob } from "../ui/Knob";

export const PAD_MODES = ["Once", "Hold", "Loop"] as const;
const PAD_MODE_HELP = ["Plays to the end once per press.", "Plays only while you hold the pad.", "Repeats in time until you press the pad again."];
const MODE_ICON = [Play, Hand, Repeat];
export const AUDIO_EXTENSIONS = ["wav", "mp3", "flac", "aiff", "aif", "ogg", "m4a", "aac", "opus"];
const PAD_COLORS = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0xa855f7, 0xec4899, 0x64748b];

const useBusy = create<{ busy: Record<number, boolean>; selected: number }>(() => ({ busy: {}, selected: 0 }));

function report(e: unknown) {
  toast.error(e instanceof Error ? e.message : String(e));
}

/** Puts a new sound on a pad, with a spinner while it decodes. */
export async function loadPad(pad: number, source: PadSource) {
  useBusy.setState((s) => ({ busy: { ...s.busy, [pad]: true } }));
  try {
    const info = await backend().samplerLoad(pad, source);
    useApp.getState().setPad(info);
    return info;
  } catch (e) {
    report(e);
  } finally {
    useBusy.setState((s) => ({ busy: { ...s.busy, [pad]: false } }));
  }
}

const timers = new Map<number, number>();
let pending: Record<number, PadPatch> = {};

/** Changes a pad's settings now in the UI and, a moment later, in the engine. */
export function patchPad(pad: number, patch: PadPatch) {
  const cur = useApp.getState().pads[pad];
  if (!cur) return;
  useApp.getState().setPad({ ...cur, ...patch, bpm: patch.bpm === undefined ? cur.bpm : patch.bpm || null });
  pending = { ...pending, [pad]: { ...pending[pad], ...patch } };
  window.clearTimeout(timers.get(pad));
  timers.set(
    pad,
    window.setTimeout(async () => {
      const p = pending[pad];
      delete pending[pad];
      try {
        useApp.getState().setPad(await backend().samplerSet(pad, p));
      } catch (e) {
        report(e);
      }
    }, 120),
  );
}

async function clearPad(pad: number) {
  try {
    useApp.getState().setPad(await backend().samplerClear(pad));
  } catch (e) {
    report(e);
  }
}

async function pickFile(pad: number) {
  const f = await backend().pickFiles(AUDIO_EXTENSIONS, `Sound for pad ${pad + 1}`);
  if (f?.[0]) loadPad(pad, { type: "file", path: f[0] });
}

/** The beat nearest `t` on a deck's grid (or `t` when the track has no grid). */
function nearestBeat(deck: number, t: number): number {
  const d = useApp.getState().decks[deck]?.detail;
  if (!d?.analysed || !d.beatPeriod) return t;
  let best = t;
  let dist = Infinity;
  for (const [b] of beatsIn(d, t - d.beatPeriod, t + d.beatPeriod)) {
    if (Math.abs(b - t) < dist) {
      dist = Math.abs(b - t);
      best = b;
    }
  }
  return best;
}

/**
 * Copies part of the track on `deck` onto a pad: the active loop when `beats` is null,
 * otherwise `beats` beats from the nearest beat. Captured loops loop and follow the tempo.
 */
export async function captureFromDeck(pad: number, deck: number, beats: number | null) {
  const info = useApp.getState().decks[deck];
  if (!info) return;
  const d = info.detail;
  const lp = useTelemetry.getState().t.decks[deck]?.looping;
  let start: number;
  let seconds: number;
  if (beats === null && lp?.active && lp.end > lp.start) {
    start = lp.start;
    seconds = lp.end - lp.start;
  } else {
    const period = d.beatPeriod || 60 / (d.bpm || 120);
    start = nearestBeat(deck, livePosition(deck));
    seconds = (beats ?? 4) * period;
  }
  const res = await loadPad(pad, { type: "track", trackId: d.track.id, start, seconds });
  if (res) toast.success(`Pad ${pad + 1}: ${res.name}`, { description: "Captured from deck " + DECK_LETTERS[deck] });
}

// ------------------------------------------------------------------ menus

type Entry =
  | { kind: "item"; label: string; run: () => void; disabled?: boolean; checked?: boolean }
  | { kind: "sep" }
  | { kind: "sub"; label: string; items: Entry[] }
  | { kind: "colors"; pad: number };

function padEntries(p: PadInfo, opts: { kit: { id: string; name: string }[]; decks: number[]; loops: boolean[] }): Entry[] {
  const pad = p.pad;
  const empty = p.source.type === "empty";
  const capture: Entry[] = opts.decks.flatMap((d) => {
    const L = DECK_LETTERS[d];
    const items: Entry[] = [];
    if (opts.loops[d]) items.push({ kind: "item", label: `Deck ${L}: the loop that is playing`, run: () => captureFromDeck(pad, d, null) });
    items.push({ kind: "item", label: `Deck ${L}: 1 bar from here`, run: () => captureFromDeck(pad, d, 4) });
    items.push({ kind: "item", label: `Deck ${L}: 4 bars from here`, run: () => captureFromDeck(pad, d, 16) });
    return items;
  });
  const out: Entry[] = [
    { kind: "sub", label: "Built-in sounds", items: opts.kit.map((k) => ({ kind: "item", label: k.name, run: () => loadPad(pad, { type: "kit", id: k.id }), checked: p.source.type === "kit" && p.source.id === k.id })) },
    { kind: "item", label: "Audio file…", run: () => pickFile(pad) },
  ];
  if (capture.length) out.push({ kind: "sub", label: "Capture from a deck", items: capture });
  if (!empty) {
    out.push({ kind: "sep" });
    PAD_MODES.forEach((m, i) => out.push({ kind: "item", label: `${m}: ${PAD_MODE_HELP[i].toLowerCase()}`, checked: p.mode === i, run: () => patchPad(pad, { mode: i }) }));
    out.push({ kind: "sep" });
    out.push({ kind: "item", label: "Start on the beat", checked: p.quantized, run: () => patchPad(pad, { quantized: !p.quantized }) });
    out.push({ kind: "item", label: p.bpm ? `Follow the tempo (made at ${p.bpm.toFixed(1)} BPM)` : "Follow the tempo (no tempo known)", checked: p.sync && !!p.bpm, disabled: !p.bpm, run: () => patchPad(pad, { sync: !p.sync }) });
    out.push({ kind: "colors", pad });
    out.push({ kind: "sep" });
    out.push({ kind: "item", label: "Clear pad", run: () => clearPad(pad) });
  }
  return out;
}

type MenuNs = typeof ContextMenu;

function renderEntries(M: MenuNs, entries: Entry[]): ReactNode {
  return entries.map((e, i) => {
    if (e.kind === "sep") return <M.Separator key={i} className="menu-sep" />;
    if (e.kind === "colors")
      return (
        <div key={i} className="flex gap-1 px-2 py-1.5">
          {PAD_COLORS.map((c) => (
            <M.Item key={c} aria-label="Pad colour" className="size-4 cursor-pointer rounded-full border border-white/20 outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-white" style={{ background: hex(c) }} onSelect={() => patchPad(e.pad, { color: c })} />
          ))}
        </div>
      );
    if (e.kind === "sub")
      return (
        <M.Sub key={i}>
          <M.SubTrigger className="menu-item">{e.label}</M.SubTrigger>
          <M.Portal>
            <M.SubContent className="menu max-h-80 overflow-y-auto">{renderEntries(M, e.items)}</M.SubContent>
          </M.Portal>
        </M.Sub>
      );
    return (
      <M.Item key={i} className="menu-item" disabled={e.disabled} onSelect={e.run}>
        <span className="inline-flex w-4 shrink-0 justify-center">{e.checked && <Check size={12} />}</span>
        {e.label}
      </M.Item>
    );
  });
}

function useMenuOptions() {
  const kit = useApp((s) => s.kit);
  const loadedKey = useApp((s) => s.decks.map((d) => (d ? 1 : 0)).join(""));
  const count = useApp((s) => s.settings?.decks ?? 2);
  const loopsKey = useTelemetry((s) => s.t.decks.map((d) => (d.looping.active ? 1 : 0)).join(""));
  const decks = [0, 1, 2, 3].filter((d) => d < Math.max(2, count) && loadedKey[d] === "1");
  return { kit, decks, loops: [0, 1, 2, 3].map((d) => loopsKey[d] === "1") };
}

// ------------------------------------------------------------------ pads

function PadButton({ pad }: { pad: number }) {
  const p = useApp((s) => s.pads[pad]);
  const playing = useTelemetry((s) => ((s.t.samplerPlaying ?? 0) >> pad) & 1) === 1;
  const busy = useBusy((s) => !!s.busy[pad]);
  const selected = useBusy((s) => s.selected === pad);
  const drop = useDropTarget(`pad-${pad}`, {
    label: `Put on pad ${pad + 1}`,
    files: (paths) => void loadPad(pad, { type: "file", path: paths[0] }),
    tracks: (ids) => void loadPad(pad, { type: "track", trackId: ids[0], start: null, seconds: null }),
  });
  const over = drop.over;
  const opts = useMenuOptions();
  if (!p) return null;
  const id = `sampler.pad.${pad + 1}`;
  const empty = p.source.type === "empty";
  const color = hex(p.color);
  const Icon = MODE_ICON[p.mode] ?? Play;
  const key = pad < 8 ? shortcutLabel(`Shift+${pad + 1}`) : "";
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="min-w-0">
          <Ctl id={id} className="block w-full">
            <button
              type="button"
              aria-label={empty ? `Pad ${pad + 1}, empty` : `Pad ${pad + 1}: ${p.name}`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                useBusy.setState({ selected: pad });
                if (empty || busy) return;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                press(id);
              }}
              onPointerUp={() => !empty && release(id)}
              onPointerCancel={() => !empty && release(id)}
              {...drop.props}
              className={clsx(
                "relative flex h-[54px] w-full select-none flex-col justify-between overflow-hidden rounded-xl border p-1.5 text-left transition-[box-shadow,background-color] duration-75",
                empty ? "border-dashed border-white/10 bg-white/[0.02] text-zinc-500 hover:bg-white/[0.05]" : "text-zinc-100",
                selected && "ring-1 ring-white/40",
                over && "ring-2 ring-[var(--accent)]",
              )}
              style={
                empty
                  ? undefined
                  : {
                      borderColor: `${color}${playing ? "" : "66"}`,
                      background: playing ? `${color}66` : `${color}1f`,
                      boxShadow: playing ? `0 0 18px -2px ${color}` : undefined,
                    }
              }
            >
              <div className="flex items-center justify-between gap-1 text-[9px] leading-none">
                <span className="font-mono text-zinc-400">{key}</span>
                {!empty && <Icon size={10} className="text-zinc-300" />}
              </div>
              {busy ? (
                <Loader2 size={14} className="animate-spin self-center text-zinc-300" />
              ) : (
                <div className={clsx("line-clamp-2 text-[11px] font-medium leading-[1.15]", p.error && "text-red-300")}>{empty ? "Empty" : p.name}</div>
              )}
            </button>
          </Ctl>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu">{renderEntries(ContextMenu, padEntries(p, opts))}</ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function PadEditor() {
  const pro = usePro();
  const pad = useBusy((s) => s.selected);
  const p = useApp((s) => s.pads[pad]);
  const opts = useMenuOptions();
  if (!p) return null;
  const empty = p.source.type === "empty";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: empty ? "transparent" : hex(p.color) }} />
        {empty ? (
          <span className="flex-1 text-xs text-zinc-400">Pad {pad + 1} is empty</span>
        ) : (
          <input
            key={`${pad}:${p.name}`}
            defaultValue={p.name}
            aria-label="Pad name"
            onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && patchPad(pad, { name: e.target.value.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-xs font-medium text-zinc-100 outline-none hover:border-white/10 focus:border-[var(--accent)]"
          />
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Btn size="sm" tone={empty ? "accent" : "default"} className="!h-6 !px-2">
              {empty ? "Pick a sound" : "Change"} <ChevronDown size={11} />
            </Btn>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu">
              {renderEntries(DropdownMenu as unknown as MenuNs, padEntries(p, opts))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {p.error && <div className="text-[11px] text-red-300">Could not load: {p.error}</div>}
      {!empty && (
        <div className="flex items-center gap-2">
          <Ctl id={`sampler.pad.${pad + 1}.mode`} explain={PAD_MODE_HELP[p.mode]}>
            <Segmented value={p.mode} onChange={(v) => patchPad(pad, { mode: v })} options={PAD_MODES.map((m, i) => ({ value: i, label: m, title: PAD_MODE_HELP[i] }))} />
          </Ctl>
          <div className="ml-auto flex items-center gap-1.5">
            <Ctl label="Pad level" explain="How loud this pad plays. Double-click to reset.">
              <Knob value={p.gainDb} min={-24} max={12} def={0} size={24} bipolar onChange={(v) => patchPad(pad, { gainDb: Math.round(v * 2) / 2 })} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`} />
            </Ctl>
            {pro && (
              <Ctl label="Pan" explain="Moves the pad's sound towards the left or right speaker.">
                <Knob value={p.pan} min={-1} max={1} def={0} size={24} bipolar onChange={(v) => patchPad(pad, { pan: v })} />
              </Ctl>
            )}
          </div>
        </div>
      )}
      {!empty && (
        <div className="flex items-center gap-2 text-[10px] text-zinc-500">
          <span>{p.seconds ? `${p.seconds.toFixed(p.seconds < 10 ? 2 : 1)} s` : "loading…"}</span>
          {p.bpm != null && <span>{p.bpm.toFixed(1)} BPM</span>}
          {pro && (
            <>
              <label className="ml-auto flex items-center gap-1">
                <input type="checkbox" checked={p.quantized} onChange={(e) => patchPad(pad, { quantized: e.target.checked })} className="accent-[var(--accent)]" />
                On the beat
              </label>
              <label className={clsx("flex items-center gap-1", !p.bpm && "opacity-40")}>
                <input type="checkbox" disabled={!p.bpm} checked={p.sync && !!p.bpm} onChange={(e) => patchPad(pad, { sync: e.target.checked })} className="accent-[var(--accent)]" />
                Follow tempo
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Pads() {
  const count = useApp((s) => s.pads.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      <div className="grid grid-cols-4 gap-1.5">
        {Array.from({ length: count }, (_, i) => (
          <PadButton key={i} pad={i} />
        ))}
      </div>
      <PadEditor />
    </div>
  );
}

async function resetKit() {
  try {
    useApp.getState().set({ pads: await backend().samplerReset() });
    toast.success("The built-in kit is back on the pads");
  } catch (e) {
    report(e);
  }
}

/** Volume of all pads and a stop button, in the panel header. */
function PadsMaster() {
  const volume = useApp((s) => s.mixer.samplerVolume);
  const anyPlaying = useTelemetry((s) => (s.t.samplerPlaying ?? 0) !== 0);
  return (
    <>
      <Ctl id="sampler.volume" className="ml-auto">
        <Knob value={volume} min={0} max={1} def={0.8} size={22} onChange={(v) => setValue("sampler.volume", v)} />
      </Ctl>
      <Ctl id="sampler.stop_all">
        <button
          type="button"
          aria-label="Stop all pads"
          disabled={!anyPlaying}
          onClick={() => tap("sampler.stop_all")}
          className={clsx("flex size-6 items-center justify-center rounded-md transition-colors", anyPlaying ? "bg-red-500/15 text-red-300 hover:bg-red-500/25" : "text-zinc-600")}
        >
          <Square size={11} />
        </button>
      </Ctl>
    </>
  );
}

export function SamplerPanel() {
  const [tab, setTab] = useState<"pads" | "fx">("pads");
  const masterFxOn = useApp((s) => s.mixer.fx[MASTER_FX].some((f) => f.on && f.type !== 0));
  return (
    <section className="flex w-[300px] shrink-0 flex-col gap-2 rounded-xl border border-white/[0.06] bg-zinc-900/60 p-2" aria-label="Sampler and master effects">
      <div className="flex items-center gap-1.5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "pads", label: "Sampler", title: "Pads that play sounds on top of your mix" },
            { value: "fx", label: <span className="inline-flex items-center gap-1">Master FX{masterFxOn && <span className="size-1.5 rounded-full bg-[var(--accent)]" />}</span>, title: "Effects on the whole mix" },
          ]}
        />
        {tab === "pads" ? <PadsMaster /> : <span className="ml-auto" />}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="Sampler options" className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu">
              <DropdownMenu.Item className="menu-item" onSelect={resetKit}>
                Put the built-in kit back on all pads
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" onSelect={() => tap("sampler.stop_all")}>
                Stop all pads
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button type="button" aria-label="Hide the sampler" onClick={() => useApp.getState().set({ samplerOpen: false })} className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
          <X size={14} />
        </button>
      </div>
      {tab === "pads" ? (
        <Pads />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          <p className="text-[11px] leading-snug text-zinc-400">Effects on everything the audience hears, after the mixer. Try a reverb wash or an echo at the end of a set.</p>
          <FxUnit unit={MASTER_FX} stacked />
        </div>
      )}
    </section>
  );
}
