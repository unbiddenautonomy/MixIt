// The mixer between the decks: per-channel gain, three-band EQ with kills, filter,
// headphone cue, meter and fader; the crossfader; master and headphone levels; and the
// "Mix it" button that runs a whole transition in time with the music.
import clsx from "clsx";
import * as Popover from "@radix-ui/react-popover";
import { Headphones, SlidersHorizontal, SlidersVertical, Sparkles, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { choose, setOn, setValue } from "../../lib/actions";
import { startTransition, cancelTransition, transitionPair, useTransition, type TransitionId } from "../../lib/transition";
import { mixItPlan, smartMix } from "../../lib/smartMix";
import { hearMix } from "../../store/rehearse";
import { toast } from "sonner";
import { useApp, usePro } from "../../store/app";
import { useDeckTele, useTelemetry } from "../../store/telemetry";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Fader } from "../ui/Fader";
import { Knob } from "../ui/Knob";
import { Meter } from "../ui/Meter";
import { DECK_COLORS } from "../deck/useWaveform";
import { MicStrip } from "../mic/MicPanel";
import { AutoDjStrip } from "../autodj/AutoDj";
import { useAutoDj } from "../../store/autodj";
import { MASTER_STRIP, openStudio, useStudio } from "../../store/studio";

/** Channel order on the mixer: 2 decks A B; 4 decks C A B D, like a club mixer. */
export function channelOrder(count: number): number[] {
  return count > 2 ? [2, 0, 1, 3] : [0, 1];
}

export function Mixer({ count }: { count: number }) {
  const pro = usePro();
  const order = channelOrder(count);
  const autodj = useAutoDj((s) => s.phase !== "off");
  return (
    <section className="flex shrink-0 flex-col gap-2 rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-3">
      <div className="flex items-stretch gap-1">
        <MicStrip compact={count > 2} />
        {order.map((d) => (
          <Channel key={d} deck={d} pro={pro} compact={count > 2} />
        ))}
        <MasterSection pro={pro} />
      </div>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <Crossfader />
        </div>
        {pro && <MixerOptions count={count} />}
      </div>
      {autodj ? <AutoDjStrip /> : <MixIt count={count} />}
    </section>
  );
}

/** What the knob bubbles say. */
const db = (v: number) => (Math.abs(v) < 0.05 ? "0 dB" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} dB`);
const eqReadout = (v: number) => (v <= -25.9 ? "Off" : db(v));
const filterReadout = (v: number) => (Math.abs(v) < 0.005 ? "Off" : `${v < 0 ? "Cut highs" : "Cut lows"} ${Math.round(Math.abs(v) * 100)}%`);

function Channel({ deck, pro, compact }: { deck: number; pro: boolean; compact: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const ch = useApp((s) => s.mixer.channels[deck]);
  const color = DECK_COLORS[deck];
  const size = compact ? 26 : 30;
  const band = (key: "high" | "mid" | "low", label: string, kill: 0 | 1 | 2) => (
    <div className="relative">
      <Ctl id={`mixer.${L}.eq.${key}`} side="left">
        <Knob value={ch[key]} min={-26} max={6} def={0} bipolar size={size} color={color} killed={ch.kills[kill]} onChange={(v) => setValue(`mixer.${L}.eq.${key}`, v)} label={label} readout={eqReadout} />
      </Ctl>
      {pro && (
        <Ctl id={`mixer.${L}.eq.kill.${key}`} label={`Kill ${label.toLowerCase()}`} explain={`Removes the ${label.toLowerCase()} completely while on.`} className="absolute -left-1 top-0">
          <button
            type="button"
            onClick={() => setOn(`mixer.${L}.eq.kill.${key}`, !ch.kills[kill])}
            className={clsx("size-2.5 rounded-full border", ch.kills[kill] ? "border-red-300 bg-red-500" : "border-white/20 bg-black/40 hover:border-white/50")}
            aria-label={`Kill ${label}`}
          />
        </Ctl>
      )}
    </div>
  );
  return (
    <div style={{ ["--accent" as string]: color }} className="flex w-[86px] flex-col items-center gap-1.5 rounded-xl bg-black/20 px-1 py-1.5">
      <div className="flex w-full items-center justify-between px-1">
        <span className="text-[11px] font-black" style={{ color }}>
          {L}
        </span>
        <StudioButton strip={deck} />
        <Ctl id={`mixer.${L}.cue`} side="top">
          <button
            type="button"
            onClick={() => setOn(`mixer.${L}.cue`, !ch.cue)}
            className={clsx("flex h-5 w-7 items-center justify-center rounded-md border transition-colors", ch.cue ? "border-transparent bg-amber-400 text-zinc-950" : "border-white/10 text-zinc-400 hover:text-zinc-100")}
            aria-label="Headphone cue"
          >
            <Headphones size={11} />
          </button>
        </Ctl>
      </div>
      <div className="grid grid-cols-2 gap-x-1 gap-y-1">
        {band("high", "High", 2)}
        {pro ? (
          <Ctl id={`mixer.${L}.trim`} side="right">
            <Knob value={ch.trim} min={-12} max={12} def={0} bipolar size={size} color="var(--color-zinc-400)" onChange={(v) => setValue(`mixer.${L}.trim`, v)} label="Gain" readout={db} />
          </Ctl>
        ) : (
          <div />
        )}
        {band("mid", "Mid", 1)}
        <Ctl id={`mixer.${L}.filter`} side="right">
          <Knob value={ch.filter} min={-1} max={1} def={0} bipolar size={size} color="#e879f9" onChange={(v) => setValue(`mixer.${L}.filter`, v)} label="Filter" readout={filterReadout} />
        </Ctl>
        {band("low", "Low", 0)}
      </div>
      <div className="flex items-end gap-1.5">
        <Meter read={(t) => t.decks[deck]?.peak ?? [0, 0]} height={compact ? 84 : 104} width={4} />
        <Ctl id={`mixer.${L}.fader`} side="left">
          <Fader value={ch.fader} min={0} max={1} def={1} length={compact ? 84 : 104} color={color} onChange={(v) => setValue(`mixer.${L}.fader`, v)} label="Volume" />
        </Ctl>
      </div>
    </div>
  );
}

function MasterSection({ pro }: { pro: boolean }) {
  const master = useApp((s) => s.mixer.master);
  const phones = useApp((s) => s.mixer.headphones);
  const cueMix = useApp((s) => s.mixer.cueMix);
  const lufs = useTelemetry((s) => Math.round(s.t.master.shortTermLufs));
  const gr = useTelemetry((s) => Math.round(s.t.master.limiterGrDb * 10) / 10);
  const clipped = useTelemetry((s) => s.t.master.clipped);
  return (
    <div className="ml-1 flex w-[70px] flex-col items-center gap-1.5 rounded-xl border border-white/[0.05] bg-black/30 px-1 py-1.5">
      <div className="flex items-center gap-1">
        <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">Master</div>
        <StudioButton strip={MASTER_STRIP} />
      </div>
      <Ctl id="mixer.master" side="right">
        <Knob value={master} min={-40} max={6} def={0} size={30} color="var(--color-zinc-100)" onChange={(v) => setValue("mixer.master", v)} label="Level" readout={db} />
      </Ctl>
      <div className="flex items-end gap-1">
        <Meter read={(t) => t.master.peak} height={pro ? 70 : 96} width={5} />
      </div>
      <Ctl label="Loudness" explain="How loud the whole mix is right now (in LUFS). Clubs and streaming sit around −14 to −8; louder only squashes the sound. The orange number is how much MixIt is turning it down to stop distortion.">
        <div className="text-center font-mono leading-tight">
          <div className={clsx("text-[11px]", lufs > -6 ? "text-orange-400" : "text-zinc-200")}>{lufs <= -69 ? "–" : lufs}</div>
          <div className="text-[9px] text-zinc-500">LUFS</div>
          {gr < -0.3 && <div className={clsx("text-[9px]", gr < -4 ? "text-red-400" : "text-orange-400")}>{gr} GR</div>}
          {clipped && <div className="text-[9px] font-bold text-red-500">CLIP</div>}
        </div>
      </Ctl>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-white/[0.06] pt-1.5">
        <Ctl id="mixer.headphones" side="right">
          <Knob value={phones} min={-40} max={6} def={-6} size={26} color="#fbbf24" onChange={(v) => setValue("mixer.headphones", v)} label="Phones" readout={db} />
        </Ctl>
        {pro && (
          <Ctl id="mixer.cue_mix" side="right">
            <Knob value={cueMix} min={0} max={1} def={0.5} size={26} color="#fbbf24" onChange={(v) => setValue("mixer.cue_mix", v)} label="Cue/Mst" />
          </Ctl>
        )}
      </div>
    </div>
  );
}

/** Opens the studio panel (EQ, compressor, effects sends) for a channel or the master. */
function StudioButton({ strip }: { strip: number }) {
  const open = useStudio((s) => s.open === strip);
  const busy = useApp((s) => (strip === MASTER_STRIP ? s.mixer.glue > 0 : (() => {
    const c = s.mixer.channels[strip];
    return !!c && (c.punch > 0 || c.warmth > 0 || c.space > 0 || c.echo > 0 || c.duckSource > 0 || c.gate || Math.abs(c.pan) > 0.01 || Math.abs(c.width - 1) > 0.01);
  })()));
  return (
    <Ctl label="Studio" explain="Opens this channel's studio: a detailed EQ you can see, compression, warmth, reverb and echo sends, and presets like 'Clearer vocals'." side="top">
      <button
        type="button"
        onClick={() => openStudio(open ? null : strip)}
        className={clsx("relative flex h-5 w-6 items-center justify-center rounded-md border transition-colors", open ? "border-transparent bg-[var(--accent,#e4e4e7)] text-zinc-950" : "border-white/10 text-zinc-400 hover:text-zinc-100")}
        aria-label="Studio"
        aria-pressed={open}
      >
        <SlidersVertical size={11} />
        {busy && !open && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-[var(--accent,#e4e4e7)]" />}
      </button>
    </Ctl>
  );
}

function Crossfader() {
  const x = useApp((s) => s.mixer.crossfader);
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="text-[10px] font-black" style={{ color: DECK_COLORS[0] }}>
        A
      </span>
      <Ctl id="mixer.crossfader" className="flex-1">
        <Fader value={x} min={-1} max={1} def={0} orientation="horizontal" length={200} color="var(--color-zinc-100)" onChange={(v) => setValue("mixer.crossfader", v)} label="Crossfader" className="w-full" />
      </Ctl>
      <span className="text-[10px] font-black" style={{ color: DECK_COLORS[1] }}>
        B
      </span>
    </div>
  );
}

export { transitionPair } from "../../lib/transition";

const SMART_EXPLAIN =
  "Picks the transition for these two tracks the way Auto DJ does: a bass swap for two heavy tracks, a filter fade for clashing keys or a big drop in energy, an echo out across very different tempos, a long blend when everything fits. It also picks the length, shifts a clashing key, loops a short ending and waits for a sung line to finish. A message says what it chose and why.";

function MixIt({ count }: { count: number }) {
  const transitions = useApp((s) => s.transitions);
  const running = useTransition((s) => s.running);
  const [kind, setKind] = useState<TransitionId | "smart">("smart");
  const [beats, setBeats] = useState<number | null>(null);
  const info = useMemo(() => transitions.find((t) => t.id === kind), [transitions, kind]);
  const smart = kind === "smart";
  const len = beats ?? info?.beats ?? 32;
  // Re-render on deck state so the label shows the right pair.
  const pairKey = useTelemetry((s) =>
    s.t.decks
      .slice(0, count)
      .map((d) => `${d.loaded ? 1 : 0}${d.playing ? 1 : 0}${d.master ? 1 : 0}`)
      .join(""),
  );
  const pair = useMemo(() => transitionPair(count), [pairKey, count]); // eslint-disable-line react-hooks/exhaustive-deps
  const L = (d: number) => String.fromCharCode(65 + d);

  if (running) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-1.5" style={{ ["--accent" as string]: DECK_COLORS[running.to] }}>
        <Sparkles size={14} className="text-[var(--accent-ink)]" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium text-zinc-100">
            {transitions.find((t) => t.id === running.kind)?.name ?? running.kind}: {L(running.from)} → {L(running.to)}
            <WaitBars deck={running.from} startBeat={running.startBeat} />
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-[var(--accent)] transition-[width] duration-100" style={{ width: `${Math.round(running.progress * 100)}%` }} />
          </div>
        </div>
        <Btn size="sm" tone="ghost" onClick={cancelTransition} aria-label="Stop transition">
          <Square size={11} />
        </Btn>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Ctl label="Transition" explain={smart ? SMART_EXPLAIN : info?.explain} className="min-w-0 flex-1">
        <select value={kind} onChange={(e) => setKind(e.target.value as TransitionId | "smart")} className="h-7 w-full min-w-0 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" data-testid="mix-kind">
          <option value="smart">Smart</option>
          {transitions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Ctl>
      {kind !== "cut" && !smart && (
        <select value={len} onChange={(e) => setBeats(Number(e.target.value))} className="h-7 w-12 rounded-md border border-white/10 bg-zinc-900 px-0.5 font-mono text-[11px] text-zinc-300 outline-none" title="Length in beats">
          {[4, 8, 16, 32, 64].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      )}
      <Ctl id="app.hear_mix" label="Hear it first" explain="Plays this mix in your headphones before you do it: a few bars before the transition, the transition just as Mix it would run it, and a few bars after, so you can check it sounds right. The audience hears nothing.">
        <Btn
          tone="ghost"
          disabled={!pair || pair[0] === pair[1]}
          onClick={() => {
            if (!pair) return;
            const m = mixItPlan(pair[0], pair[1], kind, len);
            if (!m) toast("Play the deck you are mixing out of first, with an analysed track on both decks.");
            else void hearMix("mixer", m.out, m.inc, m.plan);
          }}
          aria-label="Hear this mix first"
          data-testid="hear-mix-it"
        >
          <Headphones size={13} />
        </Btn>
      </Ctl>
      <Ctl id="app.mix_it" label="Mix it" explain="Runs the whole transition for you, on the beat: syncs the next track, starts it at the top of the next 8-bar phrase so both tracks line up, and moves the faders and EQs like a DJ would. Touch any control to take over.">
        <Btn tone="accent" className="whitespace-nowrap" style={{ ["--accent" as string]: pair ? DECK_COLORS[pair[1]] : "#a1a1aa" }} disabled={!pair} onClick={() => pair && (kind === "smart" ? (pair[0] === pair[1] ? startTransition(pair[0], pair[1], "blend", 32) : void smartMix(pair[0], pair[1])) : startTransition(pair[0], pair[1], kind, kind === "cut" ? 0 : len))} data-testid="mix-it">
          <Sparkles size={13} />
          {pair ? (pair[0] === pair[1] ? `Start ${L(pair[0])}` : `Mix ${L(pair[0])}→${L(pair[1])}`) : "Mix it"}
        </Btn>
      </Ctl>
    </div>
  );
}

/** Pro mixer options: curves, EQ character, headphone split and crossfader sides. */
function MixerOptions({ count }: { count: number }) {
  const m = useApp((s) => s.mixer);
  const row = (label: string, explain: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      {children}
      <div className="text-[11px] leading-snug text-zinc-500">{explain}</div>
    </div>
  );
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="rounded-md p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200" aria-label="Mixer options" title="Mixer options">
          <SlidersHorizontal size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" sideOffset={8} className="z-50 flex w-80 flex-col gap-3 rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur">
          {row(
            "Crossfader curve",
            "Smooth for long blends, sharp for quick cuts and scratching.",
            <Segmented value={m.crossfaderCurve} onChange={(v) => choose("mixer.crossfader_curve", v)} options={["Smooth", "Power", "Sharp"].map((l, i) => ({ value: i, label: l }))} />,
          )}
          {row(
            "Channel faders",
            "How quickly the channel faders get loud as you raise them.",
            <Segmented value={m.faderCurve} onChange={(v) => choose("mixer.fader_curve", v)} options={["Linear", "Smooth", "Steep"].map((l, i) => ({ value: i, label: l }))} />,
          )}
          {row(
            "EQ",
            "Classic shapes the tone gently; Isolator can remove each band completely.",
            <Segmented value={m.eqMode} onChange={(v) => choose("mixer.eq_mode", v)} options={["Classic", "Isolator"].map((l, i) => ({ value: i, label: l }))} />,
          )}
          {row(
            "Crossfader sides",
            "Which side of the crossfader each channel is on. Thru ignores the crossfader.",
            <div className="flex flex-col gap-1">
              {channelOrder(count).map((d) => (
                <div key={d} className="flex items-center gap-2">
                  <span className="w-4 font-black" style={{ color: DECK_COLORS[d] }}>
                    {String.fromCharCode(65 + d)}
                  </span>
                  <Segmented value={m.assign[d]} onChange={(v) => choose(`mixer.${String.fromCharCode(65 + d)}.assign`, v)} options={["A", "Thru", "B"].map((l, i) => ({ value: i, label: l }))} />
                </div>
              ))}
            </div>,
          )}
          <label className="flex items-center gap-2 text-zinc-300">
            <input type="checkbox" checked={m.crossfaderReverse} onChange={(e) => setOn("mixer.crossfader_reverse", e.target.checked)} />
            Reverse the crossfader
          </label>
          <label className="flex items-center gap-2 text-zinc-300">
            <input type="checkbox" checked={m.splitCue} onChange={(e) => setOn("mixer.split_cue", e.target.checked)} />
            Split cue: headphone cue left, master right
          </label>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** "starts in 3 bars" while a transition waits for the top of the next phrase. */
function WaitBars({ deck, startBeat }: { deck: number; startBeat: number }) {
  const bars = useDeckTele(deck, (d) => Math.ceil((startBeat - d.beat) / 4));
  if (bars <= 0) return null;
  return <span className="ml-1.5 font-normal text-zinc-400">starts in {bars} bar{bars === 1 ? "" : "s"}</span>;
}
