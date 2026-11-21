// The sound editor: trim, cut, copy, paste, fade, turn up or down, normalise, reverse,
// silence and clean up a mic take, a pad's sound or part of a track, then save it to a
// pad or the library. Edits are a list of steps over the untouched original, so any
// step can be undone, or taken out later while keeping the ones after it.
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  AudioLines,
  ClipboardPaste,
  Copy,
  Crop,
  Eraser,
  FlipHorizontal2,
  Library as LibraryIcon,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../../backend";
import type { EditOp, FadeShape, PadSource, SoundView } from "../../backend/types";
import { afterStep, clipboardLength, FADE_SHAPES, groupSteps, lengthAfter, type Selection } from "../../lib/soundEdit";
import { LOUDNESS_TARGETS } from "../../lib/studio";
import { useApp } from "../../store/app";
import { Btn } from "../ui/Button";

// ------------------------------------------------------------------ state

interface SoundEditorState {
  source: PadSource | null;
  /** Pad the sound came from (saving can put it back there). */
  pad: number | null;
  id: number | null;
  name: string;
  ops: EditOp[];
  redo: EditOp[][];
  view: SoundView | null;
  busy: boolean;
  sel: Selection;
  cursor: number;
}

const empty: SoundEditorState = { source: null, pad: null, id: null, name: "", ops: [], redo: [], view: null, busy: false, sel: null, cursor: 0 };

export const useSoundEditor = create<SoundEditorState & { set: (p: Partial<SoundEditorState>) => void }>((set) => ({ ...empty, set: (p) => set(p) }));

const BINS = 4000;
let renderSeq = 0;

/** Opens the editor on a sound. `pad` is the pad it came from, if any. */
export async function openSoundEditor(source: PadSource, opts: { pad?: number | null; name?: string } = {}) {
  await closeSoundEditor();
  const s = useSoundEditor.getState();
  s.set({ ...empty, source, pad: opts.pad ?? null, busy: true, name: opts.name ?? "" });
  try {
    const o = await backend().soundOpen(source, BINS);
    useSoundEditor.getState().set({ id: o.id, view: o.view, name: opts.name || o.name, busy: false });
  } catch (e) {
    useSoundEditor.getState().set({ ...empty });
    toast.error(`Could not open the sound: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function closeSoundEditor() {
  stopPlayback();
  const { id } = useSoundEditor.getState();
  useSoundEditor.getState().set({ ...empty });
  if (id != null) await backend().soundClose(id).catch(() => undefined);
}

/** Re-renders the drawing after the steps change. */
async function refresh(ops: EditOp[]) {
  const { id } = useSoundEditor.getState();
  if (id == null) return;
  const my = ++renderSeq;
  useSoundEditor.getState().set({ busy: true });
  try {
    const view = await backend().soundRender(id, ops, BINS);
    if (my === renderSeq) useSoundEditor.getState().set({ view, busy: false });
  } catch (e) {
    if (my === renderSeq) useSoundEditor.getState().set({ busy: false });
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** Adds steps (one action), moving the selection the way the last step leaves it. */
function push(...steps: EditOp[]) {
  const s = useSoundEditor.getState();
  if (!s.view) return;
  let clip = clipboardLength(s.ops);
  let sel = s.sel;
  let cursor = s.cursor;
  let len = s.view.seconds;
  for (const st of steps) {
    len = lengthAfter(st, len, clip);
    ({ sel, cursor } = afterStep(st, sel, cursor, clip));
    if (st.op === "copy") clip = Math.abs(st.end - st.start);
  }
  const ops = [...s.ops, ...steps];
  s.set({ ops, redo: [], sel, cursor: Math.min(cursor, len), view: { ...s.view, seconds: len } });
  stopPlayback();
  void refresh(ops);
}

function undo() {
  const s = useSoundEditor.getState();
  const groups = groupSteps(s.ops);
  const last = groups[groups.length - 1];
  if (!last) return;
  const ops = s.ops.slice(0, last.from);
  s.set({ ops, redo: [...s.redo, s.ops.slice(last.from)], sel: null });
  stopPlayback();
  void refresh(ops);
}

function redo() {
  const s = useSoundEditor.getState();
  const next = s.redo[s.redo.length - 1];
  if (!next) return;
  const ops = [...s.ops, ...next];
  s.set({ ops, redo: s.redo.slice(0, -1), sel: null });
  stopPlayback();
  void refresh(ops);
}

/** Takes one step out, keeping the ones after it. */
function removeStep(from: number, to: number) {
  const s = useSoundEditor.getState();
  const ops = [...s.ops.slice(0, from), ...s.ops.slice(to + 1)];
  s.set({ ops, redo: [], sel: null });
  stopPlayback();
  void refresh(ops);
}

// ------------------------------------------------------------------ playback

const usePlay = create<{ playing: boolean; pos: number; loop: boolean }>(() => ({ playing: false, pos: 0, loop: false }));
let player: HTMLAudioElement | null = null;
let playerKey = "";
let playerUrl: string | null = null;
let raf = 0;

function stopPlayback() {
  player?.pause();
  cancelAnimationFrame(raf);
  usePlay.setState({ playing: false });
}

async function play(from: number, to: number | null) {
  const s = useSoundEditor.getState();
  if (s.id == null) return;
  stopPlayback();
  const key = `${s.id}:${JSON.stringify(s.ops)}`;
  if (key !== playerKey || !player) {
    try {
      const wav = await backend().soundAudio(s.id, s.ops);
      if (playerUrl) URL.revokeObjectURL(playerUrl);
      playerUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
      player = new Audio(playerUrl);
      playerKey = key;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
  }
  const a = player;
  a.currentTime = from;
  await a.play().catch(() => undefined);
  usePlay.setState({ playing: true, pos: from });
  const tick = () => {
    const end = to ?? a.duration;
    if (a.currentTime >= end - 0.005 || a.ended) {
      if (usePlay.getState().loop && to != null) {
        a.currentTime = from;
      } else {
        stopPlayback();
        usePlay.setState({ pos: to ?? 0 });
        return;
      }
    }
    usePlay.setState({ pos: a.currentTime });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function togglePlay() {
  if (usePlay.getState().playing) return stopPlayback();
  const { sel, cursor } = useSoundEditor.getState();
  if (sel && sel.end - sel.start > 0.01) void play(sel.start, sel.end);
  else void play(cursor, null);
}

// ------------------------------------------------------------------ actions

/** The selection, or the whole sound when nothing is selected. */
function target(): { start: number; end: number } | null {
  const s = useSoundEditor.getState();
  if (!s.view) return null;
  return s.sel && s.sel.end - s.sel.start > 0.0005 ? s.sel : { start: 0, end: s.view.seconds };
}

const hasSel = () => {
  const s = useSoundEditor.getState().sel;
  return !!s && s.end - s.start > 0.0005;
};

const act = {
  trim: () => hasSel() && push({ op: "trim", ...target()! }),
  cut: () => hasSel() && push({ op: "copy", ...target()! }, { op: "delete", ...target()! }),
  copy: () => {
    if (!hasSel()) return;
    push({ op: "copy", ...target()! });
    toast.message("Copied. Click where it should go and press Paste.");
  },
  paste: () => {
    const s = useSoundEditor.getState();
    if (clipboardLength(s.ops) <= 0) return toast.message("Copy or cut a passage first.");
    push({ op: "paste", at: s.sel ? s.sel.start : s.cursor });
  },
  delete: () => hasSel() && push({ op: "delete", ...target()! }),
  silence: () => hasSel() && push({ op: "silence", ...target()! }),
  reverse: () => push({ op: "reverse", ...target()! }),
  fade: (fadeIn: boolean, shape: FadeShape) => {
    const s = useSoundEditor.getState();
    if (!s.view) return;
    // With no selection: the first or last second (or a quarter of a short sound).
    const len = s.view.seconds;
    const d = Math.min(1, len / 4);
    const r = hasSel() ? target()! : fadeIn ? { start: 0, end: d } : { start: len - d, end: len };
    push({ op: "fade", ...r, fadeIn, shape });
  },
  gain: (db: number) => push({ op: "gain", ...target()!, db }),
  normalize: (to: "peak" | "loudness", level: number) => push({ op: "normalize", to, level }),
  cleanUp: () => push({ op: "removeDc" }, { op: "trimSilence", thresholdDb: -48 }),
  insertSilence: (seconds: number) => {
    const s = useSoundEditor.getState();
    push({ op: "insertSilence", at: s.sel ? s.sel.start : s.cursor, seconds });
  },
};

// ------------------------------------------------------------------ the dialog

export function SoundEditor() {
  const open = useSoundEditor((s) => s.source !== null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let done = true;
      if (k === " ") togglePlay();
      else if (mod && k === "z" && !e.shiftKey) undo();
      else if (mod && (k === "y" || (k === "z" && e.shiftKey))) redo();
      else if (mod && k === "x") act.cut();
      else if (mod && k === "c") act.copy();
      else if (mod && k === "v") act.paste();
      else if (mod && k === "a") {
        const v = useSoundEditor.getState().view;
        if (v) useSoundEditor.getState().set({ sel: { start: 0, end: v.seconds } });
      } else if (k === "delete" || k === "backspace") act.delete();
      else if (k === "escape" && hasSel()) useSoundEditor.getState().set({ sel: null });
      else done = false;
      if (done) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && void closeSoundEditor()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(1100px,96vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl"
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => hasSel() && e.preventDefault()}
        >
          {open && <Body />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body() {
  const name = useSoundEditor((s) => s.name);
  const view = useSoundEditor((s) => s.view);
  const busy = useSoundEditor((s) => s.busy);
  const ops = useSoundEditor((s) => s.ops);
  const redoN = useSoundEditor((s) => s.redo.length);
  const sel = useSoundEditor((s) => s.sel);
  const playing = usePlay((s) => s.playing);
  const loop = usePlay((s) => s.loop);
  const steps = groupSteps(ops);
  const selected = !!sel && sel.end - sel.start > 0.0005;
  const [shape, setShape] = useState<FadeShape>("smooth");
  return (
    <>
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <AudioLines size={16} className="text-sky-400" />
        <Dialog.Title className="text-base font-semibold text-zinc-50">Edit sound</Dialog.Title>
        <input className="input h-7 w-72 text-sm" value={name} onChange={(e) => useSoundEditor.getState().set({ name: e.target.value })} aria-label="Name" />
        {busy && <Loader2 size={14} className="animate-spin text-zinc-500" />}
        <Dialog.Close className="ml-auto rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
          <X size={16} />
        </Dialog.Close>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto p-5">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Btn size="sm" tone="accent" style={{ ["--accent" as string]: "#38bdf8" }} onClick={togglePlay} title="Play (Space). Plays the selection when there is one.">
              {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? "Stop" : selected ? "Play selection" : "Play"}
            </Btn>
            <Btn size="sm" active={loop} onClick={() => usePlay.setState({ loop: !loop })} title="Repeat the selection while playing">
              <Repeat size={12} />
            </Btn>
            <Sep />
            <Tool icon={<Crop size={12} />} label="Keep selection" hint="Keeps only the selected part" disabled={!selected} onClick={act.trim} />
            <Tool icon={<Scissors size={12} />} label="Cut" hint="Removes the selection and keeps it for pasting (Ctrl+X)" disabled={!selected} onClick={act.cut} />
            <Tool icon={<Copy size={12} />} label="Copy" hint="Keeps a copy of the selection for pasting (Ctrl+C)" disabled={!selected} onClick={act.copy} />
            <Tool icon={<ClipboardPaste size={12} />} label="Paste" hint="Inserts what you cut or copied at the cursor (Ctrl+V)" disabled={clipboardLength(ops) <= 0} onClick={act.paste} />
            <Tool icon={<Trash2 size={12} />} label="Delete" hint="Removes the selection; the rest closes up (Delete)" disabled={!selected} onClick={act.delete} />
            <Tool icon={<VolumeX size={12} />} label="Silence" hint="Makes the selection silent, keeping the length" disabled={!selected} onClick={act.silence} />
            <Sep />
            <Tool icon={<ArrowRightToLine size={12} />} label="Fade in" hint="Rises from silence over the selection (or the first second)" onClick={() => act.fade(true, shape)} />
            <Tool icon={<ArrowLeftToLine size={12} />} label="Fade out" hint="Falls to silence over the selection (or the last second)" onClick={() => act.fade(false, shape)} />
            <select value={shape} onChange={(e) => setShape(e.target.value as FadeShape)} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-300 outline-none" title={FADE_SHAPES.find((s) => s.value === shape)?.hint} aria-label="Fade shape">
              {FADE_SHAPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <Sep />
            <GainTool selected={selected} />
            <NormalizeTool />
            <Tool icon={<FlipHorizontal2 size={12} />} label="Reverse" hint="Plays the selection (or the whole sound) backwards" onClick={act.reverse} />
            <InsertSilenceTool />
            <Tool icon={<Sparkles size={12} />} label="Clean up" hint="Cuts the silence at the start and end and centres the waveform: a quick fix for mic takes" onClick={act.cleanUp} />
          </div>
          <Wave />
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
            <span>Drag to select · click to place the cursor · Shift+click to extend · Ctrl+scroll to zoom</span>
            {view && (
              <span className="ml-auto font-mono text-zinc-400">
                {view.seconds.toFixed(2)} s · peak {view.peakDb <= -98 ? "–" : `${view.peakDb.toFixed(1)} dB`} · {view.lufs <= -98 ? "too short to measure loudness" : `${view.lufs.toFixed(1)} LUFS`}
              </span>
            )}
          </div>
        </div>
        <aside className="flex w-64 shrink-0 flex-col gap-3">
          <div className="flex items-center gap-1">
            <div className="flex-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Steps</div>
            <Btn size="sm" tone="ghost" disabled={!steps.length} onClick={undo} aria-label="Undo" title="Undo (Ctrl+Z)">
              <Undo2 size={12} />
            </Btn>
            <Btn size="sm" tone="ghost" disabled={!redoN} onClick={redo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
              <Redo2 size={12} />
            </Btn>
          </div>
          <div className="flex min-h-24 flex-col gap-0.5 rounded-lg bg-black/20 p-1.5 text-[11px]">
            {steps.length === 0 ? (
              <div className="p-2 leading-snug text-zinc-500">Nothing changed yet. Every edit is listed here; the original is never touched, so you can take out any step later.</div>
            ) : (
              steps.map((st, i) => (
                <div key={i} className="group flex items-start gap-1.5 rounded px-1.5 py-1 hover:bg-white/5">
                  <span className="w-4 shrink-0 text-right font-mono text-zinc-600">{i + 1}</span>
                  <span className="flex-1 leading-snug text-zinc-300">{st.label}</span>
                  <button type="button" className="text-zinc-600 opacity-0 hover:text-zinc-200 group-hover:opacity-100" onClick={() => removeStep(st.from, st.to)} aria-label={`Take out step ${i + 1}`} title="Take out this step (the later ones stay)">
                    <X size={11} />
                  </button>
                </div>
              ))
            )}
          </div>
          {steps.length > 0 && (
            <button type="button" className="self-start text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => removeStep(0, ops.length - 1)}>
              Start over from the original
            </button>
          )}
          <SaveSection />
        </aside>
      </div>
    </>
  );
}

function Sep() {
  return <div className="mx-0.5 h-5 w-px bg-white/10" />;
}

function Tool({ icon, label, hint, disabled, onClick }: { icon: ReactNode; label: string; hint: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Btn size="sm" disabled={disabled} onClick={onClick} title={hint}>
      {icon} {label}
    </Btn>
  );
}

function GainTool({ selected }: { selected: boolean }) {
  const [db, setDb] = useState(-3);
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Btn size="sm" active={open} title="Turns the selection (or the whole sound) up or down">
          <Volume2 size={12} /> Volume
        </Btn>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="z-[60] flex w-64 flex-col gap-2 rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur">
          <div className="text-zinc-300">{selected ? "Turn the selection" : "Turn the whole sound"} {db >= 0 ? "up" : "down"} by</div>
          <div className="flex items-center gap-2">
            <input type="range" min={-24} max={12} step={0.5} value={db} onChange={(e) => setDb(Number(e.target.value))} className="flex-1 accent-sky-400" />
            <span className="w-14 text-right font-mono text-zinc-200">
              {db > 0 ? "+" : ""}
              {db.toFixed(1)} dB
            </span>
          </div>
          <div className="text-zinc-500">−6 dB is about half as loud to the ear; +6 dB twice.</div>
          <Btn
            tone="accent"
            style={{ ["--accent" as string]: "#38bdf8" }}
            disabled={db === 0}
            onClick={() => {
              act.gain(db);
              setOpen(false);
            }}
          >
            Apply
          </Btn>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NormalizeTool() {
  const [open, setOpen] = useState(false);
  const pick = (to: "peak" | "loudness", level: number) => {
    act.normalize(to, level);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Btn size="sm" active={open} title="Sets the level of the whole sound">
          <Plus size={12} /> Normalise
        </Btn>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="z-[60] flex w-72 flex-col gap-1 rounded-xl border border-white/10 bg-zinc-900/95 p-1.5 text-xs shadow-2xl backdrop-blur">
          <button type="button" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.07]" onClick={() => pick("peak", -1)}>
            <div className="font-medium text-zinc-100">As loud as it can go</div>
            <div className="text-zinc-500">The loudest point at −1 dB. Best for pads and one-shots.</div>
          </button>
          {LOUDNESS_TARGETS.map((t) => (
            <button key={t.id} type="button" className="rounded-lg px-2.5 py-1.5 text-left hover:bg-white/[0.07]" onClick={() => pick("loudness", t.lufs)}>
              <div className="font-medium text-zinc-100">
                {t.name} ({t.lufs} LUFS)
              </div>
              <div className="text-zinc-500">Matches the loudness of other sounds at this level; never past −1 dB peak.</div>
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function InsertSilenceTool() {
  const [open, setOpen] = useState(false);
  const [secs, setSecs] = useState(0.5);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Btn size="sm" active={open} title="Adds a gap of silence at the cursor">
          <Minus size={12} /> Add gap
        </Btn>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="z-[60] flex w-56 flex-col gap-2 rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur">
          <div className="text-zinc-300">Silence to add at the cursor</div>
          <div className="flex items-center gap-2">
            <input type="number" min={0.01} max={60} step={0.1} value={secs} onChange={(e) => setSecs(Number(e.target.value))} className="input h-7 w-20 font-mono" />
            <span className="text-zinc-500">seconds</span>
          </div>
          <Btn
            tone="accent"
            style={{ ["--accent" as string]: "#38bdf8" }}
            disabled={!(secs > 0)}
            onClick={() => {
              act.insertSilence(Math.min(60, secs));
              setOpen(false);
            }}
          >
            Add
          </Btn>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SaveSection() {
  const pad = useSoundEditor((s) => s.pad);
  const pads = useApp((s) => s.pads);
  const [target, setTarget] = useState<number>(pad ?? Math.max(0, pads.findIndex((p) => p.source.type === "empty")));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (pad != null) setTarget(pad);
  }, [pad]);
  const save = async (where: "pad" | "library") => {
    const s = useSoundEditor.getState();
    if (s.id == null) return;
    setSaving(true);
    try {
      const path = await backend().soundSave(s.id, s.ops, s.name || "Edited sound");
      if (where === "pad") {
        const { loadPad } = await import("../sampler/SamplerPanel");
        const info = await loadPad(target, { type: "file", path });
        if (info) toast.success(`Saved and put on pad ${target + 1}.`);
      } else {
        await backend().addToLibrary([path]);
        toast.success("Saved. It is being added to the library.", { description: path });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-auto flex flex-col gap-2 border-t border-white/[0.06] pt-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Save</div>
      <div className="flex items-center gap-1.5">
        <select value={target} onChange={(e) => setTarget(Number(e.target.value))} className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Pad">
          {pads.map((p, i) => (
            <option key={i} value={i}>
              Pad {i + 1}
              {p.source.type === "empty" ? " (empty)" : `: ${p.name}`}
            </option>
          ))}
        </select>
        <Btn size="sm" tone="accent" style={{ ["--accent" as string]: "#38bdf8" }} disabled={saving} onClick={() => save("pad")}>
          {pad === target ? "Replace pad" : "Put on pad"}
        </Btn>
      </div>
      <Btn size="sm" disabled={saving} onClick={() => save("library")}>
        <LibraryIcon size={12} /> Save to the library
      </Btn>
      <div className="text-[11px] leading-snug text-zinc-500">Saving makes a new file; the original sound is kept as it was.</div>
      <button type="button" className="flex items-center gap-1 self-start text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => useSoundEditor.getState().set({ sel: null, cursor: 0 })}>
        <Eraser size={11} /> Clear the selection
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ waveform

function Wave() {
  const view = useSoundEditor((s) => s.view);
  const sel = useSoundEditor((s) => s.sel);
  const cursor = useSoundEditor((s) => s.cursor);
  const pos = usePlay((s) => s.pos);
  const playing = usePlay((s) => s.playing);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  // Visible window (seconds); null shows everything.
  const [win, setWin] = useState<[number, number] | null>(null);
  const H = 220;
  const len = view?.seconds ?? 1;
  const [v0, v1] = win ?? [0, len];
  const xOf = useCallback((t: number) => ((t - v0) / Math.max(1e-6, v1 - v0)) * width, [v0, v1, width]);
  const tOf = useCallback((x: number) => Math.max(0, Math.min(len, v0 + (x / width) * (v1 - v0))), [v0, v1, width, len]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (win && win[1] > len) setWin(null);
  }, [len, win]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !view) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, H);
    const mid = H / 2;
    // Time grid.
    const span = v1 - v0;
    const step = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => span / s <= 12) ?? 120;
    g.font = "10px ui-sans-serif, system-ui";
    for (let t = Math.ceil(v0 / step) * step; t <= v1; t += step) {
      const x = xOf(t);
      g.fillStyle = "rgba(255,255,255,0.05)";
      g.fillRect(Math.round(x), 0, 1, H);
      g.fillStyle = "rgba(255,255,255,0.3)";
      g.fillText(step < 1 ? `${t.toFixed(2)}s` : `${Math.round(t)}s`, x + 3, 11);
    }
    g.fillStyle = "rgba(255,255,255,0.12)";
    g.fillRect(0, mid, width, 1);
    // Peaks: each bin covers len / bins seconds.
    const p = view.peaks;
    const binS = len / Math.max(1, p.length);
    g.fillStyle = "#38bdf8";
    for (let x = 0; x < width; x++) {
      const a = Math.floor(tOf(x) / binS);
      const b = Math.max(a + 1, Math.floor(tOf(x + 1) / binS));
      let lo = 0;
      let hi = 0;
      for (let i = a; i < Math.min(b, p.length); i++) {
        lo = Math.min(lo, p[i][0]);
        hi = Math.max(hi, p[i][1]);
      }
      if (hi > lo) g.fillRect(x, mid - hi * (mid - 6), 1, Math.max(1, (hi - lo) * (mid - 6)));
    }
  }, [view, width, v0, v1, xOf, tOf, len]);

  const drag = useRef<{ t0: number } | null>(null);
  const tAt = (e: React.PointerEvent | React.WheelEvent) => tOf(e.clientX - canvas.current!.getBoundingClientRect().left);

  if (!view) return <div className="flex h-[220px] items-center justify-center rounded-lg bg-black/40 text-xs text-zinc-500"><Loader2 size={14} className="mr-2 animate-spin" /> Opening the sound…</div>;
  return (
    <div ref={wrap} className="relative select-none">
      <canvas
        ref={canvas}
        className="block w-full cursor-text rounded-lg bg-black/40"
        style={{ height: H }}
        aria-label="Waveform"
        onPointerDown={(e) => {
          const t = tAt(e);
          const s = useSoundEditor.getState();
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          if (e.shiftKey) {
            const anchor = s.sel ? (Math.abs(t - s.sel.start) < Math.abs(t - s.sel.end) ? s.sel.end : s.sel.start) : s.cursor;
            drag.current = { t0: anchor };
            s.set({ sel: { start: Math.min(anchor, t), end: Math.max(anchor, t) } });
          } else {
            drag.current = { t0: t };
            s.set({ sel: null, cursor: t });
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const t = tAt(e);
          useSoundEditor.getState().set({ sel: Math.abs(t - d.t0) * (width / (v1 - v0)) < 3 ? null : { start: Math.min(d.t0, t), end: Math.max(d.t0, t) } });
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            const t = tAt(e);
            const f = e.deltaY < 0 ? 0.8 : 1.25;
            const span = Math.max(0.02, Math.min(len, (v1 - v0) * f));
            let a = t - (t - v0) * (span / (v1 - v0));
            a = Math.max(0, Math.min(len - span, a));
            setWin(span >= len - 1e-6 ? null : [a, a + span]);
          } else if (win) {
            const shift = ((e.deltaX || e.deltaY) / width) * (v1 - v0);
            const a = Math.max(0, Math.min(len - (v1 - v0), v0 + shift));
            setWin([a, a + (v1 - v0)]);
          }
        }}
      />
      {sel && sel.end > sel.start && (
        <div className="pointer-events-none absolute top-0 rounded bg-sky-400/20 ring-1 ring-sky-300/50" style={{ left: xOf(sel.start), width: Math.max(1, xOf(sel.end) - xOf(sel.start)), height: H }}>
          <span className="absolute bottom-1 left-1 rounded bg-zinc-950/80 px-1 font-mono text-[10px] text-sky-200">{(sel.end - sel.start).toFixed(2)} s</span>
        </div>
      )}
      <div className="pointer-events-none absolute top-0 w-px bg-amber-300" style={{ left: xOf(cursor), height: H }} />
      {playing && <div className="pointer-events-none absolute top-0 w-px bg-white" style={{ left: xOf(pos), height: H }} />}
      <div className="absolute right-2 top-2 flex gap-1">
        <Btn size="sm" tone="ghost" onClick={() => setWin(null)} disabled={!win} title="Show the whole sound">
          Fit
        </Btn>
        <Btn
          size="sm"
          tone="ghost"
          disabled={!sel}
          onClick={() => sel && setWin([Math.max(0, sel.start - (sel.end - sel.start) * 0.1), Math.min(len, sel.end + (sel.end - sel.start) * 0.1)])}
          title="Zoom to the selection"
        >
          Zoom to selection
        </Btn>
      </div>
    </div>
  );
}
