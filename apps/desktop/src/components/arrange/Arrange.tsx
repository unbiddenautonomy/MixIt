// Arrange: a mix on a timeline. Clips sit on four deck lanes over a tempo ruler; move
// and trim them on the bar grid, edit gain, key and automation, then render the mix.
import clsx from "clsx";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, FolderOpen, Layers, Loader2, Minus, Music, Play, Plus, Rewind, Save, SlidersVertical, Sparkles, Square, Trash2, Wand2, X } from "lucide-react";
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
import { moveClip, PHRASE_BEATS, rippleDelete, snapClipStart, toProjectKey } from "../../lib/arrangeOps";

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
  const [sel, setSelRaw] = useState<number | null>(null);
  const tempoSel = useArrangeUi((s) => s.tempoSel);
  const setSel = (id: number | null) => {
    setSelRaw(id);
    if (id != null) useArrangeUi.getState().set({ tempoSel: null });
  };
  const [show, setShow] = useState<ProjectParam[]>(["Volume", "EqLow"]);
  const [width, setWidth] = useState(1200);
  const area = useRef<HTMLDivElement>(null);
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
  const beats = Math.max(64, projectBeats(project) + 32);
  const total = beatToSeconds(project, projectBeats(project));
  const clip = project.clips.find((c) => c.id === sel) ?? null;
  const rendering = job && !job.finished;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.06] bg-zinc-900/60 px-3 py-2">
        <input className="input h-8 w-56 text-sm font-semibold" value={project.name} onChange={(e) => setProject({ ...project, name: e.target.value }, undefined, "name")} />
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
          <HistoryButtons />
          <div className="h-5 w-px bg-white/10" />
          <SnapPicker />
          <div className="h-5 w-px bg-white/10" />
          <div className="flex items-center gap-1 text-[11px] text-zinc-400">
            Show
            {(Object.keys(PARAM_COLORS) as ProjectParam[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setShow(show.includes(p) ? show.filter((x) => x !== p) : [...show, p])}
                className={clsx("rounded px-1.5 py-0.5", show.includes(p) ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300")}
              >
                <span className="mr-1 inline-block size-1.5 rounded-full" style={{ background: PARAM_COLORS[p] }} />
                {p === "FxMix" ? "FX" : p.replace("Eq", "EQ ")}
              </button>
            ))}
          </div>
          <div className="h-5 w-px bg-white/10" />
          <Btn size="sm" tone="ghost" onClick={() => setPpb((p) => Math.max(0.08, p / 1.5))} aria-label="Zoom out">
            <Minus size={12} />
          </Btn>
          <Btn size="sm" tone="ghost" onClick={() => setPpb((p) => Math.min(40, p * 1.5))} aria-label="Zoom in">
            <Plus size={12} />
          </Btn>
          <Btn size="sm" tone="ghost" active={zoom == null} onClick={() => setZoom(null)}>
            Fit
          </Btn>
          <PlayButton project={project} />
          <Btn size="sm" onClick={() => openLaneStudio(MASTER_STRIP)} title="EQ, glue and loudness for the whole mix, and its reverb and echo">
            <SlidersVertical size={12} /> Mix studio
          </Btn>
          <Btn size="sm" onClick={() => useApp.getState().set({ automixOpen: true })}>
            <Wand2 size={12} /> Automix
          </Btn>
          <Btn size="sm" onClick={openProject}>
            <FolderOpen size={12} /> Open
          </Btn>
          <Btn size="sm" onClick={() => saveProject(false)}>
            <Save size={12} /> Save
          </Btn>
          {rendering ? (
            <Btn size="sm" tone="danger" onClick={() => backend().cancelJob()}>
              <Loader2 size={12} className="animate-spin" /> {job.total ? Math.round((job.done / job.total) * 100) : 0}% · Stop
            </Btn>
          ) : (
            <ExportMenu />
          )}
          <Btn size="sm" tone="ghost" onClick={closeProject} aria-label="Close project">
            <X size={12} />
          </Btn>
        </div>
      </div>
      <div ref={area} className="flex min-h-0 flex-1 gap-2">
        <Timeline project={project} ppb={ppb} beats={beats} sel={sel} setSel={setSel} show={show} />
        {tempoSel != null && project.tempo.segments[tempoSel] ? <TempoPanel project={project} index={tempoSel} /> : clip && <ClipPanel clip={clip} project={project} close={() => setSel(null)} />}
      </div>
    </div>
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

function Timeline({ project, ppb, beats, sel, setSel, show }: { project: MixProject; ppb: number; beats: number; sel: number | null; setSel: (id: number | null) => void; show: ProjectParam[] }) {
  const width = beats * ppb;
  const scroller = useRef<HTMLDivElement>(null);
  // Label every N bars, N a power of two that keeps labels at least ~56 px apart.
  const barEvery = [1, 2, 4, 8, 16, 32, 64, 128, 256].find((n) => n * 4 * ppb >= 56) ?? 512;
  const gridBeats = Math.max(4, barEvery);
  const lanes = 4;

  const addTracks = async (ids: number[], lane: number, x: number) => {
    const rows = await rowsById(ids);
    let start = Math.max(0, Math.round(x / ppb / 4) * 4);
    let p = useApp.getState().project ?? project;
    let next = p.next_id;
    const clips = [...p.clips];
    for (const r of rows) {
      const c = clipFromTrack(r, next++, lane, start);
      clips.push(c);
      start += c.length;
    }
    p = { ...p, clips, next_id: next };
    setProject(p, undefined, undefined, rows.length === 1 ? `Add “${rows[0].title}”` : `Add ${rows.length} tracks`);
  };

  return (
    <div ref={scroller} className="screen relative min-w-0 flex-1 overflow-auto rounded-2xl border border-white/[0.06] bg-zinc-950" onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}>
      <div style={{ width: width + 80 }} className="relative">
        {/* Ruler */}
        <div className="sticky top-0 z-20 flex h-9 border-b border-white/[0.06] bg-zinc-950/95 backdrop-blur">
          <div className="sticky left-0 z-10 w-20 shrink-0 border-r border-white/[0.06] bg-zinc-950" />
          <div
            className="relative flex-1 cursor-pointer"
            title="Click to set where Play starts"
            onPointerDown={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const beat = Math.max(0, Math.round((e.clientX - r.left) / ppb / 4) * 4);
              usePreview.getState().set({ cursor: beat });
            }}
          >
            {Array.from({ length: Math.ceil(beats / 4) }, (_, bar) =>
              bar % barEvery === 0 ? (
                <div key={bar} className="absolute top-0 h-full border-l border-white/[0.08] pl-1" style={{ left: bar * 4 * ppb }}>
                  <div className="font-mono text-[10px] text-zinc-400">{bar + 1}</div>
                  {bar % (barEvery * 4) === 0 && <div className="font-mono text-[9px] text-zinc-600">{clock(beatToSeconds(project, bar * 4))}</div>}
                </div>
              ) : null,
            )}
            {project.markers.map((m, i) => (
              <div key={i} className="absolute top-0 h-full border-l border-pink-400/60 pl-1 text-[9px] text-pink-300" style={{ left: m.beat * ppb }}>
                {m.label}
              </div>
            ))}
          </div>
        </div>
        <TempoLane project={project} ppb={ppb} beats={beats} />
        {/* Lanes */}
        {Array.from({ length: lanes }, (_, lane) => (
          <div key={lane} className="flex border-b border-white/[0.04]" style={{ height: LANE_H }}>
            <div className="sticky left-0 z-10 flex w-20 shrink-0 items-center gap-2 border-r border-white/[0.06] bg-zinc-950 px-2">
              <span className="flex size-6 items-center justify-center rounded-md text-xs font-black text-zinc-950" style={{ background: DECK_COLORS[lane] }}>
                {String.fromCharCode(65 + lane)}
              </span>
              <LaneStudioButton project={project} lane={lane} />
            </div>
            <LaneDrop
              lane={lane}
              onTracks={(ids, x) => addTracks(ids, lane, x)}
              style={{ backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.035) 0 1px, transparent 1px ${ppb * gridBeats}px), repeating-linear-gradient(to right, rgba(255,255,255,0.07) 0 1px, transparent 1px ${ppb * gridBeats * 4}px)` }}
              onPointerDown={(e) => e.target === e.currentTarget && setSel(null)}
            >
              {project.clips
                .filter((c) => c.lane === lane)
                .map((c) => (
                  <ClipBox key={c.id} clip={c} ppb={ppb} selected={sel === c.id} onSelect={() => setSel(c.id)} show={show} />
                ))}
            </LaneDrop>
          </div>
        ))}
        <Playhead project={project} ppb={ppb} />
        <div className="px-24 py-3 text-[11px] text-zinc-600">Drag tracks from the library onto a lane. Drag clips to move them (up or down to change deck; they snap to the Beat, Bar or Phrase grid you picked, or to beats while you hold Shift), drag the right edge to trim.</div>
      </div>
    </div>
  );
}

function ClipBox({ clip, ppb, selected, onSelect, show }: { clip: Clip; ppb: number; selected: boolean; onSelect: () => void; show: ProjectParam[] }) {
  const editing = useAutoEdit((s) => s.param);
  const drag = useRef<{ x: number; y: number; start: number; length: number; lane: number; mode: "move" | "trim" } | null>(null);
  const color = DECK_COLORS[clip.lane] ?? "#a1a1aa";
  const w = clip.length * ppb;
  return (
    <div
      className={clsx("group absolute top-1.5 overflow-hidden rounded-lg border text-[11px]", selected ? "border-white shadow-[0_0_0_1px_white]" : "border-transparent")}
      style={{ left: clip.start * ppb, width: w, height: LANE_H - 12, background: `${color}26`, borderLeft: `3px solid ${color}` }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        const trim = (e.target as HTMLElement).dataset.trim === "1";
        drag.current = { x: e.clientX, y: e.clientY, start: clip.start, length: clip.length, lane: clip.lane, mode: trim ? "trim" : "move" };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const mode = e.shiftKey ? "beat" : useArrangeUi.getState().snap;
        const cur = useApp.getState().project;
        const me = cur?.clips.find((c) => c.id === clip.id);
        if (!cur || !me) return;
        if (d.mode === "move") {
          const start = snapClipStart(cur, me, d.start + (e.clientX - d.x) / ppb, mode);
          const lane = Math.max(0, Math.min(3, d.lane + Math.round((e.clientY - d.y) / LANE_H)));
          if (start !== me.start || lane !== me.lane) setProject(moveClip(cur, clip.id, start, lane), undefined, `clip:${clip.id}:start`);
        } else {
          const step = mode === "beat" ? 1 : mode === "bar" ? 4 : PHRASE_BEATS;
          const length = Math.max(step, d.length + Math.round((e.clientX - d.x) / ppb / step) * step);
          if (length !== me.length) updateClip(clip.id, withLength(me, length));
        }
      }}
      onPointerUp={() => (drag.current = null)}
    >
      <svg className="pointer-events-none absolute inset-0" width={w} height={LANE_H - 12} preserveAspectRatio="none">
        {clip.lanes
          .filter((l) => show.includes(l.param))
          .map((l) => (
            <polyline key={l.param} points={lanePoints(l, clip, ppb, LANE_H - 12)} fill="none" stroke={PARAM_COLORS[l.param]} strokeWidth={1.3} opacity={0.85} />
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
      <div data-trim="1" className="absolute right-0 top-0 h-full w-2 cursor-ew-resize opacity-0 group-hover:opacity-100" style={{ background: `${color}66` }} />
      {selected && editing && <AutomationEditor clip={clip} ppb={ppb} height={LANE_H - 12} param={editing} />}
    </div>
  );
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
  if (status !== "idle") {
    return (
      <Btn size="sm" tone="accent" style={{ ["--accent" as string]: "#34d399" }} onClick={stopPreview}>
        {status === "loading" ? <Loader2 size={12} className="animate-spin" /> : <Square size={11} fill="currentColor" />}
        {status === "loading" ? "Preparing…" : "Stop"}
      </Btn>
    );
  }
  return (
    <Btn
      size="sm"
      tone="accent"
      style={{ ["--accent" as string]: "#34d399" }}
      disabled={project.clips.length === 0}
      onClick={() => playPreview(project, cursor, Math.min(projectBeats(project) + 8, cursor + 128))}
      title="Plays 32 bars from the marker on the ruler"
    >
      <Play size={11} fill="currentColor" /> Play from bar {Math.floor(cursor / 4) + 1}
    </Btn>
  );
}

/** The start marker, and the moving play head while a preview plays. */
function Playhead({ project, ppb }: { project: MixProject; ppb: number }) {
  const cursor = usePreview((s) => s.cursor);
  const status = usePreview((s) => s.status);
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (status !== "playing") return;
    let raf = 0;
    const tick = () => {
      const { audio, from } = usePreview.getState();
      if (audio && line.current) line.current.style.transform = `translateX(${beatAfter(project, from, audio.currentTime) * ppb}px)`;
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

/** Opens a lane's studio (EQ, compressor and more for every clip on it). */
function LaneStudioButton({ project, lane }: { project: MixProject; lane: number }) {
  const open = useStudio((s) => s.lane === lane);
  const st = project.strips?.[lane];
  const used = !!st && (st.compOn || st.satOn || st.gateOn || (st.eqOn && st.bands.some((b) => b.enabled)) || Math.abs(st.width - 1) > 0.01 || Math.abs(st.outputDb) > 0.01);
  return (
    <button
      type="button"
      onClick={() => openLaneStudio(open ? null : lane)}
      className={clsx("relative flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px]", open ? "border-transparent bg-white/15 text-zinc-50" : "border-white/10 text-zinc-500 hover:text-zinc-200")}
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
