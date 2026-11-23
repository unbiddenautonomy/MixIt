// Arrange: a mix on a timeline. Clips sit on four deck lanes over a tempo ruler; move
// and trim them on the bar grid, edit gain, key and automation, then render the mix.
import clsx from "clsx";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ClipboardPaste, Copy, CopyPlus, Flag, FolderOpen, Layers, Loader2, Minus, Music, Play, Plus, Repeat, Rewind, Save, Scissors, SlidersVertical, Sparkles, Square, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { backend } from "../../backend";
import type { AutomationLane, AutomationPoint, Clip, CurveShape, MixProject, ProjectParam, TrackRow } from "../../backend/types";
import { bpm as fmtBpm, clock } from "../../lib/format";
import { useApp } from "../../store/app";
import { Btn } from "../ui/Button";
import { DECK_COLORS } from "../deck/useWaveform";
import { useDropTarget } from "../../lib/dnd";
import { rowsById } from "../library/data";
import { playPreview, stopPreview, usePreview } from "./preview";
import { AutomationEditor, PARAM_COLORS, PARAM_DEFAULT, PARAM_LABEL, PARAM_RANGE, setLane, setLaneCurve, useAutoEdit } from "./AutomationEditor";
import { beatAfter, beatToSeconds, bpmAt, closeProject, emptyProject, openProject, projectBeats, renderProject, renderStems, saveProject, setProject, updateClip } from "./projectIo";
import { LOUDNESS_TARGETS } from "../../lib/studio";
import { MASTER_STRIP, openLaneStudio, useStudio } from "../../store/studio";
import { EffectRow, HistoryButtons, IssuesButton, KeyRow, SnapPicker, TempoLane, TempoPanel, TransitionSection, useArrangeUi } from "./ArrangeParts";
import { fadeOf, laneHeard, moveClips, setLaneState, moveMarker, PHRASE_BEATS, removeMarker, renameMarker, rippleDelete, setFade, snapClipStart, toProjectKey } from "../../lib/arrangeOps";
import { addMarkerAtCursor, copySelection, cutSelection, deleteSelection, duplicateSelection, paste, select, selectBox, splitAt, toggleLoop, togglePlay } from "./editing";
import { shortcutLabel } from "../../lib/actions";

const LANE_H = 76;

export function clipFromTrack(t: TrackRow, id: number, lane: number, start: number): Clip {
  const bpm = t.bpm ?? 120;
  return {
    id,
    track: { hash: null, path: t.path, title: t.title, artist: t.artist, bpm, key: toProjectKey(t.key), duration: t.duration },
    lane,
    start,
    length: Math.max(4, Math.floor((t.duration * bpm) / 60 / 4) * 4),
    source_start: 0,
    key_shift: 0,
    keylock: true,
    gain_db: 0,
    lanes: [],
    fx: null,
    name: t.title,
  };
}

export function Arrange() {
  const project = useApp((s) => s.project);
  const path = useApp((s) => s.projectPath);
  const dirty = useApp((s) => s.projectDirty);
  const job = useApp((s) => s.jobs.render);
  const [zoom, setZoom] = useState<number | null>(null); // pixels per beat; null fits the mix
  const selected = useArrangeUi((s) => s.selected);
  const sel = selected.length ? selected[selected.length - 1] : null;
  const tempoSel = useArrangeUi((s) => s.tempoSel);
  const setSel = (id: number | null) => select(id == null ? [] : [id]);
  const [show, setShow] = useState<ProjectParam[]>(["Volume", "EqLow"]);
  const [width, setWidth] = useState(1200);
  const area = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** Where to scroll once the new zoom is drawn (a beat at the left edge, or one to keep under a point). */
  const pendingScroll = useRef<{ beat: number; x: number } | null>(null);
  useEffect(() => {
    const s = pendingScroll.current;
    const el = scroller.current;
    if (!s || !el || zoom == null) return;
    pendingScroll.current = null;
    el.scrollLeft = Math.max(0, 80 + s.beat * zoom - s.x);
  }, [zoom]);
  useEffect(() => () => stopPreview(), []);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [project != null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return <EmptyArrange />;
  const fit = Math.max(0.08, Math.min(40, (width - 110) / Math.max(16, projectBeats(project) + 8)));
  const ppb = zoom ?? fit;
  const setPpb = (f: (p: number) => number) => setZoom(f(ppb));
  /** Zooms keeping `beat` at `x` pixels from the timeline's left edge. */
  const zoomAround = (next: number, beat: number, x: number) => {
    pendingScroll.current = { beat, x };
    setZoom(Math.max(0.08, Math.min(40, next)));
  };
  const zoomToSelection = () => {
    const sel = project.clips.filter((c) => selected.includes(c.id));
    if (!sel.length) return;
    const from = Math.min(...sel.map((c) => c.start));
    const to = Math.max(...sel.map((c) => c.start + c.length));
    const visible = (scroller.current?.clientWidth ?? width) - 100;
    zoomAround(visible / Math.max(8, to - from + 8), Math.max(0, from - 4), 80);
  };
  const beats = Math.max(64, projectBeats(project) + 32);
  const total = beatToSeconds(project, projectBeats(project));
  const clip = project.clips.find((c) => c.id === sel) ?? null;
  const many = selected.filter((id) => project.clips.some((c) => c.id === id));
  const rendering = job && !job.finished;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Two rows: the project and what you do with it, then the editing tools. */}
      <div className="flex flex-col gap-2 rounded-2xl border border-white/[0.06] bg-zinc-900/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <input className="input h-8 w-56 text-sm font-semibold" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value }, undefined, "name")} aria-label="Mix name" />
          <span className="font-mono text-xs text-zinc-400">
            {project.clips.length} clips · {clock(total)} · {fmtBpm(bpmAt(project, 0))}
            {project.tempo.segments.length > 1 && ` → ${fmtBpm(project.tempo.segments[project.tempo.segments.length - 1].bpm)}`} BPM
          </span>
          {path && <span className="max-w-64 truncate text-[11px] text-zinc-600">{path}</span>}
          <IssuesButton project={project} select={setSel} />
          {dirty && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300" title="Save with the Save button or Ctrl/⌘+S">
              Not saved
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <PlayButton project={project} />
            <Btn size="sm" onClick={() => openLaneStudio(MASTER_STRIP)} title="EQ, glue and loudness for the whole mix, and its reverb and echo">
              <SlidersVertical size={12} /> Mix studio
            </Btn>
            <Btn size="sm" onClick={() => useApp.getState().set({ automixOpen: true })}>
              <Wand2 size={12} /> Automix
            </Btn>
            <div className="h-5 w-px bg-white/10" />
            <Btn size="sm" tone="ghost" onClick={openProject}>
              <FolderOpen size={12} /> Open
            </Btn>
            <Btn size="sm" tone="ghost" onClick={() => saveProject(false)}>
              <Save size={12} /> Save
            </Btn>
            {rendering ? (
              <Btn size="sm" tone="danger" onClick={() => backend().cancelJob()}>
                <Loader2 size={12} className="animate-spin" /> {job.total ? Math.round((job.done / job.total) * 100) : 0}% · Stop
              </Btn>
            ) : (
              <ExportMenu />
            )}
            <Btn size="sm" tone="ghost" onClick={closeProject} aria-label="Close project" title="Close this mix">
              <X size={12} />
            </Btn>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
          <HistoryButtons />
          <div className="h-5 w-px bg-white/10" />
          <EditTools count={many.length} />
          <div className="h-5 w-px bg-white/10" />
          <SnapPicker />
          <div className="h-5 w-px bg-white/10" />
          <ShowMenu show={show} setShow={setShow} />
          <div className="ml-auto flex items-center gap-1">
            <Btn size="sm" tone="ghost" onClick={() => setPpb((p) => Math.max(0.08, p / 1.5))} aria-label="Zoom out" title="Zoom out">
              <Minus size={12} />
            </Btn>
            <Btn size="sm" tone="ghost" onClick={() => setPpb((p) => Math.min(40, p * 1.5))} aria-label="Zoom in" title="Zoom in">
              <Plus size={12} />
            </Btn>
            <Btn size="sm" tone="ghost" active={zoom == null} onClick={() => setZoom(null)} title="Show the whole mix">
              Fit
            </Btn>
            <Btn size="sm" tone="ghost" disabled={!many.length} onClick={zoomToSelection} title="Zoom in on the selected clips">
              Selection
            </Btn>
          </div>
        </div>
      </div>
      <div ref={area} className="flex min-h-0 flex-1 gap-2">
        <Timeline project={project} ppb={ppb} beats={beats} selected={selected} show={show} scroller={scroller} zoomAround={zoomAround} />
        {tempoSel != null && project.tempo.segments[tempoSel] ? (
          <TempoPanel project={project} index={tempoSel} />
        ) : many.length > 1 ? (
          <MultiPanel ids={many} project={project} />
        ) : (
          clip && <ClipPanel clip={clip} project={project} close={() => setSel(null)} />
        )}
      </div>
    </div>
  );
}

/** Which automation lines to draw on the clips, in one menu instead of eight toggles. */
function ShowMenu({ show, setShow }: { show: ProjectParam[]; setShow: (s: ProjectParam[]) => void }) {
  const params = Object.keys(PARAM_COLORS) as ProjectParam[];
  const name = (p: ProjectParam) => (p === "FxMix" ? "FX" : p.replace("Eq", "EQ "));
  const summary = show.length === 0 ? "none" : show.length <= 2 ? show.map(name).join(", ") : `${show.length} lines`;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Btn size="sm" tone="ghost" title="Which automation lines to draw on the clips" data-testid="arrange-show">
          <span className="text-zinc-400">Show</span> {summary}
          <ChevronDown size={11} className="text-zinc-500" />
        </Btn>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="menu">
          {params.map((p) => (
            <DropdownMenu.CheckboxItem
              key={p}
              className="menu-item"
              checked={show.includes(p)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setShow(on ? [...show, p] : show.filter((x) => x !== p))}
            >
              <span className="inline-block size-2 rounded-full" style={{ background: PARAM_COLORS[p] }} />
              <span className="flex-1">{name(p)}</span>
              {show.includes(p) && <Check size={12} className="text-zinc-300" />}
            </DropdownMenu.CheckboxItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function EmptyArrange() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/10 text-center">
      <Sparkles size={28} className="text-sky-300" />
      <div>
        <div className="text-lg font-semibold text-zinc-100">Build a mix on a timeline</div>
        <p className="mt-1 max-w-md text-sm text-zinc-400">Let Automix plan a whole set from a playlist, or start empty and drag tracks from the library onto the lanes. Then render it to a WAV or FLAC file.</p>
      </div>
      <div className="flex gap-2">
        <Btn tone="accent" style={{ ["--accent" as string]: "#38bdf8" }} onClick={() => useApp.getState().set({ automixOpen: true })}>
          <Wand2 size={13} /> Automix
        </Btn>
        <Btn onClick={() => setProject(emptyProject(), null)}>New empty mix</Btn>
        <Btn onClick={openProject}>
          <FolderOpen size={13} /> Open…
        </Btn>
      </div>
    </div>
  );
}

function Timeline({
  project,
  ppb,
  beats,
  selected,
  show,
  scroller,
  zoomAround,
}: {
  project: MixProject;
  ppb: number;
  beats: number;
  selected: number[];
  show: ProjectParam[];
  scroller: React.RefObject<HTMLDivElement | null>;
  zoomAround: (ppb: number, beat: number, x: number) => void;
}) {
  const width = beats * ppb;
  const inner = useRef<HTMLDivElement>(null);
  // Ctrl/⌘ + wheel (or a trackpad pinch) zooms around the pointer. A native listener,
  // because React's wheel listeners cannot stop the page from zooming.
  const zoomRef = useRef({ ppb, zoomAround });
  zoomRef.current = { ppb, zoomAround };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const { ppb: p, zoomAround: z } = zoomRef.current;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      z(p * Math.exp(-e.deltaY * 0.0025), Math.max(0, (el.scrollLeft + x - 80) / p), x);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [scroller]);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const loop = useArrangeUi((s) => s.loop);
  const looping = useArrangeUi((s) => s.looping);
  // Label every N bars, N a power of two that keeps labels at least ~56 px apart.
  const barEvery = [1, 2, 4, 8, 16, 32, 64, 128, 256].find((n) => n * 4 * ppb >= 56) ?? 512;
  const gridBeats = Math.max(4, barEvery);
  const lanes = 4;
  const selSet = new Set(selected);

  const addTracks = async (ids: number[], lane: number, x: number) => {
    const rows = await rowsById(ids);
    let start = Math.max(0, Math.round(x / ppb / 4) * 4);
    let p = useApp.getState().project ?? project;
    let next = p.next_id;
    const clips = [...p.clips];
    const made: number[] = [];
    for (const r of rows) {
      const c = clipFromTrack(r, next++, lane, start);
      clips.push(c);
      made.push(c.id);
      start += c.length;
    }
    p = { ...p, clips, next_id: next };
    setProject(p, undefined, undefined, rows.length === 1 ? `Add “${rows[0].title}”` : `Add ${rows.length} tracks`);
    select(made);
  };

  /** Timeline beat and lane under a point on screen. */
  const at = (clientX: number, clientY: number) => {
    const lr = lanesRef.current!.getBoundingClientRect();
    return { beat: Math.max(0, (clientX - lr.left - 80) / ppb), lane: Math.max(0, Math.min(lanes - 1, Math.floor((clientY - lr.top) / LANE_H))) };
  };

  /** On an empty part of a lane: a click moves the play marker there, a drag selects clips in a box. */
  const startBox = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const ir = inner.current!.getBoundingClientRect();
    const x0 = e.clientX - ir.left;
    const y0 = e.clientY - ir.top;
    const from = at(e.clientX, e.clientY);
    const additive = e.ctrlKey || e.metaKey;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const r = inner.current!.getBoundingClientRect();
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      setBox({ x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top });
      const to = at(ev.clientX, ev.clientY);
      selectBox(from.beat, to.beat, from.lane, to.lane, additive);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBox(null);
      if (!moved) {
        if (!additive) select([]);
        usePreview.getState().set({ cursor: Math.round(from.beat / 4) * 4 });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={scroller}
      className="screen relative min-w-0 flex-1 overflow-auto rounded-2xl border border-white/[0.06] bg-zinc-950"
      onPointerDown={(e) => e.target === e.currentTarget && select([])}
    >
      <div ref={inner} style={{ width: width + 80 }} className="relative">
        <Ruler project={project} ppb={ppb} beats={beats} barEvery={barEvery} />
        <TempoLane project={project} ppb={ppb} beats={beats} />
        {/* Lanes */}
        <div ref={lanesRef}>
          {Array.from({ length: lanes }, (_, lane) => (
            <div key={lane} className="flex border-b border-white/[0.04]" style={{ height: LANE_H }}>
              <div className="sticky left-0 z-10 flex w-20 shrink-0 items-center gap-1 border-r border-white/[0.06] bg-zinc-950 px-1.5">
                <span className="flex size-6 items-center justify-center rounded-md text-xs font-black text-zinc-950" style={{ background: DECK_COLORS[lane] }}>
                  {String.fromCharCode(65 + lane)}
                </span>
                <LaneStudioButton project={project} lane={lane} />
                <LaneMuteSolo project={project} lane={lane} />
              </div>
              <LaneDrop
                lane={lane}
                onTracks={(ids, x) => addTracks(ids, lane, x)}
                style={{ backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.035) 0 1px, transparent 1px ${ppb * gridBeats}px), repeating-linear-gradient(to right, rgba(255,255,255,0.07) 0 1px, transparent 1px ${ppb * gridBeats * 4}px)` }}
                onPointerDown={startBox}
              >
                {project.clips
                  .filter((c) => c.lane === lane)
                  .map((c) => (
                    <ClipBox key={c.id} clip={c} ppb={ppb} selected={selSet.has(c.id)} only={selected.length === 1} show={show} silent={!laneHeard(project, lane)} />
                  ))}
              </LaneDrop>
            </div>
          ))}
        </div>
        {loop && (
          <div
            className={clsx("pointer-events-none absolute bottom-0 top-9 z-[5] border-x", looping ? "border-amber-300/50 bg-amber-300/[0.05]" : "border-white/10")}
            style={{ left: 80 + loop.from * ppb, width: (loop.to - loop.from) * ppb }}
          />
        )}
        {project.markers.map((m, i) => (
          <div key={i} className="pointer-events-none absolute bottom-0 top-9 z-[5] w-px bg-pink-400/25" style={{ left: 80 + m.beat * ppb }} />
        ))}
        {box && (
          <div
            className="pointer-events-none absolute z-30 rounded border border-sky-300/70 bg-sky-300/10"
            style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
          />
        )}
        <Playhead project={project} ppb={ppb} scroller={scroller} />
        <div className="px-24 py-3 text-[11px] text-zinc-600">
          Drag tracks from the library onto a lane. Drag clips to move them (up or down to change deck; they snap to the Beat, Bar or Phrase grid you picked, or to beats while you hold Shift), drag the right edge to trim and the top corners to fade. Ctrl/⌘-click or drag a box to select several clips; Alt-click a clip to cut it there. Right-click a clip for more.
        </div>
      </div>
    </div>
  );
}

/** Bars and times, markers, and the loop. Click to set the play marker; Shift-drag to set the loop. */
function Ruler({ project, ppb, beats, barEvery }: { project: MixProject; ppb: number; beats: number; barEvery: number }) {
  const loop = useArrangeUi((s) => s.loop);
  const looping = useArrangeUi((s) => s.looping);
  const snapBeat = (b: number, fine: boolean) => Math.max(0, fine ? Math.round(b) : Math.round(b / 4) * 4);
  return (
    <div className="sticky top-0 z-20 flex h-9 border-b border-white/[0.06] bg-zinc-950/95 backdrop-blur">
      <div className="sticky left-0 z-10 w-20 shrink-0 border-r border-white/[0.06] bg-zinc-950" />
      <div
        className="relative flex-1 cursor-pointer"
        title="Click to set where Play starts. Shift-drag to choose a stretch to loop."
        data-testid="arrange-ruler"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("[data-marker]")) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const beatOf = (x: number) => snapBeat((x - r.left) / ppb, e.altKey);
          const b0 = beatOf(e.clientX);
          if (!e.shiftKey) {
            usePreview.getState().set({ cursor: b0 });
            return;
          }
          const move = (ev: PointerEvent) => {
            const b1 = beatOf(ev.clientX);
            if (b1 !== b0) useArrangeUi.getState().set({ loop: { from: Math.min(b0, b1), to: Math.max(b0, b1) }, looping: true });
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        {loop && (
          <div
            className={clsx("pointer-events-none absolute bottom-0 h-1.5 rounded-sm", looping ? "bg-amber-300/80" : "bg-white/20")}
            style={{ left: loop.from * ppb, width: (loop.to - loop.from) * ppb }}
          />
        )}
        {Array.from({ length: Math.ceil(beats / 4) }, (_, bar) =>
          bar % barEvery === 0 ? (
            <div key={bar} className="pointer-events-none absolute top-0 h-full border-l border-white/[0.08] pl-1" style={{ left: bar * 4 * ppb }}>
              <div className="font-mono text-[10px] text-zinc-400">{bar + 1}</div>
              {bar % (barEvery * 4) === 0 && <div className="font-mono text-[9px] text-zinc-600">{clock(beatToSeconds(project, bar * 4))}</div>}
            </div>
          ) : null,
        )}
        {project.markers.map((m, i) => (
          <MarkerFlag key={`${i}:${m.beat}`} index={i} beat={m.beat} label={m.label} ppb={ppb} />
        ))}
      </div>
    </div>
  );
}

/** A marker on the ruler: drag to move, click to put the play marker on it, double-click to rename, right-click to remove. */
function MarkerFlag({ index, beat, label, ppb }: { index: number; beat: number; label: string; ppb: number }) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      data-marker
      className="absolute top-0 z-10 flex h-full cursor-grab items-start border-l-2 border-pink-400 bg-zinc-950/70 pl-1 pr-1 text-[10px] font-medium text-pink-200 active:cursor-grabbing"
      style={{ left: beat * ppb }}
      title={`${label}: drag to move, double-click to rename, right-click to remove`}
      onPointerDown={(e) => {
        if (e.button !== 0 || editing) return;
        e.stopPropagation();
        const x0 = e.clientX;
        let moved = false;
        let now = beat;
        const move = (ev: PointerEvent) => {
          const p = useApp.getState().project;
          if (!p) return;
          if (!moved && Math.abs(ev.clientX - x0) < 3) return;
          moved = true;
          const raw = beat + (ev.clientX - x0) / ppb;
          const b = Math.max(0, ev.shiftKey ? Math.round(raw) : Math.round(raw / 4) * 4);
          const idx = p.markers.findIndex((m) => m.label === label && Math.abs(m.beat - now) < 1e-6);
          if (idx < 0 || b === now) return;
          now = b;
          setProject(moveMarker(p, idx, b), undefined, `marker:${label}`, `Move “${label}”`);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (!moved) usePreview.getState().set({ cursor: beat });
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const p = useApp.getState().project;
        if (p) setProject(removeMarker(p, index), undefined, undefined, `Remove “${label}”`);
      }}
    >
      {editing ? (
        <input
          autoFocus
          defaultValue={label}
          aria-label="Marker name"
          className="w-24 rounded bg-zinc-900 px-1 text-[10px] text-zinc-100 outline-none ring-1 ring-pink-400"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => {
            setEditing(false);
            const p = useApp.getState().project;
            const v = e.target.value.trim();
            if (p && v && v !== label) setProject(renameMarker(p, index, v), undefined, undefined, `Rename marker to “${v}”`);
          }}
        />
      ) : (
        <span className="mt-0.5 flex items-center gap-0.5 whitespace-nowrap">
          <Flag size={9} />
          {label}
        </span>
      )}
    </div>
  );
}

type Drag =
  | { mode: "move"; x: number; y: number; start: number; origin: MixProject; ids: number[]; last: string }
  | { mode: "trim"; x: number; length: number }
  | { mode: "fade"; side: "in" | "out"; x: number; beats: number };

function ClipBox({ clip, ppb, selected, only, show, silent }: { clip: Clip; ppb: number; selected: boolean; only: boolean; show: ProjectParam[]; silent: boolean }) {
  const editing = useAutoEdit((s) => s.param);
  const drag = useRef<Drag | null>(null);
  const menuAt = useRef(clip.start);
  const color = DECK_COLORS[clip.lane] ?? "#a1a1aa";
  const w = clip.length * ppb;
  const h = LANE_H - 12;
  const fadeIn = fadeOf(clip, "in");
  const fadeOut = fadeOf(clip, "out");
  const beatAtX = (clientX: number, el: HTMLElement, fine: boolean) => {
    const r = el.getBoundingClientRect();
    const raw = clip.start + (clientX - r.left) / ppb;
    return fine ? Math.round(raw * 4) / 4 : Math.round(raw);
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          data-clip={clip.id}
          className={clsx("group absolute top-1.5 overflow-hidden rounded-lg border text-[11px]", selected ? "border-white shadow-[0_0_0_1px_white]" : "border-transparent", silent && "opacity-35 grayscale")}
          style={{ left: clip.start * ppb, width: w, height: h, background: `${color}${selected ? "38" : "26"}`, borderLeft: `3px solid ${color}` }}
          onContextMenu={(e) => {
            menuAt.current = beatAtX(e.clientX, e.currentTarget, false);
            if (!useArrangeUi.getState().selected.includes(clip.id)) select([clip.id]);
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            const el = e.currentTarget as HTMLElement;
            if (e.altKey) {
              splitAt(beatAtX(e.clientX, el, e.shiftKey), [clip.id]);
              return;
            }
            const ui = useArrangeUi.getState();
            if (e.ctrlKey || e.metaKey) {
              select(ui.selected.includes(clip.id) ? ui.selected.filter((id) => id !== clip.id) : [...ui.selected, clip.id]);
              return;
            }
            const ids = ui.selected.includes(clip.id) ? [...ui.selected.filter((id) => id !== clip.id), clip.id] : [clip.id];
            select(ids);
            const t = (e.target as HTMLElement).dataset;
            if (t.trim === "1") drag.current = { mode: "trim", x: e.clientX, length: clip.length };
            else if (t.fade === "in" || t.fade === "out") drag.current = { mode: "fade", side: t.fade, x: e.clientX, beats: t.fade === "in" ? fadeIn : fadeOut };
            else drag.current = { mode: "move", x: e.clientX, y: e.clientY, start: clip.start, origin: useApp.getState().project ?? useApp.getState().project!, ids, last: "0:0" };
            el.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const mode = e.shiftKey ? "beat" : useArrangeUi.getState().snap;
            const cur = useApp.getState().project;
            const me = cur?.clips.find((c) => c.id === clip.id);
            if (!cur || !me) return;
            if (d.mode === "move") {
              const me0 = d.origin.clips.find((c) => c.id === clip.id) ?? me;
              const start = snapClipStart(d.origin, me0, d.start + (e.clientX - d.x) / ppb, mode);
              const dl = Math.round((e.clientY - d.y) / LANE_H);
              const key = `${start - d.start}:${dl}`;
              if (key === d.last) return;
              d.last = key;
              setProject(moveClips(d.origin, d.ids, start - d.start, dl), undefined, `clips:${d.ids.join(",")}:move`, d.ids.length > 1 ? `Move ${d.ids.length} clips` : undefined);
            } else if (d.mode === "trim") {
              const step = mode === "beat" ? 1 : mode === "bar" ? 4 : PHRASE_BEATS;
              const length = Math.max(step, d.length + Math.round((e.clientX - d.x) / ppb / step) * step);
              if (length !== me.length) updateClip(clip.id, withLength(me, length));
            } else {
              const dx = (e.clientX - d.x) / ppb;
              const raw = d.side === "in" ? d.beats + dx : d.beats - dx;
              const beats = Math.max(0, Math.min(me.length, e.shiftKey ? Math.round(raw * 4) / 4 : Math.round(raw)));
              if (beats !== fadeOf(me, d.side)) updateClip(clip.id, { lanes: setFade(me, d.side, beats).lanes }, d.side === "in" ? "Fade in" : "Fade out");
            }
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            // A click (no drag) on a clip of a group selects just that clip.
            if (d?.mode === "move" && d.ids.length > 1 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) select([clip.id]);
          }}
        >
          <svg className="pointer-events-none absolute inset-0" width={w} height={h} preserveAspectRatio="none">
            {fadeIn > 0 && <polygon points={`0,0 ${fadeIn * ppb},0 0,${h}`} fill="rgba(0,0,0,0.45)" />}
            {fadeOut > 0 && <polygon points={`${w},0 ${w - fadeOut * ppb},0 ${w},${h}`} fill="rgba(0,0,0,0.45)" />}
            {clip.lanes
              .filter((l) => show.includes(l.param))
              .map((l) => (
                <polyline key={l.param} points={lanePoints(l, clip, ppb, h)} fill="none" stroke={PARAM_COLORS[l.param]} strokeWidth={1.3} opacity={0.85} />
              ))}
          </svg>
          <div className="relative flex items-center gap-1 truncate px-1.5 pt-1 font-medium text-zinc-100">
            {clip.reverse && <Rewind size={10} className="shrink-0 text-zinc-300" aria-label="Plays backwards" />}
            <span className="truncate">{clip.name || clip.track.title}</span>
          </div>
          <div className="relative truncate px-1.5 text-[10px] text-zinc-400">
            {clip.track.artist} · {fmtBpm(clip.track.bpm)}
            {clip.key_shift !== 0 && ` · ${clip.key_shift > 0 ? "+" : ""}${clip.key_shift} st`}
            {clip.gain_db !== 0 && ` · ${clip.gain_db > 0 ? "+" : ""}${clip.gain_db.toFixed(1)} dB`}
          </div>
          <div data-trim="1" className="absolute right-0 top-3 h-[calc(100%-12px)] w-2 cursor-ew-resize opacity-0 group-hover:opacity-100" style={{ background: `${color}66` }} />
          <div data-fade="in" title="Drag to fade in" className={clsx("absolute top-0 size-3 cursor-ew-resize rounded-sm border border-white/80 bg-zinc-900", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")} style={{ left: Math.max(0, fadeIn * ppb - 6) }} />
          <div data-fade="out" title="Drag to fade out" className={clsx("absolute top-0 size-3 cursor-ew-resize rounded-sm border border-white/80 bg-zinc-900", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")} style={{ right: Math.max(0, fadeOut * ppb - 6) }} />
          {selected && only && editing && <AutomationEditor clip={clip} ppb={ppb} height={h} param={editing} />}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu">
          <ContextMenu.Item className="menu-item" onSelect={() => splitAt(menuAt.current, [clip.id])}>
            <Scissors size={12} /> Cut in two here
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={duplicateSelection}>
            <CopyPlus size={12} /> Duplicate <Kbd id="app.clip_duplicate" />
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={copySelection}>
            <Copy size={12} /> Copy <Kbd id="app.clip_copy" />
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={cutSelection}>
            <Scissors size={12} /> Cut out <Kbd id="app.clip_cut" />
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              usePreview.getState().set({ cursor: menuAt.current });
              paste();
            }}
          >
            <ClipboardPaste size={12} /> Paste here
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-white/10" />
          <ContextMenu.Item className="menu-item" onSelect={() => updateClip(clip.id, { lanes: setFade(setFade(clip, "in", 8), "out", 8).lanes }, "Fade in and out")}>
            Fade in and out over 2 bars
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => updateClip(clip.id, { lanes: setFade(setFade(clip, "in", 0), "out", 0).lanes }, "Remove fades")} disabled={!fadeIn && !fadeOut}>
            Remove fades
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-white/10" />
          <ContextMenu.Item className="menu-item text-red-300" onSelect={deleteSelection}>
            <Trash2 size={12} /> Remove <Kbd id="app.clip_delete" />
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A shortcut hint at the end of a menu item. */
function Kbd({ id }: { id: string }) {
  const sc = useApp((s) => s.registry.find((a) => a.id === id)?.shortcut ?? null);
  return sc ? <span className="ml-auto pl-4 font-mono text-[10px] text-zinc-500">{shortcutLabel(sc)}</span> : null;
}

/** A new length for a clip; a reversed clip keeps what is heard at its start, so its
 * range of the track grows or shrinks at the bottom. */
function withLength(c: Clip, length: number): Partial<Clip> {
  return c.reverse ? { length, source_start: Math.max(0, c.source_start - (length - c.length)) } : { length };
}

function lanePoints(l: AutomationLane, clip: Clip, ppb: number, h: number): string {
  const [lo, hi] = PARAM_RANGE[l.param];
  const y = (v: number) => (h - 4 - ((v - lo) / (hi - lo)) * (h - 8)).toFixed(1);
  const pts = l.points.map((p) => `${((p.beat - clip.start) * ppb).toFixed(1)},${y(p.value)}`);
  if (l.points.length) {
    pts.unshift(`0,${y(l.points[0].value)}`);
    pts.push(`${(clip.length * ppb).toFixed(1)},${y(l.points[l.points.length - 1].value)}`);
  }
  return pts.join(" ");
}

function ClipPanel({ clip, project, close }: { clip: Clip; project: MixProject; close: () => void }) {
  const startSecs = useMemo(() => beatToSeconds(project, clip.start), [project, clip.start]);
  const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : d);
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-3 text-xs">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <input className="input h-7 w-full font-medium" value={clip.name} onChange={(e) => updateClip(clip.id, { name: e.target.value })} />
          <div className="mt-1 truncate text-zinc-500">{clip.track.artist}</div>
        </div>
        <button type="button" className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" onClick={close} aria-label="Close">
          <X size={13} />
        </button>
      </div>
      <Row label="Deck">
        <select className="input h-7 w-full" value={clip.lane} onChange={(e) => updateClip(clip.id, { lane: Number(e.target.value) })}>
          {[0, 1, 2, 3].map((l) => (
            <option key={l} value={l}>
              {String.fromCharCode(65 + l)}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Starts">
        <span className="font-mono text-zinc-300">
          bar {Math.floor(clip.start / 4) + 1}.{(clip.start % 4) + 1} · {clock(startSecs)}
        </span>
      </Row>
      <Row label="Length">
        <input className="input h-7 w-20 font-mono" defaultValue={clip.length} key={`len${clip.id}${clip.length}`} onBlur={(e) => updateClip(clip.id, withLength(clip, Math.max(1, num(e.target.value, clip.length))))} />
        <span className="text-zinc-500">beats</span>
      </Row>
      <Row label="From beat">
        <input className="input h-7 w-20 font-mono" defaultValue={clip.source_start} key={`src${clip.id}${clip.source_start}`} onBlur={(e) => updateClip(clip.id, { source_start: Math.max(0, num(e.target.value, clip.source_start)) })} />
        <span className="text-zinc-500">of the track</span>
      </Row>
      <Row label="Gain">
        <input type="range" min={-12} max={12} step={0.5} value={clip.gain_db} onChange={(e) => updateClip(clip.id, { gain_db: Number(e.target.value) })} className="flex-1 accent-sky-400" />
        <span className="w-12 text-right font-mono text-zinc-300">{clip.gain_db.toFixed(1)} dB</span>
      </Row>
      <KeyRow clip={clip} project={project} />
      <label className="flex items-center gap-2 text-zinc-300">
        <input type="checkbox" checked={clip.keylock} onChange={(e) => updateClip(clip.id, { keylock: e.target.checked })} />
        Key lock (tempo changes keep the pitch)
      </label>
      <label className="flex items-center gap-2 text-zinc-300" title="Plays this part of the track from its end to its start, for a rewind or a build-up effect.">
        <input type="checkbox" checked={!!clip.reverse} onChange={(e) => updateClip(clip.id, { reverse: e.target.checked }, e.target.checked ? "Play backwards" : "Play forwards")} />
        <Rewind size={12} className="text-zinc-500" /> Play backwards
      </label>
      <EffectRow clip={clip} />
      <TransitionSection key={clip.id} clip={clip} project={project} />
      <AutomationSection clip={clip} />
      <div className="flex gap-1">
        <Btn size="sm" className="flex-1" onClick={() => playPreview(project, Math.max(0, clip.start - 16), clip.start + 48)}>
          <Play size={11} /> Hear the mix in
        </Btn>
        <Btn size="sm" className="flex-1" onClick={() => playPreview(project, Math.max(0, (clip.start + clip.length) - 48), (clip.start + clip.length) + 16)}>
          <Play size={11} /> Mix out
        </Btn>
      </div>
      <div className="truncate font-mono text-[10px] text-zinc-600" title={clip.track.path ?? ""}>
        {clip.track.path}
      </div>
      <div className="flex gap-1">
        <Btn
          size="sm"
          tone="danger"
          className="flex-1"
          onClick={() => {
            setProject({ ...project, clips: project.clips.filter((c) => c.id !== clip.id) }, undefined, undefined, `Remove “${clip.name || clip.track.title}”`);
            close();
          }}
        >
          <Trash2 size={12} /> Remove
        </Btn>
        <Btn
          size="sm"
          tone="danger"
          className="flex-1"
          title="Removes the clip and moves everything after it back, so the next track mixes in where this one did."
          onClick={() => {
            setProject(rippleDelete(project, clip.id), undefined, undefined, `Remove “${clip.name || clip.track.title}” and close the gap`);
            close();
          }}
        >
          <Trash2 size={12} /> Remove, close gap
        </Btn>
      </div>
    </aside>
  );
}

function AutomationSection({ clip }: { clip: Clip }) {
  const editing = useAutoEdit((s) => s.param);
  const lane = editing ? clip.lanes.find((l) => l.param === editing) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Automation</div>
      <div className="flex flex-wrap gap-1">
        {(Object.keys(PARAM_LABEL) as ProjectParam[]).map((p) => {
          const n = clip.lanes.find((l) => l.param === p)?.points.length ?? 0;
          return (
            <button
              key={p}
              type="button"
              onClick={() => useAutoEdit.setState({ param: editing === p ? null : p })}
              className={clsx("flex items-center gap-1 rounded-md border px-1.5 py-0.5", editing === p ? "border-[var(--accent)] bg-[var(--accent)]/15 text-zinc-100" : "border-white/10 text-zinc-400 hover:text-zinc-200")}
              title={`Draw ${PARAM_LABEL[p]} on this clip`}
            >
              <span className="size-1.5 rounded-full" style={{ background: PARAM_COLORS[p] }} />
              {PARAM_LABEL[p]}
              {n > 0 && <span className="font-mono text-[10px] text-zinc-500">{n}</span>}
            </button>
          );
        })}
      </div>
      {editing ? (
        <>
          <p className="leading-snug text-zinc-500">Click in the clip to add a point, drag to move it, double-click to delete. Points snap to beats; hold Shift for finer steps.</p>
          <div className="flex items-center gap-1.5">
            <select className="input h-7 min-w-0 flex-1" value={lane?.points[0]?.curve ?? "Linear"} disabled={!lane?.points.length} onChange={(e) => setLaneCurve(clip, editing, e.target.value as CurveShape)} aria-label="Curve shape">
              <option value="Linear">Straight lines</option>
              <option value="Smooth">Smooth curves</option>
              <option value="Power">Equal-power (smooth volume crossfades)</option>
              <option value="Hold">Steps (jump at each point)</option>
            </select>
            <Btn size="sm" tone="ghost" disabled={!lane?.points.length} onClick={() => setLane(clip, editing, [])} aria-label={`Clear ${PARAM_LABEL[editing]}`}>
              <Trash2 size={11} />
            </Btn>
          </div>
          <div className="flex gap-1">
            <Btn size="sm" className="flex-1" onClick={() => setLane(clip, editing, rampPoints(clip, editing, "in"))} title="Rises from the start of the clip over 16 beats">
              Ramp in
            </Btn>
            <Btn size="sm" className="flex-1" onClick={() => setLane(clip, editing, rampPoints(clip, editing, "out"))} title="Falls over the last 16 beats of the clip">
              Ramp out
            </Btn>
          </div>
        </>
      ) : (
        <p className="leading-snug text-zinc-500">Pick a control to draw how it moves during this clip, like a fade or a bass swap.</p>
      )}
    </div>
  );
}

/** A 16-beat ramp between the control's "away" value and its resting value. */
function rampPoints(clip: Clip, param: ProjectParam, dir: "in" | "out"): AutomationPoint[] {
  const [lo] = PARAM_RANGE[param];
  const away = param === "Filter" ? (dir === "in" ? -1 : 1) : lo;
  const rest = PARAM_DEFAULT[param] === lo ? PARAM_RANGE[param][1] : PARAM_DEFAULT[param];
  const len = Math.min(16, clip.length);
  const a = dir === "in" ? clip.start : clip.start + clip.length - len;
  const curve: CurveShape = param === "Volume" ? "Power" : "Smooth";
  return dir === "in"
    ? [
        { beat: a, value: away, curve },
        { beat: a + len, value: rest, curve },
      ]
    : [
        { beat: a, value: rest, curve },
        { beat: a + len, value: away, curve },
      ];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function PlayButton({ project }: { project: MixProject }) {
  const status = usePreview((s) => s.status);
  const cursor = usePreview((s) => s.cursor);
  const looping = useArrangeUi((s) => s.looping);
  const loop = useArrangeUi((s) => s.loop);
  return (
    <>
      <Btn
        size="sm"
        tone="accent"
        style={{ ["--accent" as string]: "#34d399" }}
        disabled={status === "idle" && project.clips.length === 0}
        onClick={togglePlay}
        title={status !== "idle" ? "Stop (Space)" : looping ? "Plays the loop over and over (Space)" : "Plays 32 bars from the play marker (Space)"}
      >
        {status === "loading" ? <Loader2 size={12} className="animate-spin" /> : status === "playing" ? <Square size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
        {status === "loading" ? "Preparing…" : status === "playing" ? "Stop" : looping && loop ? `Loop bars ${Math.floor(loop.from / 4) + 1}–${Math.ceil(loop.to / 4)}` : `Play from bar ${Math.floor(cursor / 4) + 1}`}
      </Btn>
      <Btn size="sm" tone="ghost" active={looping} onClick={toggleLoop} aria-label="Loop" title="Loop: repeat a stretch while you adjust it (L). Shift-drag on the ruler to choose it; it starts as the selected clips, or 8 bars from the play marker.">
        <Repeat size={12} />
      </Btn>
    </>
  );
}

/** Edit buttons for the selected clips, plus a marker at the play marker. */
function EditTools({ count }: { count: number }) {
  const none = count === 0;
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Edit clips">
      <Btn size="sm" tone="ghost" onClick={() => splitAt()} aria-label="Cut in two at the play marker" title="Cut the selected clips (or every clip under the play marker) in two at the play marker (Ctrl/⌘+B)">
        <Scissors size={12} />
      </Btn>
      <Btn size="sm" tone="ghost" disabled={none} onClick={duplicateSelection} aria-label="Duplicate" title="Repeat the selected clips right after themselves (Ctrl/⌘+D)">
        <CopyPlus size={12} />
      </Btn>
      <Btn size="sm" tone="ghost" disabled={none} onClick={copySelection} aria-label="Copy" title="Copy the selected clips (Ctrl/⌘+C)">
        <Copy size={12} />
      </Btn>
      <Btn size="sm" tone="ghost" onClick={paste} aria-label="Paste" title="Paste at the play marker (Ctrl/⌘+V)">
        <ClipboardPaste size={12} />
      </Btn>
      <Btn size="sm" tone="ghost" disabled={none} onClick={deleteSelection} aria-label="Remove selected clips" title="Remove the selected clips (Delete)">
        <Trash2 size={12} />
      </Btn>
      <Btn size="sm" tone="ghost" onClick={addMarkerAtCursor} aria-label="Add marker" title="Add a marker at the play marker, to label parts of the mix like Drop or Outro">
        <Flag size={12} />
      </Btn>
    </div>
  );
}

/** The side panel when several clips are selected: change them all at once. */
function MultiPanel({ ids, project }: { ids: number[]; project: MixProject }) {
  const clips = project.clips.filter((c) => ids.includes(c.id));
  const from = Math.min(...clips.map((c) => c.start));
  const to = Math.max(...clips.map((c) => c.start + c.length));
  const nudge = (beats: number, lanes = 0) => setProject(moveClips(project, ids, beats, lanes), undefined, undefined, `Move ${ids.length} clips`);
  const gain = (db: number) =>
    setProject({ ...project, clips: project.clips.map((c) => (ids.includes(c.id) ? { ...c, gain_db: Math.max(-24, Math.min(12, Math.round((c.gain_db + db) * 2) / 2)) } : c)) }, undefined, `clips:${ids.join(",")}:gain`, `Change the volume of ${ids.length} clips`);
  const fades = (beats: number) =>
    setProject({ ...project, clips: project.clips.map((c) => (ids.includes(c.id) ? { ...c, lanes: setFade(setFade(c, "in", beats), "out", beats).lanes } : c)) }, undefined, undefined, beats ? `Fade ${ids.length} clips` : `Remove fades from ${ids.length} clips`);
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-3 text-xs" aria-label="Selected clips">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-zinc-100">{ids.length} clips selected</div>
          <div className="mt-0.5 text-zinc-500">
            bars {Math.floor(from / 4) + 1} to {Math.ceil(to / 4)} · {clock(beatToSeconds(project, to) - beatToSeconds(project, from))}
          </div>
        </div>
        <button type="button" className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" onClick={() => select([])} aria-label="Clear selection">
          <X size={13} />
        </button>
      </div>
      <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
        {clips
          .sort((a, b) => a.start - b.start)
          .map((c) => (
            <li key={c.id} className="flex items-center gap-1.5 truncate text-zinc-300">
              <span className="size-2 shrink-0 rounded-full" style={{ background: DECK_COLORS[c.lane] }} />
              <span className="truncate">{c.name || c.track.title}</span>
            </li>
          ))}
      </ul>
      <Row label="Move">
        <div className="flex flex-wrap gap-1">
          <Btn size="sm" onClick={() => nudge(-PHRASE_BEATS)} title="8 bars earlier">−8 bars</Btn>
          <Btn size="sm" onClick={() => nudge(-4)} title="One bar earlier">−1</Btn>
          <Btn size="sm" onClick={() => nudge(4)} title="One bar later">+1</Btn>
          <Btn size="sm" onClick={() => nudge(PHRASE_BEATS)} title="8 bars later">+8 bars</Btn>
        </div>
      </Row>
      <Row label="Deck">
        <div className="flex gap-1">
          <Btn size="sm" onClick={() => nudge(0, -1)} title="Move them all up one deck lane">Up</Btn>
          <Btn size="sm" onClick={() => nudge(0, 1)} title="Move them all down one deck lane">Down</Btn>
        </div>
      </Row>
      <Row label="Volume">
        <div className="flex gap-1">
          <Btn size="sm" onClick={() => gain(-1)} title="All 1 dB quieter, keeping their balance">−1 dB</Btn>
          <Btn size="sm" onClick={() => gain(1)} title="All 1 dB louder, keeping their balance">+1 dB</Btn>
        </div>
      </Row>
      <Row label="Fades">
        <div className="flex gap-1">
          <Btn size="sm" onClick={() => fades(8)} title="Fade each clip in and out over 2 bars">2 bars</Btn>
          <Btn size="sm" onClick={() => fades(0)}>None</Btn>
        </div>
      </Row>
      <div className="grid grid-cols-2 gap-1">
        <Btn size="sm" onClick={duplicateSelection}>
          <CopyPlus size={11} /> Duplicate
        </Btn>
        <Btn size="sm" onClick={copySelection}>
          <Copy size={11} /> Copy
        </Btn>
        <Btn size="sm" onClick={() => playPreview(project, Math.max(0, from - 8), to + 8)}>
          <Play size={11} /> Hear them
        </Btn>
        <Btn size="sm" tone="danger" onClick={deleteSelection}>
          <Trash2 size={11} /> Remove
        </Btn>
      </div>
      <p className="leading-snug text-zinc-500">Drag any selected clip to move them all together. Ctrl/⌘-click a clip to add it to or take it out of the selection.</p>
    </aside>
  );
}

/** The start marker, and the moving play head while a preview plays. */
function Playhead({ project, ppb, scroller }: { project: MixProject; ppb: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const cursor = usePreview((s) => s.cursor);
  const status = usePreview((s) => s.status);
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (status !== "playing") return;
    let raf = 0;
    const tick = () => {
      const { audio, from } = usePreview.getState();
      if (audio && line.current) {
        const x = beatAfter(project, from, audio.currentTime) * ppb;
        line.current.style.transform = `translateX(${x}px)`;
        // Keep the play head in view: turn the page when it reaches the right edge.
        const el = scroller.current;
        if (el && (80 + x > el.scrollLeft + el.clientWidth - 40 || 80 + x < el.scrollLeft + 80)) el.scrollLeft = Math.max(0, x - 40);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, project, ppb]);
  return (
    <>
      <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-emerald-400/50" style={{ left: 80 + cursor * ppb }}>
        <div className="absolute -left-1 top-0 size-2 rotate-45 bg-emerald-400" />
      </div>
      {status === "playing" && <div ref={line} className="pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-white shadow-[0_0_8px_white]" style={{ left: 80 }} />}
    </>
  );
}

/** A deck lane on the timeline: tracks dropped on it become clips where they land. */
function LaneDrop({ lane, onTracks, children, ...rest }: { lane: number; onTracks: (ids: number[], x: number) => void; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  const drop = useDropTarget(`arrange-lane-${lane}`, {
    label: `Add to the timeline on deck ${String.fromCharCode(65 + lane)}`,
    tracks: (ids, at) => onTracks(ids, at.x - at.el.getBoundingClientRect().left),
  });
  return (
    <div {...rest} {...drop.props} className={clsx("relative flex-1", drop.over && "bg-sky-400/[0.06]")}>
      {children}
    </div>
  );
}

/** Mute (leave the lane out of the mix) and solo (hear only this lane) buttons. */
function LaneMuteSolo({ project, lane }: { project: MixProject; lane: number }) {
  const st = project.lane_states?.[lane];
  const L = String.fromCharCode(65 + lane);
  const set = (patch: { muted?: boolean; solo?: boolean }, label: string) => setProject(setLaneState(project, lane, patch), undefined, undefined, label);
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        aria-label={`Mute deck ${L} lane`}
        aria-pressed={!!st?.muted}
        title={`Mute: leave deck ${L} out of the mix (also when you play and render)`}
        onClick={() => set({ muted: !st?.muted }, st?.muted ? `Unmute deck ${L}` : `Mute deck ${L}`)}
        className={clsx("h-[14px] w-4 rounded-sm text-[9px] font-bold leading-none", st?.muted ? "bg-red-500 text-white" : "bg-white/[0.06] text-zinc-500 hover:text-zinc-200")}
      >
        M
      </button>
      <button
        type="button"
        aria-label={`Solo deck ${L} lane`}
        aria-pressed={!!st?.solo}
        title={`Solo: hear only deck ${L} (and other soloed lanes)`}
        onClick={() => set({ solo: !st?.solo }, st?.solo ? `Unsolo deck ${L}` : `Solo deck ${L}`)}
        className={clsx("h-[14px] w-4 rounded-sm text-[9px] font-bold leading-none", st?.solo ? "bg-amber-400 text-zinc-950" : "bg-white/[0.06] text-zinc-500 hover:text-zinc-200")}
      >
        S
      </button>
    </div>
  );
}

/** Opens a lane's studio (EQ, compressor and more for every clip on it). */
function LaneStudioButton({ project, lane }: { project: MixProject; lane: number }) {
  const open = useStudio((s) => s.lane === lane);
  const st = project.strips?.[lane];
  const used = !!st && (st.compOn || st.satOn || st.gateOn || (st.eqOn && st.bands.some((b) => b.enabled)) || Math.abs(st.width - 1) > 0.01 || Math.abs(st.outputDb) > 0.01);
  return (
    <button
      type="button"
      onClick={() => openLaneStudio(open ? null : lane)}
      className={clsx("relative flex h-6 items-center gap-1 rounded-md border px-1 text-[10px]", open ? "border-transparent bg-white/15 text-zinc-50" : "border-white/10 text-zinc-500 hover:text-zinc-200")}
      title={`Studio for deck ${String.fromCharCode(65 + lane)}: EQ, compression and warmth for every clip on this lane`}
      aria-label={`Deck ${String.fromCharCode(65 + lane)} lane studio`}
    >
      <SlidersVertical size={11} />
      {used && <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full" style={{ background: DECK_COLORS[lane] }} />}
    </button>
  );
}

/** Render the mix (WAV or FLAC, optionally to a loudness target) or export stems. */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<"wav" | "flac">("wav");
  const [target, setTarget] = useState<string>("none");
  const web = backend().kind === "web";
  const lufs = LOUDNESS_TARGETS.find((t) => t.id === target)?.lufs ?? null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Btn size="sm" tone="accent" style={{ ["--accent" as string]: "#34d399" }}>
          <Music size={12} /> Render <ChevronDown size={11} />
        </Btn>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 flex w-80 flex-col gap-3 rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur">
          <div className="flex flex-col gap-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">File type</div>
            <div className="flex gap-1">
              {(["wav", "flac"] as const).map((f) => (
                <Btn key={f} size="sm" active={format === f} disabled={web && f === "flac"} onClick={() => setFormat(f)} className="flex-1">
                  {f === "wav" ? "WAV" : "FLAC"}
                </Btn>
              ))}
            </div>
            <div className="leading-snug text-zinc-500">{web ? "The browser version saves WAV files." : "FLAC is lossless like WAV and about half the size."}</div>
          </div>
          <div className="flex flex-col gap-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Loudness</div>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-7 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" disabled={web}>
              <option value="none">As mixed</option>
              {LOUDNESS_TARGETS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.lufs} LUFS)
                </option>
              ))}
            </select>
            <div className="leading-snug text-zinc-500">{web ? "Matching a loudness target needs the desktop app." : (LOUDNESS_TARGETS.find((t) => t.id === target)?.hint ?? "Keeps the level you mixed at.")}</div>
          </div>
          <Btn
            tone="accent"
            style={{ ["--accent" as string]: "#34d399" }}
            onClick={() => {
              setOpen(false);
              void renderProject({ format, targetLufs: web ? null : lufs });
            }}
          >
            <Music size={12} /> Render the mix
          </Btn>
          <div className="flex flex-col gap-1 border-t border-white/[0.06] pt-3">
            <Btn
              onClick={() => {
                setOpen(false);
                void renderStems(web ? "wav" : format);
              }}
            >
              <Layers size={12} /> Export stems
            </Btn>
            <div className="leading-snug text-zinc-500">One file per deck, all the same length, so you can finish the mix in another program. Each keeps its lane studio and sends; the mix studio and limiter are left off.</div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
