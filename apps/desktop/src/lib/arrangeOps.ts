// Pure edits on mix projects for Arrange: tempo changes, keys per clip, phrase snapping,
// transitions (the same presets as crates/mixit-project/src/transition.rs) and
// transition templates the user saves from their own edits.
import type { AutomationLane, AutomationPoint, Clip, CurveShape, KeyDto, MixProject, ProjectParam, TempoSegment } from "../backend/types";
import { bestShift, compatible, keyDto, keyFromIndex, transpose, type Key } from "./keys";

export const PHRASE_BEATS = 32;
export const EQ_CUT = -26;
/** Echo's index in the effect list (mixit-dsp `FxKind::ALL`). */
export const FX_ECHO = 1;

const RANGE: Record<ProjectParam, [number, number]> = { Volume: [0, 1], EqLow: [-26, 6], EqMid: [-26, 6], EqHigh: [-26, 6], Filter: [-1, 1], FxMix: [0, 1], Pan: [-1, 1], Space: [0, 1], Echo: [0, 1] };
const DEFAULT: Record<ProjectParam, number> = { Volume: 1, EqLow: 0, EqMid: 0, EqHigh: 0, Filter: 0, FxMix: 0, Pan: 0, Space: 0, Echo: 0 };

// ---------------------------------------------------------------- keys

/** A key as projects store it (mixit-core `Key`). */
export interface ProjectKey {
  tonic: number;
  mode: "Major" | "Minor";
}

export function toProjectKey(k: KeyDto | null | undefined): ProjectKey | null {
  if (!k) return null;
  const key = keyFromIndex(k.index);
  return { tonic: key.tonic, mode: key.minor ? "Minor" : "Major" };
}

/** The track's own key, from a clip's track reference. */
export function trackKey(c: Clip): Key | null {
  const k = c.track.key as Partial<ProjectKey> | null | undefined;
  if (!k || typeof k.tonic !== "number" || (k.mode !== "Major" && k.mode !== "Minor")) return null;
  return { tonic: k.tonic, minor: k.mode === "Minor" };
}

/** The key heard from a clip, after its key shift. */
export function clipKey(c: Clip): Key | null {
  const k = trackKey(c);
  return k ? transpose(k, Math.round(c.key_shift)) : null;
}

export function clipKeyDto(c: Clip): KeyDto | null {
  const k = clipKey(c);
  return k ? keyDto(k) : null;
}

/**
 * The clips mixed with this one: `before` plays when it comes in (or ended last before it
 * started), `after` comes in while it plays (or starts first after it ends).
 */
export function neighbours(p: MixProject, clip: Clip): { before: Clip | null; after: Clip | null } {
  let before: Clip | null = null;
  let after: Clip | null = null;
  for (const c of p.clips) {
    if (c.id === clip.id) continue;
    if (c.start < clip.start && (!before || c.start + c.length > before.start + before.length)) before = c;
    if (c.start > clip.start && (!after || c.start < after.start)) after = c;
  }
  return { before, after };
}

/**
 * The smallest key shift (up to ±max semitones) that makes the clip sit well with the
 * clip it mixes out of (or, for the first clip, the one it mixes into). Null when the
 * keys are unknown or nothing within reach fits.
 */
export function matchKeyShift(p: MixProject, clip: Clip, max = 2): number | null {
  const own = trackKey(clip);
  const { before, after } = neighbours(p, clip);
  const ref = before ?? after;
  const target = ref ? clipKey(ref) : null;
  if (!own || !target) return null;
  return bestShift(own, target, max);
}

// ---------------------------------------------------------------- snapping

export type SnapMode = "beat" | "bar" | "phrase";

/**
 * Where a dragged clip lands. "phrase" lines the track's 8-bar phrases up with the
 * phrases of the clip already playing there (or of the mix, when none is), which is
 * how DJs keep drops and breakdowns on the same downbeats.
 */
export function snapClipStart(p: MixProject, clip: Clip, raw: number, mode: SnapMode): number {
  if (mode === "beat") return Math.max(0, Math.round(raw));
  if (mode === "bar") return Math.max(0, Math.round(raw / 4) * 4);
  let ref: Clip | null = null;
  for (const c of p.clips) {
    if (c.id === clip.id || c.lane === clip.lane) continue;
    if (c.start <= raw && raw < c.start + c.length && (!ref || c.start < ref.start)) ref = c;
  }
  // Timeline beat of the phrase grid's origin, and of the clip's own beat 0.
  const origin = ref ? ref.start - ref.source_start : 0;
  const k = Math.round((raw - clip.source_start - origin) / PHRASE_BEATS);
  let start = origin + clip.source_start + k * PHRASE_BEATS;
  while (start < 0) start += PHRASE_BEATS;
  return start;
}

/** Moves a clip, taking its automation with it. */
export function moveClip(p: MixProject, id: number, start: number, lane?: number): MixProject {
  return {
    ...p,
    clips: p.clips.map((c) => {
      if (c.id !== id) return c;
      const d = start - c.start;
      return { ...c, start, lane: lane ?? c.lane, lanes: c.lanes.map((l) => ({ ...l, points: l.points.map((x) => ({ ...x, beat: x.beat + d })) })) };
    }),
  };
}

/**
 * Removes a clip and closes the gap it leaves: the next clip to start after it moves
 * back to where the removed one started (so it mixes in from the clip before instead),
 * and everything after moves with it, markers too. Without a later clip it is a plain
 * remove.
 */
export function rippleDelete(p: MixProject, id: number): MixProject {
  const gone = p.clips.find((c) => c.id === id);
  if (!gone) return p;
  const rest = p.clips.filter((c) => c.id !== id);
  const later = rest.filter((c) => c.start > gone.start);
  if (!later.length) return { ...p, clips: rest };
  const next = Math.min(...later.map((c) => c.start));
  const d = next - gone.start;
  const shift = (c: Clip): Clip => ({ ...c, start: c.start - d, lanes: c.lanes.map((l) => ({ ...l, points: l.points.map((x) => ({ ...x, beat: x.beat - d })) })) });
  return {
    ...p,
    clips: rest.map((c) => (c.start > gone.start ? shift(c) : c)),
    markers: p.markers.filter((m) => m.beat <= gone.start || m.beat >= next).map((m) => (m.beat >= next ? { ...m, beat: m.beat - d } : m)),
  };
}

/** The track beat heard at a timeline beat (counting down for a reversed clip). */
export function sourceBeat(c: Clip, beat: number): number {
  return c.reverse ? c.source_start + c.length - (beat - c.start) : c.source_start + (beat - c.start);
}

// ---------------------------------------------------------------- tempo

export const MIN_BPM = 40;
export const MAX_BPM = 250;

const clampBpm = (b: number) => Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(b * 100) / 100));

/**
 * Adds (or changes) a tempo change at `beat`. With `ramp`, the tempo glides there from
 * the previous change; otherwise it jumps on the beat. The new tempo holds until the
 * next change (like `TempoMap::insert_change`).
 */
export function setTempoChange(p: MixProject, beat: number, bpm: number, ramp: boolean): MixProject {
  const b = Math.max(0, Math.round(beat));
  const v = clampBpm(bpm);
  const segs: TempoSegment[] = p.tempo.segments.filter((s) => Math.abs(s.start_beat - b) > 1e-6).map((s) => ({ ...s }));
  const i = segs.findIndex((s) => s.start_beat > b);
  const idx = i < 0 ? segs.length : i;
  if (idx > 0) segs[idx - 1].end_bpm = ramp ? v : segs[idx - 1].bpm;
  segs.splice(idx, 0, { start_beat: b, bpm: v, end_bpm: v });
  if (segs[0].start_beat !== 0) segs.unshift({ start_beat: 0, bpm: v, end_bpm: v });
  return { ...p, tempo: { ...p.tempo, segments: segs } };
}

/** Removes the tempo change at index `i` (the first segment cannot be removed). */
export function removeTempoChange(p: MixProject, i: number): MixProject {
  const old = p.tempo.segments;
  if (i <= 0 || i >= old.length) return p;
  const segs = old.filter((_, k) => k !== i).map((s) => ({ ...s }));
  const prev = segs[i - 1];
  const next = segs[i];
  const ramped = old[i - 1].end_bpm !== old[i - 1].bpm;
  prev.end_bpm = ramped && next ? next.bpm : prev.bpm;
  return { ...p, tempo: { ...p.tempo, segments: segs } };
}

/** Whether the tempo glides into change `i` (true) or jumps (false). */
export function rampsInto(p: MixProject, i: number): boolean {
  const s = p.tempo.segments;
  return i > 0 && i < s.length && s[i - 1].end_bpm !== s[i - 1].bpm;
}

/** Moves the tempo change at index `i` to a new beat, between its neighbours. */
export function moveTempoChange(p: MixProject, i: number, beat: number): MixProject {
  const s = p.tempo.segments;
  if (i <= 0 || i >= s.length) return p;
  const lo = s[i - 1].start_beat + 1;
  const hi = i + 1 < s.length ? s[i + 1].start_beat - 1 : Infinity;
  const b = Math.max(lo, Math.min(hi, Math.round(beat)));
  return { ...p, tempo: { ...p.tempo, segments: s.map((x, k) => (k === i ? { ...x, start_beat: b } : x)) } };
}

// ---------------------------------------------------------------- automation

function lane(c: Clip, param: ProjectParam): AutomationLane {
  return c.lanes.find((l) => l.param === param) ?? { param, points: [] };
}

function setPoint(c: Clip, param: ProjectParam, beat: number, value: number, curve: CurveShape): Clip {
  const [lo, hi] = RANGE[param];
  const pt: AutomationPoint = { beat, value: Math.max(lo, Math.min(hi, value)), curve };
  const l = lane(c, param);
  const points = [...l.points.filter((x) => Math.abs(x.beat - beat) > 1e-9), pt].sort((a, b) => a.beat - b.beat);
  return { ...c, lanes: [...c.lanes.filter((x) => x.param !== param), { param, points }] };
}

function clearRange(c: Clip, from: number, to: number): Clip {
  return { ...c, lanes: c.lanes.map((l) => ({ ...l, points: l.points.filter((x) => x.beat < from - 1e-9 || x.beat > to + 1e-9) })).filter((l) => l.points.length > 0) };
}

/** A lane's value at a timeline beat (same curves as the engine). */
export function valueAt(c: Clip, param: ProjectParam, beat: number): number {
  const pts = lane(c, param).points;
  if (!pts.length) return DEFAULT[param];
  // Same as `Lane::value_at`: the segment that starts at or before `beat`.
  let i = 0;
  while (i < pts.length && pts[i].beat <= beat) i++;
  if (i === 0) return pts[0].value;
  if (i === pts.length) return pts[i - 1].value;
  const a = pts[i - 1];
  const b = pts[i];
  const span = b.beat - a.beat;
  const t = span > 0 ? Math.max(0, Math.min(1, (beat - a.beat) / span)) : 1;
  const x = (t * Math.PI) / 2;
  const shaped = a.curve === "Linear" ? t : a.curve === "Smooth" ? t * t * (3 - 2 * t) : a.curve === "Hold" ? 0 : b.value >= a.value ? Math.sin(x) : 1 - Math.cos(x);
  return a.value + (b.value - a.value) * shaped;
}

// ---------------------------------------------------------------- transitions

export type TransitionKind = "Blend" | "BassSwap" | "FilterFade" | "EchoOut" | "Cut" | "Brake";

export const TRANSITIONS: { kind: TransitionKind; name: string; explain: string; beats: number }[] = [
  { kind: "Blend", name: "Blend", explain: "Fades one track out while the other fades in. Smooth and safe for most music.", beats: 32 },
  { kind: "BassSwap", name: "Bass swap", explain: "Brings the new track in without its bass, then swaps the basslines on a downbeat so they never clash.", beats: 32 },
  { kind: "FilterFade", name: "Filter fade", explain: "Thins the old track out with a filter while the new one opens up.", beats: 32 },
  { kind: "EchoOut", name: "Echo out", explain: "The old track ends in an echo that rings over the start of the new one.", beats: 8 },
  { kind: "Cut", name: "Cut", explain: "Switches instantly on a downbeat. Punchy, great into a drop.", beats: 0 },
  { kind: "Brake", name: "Brake", explain: "Stops the old track like a turntable, then the new one slams in.", beats: 4 },
];

/**
 * Writes a transition from clip `outId` into clip `inId` (which starts where it is): the
 * outgoing clip is trimmed to end after the overlap, and both clips' automation inside
 * the overlap is replaced. Mirrors `mixit_project::transition::apply`.
 */
export function applyTransition(p: MixProject, outId: number, inId: number, kind: TransitionKind, beats: number): MixProject {
  if (outId === inId) throw new Error("A transition needs two different clips.");
  let o = p.clips.find((c) => c.id === outId);
  let i = p.clips.find((c) => c.id === inId);
  if (!o || !i) throw new Error("That clip is no longer in the mix.");
  const start = i.start;
  if (o.start >= start) throw new Error("The track you mix out of has to start before the one you mix into.");
  beats = Math.max(0, beats);
  const end = start + beats;
  const half = start + Math.round(beats * 0.5);
  if (i.lane === o.lane) i = { ...i, lane: (o.lane + 1) % 4 };
  const tail = kind === "EchoOut" ? Math.max(1, beats) : kind === "Cut" ? 0 : beats;
  o = { ...o, length: Math.max(1, start + tail - o.start) };
  o = clearRange(o, start - 1e-6, o.start + o.length + 1e-6);
  switch (kind) {
    case "Blend":
      o = setPoint(o, "Volume", start, 1, "Power");
      o = setPoint(o, "Volume", end, 0, "Linear");
      break;
    case "BassSwap":
      o = setPoint(o, "EqLow", half - 0.001, 0, "Hold");
      o = setPoint(o, "EqLow", half, EQ_CUT, "Hold");
      o = setPoint(o, "Volume", half, 1, "Smooth");
      o = setPoint(o, "Volume", end, 0, "Linear");
      break;
    case "FilterFade":
      o = setPoint(o, "Filter", start, 0, "Smooth");
      o = setPoint(o, "Filter", end, 0.85, "Linear");
      o = setPoint(o, "Volume", half, 1, "Smooth");
      o = setPoint(o, "Volume", end, 0, "Linear");
      break;
    case "EchoOut":
      o = { ...o, fx: { kind: FX_ECHO, beats: 0.75 } };
      o = setPoint(o, "FxMix", start - 2, 0, "Linear");
      o = setPoint(o, "FxMix", start - 0.01, 0.7, "Hold");
      for (const band of ["EqLow", "EqMid", "EqHigh"] as const) {
        o = setPoint(o, band, start - 0.01, 0, "Hold");
        o = setPoint(o, band, start, EQ_CUT, "Hold");
      }
      break;
    case "Cut":
      break;
    case "Brake":
      o = setPoint(o, "Volume", start - beats, 1, "Smooth");
      o = setPoint(o, "Volume", start, 0, "Hold");
      o = setPoint(o, "Filter", start - beats, 0, "Smooth");
      o = setPoint(o, "Filter", start, -0.9, "Hold");
      o = { ...o, length: Math.max(1, start - o.start) };
      break;
  }
  i = clearRange(i, start - 1e-6, end + 1e-6);
  switch (kind) {
    case "Blend":
      i = setPoint(i, "Volume", start, 0, "Power");
      i = setPoint(i, "Volume", end, 1, "Linear");
      break;
    case "BassSwap":
      i = setPoint(i, "EqLow", start, EQ_CUT, "Hold");
      i = setPoint(i, "EqLow", half, 0, "Hold");
      i = setPoint(i, "Volume", start, 0, "Smooth");
      i = setPoint(i, "Volume", half, 1, "Linear");
      break;
    case "FilterFade":
      i = setPoint(i, "Filter", start, -0.85, "Smooth");
      i = setPoint(i, "Filter", end, 0, "Linear");
      i = setPoint(i, "Volume", start, 0, "Smooth");
      i = setPoint(i, "Volume", half, 1, "Linear");
      break;
    default:
      i = setPoint(i, "Volume", start, 1, "Linear");
  }
  const oo = o;
  const ii = i;
  return { ...p, clips: p.clips.map((c) => (c.id === outId ? oo : c.id === inId ? ii : c)) };
}

/** The clip that the given clip mixes out of: the latest-ending one that starts before it. */
export function mixesOutOf(p: MixProject, clip: Clip): Clip | null {
  return neighbours(p, clip).before;
}

// ---------------------------------------------------------------- templates

interface TemplatePoint {
  /** Beats from the incoming clip's start; scaled with the overlap when it is inside it. */
  at: number;
  value: number;
  curve: CurveShape;
}

export interface TransitionTemplate {
  id: string;
  name: string;
  /** Overlap the template was made with. */
  beats: number;
  out: { param: ProjectParam; points: TemplatePoint[] }[];
  in: { param: ProjectParam; points: TemplatePoint[] }[];
  outFx: Clip["fx"];
  inFx: Clip["fx"];
}

/** How far before the overlap the outgoing moves and after it the incoming moves are kept. */
const LEAD = 16;

/** Saves the transition between two clips (their moves around the overlap) as a template. */
export function captureTemplate(p: MixProject, outId: number, inId: number, name: string): TransitionTemplate {
  const o = p.clips.find((c) => c.id === outId);
  const i = p.clips.find((c) => c.id === inId);
  if (!o || !i) throw new Error("That clip is no longer in the mix.");
  const start = i.start;
  const beats = Math.max(0, o.start + o.length - start);
  const grab = (c: Clip, from: number, to: number) =>
    c.lanes
      .map((l) => ({ param: l.param, points: l.points.filter((x) => x.beat >= from - 1e-9 && x.beat <= to + 1e-9).map((x) => ({ at: x.beat - start, value: x.value, curve: x.curve })) }))
      .filter((l) => l.points.length > 0);
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim() || "My transition",
    beats,
    out: grab(o, start - LEAD, start + beats),
    in: grab(i, start, start + beats + LEAD),
    outFx: o.fx,
    inFx: i.fx,
  };
}

/** Applies a saved template between two clips, stretched to `beats` of overlap. */
export function applyTemplate(p: MixProject, outId: number, inId: number, t: TransitionTemplate, beats = t.beats): MixProject {
  let o = p.clips.find((c) => c.id === outId);
  let i = p.clips.find((c) => c.id === inId);
  if (!o || !i) throw new Error("That clip is no longer in the mix.");
  if (o.start >= i.start) throw new Error("The track you mix out of has to start before the one you mix into.");
  const start = i.start;
  const scale = t.beats > 0 ? beats / t.beats : 1;
  const place = (at: number) => start + (at < 0 ? at : at > t.beats ? beats + (at - t.beats) : at * scale);
  if (i.lane === o.lane) i = { ...i, lane: (o.lane + 1) % 4 };
  o = clearRange({ ...o, length: Math.max(1, start + beats - o.start), fx: t.outFx ?? o.fx }, start - LEAD, start + beats + 1e-6);
  i = clearRange({ ...i, fx: t.inFx ?? i.fx }, start - 1e-6, start + beats + LEAD);
  for (const l of t.out) for (const x of l.points) o = setPoint(o, l.param, place(x.at), x.value, x.curve);
  for (const l of t.in) for (const x of l.points) i = setPoint(i, l.param, place(x.at), x.value, x.curve);
  const oo = o;
  const ii = i;
  return { ...p, clips: p.clips.map((c) => (c.id === outId ? oo : c.id === inId ? ii : c)) };
}

// ---------------------------------------------------------------- checks

export type ProjectIssue = { kind: "overlap"; a: number; b: number } | { kind: "key"; a: number; b: number } | { kind: "stretch"; clip: number; percent: number };

/** Problems worth showing (mirrors `MixProject::check`). */
export function projectIssues(p: MixProject, bpmAt: (beat: number) => number): ProjectIssue[] {
  const out: ProjectIssue[] = [];
  p.clips.forEach((a, n) => {
    for (const b of p.clips.slice(n + 1)) {
      const s = Math.max(a.start, b.start);
      const e = Math.min(a.start + a.length, b.start + b.length);
      if (e <= s) continue;
      if (a.lane === b.lane) out.push({ kind: "overlap", a: a.id, b: b.id });
      const ka = clipKey(a);
      const kb = clipKey(b);
      if (ka && kb && !compatible(ka, kb)) out.push({ kind: "key", a: a.id, b: b.id });
    }
    if (a.track.bpm > 0) {
      const stretch = bpmAt(a.start + a.length / 2) / a.track.bpm;
      const ok = (lo: number, hi: number) => stretch >= lo && stretch <= hi;
      if (!ok(0.92, 1.08) && !ok(0.46, 0.54) && !ok(1.84, 2.16)) out.push({ kind: "stretch", clip: a.id, percent: (stretch - 1) * 100 });
    }
  });
  return out;
}

// ---------------------------------------------------------------- editing many clips

const shiftLanes = (c: Clip, d: number): AutomationLane[] => (d === 0 ? c.lanes : c.lanes.map((l) => ({ ...l, points: l.points.map((x) => ({ ...x, beat: x.beat + d })) })));

/**
 * Moves a group of clips together by `dBeats` and `dLane`, keeping their spacing. The
 * move is limited so no clip goes before the start or off the four lanes.
 */
export function moveClips(p: MixProject, ids: number[], dBeats: number, dLane = 0): MixProject {
  const set = new Set(ids);
  const group = p.clips.filter((c) => set.has(c.id));
  if (!group.length) return p;
  const minStart = Math.min(...group.map((c) => c.start));
  const minLane = Math.min(...group.map((c) => c.lane));
  const maxLane = Math.max(...group.map((c) => c.lane));
  const db = Math.max(-minStart, dBeats);
  const dl = Math.max(-minLane, Math.min(3 - maxLane, dLane));
  if (db === 0 && dl === 0) return p;
  return { ...p, clips: p.clips.map((c) => (set.has(c.id) ? { ...c, start: c.start + db, lane: c.lane + dl, lanes: shiftLanes(c, db) } : c)) };
}

/** Clips copied to the clipboard: their positions relative to the earliest one. */
export interface ClipBoard {
  clips: Clip[];
  /** Length from the earliest start to the latest end. */
  span: number;
}

export function copyClips(p: MixProject, ids: number[]): ClipBoard | null {
  const set = new Set(ids);
  const group = p.clips.filter((c) => set.has(c.id));
  if (!group.length) return null;
  const from = Math.min(...group.map((c) => c.start));
  const to = Math.max(...group.map((c) => c.start + c.length));
  return { clips: group.map((c) => ({ ...c, start: c.start - from, lanes: shiftLanes(c, -from) })), span: to - from };
}

/** Puts clipboard clips into the mix with their earliest start at `at`. Returns the new ids. */
export function pasteClips(p: MixProject, board: ClipBoard, at: number): { project: MixProject; ids: number[] } {
  let next = p.next_id;
  const at0 = Math.max(0, at);
  const added = board.clips.map((c) => ({ ...c, id: next++, start: c.start + at0, lanes: shiftLanes(c, at0) }));
  return { project: { ...p, clips: [...p.clips, ...added], next_id: next }, ids: added.map((c) => c.id) };
}

/** Copies clips to just after the group, on the next bar, so they repeat. */
export function duplicateClips(p: MixProject, ids: number[]): { project: MixProject; ids: number[] } {
  const board = copyClips(p, ids);
  if (!board) return { project: p, ids: [] };
  const from = Math.min(...p.clips.filter((c) => ids.includes(c.id)).map((c) => c.start));
  return pasteClips(p, board, from + Math.ceil(board.span / 4) * 4);
}

export function removeClips(p: MixProject, ids: number[]): MixProject {
  const set = new Set(ids);
  return { ...p, clips: p.clips.filter((c) => !set.has(c.id)) };
}

/** Points of a lane split at `beat`: each side keeps its own points plus the value at the cut. */
function splitLane(c: Clip, l: AutomationLane, beat: number): [AutomationLane, AutomationLane] {
  const v = valueAt(c, l.param, beat);
  const i = l.points.findIndex((x) => x.beat > beat);
  const curve = i > 0 ? l.points[i - 1].curve : (l.points[0]?.curve ?? "Linear");
  const left = l.points.filter((x) => x.beat < beat - 1e-9);
  const right = l.points.filter((x) => x.beat > beat + 1e-9);
  return [
    { ...l, points: [...left, { beat, value: v, curve }] },
    { ...l, points: [{ beat, value: v, curve }, ...right] },
  ];
}

/**
 * Cuts a clip in two at a timeline beat. Both halves keep playing exactly what they
 * played before (a reversed clip too), and automation is cut with the value at the cut
 * kept on both sides. Returns the ids of the two halves, or the project unchanged when
 * the beat is not inside the clip.
 */
export function splitClip(p: MixProject, id: number, beat: number): { project: MixProject; ids: number[] } {
  const c = p.clips.find((x) => x.id === id);
  if (!c || beat <= c.start || beat >= c.start + c.length) return { project: p, ids: [] };
  const k = beat - c.start;
  const lanes = c.lanes.map((l) => splitLane(c, l, beat));
  const a: Clip = { ...c, length: k, source_start: c.reverse ? c.source_start + (c.length - k) : c.source_start, lanes: lanes.map((x) => x[0]) };
  const b: Clip = { ...c, id: p.next_id, start: beat, length: c.length - k, source_start: c.reverse ? c.source_start : c.source_start + k, lanes: lanes.map((x) => x[1]) };
  const clips = p.clips.flatMap((x) => (x.id === id ? [a, b] : [x]));
  return { project: { ...p, clips, next_id: p.next_id + 1 }, ids: [a.id, b.id] };
}

/** Clips that touch a box on the timeline (beats and lanes, ends included). */
export function clipsInBox(p: MixProject, beatA: number, beatB: number, laneA: number, laneB: number): number[] {
  const [b0, b1] = beatA <= beatB ? [beatA, beatB] : [beatB, beatA];
  const [l0, l1] = laneA <= laneB ? [laneA, laneB] : [laneB, laneA];
  return p.clips.filter((c) => c.lane >= l0 && c.lane <= l1 && c.start < b1 && c.start + c.length > b0).map((c) => c.id);
}

/** How many beats a clip fades in or out over, read from its volume automation (0 for none). */
export function fadeOf(c: Clip, side: "in" | "out"): number {
  const pts = lane(c, "Volume").points;
  if (pts.length < 2) return 0;
  if (side === "in") {
    const [a, b] = pts;
    return Math.abs(a.beat - c.start) < 1e-6 && a.value <= 0.001 && b.value >= 0.999 ? b.beat - a.beat : 0;
  }
  const a = pts[pts.length - 2];
  const b = pts[pts.length - 1];
  return Math.abs(b.beat - (c.start + c.length)) < 1e-6 && b.value <= 0.001 && a.value >= 0.999 ? b.beat - a.beat : 0;
}

/**
 * Sets a fade at the start or end of a clip (an equal-power volume ramp of `beats`, 0 to
 * remove it). Other volume moves in the clip are kept, except the ones under the fade.
 */
export function setFade(c: Clip, side: "in" | "out", beats: number): Clip {
  const len = Math.max(0, Math.min(c.length, Math.round(beats * 4) / 4));
  const old = fadeOf(c, side);
  if (old === 0 && len === 0) return c;
  const end = c.start + c.length;
  let out = c;
  // Take away the old fade and anything the new one covers.
  if (side === "in") out = clearRange(out, c.start, c.start + Math.max(old, len));
  else out = clearRange(out, end - Math.max(old, len), end);
  if (len > 0) {
    if (side === "in") {
      out = setPoint(out, "Volume", c.start, 0, "Power");
      out = setPoint(out, "Volume", c.start + len, 1, "Linear");
    } else {
      out = setPoint(out, "Volume", end - len, 1, "Power");
      out = setPoint(out, "Volume", end, 0, "Linear");
    }
  }
  return out;
}

// ---------------------------------------------------------------- markers

export type Marker = MixProject["markers"][number];

const sortMarkers = (m: Marker[]) => [...m].sort((a, b) => a.beat - b.beat);

export function addMarker(p: MixProject, beat: number, label?: string): { project: MixProject; index: number } {
  const b = Math.max(0, Math.round(beat));
  const existing = p.markers.findIndex((m) => Math.abs(m.beat - b) < 1e-6);
  if (existing >= 0) return { project: p, index: existing };
  const markers = sortMarkers([...p.markers, { beat: b, label: label ?? `Marker ${p.markers.length + 1}` }]);
  return { project: { ...p, markers }, index: markers.findIndex((m) => m.beat === b) };
}

export function moveMarker(p: MixProject, index: number, beat: number): MixProject {
  if (!p.markers[index]) return p;
  return { ...p, markers: sortMarkers(p.markers.map((m, i) => (i === index ? { ...m, beat: Math.max(0, Math.round(beat)) } : m))) };
}

export function renameMarker(p: MixProject, index: number, label: string): MixProject {
  return { ...p, markers: p.markers.map((m, i) => (i === index ? { ...m, label } : m)) };
}

export function removeMarker(p: MixProject, index: number): MixProject {
  return { ...p, markers: p.markers.filter((_, i) => i !== index) };
}

/** The marker after (dir 1) or before (dir -1) a beat, for jumping between them. */
export function markerNear(p: MixProject, beat: number, dir: 1 | -1): Marker | null {
  const m = sortMarkers(p.markers);
  return dir > 0 ? (m.find((x) => x.beat > beat + 1e-6) ?? null) : ([...m].reverse().find((x) => x.beat < beat - 1e-6) ?? null);
}
