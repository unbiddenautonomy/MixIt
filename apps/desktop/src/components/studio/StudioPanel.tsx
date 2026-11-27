// The studio panel for one strip (a deck's channel or the master): an EQ drawn over the
// live spectrum, the one-knob controls, presets in plain words and, under "Show all
// controls" (or in Pro), every setting of the gate, compressor, saturation and output.
// It floats over the mixer without blocking it, so you can keep mixing while you listen.
import clsx from "clsx";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Power, RotateCcw, Sparkles, Target, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BandDto, BandShape, ProjectReturns, StudioDto } from "../../backend/types";
import { choose, findAction, setOn, setValue } from "../../lib/actions";
import { BAND_SLOTS, LOUDNESS_TARGETS, STUDIO_PRESETS, defaultBand, defaultStudio, fmtHz, hasGain } from "../../lib/studio";
import { useApp, usePro } from "../../store/app";
import { ECHO_BEATS, MASTER_STRIP, matchGainDb, openLaneStudio, openStudio, updateStudio, useStudio } from "../../store/studio";
import { setProject } from "../arrange/projectIo";
import { useTelemetry } from "../../store/telemetry";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Knob } from "../ui/Knob";
import { DECK_COLORS } from "../deck/useWaveform";
import { BAND_COLORS, EqGraph } from "./EqGraph";

const MASTER_COLOR = "#e4e4e7";

const SHAPES: { value: BandShape; label: string; hint: string }[] = [
  { value: "bell", label: "Bell", hint: "Boosts or cuts around one pitch." },
  { value: "lowShelf", label: "Low shelf", hint: "Turns everything below a pitch up or down." },
  { value: "highShelf", label: "High shelf", hint: "Turns everything above a pitch up or down." },
  { value: "lowCut", label: "Low cut", hint: "Removes everything below a pitch (rumble, mud)." },
  { value: "highCut", label: "High cut", hint: "Removes everything above a pitch (hiss, harshness)." },
  { value: "notch", label: "Notch", hint: "Removes one narrow pitch, like a hum or a ringing note." },
  { value: "bandPass", label: "Band only", hint: "Keeps only the sound around one pitch, like a telephone." },
];

export const stripName = (strip: number) => (strip === MASTER_STRIP ? "Master" : `Deck ${String.fromCharCode(65 + strip)}`);
const stripColor = (strip: number) => (strip === MASTER_STRIP ? MASTER_COLOR : DECK_COLORS[strip]);

export function StudioPanel() {
  const open = useStudio((s) => s.open);
  const lane = useStudio((s) => s.lane);
  const count = useApp((s) => s.settings?.decks ?? 2);
  const shown = open !== null || lane !== null;
  return (
    <Dialog.Root
      modal={false}
      open={shown}
      onOpenChange={(o) => {
        if (o) return;
        openStudio(null);
        openLaneStudio(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed bottom-3 left-1/2 z-40 flex max-h-[min(640px,86vh)] w-[min(1000px,96vw)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl backdrop-blur"
          aria-describedby={undefined}
        >
          {open !== null ? <LiveBody strip={open} count={count} /> : lane !== null ? <LaneBody lane={lane} /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A live channel's or the master's strip, sent to the engine as it changes. */
function LiveBody({ strip, count }: { strip: number; count: number }) {
  const settings = useStudio((s) => s.settings[strip]);
  const strips = [...Array.from({ length: count }, (_, i) => i), MASTER_STRIP];
  return (
    <Body
      id={`live${strip}`}
      title={`${stripName(strip)} studio`}
      color={stripColor(strip)}
      master={strip === MASTER_STRIP}
      settings={settings}
      change={(f) => void updateStudio(strip, f)}
      switcher={<Segmented value={strip} onChange={(v) => openStudio(v)} options={strips.map((s) => ({ value: s, label: s === MASTER_STRIP ? "Master" : String.fromCharCode(65 + s), title: `${stripName(s)} studio` }))} />}
      quick={strip === MASTER_STRIP ? (st, ch) => <MasterQuick settings={st} change={ch} /> : () => <ChannelQuick deck={strip} count={count} />}
      details={strip}
      live
    />
  );
}

/** A lane's (or the mix's master) strip in the Arrange project, saved with it. */
function LaneBody({ lane }: { lane: number }) {
  const project = useApp((s) => s.project);
  if (!project) return <div className="p-8 text-center text-xs text-zinc-500">Open a project in Arrange first.</div>;
  const master = lane === MASTER_STRIP;
  const settings = (master ? project.master_strip : project.strips?.[lane]) ?? defaultStudio();
  const change = (f: (s: StudioDto) => StudioDto) => {
    const p = useApp.getState().project;
    if (!p) return;
    const cur = (master ? p.master_strip : p.strips?.[lane]) ?? defaultStudio();
    const next = f(structuredClone(cur));
    if (master) setProject({ ...p, master_strip: next }, undefined, "strip:master", "Mix master studio");
    else {
      const strips = Array.from({ length: 4 }, (_, i) => p.strips?.[i] ?? defaultStudio());
      strips[lane] = next;
      setProject({ ...p, strips }, undefined, `strip:${lane}`, `Deck ${String.fromCharCode(65 + lane)} lane studio`);
    }
  };
  return (
    <Body
      id={`lane${lane}`}
      title={master ? "Mix master studio" : `Deck ${String.fromCharCode(65 + lane)} lane studio`}
      color={stripColor(lane)}
      master={master}
      settings={settings}
      change={change}
      switcher={<Segmented value={lane} onChange={(v) => openLaneStudio(v)} options={[0, 1, 2, 3, MASTER_STRIP].map((s) => ({ value: s, label: s === MASTER_STRIP ? "Master" : String.fromCharCode(65 + s) }))} />}
      quick={master ? () => <ProjectReturnsEditor /> : () => <LaneHelp />}
      details={lane}
      live={false}
    />
  );
}

function Body({
  id,
  title,
  color,
  master,
  settings,
  change,
  switcher,
  quick,
  details,
  live,
}: {
  id: string;
  title: string;
  color: string;
  master: boolean;
  settings: StudioDto | null;
  change: (f: (s: StudioDto) => StudioDto) => void;
  switcher: ReactNode;
  quick: (s: StudioDto, change: (f: (s: StudioDto) => StudioDto) => void) => ReactNode;
  details: number;
  live: boolean;
}) {
  const pro = usePro();
  const [all, setAll] = useState(pro);
  const [band, setBand] = useState<number | null>(null);
  useEffect(() => setBand(null), [id]);
  return (
    <div style={{ ["--accent" as string]: color }} className="flex min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="size-2.5 rounded-full" style={{ background: color }} />
        <Dialog.Title className="text-sm font-semibold text-zinc-50">{title}</Dialog.Title>
        {switcher}
        <div className="ml-auto flex items-center gap-2">
          {settings && <Presets master={master} onPick={(p) => change(p)} />}
          {live && (
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              Show all controls
            </label>
          )}
          <Dialog.Close className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
            <X size={16} />
          </Dialog.Close>
        </div>
      </div>
      {!settings ? (
        <div className="p-8 text-center text-xs text-zinc-500">Loading…</div>
      ) : (
        <div className="min-h-0 overflow-y-auto p-4">
          <div className="grid grid-cols-[minmax(0,1fr)_260px] gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Section
                  title="EQ"
                  on={settings.eqOn}
                  onToggle={(on) => change((s) => ({ ...s, eqOn: on }))}
                  explain={live ? "Shapes the tone: turn pitches up or down. The grey hill behind the line is what is playing right now, so you can see where the bass, voice and cymbals are." : "Shapes the tone of everything on this lane: turn pitches up or down."}
                />
                <span className="text-[11px] text-zinc-500">Drag a dot to move it, scroll on it for narrower or wider, double-click to add or remove.</span>
                <button type="button" className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-white/10 hover:text-zinc-200" onClick={() => change((s) => ({ ...s, bands: defaultStudio().bands }))}>
                  <RotateCcw size={11} /> Flat
                </button>
              </div>
              <EqGraph settings={settings} selected={band} onSelect={setBand} color={color} onChange={(bands) => change((s) => ({ ...s, bands }))} />
              <BandRow settings={settings} selected={band} onSelect={setBand} onChange={(bands) => change((s) => ({ ...s, bands }))} />
            </div>
            <div className="flex flex-col gap-3">{quick(settings, change)}</div>
          </div>
          {(all || !live) && <Details strip={details} settings={settings} change={change} />}
        </div>
      )}
    </div>
  );
}

function LaneHelp() {
  return (
    <div className="flex flex-col gap-2 text-[11px] leading-snug text-zinc-400">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">This lane</div>
      <p>These settings shape every clip on this lane, the same way a deck's studio shapes what it plays live.</p>
      <p>Pan and the reverb and echo sends can change during a clip: pick them under Automation in the clip's panel and draw how they move.</p>
      <p className="text-zinc-500">Use "Hear the mix in" on a clip to listen to a change.</p>
    </div>
  );
}

/** The project's shared reverb and echo. */
function ProjectReturnsEditor() {
  const project = useApp((s) => s.project);
  const r = project?.returns ?? DEFAULT_RETURNS;
  const set = (patch: Partial<ProjectReturns>) => {
    const p = useApp.getState().project;
    if (p) setProject({ ...p, returns: { ...(p.returns ?? DEFAULT_RETURNS), ...patch } }, undefined, "returns", "Reverb and echo");
  };
  return (
    <>
      <Group title="Space (reverb)" explain="The shared reverb every lane's Reverb send automation goes to.">
        <Knob value={r.space_level_db} min={-60} max={6} def={-3} size={36} onChange={(v) => set({ space_level_db: v })} label="Level" format={(v) => `${Math.round(v)} dB`} />
        <Knob value={r.space_size} min={0} max={1} def={0.5} size={36} onChange={(v) => set({ space_size: v })} label="Size" format={pct} />
      </Group>
      <Group title="Echo" explain="The shared echo every lane's Echo send automation goes to.">
        <Knob value={r.echo_level_db} min={-60} max={6} def={-3} size={36} onChange={(v) => set({ echo_level_db: v })} label="Level" format={(v) => `${Math.round(v)} dB`} />
        <Knob value={r.echo_feedback} min={0} max={1} def={0.5} size={36} onChange={(v) => set({ echo_feedback: v })} label="Repeats" format={pct} />
        <select value={r.echo_beats} onChange={(e) => set({ echo_beats: Number(e.target.value) })} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Echo time">
          {ECHO_BEATS.map((b) => (
            <option key={b} value={b}>
              {b === 1 ? "1 beat" : b < 1 ? `${b === 0.25 ? "1/4" : b === 0.5 ? "1/2" : "3/4"} beat` : `${b} beats`}
            </option>
          ))}
        </select>
      </Group>
      <p className="text-[11px] leading-snug text-zinc-500">The loudness of the finished file is set when you render: pick a target there.</p>
    </>
  );
}

const DEFAULT_RETURNS: ProjectReturns = { space_level_db: -3, space_size: 0.5, echo_level_db: -3, echo_feedback: 0.5, echo_beats: 0.75 };

// ------------------------------------------------------------------ presets

function Presets({ master, onPick }: { master: boolean; onPick: (f: (s: StudioDto) => StudioDto) => void }) {
  const [open, setOpen] = useState(false);
  const list = STUDIO_PRESETS.filter((p) => p.for === "both" || p.for === (master ? "master" : "channel"));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Btn size="sm" active={open}>
          <Sparkles size={12} /> Presets <ChevronDown size={11} />
        </Btn>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 flex w-80 flex-col gap-0.5 rounded-xl border border-white/10 bg-zinc-900/95 p-1.5 text-xs shadow-2xl backdrop-blur">
          {list.map((p) => (
            <button
              key={p.id}
              type="button"
              className="rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.07]"
              onClick={() => {
                onPick(p.apply);
                setOpen(false);
              }}
            >
              <div className="font-medium text-zinc-100">{p.name}</div>
              <div className="leading-snug text-zinc-500">{p.hint}</div>
            </button>
          ))}
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-zinc-500">Presets add to what is there; "Start clean" clears it first.</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ------------------------------------------------------------------ bands

function BandRow({ settings, selected, onSelect, onChange }: { settings: StudioDto; selected: number | null; onSelect: (i: number | null) => void; onChange: (b: BandDto[]) => void }) {
  const set = (i: number, p: Partial<BandDto>) => onChange(settings.bands.map((b, j) => (j === i ? { ...b, ...p } : b)));
  const b = selected === null ? null : settings.bands[selected];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1">
        {settings.bands.map((x, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              if (!x.enabled) {
                const slot = BAND_SLOTS[i];
                set(i, { ...defaultBand(), ...slot, enabled: true, q: slot.shape === "bell" ? 1 : Math.SQRT1_2 });
              }
              onSelect(i);
            }}
            className={clsx("flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px]", selected === i ? "border-white/40 bg-white/10 text-zinc-50" : "border-white/10 text-zinc-400 hover:text-zinc-100", !x.enabled && "opacity-50")}
            title={x.enabled ? `${SHAPES.find((s) => s.value === x.shape)?.label} at ${fmtHz(x.freq)}` : "Add this band"}
          >
            <span className="size-2 rounded-full" style={{ background: BAND_COLORS[i] }} />
            {x.enabled ? fmtHz(x.freq) : "+"}
          </button>
        ))}
      </div>
      {b && selected !== null && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-black/20 px-3 py-2">
          <Field label="Shape" hint={SHAPES.find((s) => s.value === b.shape)?.hint}>
            <select value={b.shape} onChange={(e) => set(selected, { shape: e.target.value as BandShape })} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none">
              {SHAPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pitch">
            <Num value={b.freq} min={20} max={20_000} step={1} unit="Hz" onChange={(v) => set(selected, { freq: v })} />
          </Field>
          {hasGain(b.shape) && (
            <Field label="Boost / cut">
              <Num value={b.gainDb} min={-18} max={18} step={0.5} unit="dB" onChange={(v) => set(selected, { gainDb: v })} />
            </Field>
          )}
          {b.shape === "lowCut" || b.shape === "highCut" ? (
            <Field label="Steepness" hint="How sharply the sound beyond the pitch is removed.">
              <Segmented value={b.slopeDb} onChange={(v) => set(selected, { slopeDb: v })} options={[12, 24, 36, 48].map((v) => ({ value: v, label: `${v}` }))} />
            </Field>
          ) : null}
          <Field label="Width" hint="Lower is wider and gentler; higher is narrower and more precise.">
            <Num value={b.q} min={0.1} max={18} step={0.05} unit="Q" onChange={(v) => set(selected, { q: v })} />
          </Field>
          <button type="button" className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-zinc-100" onClick={() => (set(selected, { enabled: false }), onSelect(null))}>
            <Power size={11} /> Remove band
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ quick controls

const L = (d: number) => String.fromCharCode(65 + d);

function QuickKnob({ id, value, min, max, def, label, bipolar, format }: { id: string; value: number; min: number; max: number; def: number; label: string; bipolar?: boolean; format?: (v: number) => string }) {
  return (
    <Ctl id={id} side="top">
      <Knob value={value} min={min} max={max} def={def} size={36} bipolar={bipolar} onChange={(v) => setValue(id, v)} label={label} format={format} />
    </Ctl>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

function ChannelQuick({ deck, count }: { deck: number; count: number }) {
  const ch = useApp((s) => s.mixer.channels[deck]);
  const id = (c: string) => `mixer.${L(deck)}.${c}`;
  const sources = useMemo(() => {
    const k = findAction(id("duck_source"))?.kind;
    return k?.type === "choice" ? k.options : ["Off", "Deck A", "Deck B", "Deck C", "Deck D"];
  }, [deck]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Group title="Sound">
        <QuickKnob id={id("pan")} value={ch.pan} min={-1} max={1} def={0} bipolar label="Pan" format={(v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)} />
        <QuickKnob id={id("punch")} value={ch.punch} min={0} max={1} def={0} label="Punch" format={pct} />
        <QuickKnob id={id("warmth")} value={ch.warmth} min={0} max={1} def={0} label="Warmth" format={pct} />
        <QuickKnob id={id("width")} value={ch.width} min={0} max={2} def={1} bipolar label="Width" format={pct} />
      </Group>
      <Group title="Sends">
        <QuickKnob id={id("space")} value={ch.space} min={0} max={1} def={0} label="Space" format={pct} />
        <QuickKnob id={id("echo")} value={ch.echo} min={0} max={1} def={0} label="Echo" format={pct} />
      </Group>
      <Group title="Duck under" explain="Turns this deck down automatically whenever another deck is loud, so a voice or a new bassline comes through without riding the fader.">
        <select value={ch.duckSource} onChange={(e) => choose(id("duck_source"), Number(e.target.value))} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Duck under">
          {sources.map((s, i) =>
            i === deck + 1 || i > count ? null : (
              <option key={s} value={i}>
                {s}
              </option>
            ),
          )}
        </select>
        {ch.duckSource > 0 && <QuickKnob id={id("duck")} value={ch.duck} min={0} max={1} def={0.5} label="Amount" format={pct} />}
      </Group>
      <Group title="Gate" explain="Silences the channel between sounds, cutting hiss, hum or a noisy room from a mic.">
        <Ctl id={id("gate")}>
          <Btn size="sm" active={ch.gate} onClick={() => setOn(id("gate"), !ch.gate)}>
            <Power size={11} /> {ch.gate ? "On" : "Off"}
          </Btn>
        </Ctl>
        <GateLight deck={deck} />
      </Group>
      <Meters deck={deck} />
    </>
  );
}

function GateLight({ deck }: { deck: number }) {
  const open = useTelemetry((s) => s.t.decks[deck]?.gateOpen ?? true);
  return <span className={clsx("size-2 rounded-full", open ? "bg-emerald-400" : "bg-zinc-700")} title={open ? "Sound is passing" : "Gate closed"} />;
}

function Meters({ deck }: { deck: number }) {
  const gr = useTelemetry((s) => Math.round((s.t.decks[deck]?.compGrDb ?? 0) * 2) / 2);
  const duck = useTelemetry((s) => Math.round((s.t.decks[deck]?.duckDb ?? 0) * 2) / 2);
  return (
    <div className="flex flex-col gap-1.5">
      <Bar label="Compressing" value={gr} max={18} color="#fb923c" explain="How much the compressor is turning the loud parts down right now." />
      <Bar label="Ducked" value={duck} max={24} color="#22d3ee" explain="How far ducking has turned this deck down right now." />
    </div>
  );
}

function Bar({ label, value, max, color, explain }: { label: string; value: number; max: number; color: string; explain: string }) {
  return (
    <Ctl label={label} explain={explain} className="w-full">
      <div className="flex w-full items-center gap-2 text-[11px] text-zinc-500">
        <span className="w-[70px] shrink-0">{label}</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div className="h-full rounded-full transition-[width] duration-75" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
        </div>
        <span className="w-9 shrink-0 text-right font-mono text-zinc-400">{value > 0 ? `−${value}` : "0"}</span>
      </div>
    </Ctl>
  );
}

function MasterQuick({ settings, change }: { settings: StudioDto; change: (f: (s: StudioDto) => StudioDto) => void }) {
  const m = useApp((s) => s.mixer);
  const times = useMemo(() => {
    const k = findAction("mixer.echo.time")?.kind;
    return k?.type === "choice" ? k.options : ["1/4 beat", "1/2 beat", "3/4 beat", "1 beat", "2 beats", "4 beats"];
  }, []);
  const gr = useTelemetry((s) => Math.round(s.t.master.glueGrDb * 2) / 2);
  return (
    <>
      <Group title="Glue">
        <QuickKnob id="mixer.glue" value={m.glue} min={0} max={1} def={0} label="Glue" format={pct} />
        <div className="min-w-0 flex-1">
          <Bar label="Compressing" value={gr} max={12} color="#fb923c" explain="How much the glue compressor is turning the whole mix down on loud moments." />
        </div>
      </Group>
      <Group title="Space (reverb)" explain="The shared reverb every deck can send to with its Space knob.">
        <QuickKnob id="mixer.space.level" value={m.spaceLevel} min={-60} max={6} def={-3} label="Level" format={(v) => `${Math.round(v)} dB`} />
        <QuickKnob id="mixer.space.size" value={m.spaceSize} min={0} max={1} def={0.5} label="Size" format={pct} />
      </Group>
      <Group title="Echo" explain="The shared echo every deck can send to with its Echo knob. It bounces left and right in time with the music.">
        <QuickKnob id="mixer.echo.level" value={m.echoLevel} min={-60} max={6} def={-3} label="Level" format={(v) => `${Math.round(v)} dB`} />
        <QuickKnob id="mixer.echo.feedback" value={m.echoFeedback} min={0} max={1} def={0.5} label="Repeats" format={pct} />
        <select value={m.echoTime} onChange={(e) => choose("mixer.echo.time", Number(e.target.value))} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Echo time">
          {times.map((t, i) => (
            <option key={t} value={i}>
              {t}
            </option>
          ))}
        </select>
      </Group>
      <Loudness settings={settings} change={change} />
    </>
  );
}

/** Mean loudness (LUFS) of the short-term readings above −50 over the last ~10 s, in the
 * energy domain like a loudness meter's gate. */
function useRecentLoudness(): number {
  const ring = useRef<number[]>([]);
  const [lufs, setLufs] = useState(-70);
  useEffect(() => {
    let last = 0;
    return useTelemetry.subscribe((s) => {
      const now = performance.now();
      if (now - last < 100) return;
      last = now;
      const v = s.t.master.shortTermLufs;
      const r = ring.current;
      r.push(v > -50 ? Math.pow(10, v / 10) : 0);
      if (r.length > 100) r.shift();
      const live = r.filter((x) => x > 0);
      setLufs(live.length < 5 ? -70 : Math.round(10 * Math.log10(live.reduce((a, b) => a + b, 0) / live.length) * 10) / 10);
    });
  }, []);
  return lufs;
}

function Loudness({ settings, change }: { settings: StudioDto; change: (f: (s: StudioDto) => StudioDto) => void }) {
  const targetId = useStudio((s) => s.target);
  const target = LOUDNESS_TARGETS.find((t) => t.id === targetId) ?? LOUDNESS_TARGETS[0];
  const lufs = useRecentLoudness();
  const diff = lufs <= -69 ? null : Math.round((lufs - target.lufs) * 10) / 10;
  const verdict = diff === null ? "Play some music to measure." : Math.abs(diff) <= 1 ? "On target." : diff > 0 ? `${diff} dB louder than the target.` : `${-diff} dB quieter than the target.`;
  const match = () => {
    const g = matchGainDb(lufs, target.lufs, settings.outputDb);
    if (g !== null) change((s) => ({ ...s, outputDb: g }));
  };
  return (
    <Group title="Loudness target" explain="How loud the finished mix should be. Streaming services turn loud mixes down, so aiming for their level keeps the punch you would otherwise lose.">
      <div className="flex w-full flex-col gap-1.5">
        <select value={target.id} onChange={(e) => useStudio.getState().set({ target: e.target.value })} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Loudness target">
          {LOUDNESS_TARGETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.lufs} LUFS)
            </option>
          ))}
        </select>
        <div className="text-[11px] leading-snug text-zinc-500">{target.hint}</div>
        <div className="flex items-center gap-2">
          <div className="font-mono text-lg leading-none text-zinc-100">{lufs <= -69 ? "–" : lufs}</div>
          <div className="text-[11px] text-zinc-500">LUFS, last 10 s</div>
          <Btn size="sm" className="ml-auto" disabled={diff === null || Math.abs(diff) <= 0.5} onClick={match} title="Sets the master output so the mix sits at the target. Play a typical part of the mix first.">
            <Target size={11} /> Match
          </Btn>
        </div>
        <div className={clsx("text-[11px]", diff !== null && Math.abs(diff) > 1 ? "text-amber-300" : "text-zinc-400")}>{verdict}</div>
      </div>
    </Group>
  );
}

// ------------------------------------------------------------------ all controls

function Details({ strip, settings, change }: { strip: number; settings: StudioDto; change: (f: (s: StudioDto) => StudioDto) => void }) {
  const c = settings.comp;
  const g = settings.gate;
  const comp = (p: Partial<StudioDto["comp"]>) => change((s) => ({ ...s, comp: { ...s.comp, ...p } }));
  const gate = (p: Partial<StudioDto["gate"]>) => change((s) => ({ ...s, gate: { ...s.gate, ...p } }));
  const master = strip === MASTER_STRIP;
  return (
    <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-4">
      <Card title="Compressor" on={settings.compOn} onToggle={(on) => change((s) => ({ ...s, compOn: on }))} explain="Evens out the level: loud moments are turned down so the quiet parts can come up. Punch and Glue set this for you.">
        <Num label="Threshold" value={c.thresholdDb} min={-60} max={0} step={0.5} unit="dB" onChange={(v) => comp({ thresholdDb: v })} hint="Sound louder than this gets turned down." />
        <Num label="Ratio" value={c.ratio} min={1} max={30} step={0.1} unit=":1" onChange={(v) => comp({ ratio: v })} hint="How hard: 2 is gentle, 8 and up is squashing." />
        <Num label="Knee" value={c.kneeDb} min={0} max={24} step={0.5} unit="dB" onChange={(v) => comp({ kneeDb: v })} hint="Softer knee starts more gently." />
        <Num label="Attack" value={c.attackMs} min={0.05} max={300} step={0.5} unit="ms" onChange={(v) => comp({ attackMs: v })} hint="Slower lets the start of each hit through." />
        <Num label="Release" value={c.releaseMs} min={5} max={3000} step={5} unit="ms" onChange={(v) => comp({ releaseMs: v })} hint="How quickly it lets go after a loud moment." />
        <Num label="Ignore bass below" value={c.sidechainHpfHz} min={0} max={500} step={5} unit="Hz" onChange={(v) => comp({ sidechainHpfHz: v })} hint="Stops the kick drum alone from pumping the whole sound." />
        <Num label="Blend" value={Math.round(c.mix * 100)} min={0} max={100} step={1} unit="%" onChange={(v) => comp({ mix: v / 100 })} hint="Below 100% mixes the untouched sound back in (parallel compression)." />
        <label className="flex items-center gap-2 text-[11px] text-zinc-300">
          <input type="checkbox" checked={c.autoMakeup} onChange={(e) => comp({ autoMakeup: e.target.checked })} />
          Make up the lost level automatically
        </label>
        {!c.autoMakeup && <Num label="Make-up" value={c.makeupDb} min={-12} max={24} step={0.5} unit="dB" onChange={(v) => comp({ makeupDb: v })} />}
      </Card>
      <Card title="Gate" on={settings.gateOn} onToggle={(on) => change((s) => ({ ...s, gateOn: on }))} explain="Silences everything quieter than the threshold, so hiss and room noise disappear between sounds.">
        <Num label="Threshold" value={g.thresholdDb} min={-90} max={0} step={0.5} unit="dB" onChange={(v) => gate({ thresholdDb: v })} hint="Quieter than this is silenced." />
        <Num label="Range" value={g.rangeDb} min={-120} max={0} step={1} unit="dB" onChange={(v) => gate({ rangeDb: v })} hint="How far down it goes when closed: −80 is silence, −10 only softens." />
        <Num label="Hysteresis" value={g.hysteresisDb} min={0} max={20} step={0.5} unit="dB" onChange={(v) => gate({ hysteresisDb: v })} hint="Stops it chattering on and off around the threshold." />
        <Num label="Attack" value={g.attackMs} min={0.05} max={100} step={0.05} unit="ms" onChange={(v) => gate({ attackMs: v })} />
        <Num label="Hold" value={g.holdMs} min={0} max={2000} step={5} unit="ms" onChange={(v) => gate({ holdMs: v })} hint="How long it stays open after the sound drops." />
        <Num label="Release" value={g.releaseMs} min={1} max={5000} step={5} unit="ms" onChange={(v) => gate({ releaseMs: v })} />
      </Card>
      <Card title="Warmth and output" on={settings.satOn} onToggle={(on) => change((s) => ({ ...s, satOn: on }))} explain="Saturation adds the gentle harmonics of tape and valves, making a sound feel fuller and louder without turning it up.">
        <Num label="Drive" value={settings.driveDb} min={0} max={30} step={0.5} unit="dB" onChange={(v) => change((s) => ({ ...s, driveDb: v }))} hint="More drive is warmer, then dirtier." />
        <Num label="Stereo width" value={Math.round(settings.width * 100)} min={0} max={200} step={1} unit="%" onChange={(v) => change((s) => ({ ...s, width: v / 100 }))} hint="0% is mono, 100% unchanged, 200% extra wide. Bass is kept in the middle." />
        <Num label="Output" value={settings.outputDb} min={-24} max={24} step={0.5} unit="dB" onChange={(v) => change((s) => ({ ...s, outputDb: v }))} hint={master ? "The level of the whole mix after this strip." : "The level after this strip, before the fader."} />
        <button type="button" className="mt-1 flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-white/10 hover:text-zinc-200" onClick={() => change(() => defaultStudio())}>
          <RotateCcw size={11} /> Reset this strip
        </button>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ bits

function Section({ title, on, onToggle, explain }: { title: string; on: boolean; onToggle: (on: boolean) => void; explain: string }) {
  return (
    <Ctl label={title} explain={explain}>
      <button type="button" onClick={() => onToggle(!on)} className={clsx("flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold uppercase tracking-wider", on ? "border-[var(--accent)]/50 text-zinc-100" : "border-white/10 text-zinc-500")} aria-pressed={on}>
        <Power size={10} className={on ? "text-[var(--accent)]" : undefined} /> {title}
      </button>
    </Ctl>
  );
}

function Group({ title, explain, children }: { title: string; explain?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Ctl label={title} explain={explain} className="self-start">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</div>
      </Ctl>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Card({ title, on, onToggle, explain, children }: { title: string; on: boolean; onToggle: (on: boolean) => void; explain: string; children: ReactNode }) {
  return (
    <div className={clsx("flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-black/20 p-3", !on && "opacity-70")}>
      <Section title={title} on={on} onToggle={onToggle} explain={explain} />
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1" title={hint}>
      <div className="text-[11px] text-zinc-500">{label}</div>
      {children}
    </div>
  );
}

/** A number box that commits on Enter or blur, clamped to its range. */
function Num({ label, value, min, max, step, unit, hint, onChange }: { label?: string; value: number; min: number; max: number; step: number; unit: string; hint?: string; onChange: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(Math.round(value / step) * step === value ? value : Number(value.toFixed(2)));
  const commit = (s: string) => {
    setText(null);
    const v = Number(s);
    if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
  };
  const box = (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={shown}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit((e.target as HTMLInputElement).value)}
        className="h-7 w-20 rounded-md border border-white/10 bg-zinc-950 px-1.5 font-mono text-[11px] text-zinc-100 outline-none focus:border-[var(--accent)]/60"
      />
      <span className="w-5 text-[11px] text-zinc-500">{unit}</span>
    </div>
  );
  if (!label) return box;
  return (
    <div className="flex items-center justify-between gap-2" title={hint}>
      <span className="text-[11px] text-zinc-400">{label}</span>
      {box}
    </div>
  );
}
