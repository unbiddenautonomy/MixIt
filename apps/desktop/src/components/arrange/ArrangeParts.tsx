// Arrange building blocks: the tempo lane and its editor, undo history, problem list,
// and the clip panel's key, effect and transition sections.
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { AlertTriangle, Check, History, Play, Redo2, Trash2, Undo2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import type { Clip, MixProject } from "../../backend/types";
import {
  applyTemplate,
  applyTransition,
  captureTemplate,
  clipKey,
  clipKeyDto,
  matchKeyShift,
  mixesOutOf,
  moveTempoChange,
  projectIssues,
  rampsInto,
  removeTempoChange,
  setTempoChange,
  TRANSITIONS,
  trackKey,
  type SnapMode,
  type TransitionKind,
} from "../../lib/arrangeOps";
import { bpm as fmtBpm } from "../../lib/format";
import { compatibility, keyColor, keyDto, keyLabel } from "../../lib/keys";
import { useApp, useNotation } from "../../store/app";
import { useTemplates } from "../../store/templates";
import { Btn, Segmented } from "../ui/Button";
import { useAutoEdit } from "./AutomationEditor";
import { playPreview } from "./preview";
import { bpmAt, jumpHistory, redoProject, setProject, undoProject, updateClip, useHistory } from "./projectIo";

/** Arrange view state shared by the timeline and the side panel. */
interface ArrangeUi {
  snap: SnapMode;
  tempoSel: number | null;
  /** Selected clips; the last one is the one the side panel shows. */
  selected: number[];
  /** A stretch of the timeline that Play repeats, in beats. */
  loop: { from: number; to: number } | null;
  looping: boolean;
}

export const useArrangeUi = create<ArrangeUi & { set: (p: Partial<ArrangeUi>) => void }>((set) => ({
  snap: "bar",
  tempoSel: null,
  selected: [],
  loop: null,
  looping: false,
  set: (p) => set(p),
}));

const barOf = (beat: number) => Math.floor(beat / 4) + 1;

// ---------------------------------------------------------------- toolbar

export function SnapPicker() {
  const snap = useArrangeUi((s) => s.snap);
  return (
    <Segmented
      value={snap}
      onChange={(v) => useArrangeUi.getState().set({ snap: v })}
      options={[
        { value: "beat", label: "Beat", title: "Clips move in single beats" },
        { value: "bar", label: "Bar", title: "Clips move in bars of 4 beats" },
        { value: "phrase", label: "Phrase", title: "Clips move in 8-bar phrases, lined up with the phrases of the track already playing, so drops and breakdowns land together" },
      ]}
    />
  );
}

export function HistoryButtons() {
  const undo = useHistory((s) => s.undo);
  const redo = useHistory((s) => s.redo);
  const base = useHistory((s) => s.base);
  const [open, setOpen] = useState(false);
  const last = undo[undo.length - 1];
  const next = redo[0];
  return (
    <div className="flex items-center">
      <Btn size="sm" tone="ghost" disabled={!last} onClick={() => undoProject()} title={last ? `Undo: ${last}` : "Nothing to undo"} aria-label="Undo">
        <Undo2 size={12} />
      </Btn>
      <Btn size="sm" tone="ghost" disabled={!next} onClick={() => redoProject()} title={next ? `Redo: ${next}` : "Nothing to redo"} aria-label="Redo">
        <Redo2 size={12} />
      </Btn>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Btn size="sm" tone="ghost" aria-label="Edit history" title="Every change you made. Click one to go back to it.">
            <History size={12} />
            {undo.length > 0 && <span className="font-mono text-[11px] text-zinc-400">{undo.length}</span>}
          </Btn>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content side="bottom" align="end" sideOffset={6} className="z-50 flex max-h-96 w-72 flex-col overflow-hidden rounded-xl border border-white/10 bg-zinc-900/95 text-xs shadow-2xl backdrop-blur">
            <div className="border-b border-white/[0.06] px-3 py-2">
              <div className="font-semibold text-zinc-100">History</div>
              <p className="text-[11px] text-zinc-500">Click a step to go back to it. Steps after it stay here until you change something.</p>
            </div>
            <div className="flex flex-col overflow-y-auto p-1">
              {[base, ...undo, ...redo].map((label, i) => {
                const now = i === undo.length;
                const future = i > undo.length;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => jumpHistory(i)}
                    className={clsx("flex items-center gap-2 rounded-md px-2 py-1 text-left", now ? "bg-[var(--accent)]/15 text-zinc-50" : future ? "text-zinc-600 hover:bg-white/5" : "text-zinc-300 hover:bg-white/5")}
                  >
                    <span className="w-5 text-right font-mono text-[11px] text-zinc-600">{i}</span>
                    <span className="flex-1 truncate">{label}</span>
                    {now && <Check size={11} className="text-[var(--accent-ink)]" />}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function IssuesButton({ project, select }: { project: MixProject; select: (id: number) => void }) {
  const notation = useNotation();
  const issues = useMemo(() => projectIssues(project, (b) => bpmAt(project, b)), [project]);
  const name = (id: number) => {
    const c = project.clips.find((x) => x.id === id);
    return c ? c.name || c.track.title : "a clip";
  };
  if (!project.clips.length) return null;
  if (!issues.length)
    return (
      <span className="flex items-center gap-1 text-[11px] text-emerald-300/80" title="No clashing keys, no two clips on one deck at once, and no track stretched too far from its own tempo.">
        <Check size={11} /> No problems
      </span>
    );
  const text = (i: (typeof issues)[number]) => {
    if (i.kind === "overlap") return `“${name(i.a)}” and “${name(i.b)}” play on the same deck at once. Move one to another deck.`;
    if (i.kind === "key") {
      const a = project.clips.find((c) => c.id === i.a);
      const b = project.clips.find((c) => c.id === i.b);
      const ka = a ? keyLabel(clipKeyDto(a), notation) : "?";
      const kb = b ? keyLabel(clipKeyDto(b), notation) : "?";
      return `“${name(i.a)}” (${ka}) and “${name(i.b)}” (${kb}) clash when they overlap. Try Match key on one of them.`;
    }
    return `“${name(i.clip)}” plays ${Math.abs(i.percent).toFixed(0)}% ${i.percent > 0 ? "faster" : "slower"} than its own tempo, which can sound unnatural. Move the mix tempo closer, or pick another track.`;
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25">
          <AlertTriangle size={11} /> {issues.length} problem{issues.length === 1 ? "" : "s"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" sideOffset={6} className="z-50 flex w-80 flex-col gap-1 rounded-xl border border-white/10 bg-zinc-900/95 p-2 text-xs shadow-2xl backdrop-blur">
          {issues.map((i, k) => (
            <button key={k} type="button" className="rounded-md px-2 py-1.5 text-left leading-snug text-zinc-300 hover:bg-white/5" onClick={() => select(i.kind === "stretch" ? i.clip : i.b)}>
              {text(i)}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- tempo lane

export const TEMPO_H = 34;

export function TempoLane({ project, ppb, beats }: { project: MixProject; ppb: number; beats: number }) {
  const segs = project.tempo.segments;
  const sel = useArrangeUi((s) => s.tempoSel);
  const drag = useRef<{ i: number; x: number; beat: number } | null>(null);
  const width = beats * ppb;
  const values = segs.flatMap((s) => [s.bpm, s.end_bpm]);
  const lo = Math.min(...values) - 2;
  const hi = Math.max(...values) + 2;
  const y = (b: number) => TEMPO_H - 6 - ((b - lo) / Math.max(1e-6, hi - lo)) * (TEMPO_H - 14);
  const pts: string[] = [];
  segs.forEach((s, i) => {
    const end = i + 1 < segs.length ? segs[i + 1].start_beat : beats;
    pts.push(`${s.start_beat * ppb},${y(s.bpm)}`, `${end * ppb},${y(s.end_bpm)}`);
  });
  return (
    <div className="flex border-b border-white/[0.06]" style={{ height: TEMPO_H }}>
      <div className="sticky left-0 z-10 flex w-20 shrink-0 flex-col justify-center border-r border-white/[0.06] bg-zinc-950 px-2">
        <span className="text-[11px] font-semibold text-amber-300">Tempo</span>
        <span className="text-[11px] leading-tight text-zinc-600">double-click to add</span>
      </div>
      <div
        className="relative flex-1"
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget && !(e.target as Element).closest("svg")) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const beat = Math.max(4, Math.round((e.clientX - r.left) / ppb / 4) * 4);
          const p = setTempoChange(project, beat, Math.round(bpmAt(project, beat)), false);
          setProject(p, undefined, undefined, `Add a tempo change at bar ${barOf(beat)}`);
          useArrangeUi.getState().set({ tempoSel: p.tempo.segments.findIndex((s) => s.start_beat === beat) });
        }}
      >
        <svg className="absolute inset-0" width={width} height={TEMPO_H}>
          <polyline points={pts.join(" ")} fill="none" stroke="rgba(251,191,36,0.55)" strokeWidth={1.5} />
        </svg>
        {segs.map((s, i) => (
          <button
            key={i}
            type="button"
            className={clsx(
              "absolute top-1 flex h-5 -translate-x-px items-center gap-0.5 rounded-r border-l-2 px-1 font-mono text-[11px]",
              sel === i ? "border-amber-300 bg-amber-400/30 text-amber-100" : "border-amber-400/70 bg-amber-400/10 text-amber-300 hover:bg-amber-400/20",
            )}
            style={{ left: s.start_beat * ppb, cursor: i > 0 ? "ew-resize" : "pointer" }}
            title={i === 0 ? "Starting tempo. Click to change it." : "Tempo change. Click to edit, drag to move it."}
            onPointerDown={(e) => {
              e.stopPropagation();
              useArrangeUi.getState().set({ tempoSel: i });
              if (i > 0) {
                drag.current = { i, x: e.clientX, beat: s.start_beat };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const beat = Math.round((d.beat + (e.clientX - d.x) / ppb) / 4) * 4;
              const cur = useApp.getState().project;
              if (cur && cur.tempo.segments[d.i]?.start_beat !== beat) setProject(moveTempoChange(cur, d.i, beat), undefined, `tempo:${d.i}:move`, "Move a tempo change");
            }}
            onPointerUp={() => (drag.current = null)}
          >
            {rampsInto(project, i) && <span className="text-amber-200/70">↗</span>}
            {fmtBpm(s.bpm)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TempoPanel({ project, index }: { project: MixProject; index: number }) {
  const s = project.tempo.segments[index];
  const [text, setText] = useState<string | null>(null);
  if (!s) return null;
  const close = () => useArrangeUi.getState().set({ tempoSel: null });
  const apply = (bpm: number, ramp = rampsInto(project, index)) => {
    if (!Number.isFinite(bpm)) return;
    setProject(setTempoChange(project, s.start_beat, bpm, ramp), undefined, `tempo:${index}:bpm`, index === 0 ? "Change the starting tempo" : `Change the tempo at bar ${barOf(s.start_beat)}`);
  };
  const playing = project.clips.filter((c) => c.start <= s.start_beat + 1 && c.start + c.length > s.start_beat);
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-3 text-xs">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-100">{index === 0 ? "Starting tempo" : `Tempo change at bar ${barOf(s.start_beat)}`}</div>
          <p className="mt-1 leading-snug text-zinc-500">Every track plays at the mix tempo. Changing it speeds tracks up or slows them down; with key lock on they keep their pitch.</p>
        </div>
        <button type="button" className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" onClick={close} aria-label="Close">
          <X size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-16 shrink-0 text-zinc-500">BPM</span>
        <Btn size="sm" onClick={() => apply(s.bpm - 1)} aria-label="One BPM slower">
          −1
        </Btn>
        <input
          className="input h-7 w-20 text-center font-mono"
          value={text ?? s.bpm.toFixed(2)}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text != null) apply(Number(text));
            setText(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Tempo in BPM"
        />
        <Btn size="sm" onClick={() => apply(s.bpm + 1)} aria-label="One BPM faster">
          +1
        </Btn>
      </div>
      {index > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-zinc-500">Change</span>
          <Segmented
            value={rampsInto(project, index) ? "ramp" : "jump"}
            onChange={(v) => apply(s.bpm, v === "ramp")}
            options={[
              { value: "ramp", label: "Glide into it", title: "The tempo moves smoothly from the previous change to this one" },
              { value: "jump", label: "Jump", title: "The tempo changes on this beat" },
            ]}
          />
        </div>
      )}
      {playing.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-black/20 p-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Playing here</div>
          {playing.map((c) => {
            const pct = (s.bpm / c.track.bpm - 1) * 100;
            return (
              <div key={c.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-zinc-300">{c.name || c.track.title}</span>
                <span className={clsx("font-mono text-[11px]", Math.abs(pct) > 8 ? "text-amber-300" : "text-zinc-500")}>
                  {pct >= 0 ? "+" : ""}
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
      <Btn size="sm" onClick={() => playPreview(project, Math.max(0, s.start_beat - 16), s.start_beat + 32)}>
        <Play size={11} /> Hear it
      </Btn>
      {index > 0 && (
        <Btn
          size="sm"
          tone="danger"
          onClick={() => {
            setProject(removeTempoChange(project, index), undefined, undefined, `Remove the tempo change at bar ${barOf(s.start_beat)}`);
            close();
          }}
        >
          <Trash2 size={12} /> Remove tempo change
        </Btn>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- clip panel parts

export function KeyRow({ clip, project }: { clip: Clip; project: MixProject }) {
  const notation = useNotation();
  const own = trackKey(clip);
  const heard = clipKeyDto(clip);
  const out = mixesOutOf(project, clip);
  const outKey = out ? clipKey(out) : null;
  const mine = clipKey(clip);
  const compat = mine && outKey ? compatibility(outKey, mine) : null;
  const shift = (v: number) => updateClip(clip.id, { key_shift: Math.max(-12, Math.min(12, v)) });
  const match = matchKeyShift(project, clip);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-zinc-500">Key</span>
        <button type="button" className="rounded bg-white/[0.06] px-2 py-0.5" onClick={() => shift(clip.key_shift - 1)} aria-label="Key down a semitone">
          −
        </button>
        <span className="flex min-w-16 items-center justify-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-bold text-zinc-950" style={{ background: keyColor(heard) }}>
          {heard ? keyLabel(heard, notation) : "?"}
          {clip.key_shift !== 0 && (
            <span className="font-semibold opacity-70">
              {clip.key_shift > 0 ? "+" : ""}
              {clip.key_shift}
            </span>
          )}
        </span>
        <button type="button" className="rounded bg-white/[0.06] px-2 py-0.5" onClick={() => shift(clip.key_shift + 1)} aria-label="Key up a semitone">
          +
        </button>
      </div>
      {own ? (
        out && outKey ? (
          <div className="flex items-center gap-1.5 pl-[72px]">
            <span className={clsx("flex-1 text-[11px] leading-snug", compat === "clash" || compat === "shift" ? "text-amber-300" : "text-emerald-300/90")}>
              {compat === "same" || compat === "match" ? `Fits with “${out.name || out.track.title}”` : compat === "boost" ? "An energy lift from the last track" : `Clashes with “${out.name || out.track.title}” (${keyLabel(keyDto(outKey), notation)})`}
            </span>
            {match !== null && match !== Math.round(clip.key_shift) && (compat === "clash" || compat === "shift") && (
              <Btn size="sm" onClick={() => updateClip(clip.id, { key_shift: match }, "Match key")} title="Shifts this track by the fewest semitones that make it sit well with the track before it">
                Match key
              </Btn>
            )}
          </div>
        ) : null
      ) : (
        <p className="pl-[72px] text-[11px] text-zinc-600">This track's key is not known, so MixIt cannot check it.</p>
      )}
    </div>
  );
}

const FX_TIMES = [0.25, 0.5, 0.75, 1, 2, 4];
const fxTime = (b: number) => (b === 0.25 ? "¼ beat" : b === 0.5 ? "½ beat" : b === 0.75 ? "¾ beat" : `${b} beat${b === 1 ? "" : "s"}`);

export function EffectRow({ clip }: { clip: Clip }) {
  const types = useApp((s) => s.fxTypes);
  const hasMix = clip.lanes.some((l) => l.param === "FxMix" && l.points.length > 0);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-zinc-500">Effect</span>
        <select
          className="input h-7 min-w-0 flex-1"
          value={clip.fx ? clip.fx.kind : -1}
          onChange={(e) => {
            const kind = Number(e.target.value);
            updateClip(clip.id, { fx: kind < 0 ? null : { kind, beats: clip.fx?.beats ?? 0.75 } });
            if (kind >= 0 && !hasMix) useAutoEdit.setState({ param: "FxMix" });
          }}
          aria-label="Effect"
        >
          <option value={-1}>None</option>
          {types.map((t, i) => (
            <option key={t} value={i}>
              {t}
            </option>
          ))}
        </select>
        {clip.fx && (
          <select className="input h-7 w-20" value={clip.fx.beats} onChange={(e) => updateClip(clip.id, { fx: { kind: clip.fx!.kind, beats: Number(e.target.value) } })} aria-label="Effect timing" title="How long each echo, gate or sweep lasts">
            {FX_TIMES.map((b) => (
              <option key={b} value={b}>
                {fxTime(b)}
              </option>
            ))}
          </select>
        )}
      </div>
      {clip.fx && !hasMix && <p className="pl-[72px] text-[11px] leading-snug text-amber-300/90">Draw “FX amount” below to bring the effect in. At zero you will not hear it.</p>}
    </div>
  );
}

export function TransitionSection({ clip, project }: { clip: Clip; project: MixProject }) {
  const out = mixesOutOf(project, clip);
  const templates = useTemplates((s) => s.list);
  const [choice, setChoice] = useState<string>("BassSwap");
  const overlap = out ? Math.max(0, out.start + out.length - clip.start) : 0;
  const [beats, setBeats] = useState<number | null>(null);
  const [name, setName] = useState("");
  if (!out) return null;
  const preset = TRANSITIONS.find((t) => t.kind === choice);
  const tpl = templates.find((t) => t.id === choice);
  const len = beats ?? (overlap > 0 ? Math.round(overlap) : (preset?.beats ?? tpl?.beats ?? 16));
  const outName = out.name || out.track.title;
  const apply = () => {
    try {
      const p = tpl ? applyTemplate(project, out.id, clip.id, tpl, len) : applyTransition(project, out.id, clip.id, choice as TransitionKind, len);
      setProject(p, undefined, undefined, `${tpl ? tpl.name : (preset?.name ?? "Transition")} into “${clip.name || clip.track.title}”`);
      setBeats(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Transition in</div>
      <p className="leading-snug text-zinc-500">
        From “{outName}”. {overlap > 0 ? `They play together for ${Math.round(overlap)} beats (${(overlap / 4).toFixed(overlap % 4 ? 1 : 0)} bars).` : "They do not overlap yet."}
      </p>
      <select
        className="input h-7"
        value={choice}
        onChange={(e) => {
          setChoice(e.target.value);
          setBeats(null);
        }}
        aria-label="Transition"
      >
        <optgroup label="Built in">
          {TRANSITIONS.map((t) => (
            <option key={t.kind} value={t.kind}>
              {t.name}
            </option>
          ))}
        </optgroup>
        {templates.length > 0 && (
          <optgroup label="Your templates">
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {preset && <p className="leading-snug text-zinc-500">{preset.explain}</p>}
      <div className="flex items-center gap-1.5">
        <span className="text-zinc-500">Length</span>
        <Segmented value={len} onChange={(v) => setBeats(v)} options={[...new Set([0, 4, 8, 16, 32, 64, Math.round(overlap)])].filter((b) => b <= 64).sort((a, b) => a - b).map((b) => ({ value: b, label: b === 0 ? "0" : String(b), title: `${b} beats` }))} />
      </div>
      <Btn size="sm" tone="accent" onClick={apply}>
        Apply transition
      </Btn>
      <div className="mt-1 flex items-center gap-1.5">
        <input className="input h-7 min-w-0 flex-1" placeholder="Name this transition" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" />
        <Btn
          size="sm"
          disabled={overlap <= 0 && !out.lanes.length}
          title="Saves the moves on both clips around this transition, so you can reuse them between any two tracks"
          onClick={() => {
            try {
              const t = captureTemplate(project, out.id, clip.id, name);
              useTemplates.getState().add(t);
              setChoice(t.id);
              setName("");
              toast.success(`Saved “${t.name}”`, { description: "Pick it from Your templates on any clip." });
            } catch (e) {
              toast.error(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Save
        </Btn>
      </div>
      {tpl && (
        <button type="button" className="self-start text-[11px] text-zinc-500 hover:text-red-300" onClick={() => (useTemplates.getState().remove(tpl.id), setChoice("BassSwap"))}>
          Delete “{tpl.name}”
        </button>
      )}
    </div>
  );
}
