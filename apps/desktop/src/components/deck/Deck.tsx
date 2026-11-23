// One deck: what is loaded, where it is, and the transport, tempo and key controls.
// Easy view keeps the essentials (play, cue, sync, tempo, hot cues, loop); Pro adds
// master, key shift, nudge, tempo range, slip, reverse and the grid tools.
import clsx from "clsx";
import { ChevronDown, ChevronUp, Disc3, KeyRound, LifeBuoy, Lock, Minus, Music2, Pause, PencilLine, Play, Plus, RotateCcw, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { act, choose, press, release, setOn, setValue, tap } from "../../lib/actions";
import { bpm as fmtBpm, clock, signedPct } from "../../lib/format";
import { keyColor, keyLabel, shiftedKey } from "../../lib/keys";
import { deckCount, useApp, useNotation, usePro } from "../../store/app";
import { useDeckTele, useTelemetry } from "../../store/telemetry";
import { useLibrary } from "../../store/library";
import { ActionBtn, Btn } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Fader } from "../ui/Fader";
import { Overview } from "./Overview";
import { BeatCounter } from "./BeatCounter";
import { EjectButton, Pads } from "./Pads";
import { useDropTarget } from "../../lib/dnd";
import { DECK_COLORS } from "./useWaveform";
import { openEditor } from "../editor/TrackEditor";
import { Cover } from "../ui/Cover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { instantDouble } from "../../lib/performance";

export const TEMPO_RANGES = [0.06, 0.08, 0.1, 0.16, 0.5, 1];
export const TEMPO_RANGE_LABELS = ["±6%", "±8%", "±10%", "±16%", "±50%", "±100%"];

export async function loadOnDeck(deck: number, trackId: number) {
  const tele = useTelemetry.getState().t.decks[deck];
  if (tele?.playing) {
    toast.warning(`Deck ${String.fromCharCode(65 + deck)} is playing. Pause it first, or load onto another deck.`);
    return;
  }
  try {
    const info = await backend().loadTrack(deck, trackId);
    useApp.getState().setDeck(info);
    useApp.getState().set({ targetDeck: deck });
    useLibrary.getState().set({ suggestFor: info.detail.track.id });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

export function Deck({ deck, compact = false }: { deck: number; compact?: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const info = useApp((s) => s.decks[deck]);
  const pro = usePro();
  const target = useApp((s) => s.targetDeck === deck);
  const drop = useDropTarget(`deck-${deck}`, { label: `Load on deck ${L}`, tracks: (ids) => loadOnDeck(deck, ids[0]) });
  const over = drop.over;
  const color = DECK_COLORS[deck];

  return (
    <section
      style={{ ["--accent" as string]: color }}
      className={clsx(
        // Fills its column so both decks line up with the mixer between them.
        "relative flex min-w-0 flex-1 flex-col gap-2 rounded-2xl border bg-zinc-900/60 p-3 transition-colors",
        over ? "border-[var(--accent)] bg-[var(--accent)]/5" : target ? "border-white/[0.12]" : "border-white/[0.06]",
      )}
      onPointerDown={() => useApp.getState().set({ targetDeck: deck })}
      {...drop.props}
      data-deck={L}
    >
      <Header deck={deck} />
      {info ? <Overview deck={deck} height={compact ? 32 : 46} /> : <EmptyDeck letter={L} compact={compact} />}
      <SafetyNote deck={deck} />
      <div className={clsx("flex min-w-0", compact ? "items-center gap-2" : "gap-3")}>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Transport deck={deck} pro={pro} compact={compact} />
          {!compact && <Pads deck={deck} />}
        </div>
        <Tempo deck={deck} pro={pro} compact={compact} />
      </div>
      {compact && <Pads deck={deck} compact />}
    </section>
  );
}

/** Shown while the safety loop holds the end of the track so the music does not stop. */
function SafetyNote({ deck }: { deck: number }) {
  const on = useDeckTele(deck, (d) => !!d.safetyLoop);
  if (!on) return null;
  const L = String.fromCharCode(65 + deck);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-100" role="status" data-testid={`safety-note-${L}`}>
      <LifeBuoy size={13} className="shrink-0 text-amber-300" />
      <span className="min-w-0 flex-1">Looping the last bars so the music doesn't stop. Mix in the next track, or let it end.</span>
      <button type="button" onClick={() => void tap(`deck.${L}.let_end`)} className="shrink-0 rounded bg-amber-300/20 px-1.5 py-0.5 font-medium text-amber-100 hover:bg-amber-300/30" data-testid={`let-end-${L}`}>
        Let it end
      </button>
    </div>
  );
}

function EmptyDeck({ letter, compact }: { letter: string; compact: boolean }) {
  return (
    <div className={clsx("flex items-center justify-center gap-2 rounded-lg border border-dashed border-white/10 text-xs text-zinc-500", compact ? "h-8" : "h-[46px]")}>
      <Music2 size={14} />
      Drag a track here, or select one and press <kbd className="rounded border border-white/10 px-1 font-mono text-[10px]">Enter</kbd> to load deck {letter}
    </div>
  );
}

/** The deck letter; click it to copy another deck's track here (an instant double). */
function DeckMenu({ deck }: { deck: number }) {
  const L = String.fromCharCode(65 + deck);
  const decks = useApp((s) => s.decks);
  const n = deckCount();
  const others = Array.from({ length: n }, (_, i) => i).filter((i) => i !== deck && decks[i]);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl text-base font-black text-zinc-950 outline-none ring-white/60 focus-visible:ring-2"
          style={{ background: DECK_COLORS[deck] }}
          title={`Deck ${L}: click to copy another deck's track here`}
          data-testid={`deck-menu-${L}`}
        >
          {L}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="menu">
          {others.length === 0 && <div className="px-2 py-1.5 text-xs text-zinc-500">Load a track on another deck to copy it here.</div>}
          {others.map((i) => (
            <DropdownMenu.Item key={i} className="menu-item" onSelect={() => void instantDouble(i, deck)} data-testid={`double-${String.fromCharCode(65 + i)}-${L}`}>
              Copy deck {String.fromCharCode(65 + i)} here, in time
              <span className="ml-3 max-w-40 truncate text-zinc-500">{decks[i]?.detail.track.title}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Header({ deck }: { deck: number }) {
  const info = useApp((s) => s.decks[deck]);
  const notation = useNotation();
  const pro = usePro();
  const bpm = useDeckTele(deck, (d) => Math.round(d.bpm * 10) / 10);
  const tempo = useDeckTele(deck, (d) => Math.round(d.tempo * d.tempoRange * 1000) / 1000);
  const keyShift = useDeckTele(deck, (d) => Math.round(d.keyShift));
  const master = useDeckTele(deck, (d) => d.master);
  const keylock = useDeckTele(deck, (d) => d.keylock);
  const t = info?.detail.track;
  const key = shiftedKey(info?.detail.key ?? t?.key, keyShift);

  return (
    // On a narrow deck (most laptop widths, the guide open, four decks) the readouts move to a
    // second row instead of squeezing the track name away. A container query rather than
    // natural wrapping, so every deck switches at the same width (deck A's Master badge would
    // otherwise make it wrap when deck B doesn't).
    <div className="@container min-w-0">
    <div className="flex min-w-0 items-center gap-x-2.5 gap-y-2 @max-2xl:flex-wrap">
      <DeckMenu deck={deck} />
      {t && <Cover trackId={t.id} has={t.hasArt} title={t.title} artist={t.artist} size={36} rounded="rounded-lg" />}
      <div className="min-w-0 flex-1 basis-0 @max-2xl:min-w-[7rem]">
        <div className="truncate text-sm font-semibold leading-tight text-zinc-50" title={t?.title}>
          {t ? t.title || "Untitled" : <span className="text-zinc-500">No track</span>}
        </div>
        <div className="truncate text-xs leading-tight text-zinc-400">{t ? t.artist || "Unknown artist" : " "}</div>
      </div>
      {t && (
        <div className="ml-auto flex shrink-0 items-center gap-2.5 @max-2xl:ml-0 @max-2xl:basis-full">
          <Ctl label="Key" explain={keyShift !== 0 ? `Shifted ${keyShift > 0 ? "+" : ""}${keyShift} semitones from ${keyLabel(info?.detail.key ?? t.key, notation)}.` : "The musical key. Keys next to each other on the Camelot wheel mix well."}>
            <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs font-bold text-zinc-950" style={{ background: keyColor(key) }}>
              {keylock && pro && <Lock size={10} />}
              {keyLabel(key, notation)}
              {keyShift !== 0 && <span className="text-[10px] font-semibold opacity-70">{keyShift > 0 ? `+${keyShift}` : keyShift}</span>}
            </span>
          </Ctl>
          <div className="text-right">
            <div className="font-mono text-base font-semibold leading-none tabular-nums text-zinc-50">{fmtBpm(bpm)}</div>
            <div className={clsx("font-mono text-[10px] leading-tight tabular-nums", tempo === 0 ? "text-zinc-500" : "text-[var(--accent-ink)]")}>{signedPct(tempo)}</div>
          </div>
          <BeatCounter deck={deck} />
          <TimeReadout deck={deck} />
          {master && <span className="rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--accent-ink)]">Master</span>}
          <Ctl label="Edit track" explain="Open the track editor: fix the beat grid, name and colour cues, choose where the track starts and turn a passage into a loop or a sampler pad.">
            <Btn size="sm" tone="ghost" onClick={() => openEditor(deck)} aria-label="Edit track">
              <PencilLine size={12} />
            </Btn>
          </Ctl>
          <EjectButton deck={deck} />
        </div>
      )}
    </div>
    </div>
  );
}

function TimeReadout({ deck }: { deck: number }) {
  const [remaining, setRemaining] = useState(true);
  const pos = useDeckTele(deck, (d) => Math.floor(d.position * 10) / 10);
  const dur = useDeckTele(deck, (d) => d.duration);
  const left = Math.max(0, dur - pos);
  const warn = left < 30 && dur > 0;
  return (
    <button type="button" onClick={() => setRemaining((r) => !r)} title="Elapsed or remaining" className={clsx("w-16 text-right font-mono text-sm tabular-nums", warn ? "animate-pulse text-red-400" : "text-zinc-200")}>
      {remaining ? `-${clock(left, true)}` : clock(pos, true)}
    </button>
  );
}

function Transport({ deck, pro, compact }: { deck: number; pro: boolean; compact: boolean }) {
  const big = compact ? "md" : "lg";
  const w = compact ? "w-12" : "w-16";
  const L = String.fromCharCode(65 + deck);
  const playing = useDeckTele(deck, (d) => d.playing);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  const sync = useDeckTele(deck, (d) => d.sync);
  const master = useDeckTele(deck, (d) => d.master);
  const keylock = useDeckTele(deck, (d) => d.keylock);
  const slip = useDeckTele(deck, (d) => d.slip);
  const reverse = useDeckTele(deck, (d) => d.reverse);
  const keyShift = useDeckTele(deck, (d) => Math.round(d.keyShift));
  const atCue = useDeckTele(deck, (d) => Math.abs(d.position - d.cue) < 0.02);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Ctl id={`deck.${L}.cue`}>
        <ActionBtn id={`deck.${L}.cue`} tone="cue" size={big} disabled={!loaded} className={clsx(w, atCue && !playing && "ring-1 ring-amber-400/60")}>
          CUE
        </ActionBtn>
      </Ctl>
      <Ctl id={`deck.${L}.play`}>
        <ActionBtn id={`deck.${L}.play`} tone="play" size={big} disabled={!loaded} className={clsx(w, playing && "!bg-emerald-500 !text-zinc-950 shadow-[0_0_18px_-3px_rgb(16,185,129)]")}>
          {playing ? <Pause size={compact ? 14 : 18} fill="currentColor" /> : <Play size={compact ? 14 : 18} fill="currentColor" />}
        </ActionBtn>
      </Ctl>
      <Ctl id={`deck.${L}.sync`}>
        <Btn size={big} active={sync} disabled={!loaded} onClick={() => setOn(`deck.${L}.sync`, !sync)} className={w}>
          SYNC
        </Btn>
      </Ctl>
      {pro && (
        <Ctl id={`deck.${L}.master`}>
          <Btn size="sm" tone={master ? "accent" : "default"} disabled={!loaded} onClick={() => tap(`deck.${L}.master`)}>
            <Disc3 size={12} /> Master
          </Btn>
        </Ctl>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Ctl id={`deck.${L}.keylock`} label="Key lock" explain="Keeps the pitch steady when you change the tempo.">
          <Btn size="sm" active={keylock} onClick={() => setOn(`deck.${L}.keylock`, !keylock)} aria-label="Key lock">
            <Lock size={12} />
          </Btn>
        </Ctl>
        <Ctl id={`deck.${L}.key_sync`} label="Match key" explain="Shifts this deck's key to fit the other deck, with key lock on.">
          <Btn size="sm" disabled={!loaded} onClick={() => tap(`deck.${L}.key_sync`)} aria-label="Match key">
            <KeyRound size={12} />
          </Btn>
        </Ctl>
        {pro && !compact && (
          <>
            <Ctl id={`deck.${L}.key_shift`} label="Key down" explain="Lowers the key by a semitone.">
              <Btn size="sm" onClick={() => setValue(`deck.${L}.key_shift`, Math.max(-12, keyShift - 1))} aria-label="Key down">
                <Minus size={12} />
              </Btn>
            </Ctl>
            <button type="button" className="w-6 text-center font-mono text-[11px] text-zinc-300 hover:text-white" title="Reset key" onClick={() => setValue(`deck.${L}.key_shift`, 0)}>
              {keyShift > 0 ? `+${keyShift}` : keyShift}
            </button>
            <Ctl id={`deck.${L}.key_shift`} label="Key up" explain="Raises the key by a semitone.">
              <Btn size="sm" onClick={() => setValue(`deck.${L}.key_shift`, Math.min(12, keyShift + 1))} aria-label="Key up">
                <Plus size={12} />
              </Btn>
            </Ctl>
            <Ctl id={`deck.${L}.slip`}>
              <Btn size="sm" active={slip} onClick={() => setOn(`deck.${L}.slip`, !slip)}>
                Slip
              </Btn>
            </Ctl>
            <Ctl id={`deck.${L}.reverse`}>
              <Btn size="sm" active={reverse} onClick={() => setOn(`deck.${L}.reverse`, !reverse)} aria-label="Reverse">
                <Undo2 size={12} />
              </Btn>
            </Ctl>
          </>
        )}
      </div>
    </div>
  );
}

function Tempo({ deck, pro, compact }: { deck: number; pro: boolean; compact: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const tempo = useDeckTele(deck, (d) => d.tempo);
  const range = useDeckTele(deck, (d) => d.tempoRange);
  const loaded = useDeckTele(deck, (d) => d.loaded);
  const rangeIndex = Math.max(0, TEMPO_RANGES.findIndex((r) => Math.abs(r - range) < 1e-3));
  if (compact) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Ctl id={`deck.${L}.tempo`}>
          <Fader value={tempo} min={-1} max={1} def={0} orientation="horizontal" length={96} onChange={(v) => setValue(`deck.${L}.tempo`, v)} label="Tempo" />
        </Ctl>
        <Btn size="sm" tone="ghost" className="!h-5 !px-1" disabled={!loaded || tempo === 0} onClick={() => setValue(`deck.${L}.tempo`, 0)} aria-label="Reset tempo">
          <RotateCcw size={11} />
        </Btn>
      </div>
    );
  }
  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-1">
      {pro && !compact && (
        <button
          type="button"
          className="flex items-center font-mono text-[10px] text-zinc-400 hover:text-zinc-100"
          title="Tempo range"
          onClick={() => choose(`deck.${L}.tempo_range`, (rangeIndex + 1) % TEMPO_RANGES.length)}
        >
          {TEMPO_RANGE_LABELS[rangeIndex]}
          <ChevronDown size={10} />
        </button>
      )}
      {pro && !compact && (
        <Ctl id={`deck.${L}.nudge_up`} label="Nudge faster" explain="Hold to speed up a little, to pull the beats back in line.">
          <Btn size="sm" className="!h-5 !px-1" onPointerDown={() => press(`deck.${L}.nudge_up`)} onPointerUp={() => release(`deck.${L}.nudge_up`)} onPointerLeave={() => release(`deck.${L}.nudge_up`)}>
            <ChevronUp size={12} />
          </Btn>
        </Ctl>
      )}
      <Ctl id={`deck.${L}.tempo`} side="left">
        <Fader value={tempo} min={-1} max={1} def={0} length={compact ? 64 : pro ? 120 : 150} onChange={(v) => setValue(`deck.${L}.tempo`, v)} label="Tempo" />
      </Ctl>
      {pro && !compact && (
        <Ctl id={`deck.${L}.nudge_down`} label="Nudge slower" explain="Hold to slow down a little, to pull the beats back in line.">
          <Btn size="sm" className="!h-5 !px-1" onPointerDown={() => press(`deck.${L}.nudge_down`)} onPointerUp={() => release(`deck.${L}.nudge_down`)} onPointerLeave={() => release(`deck.${L}.nudge_down`)}>
            <ChevronDown size={12} />
          </Btn>
        </Ctl>
      )}
      <Ctl id={`deck.${L}.tempo_reset`} label="Reset tempo" explain="Back to the track's original tempo.">
        <Btn size="sm" tone="ghost" className="!h-5 !px-1" disabled={!loaded || tempo === 0} onClick={() => (pro ? tap(`deck.${L}.tempo_reset`) : act(`deck.${L}.tempo`, { type: "value", value: 0 }))} aria-label="Reset tempo">
          <RotateCcw size={11} />
        </Btn>
      </Ctl>
    </div>
  );
}
