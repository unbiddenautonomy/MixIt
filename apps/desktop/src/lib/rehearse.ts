// Hearing a mix before it happens: the planned transition from one track into the next
// (the same plan Auto DJ carries out on the decks) written as a small two-clip project,
// so the renderer can play it in the preview player, in the headphones.
import type { Clip, MixProject, TempoSegment, TrackDetail } from "../backend/types";
import { applyTransition, toProjectKey, type TransitionKind } from "./arrangeOps";
import { beatAtSeconds, type MixPlan } from "./autodj";
import { GLIDE_MIN_PCT, GLIDE_PCT_PER_BAR } from "./glide";
import type { TransitionId } from "./transition";

const KINDS: Record<TransitionId, TransitionKind> = {
  blend: "Blend",
  bassSwap: "BassSwap",
  filterFade: "FilterFade",
  echoOut: "EchoOut",
  cut: "Cut",
  brake: "Brake",
};

export interface Rehearsal {
  project: MixProject;
  /** The passage to play (project beats). */
  from: number;
  to: number;
  /** Seconds into the passage where the transition starts and where it is over. */
  mixAt: number;
  mixEnd: number;
}

function clip(d: TrackDetail, id: number, lane: number, start: number, length: number, sourceStart: number): Clip {
  const t = d.track;
  return {
    id,
    track: { hash: null, path: t.path, title: t.title, artist: t.artist, bpm: d.bpm ?? 120, key: toProjectKey(d.key), duration: t.duration },
    lane,
    start,
    length,
    source_start: sourceStart,
    key_shift: 0,
    keylock: true,
    gain_db: 0,
    lanes: [],
    fx: null,
    name: t.title,
  };
}

/**
 * The plan from `out` into `inc` as a project: `lead` beats of the outgoing track before the
 * transition, the transition itself, and `tail` beats of the incoming track after it. The
 * project runs at the outgoing tempo; when the plan does not sync, the tempo changes to the
 * incoming track's own where the transition starts (an echo out, cut or brake).
 */
export function rehearsal(out: TrackDetail, inc: TrackDetail, plan: MixPlan, lead = 16, tail = 16): Rehearsal {
  const outBpm = out.bpm ?? 120;
  const inBpm = inc.bpm ?? outBpm;
  // The outgoing track has to have that much music before the mix point.
  const pre = Math.max(0, Math.min(lead, Math.floor(plan.outStartBeat)));
  const beats = plan.kind === "cut" ? 0 : Math.max(1, plan.beats);
  const after = beats + tail;
  const a = clip(out, 1, 0, 0, pre + after, plan.outStartBeat - pre);
  const b = { ...clip(inc, 2, 1, pre, after, Math.max(0, beatAtSeconds(inc, plan.inCueSeconds))), key_shift: plan.keyShift };
  const segments = plan.sync
    ? [{ start_beat: 0, bpm: outBpm, end_bpm: outBpm }]
    : [
        { start_beat: 0, bpm: outBpm, end_bpm: outBpm },
        { start_beat: pre, bpm: inBpm, end_bpm: inBpm },
      ];
  let project: MixProject = {
    version: 1,
    name: `${out.track.title} into ${inc.track.title}`,
    tempo: { segments, time_signatures: [{ start_beat: 0, numerator: out.beatsPerBar || 4, denominator: 4 }] },
    clips: [a, b],
    markers: [{ beat: pre, label: "Mix" }],
    master_gain_db: 0,
    next_id: 3,
  };
  project = applyTransition(project, 1, 2, KINDS[plan.kind], beats);
  if (plan.loopBeats > 0) project = loopOut(project, pre, plan.outStartBeat, plan.loopBeats);
  const spbOut = 60 / outBpm;
  const spbMix = 60 / (plan.sync ? outBpm : inBpm);
  return { project, from: 0, to: pre + after, mixAt: pre * spbOut, mixEnd: pre * spbOut + beats * spbMix };
}

/** Plays the outgoing clip's `loop` beats from timeline beat `at` (track beat `source`)
 * over and over to its end, as the deck's loop does: the clip is cut there and repeated,
 * each piece keeping the transition's automation. */
function loopOut(p: MixProject, at: number, source: number, loop: number, clipId = 1): MixProject {
  const o = p.clips.find((c) => c.id === clipId);
  if (!o) return p;
  const end = o.start + o.length;
  const pieces: Clip[] = [{ ...o, length: Math.min(o.length, at + loop - o.start) }];
  let id = p.next_id;
  for (let s = at + loop; s < end - 1e-9; s += loop) pieces.push({ ...o, id: id++, start: s, length: Math.min(loop, end - s), source_start: source });
  return { ...p, clips: [...pieces, ...p.clips.filter((c) => c.id !== clipId)], next_id: id };
}

export interface Medley {
  project: MixProject;
  from: number;
  to: number;
  /** Each change: where its transition starts and ends (seconds into the medley), and what it is. */
  changes: { at: number; end: number; label: string }[];
}

/**
 * Every change of a set, one after another: for each pair, `lead` beats before the
 * transition, the transition and `tail` beats after it, played back to back so a whole
 * queue can be checked in a few minutes.
 */
export function medley(steps: { out: TrackDetail; inc: TrackDetail; plan: MixPlan }[], lead = 8, tail = 8): Medley {
  const clips: Clip[] = [];
  const segments: TempoSegment[] = [];
  const markers: MixProject["markers"] = [];
  const changes: Medley["changes"] = [];
  let beat = 0;
  let seconds = 0;
  let id = 1;
  for (const { out, inc, plan } of steps) {
    const r = rehearsal(out, inc, plan, lead, tail);
    for (const c of r.project.clips) {
      clips.push({ ...c, id: id++, start: c.start + beat, lanes: c.lanes.map((l) => ({ ...l, points: l.points.map((p) => ({ ...p, beat: p.beat + beat })) })) });
    }
    for (const s of r.project.tempo.segments) segments.push({ ...s, start_beat: s.start_beat + beat });
    markers.push({ beat: beat + (r.project.markers[0]?.beat ?? 0), label: `${out.track.title} into ${inc.track.title}` });
    changes.push({ at: seconds + r.mixAt, end: seconds + r.mixEnd, label: `${out.track.title} into ${inc.track.title}` });
    // This step's length in seconds: its passage at its own tempo map.
    seconds += passageSeconds(r.project.tempo.segments, r.to - r.from);
    beat += r.to - r.from;
  }
  return {
    project: { version: 1, name: "Rehearse the set", tempo: { segments, time_signatures: [{ start_beat: 0, numerator: 4, denominator: 4 }] }, clips, markers, master_gain_db: 0, next_id: id },
    from: 0,
    to: beat,
    changes,
  };
}

/** Seconds of the first `beats` beats under constant-tempo segments. */
function passageSeconds(segs: TempoSegment[], beats: number): number {
  let t = 0;
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i].start_beat;
    const b = Math.min(beats, segs[i + 1]?.start_beat ?? beats);
    if (b > a) t += ((b - a) * 60) / segs[i].bpm;
  }
  return t;
}

/** The tempo at `beat` under `segs` (ramps are linear in beats up to the next segment). */
export function tempoAt(segs: TempoSegment[], beat: number): number {
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].start_beat <= beat) i++;
  const s = segs[i];
  const next = segs[i + 1]?.start_beat;
  if (next === undefined || next <= s.start_beat) return s.end_bpm;
  return s.bpm + ((s.end_bpm - s.bpm) * (beat - s.start_beat)) / (next - s.start_beat);
}

/** Holds the tempo from `beat` on at `bpm`: later segments go, a ramp running past it stops there. */
function holdFrom(segs: TempoSegment[], beat: number, bpm: number): TempoSegment[] {
  const at = tempoAt(segs, beat);
  const keep = segs.filter((s) => s.start_beat < beat - 1e-9).map((s) => ({ ...s }));
  const last = keep[keep.length - 1];
  if (last && last.end_bpm !== last.bpm) last.end_bpm = at;
  keep.push({ start_beat: beat, bpm, end_bpm: bpm });
  return keep;
}

/**
 * A whole set as one mix project, every change as Auto DJ plans it: each track whole from
 * where it comes in (the first from its start) until its transition into the next is over,
 * with that transition's automation, key shift and short-ending loop. Synced tracks play at
 * the tempo of the one before; with `glide`, the tempo then eases back to each track's own
 * as Auto DJ does live. Ready to edit in Arrange and render to a file.
 */
export function setMix(details: TrackDetail[], plans: MixPlan[], opts: { glide?: boolean; name?: string } = {}): MixProject {
  if (details.length === 0) throw new Error("A mix needs at least one track.");
  const first = details[0];
  const bpb = first.beatsPerBar || 4;
  const endBeat = (d: TrackDetail) => Math.max(1, beatAtSeconds(d, d.track.duration));
  let project: MixProject = {
    version: 1,
    name: opts.name ?? "Auto DJ set",
    tempo: { segments: [{ start_beat: 0, bpm: first.bpm ?? 120, end_bpm: first.bpm ?? 120 }], time_signatures: [{ start_beat: 0, numerator: bpb, denominator: 4 }] },
    clips: [clip(first, 1, 0, 0, endBeat(first), 0)],
    markers: [],
    master_gain_db: 0,
    next_id: 2,
  };
  // The clip playing now: its id, where it starts on the timeline and in its track.
  let cur = { id: 1, start: 0, source: 0 };
  let free = 0; // The first timeline beat a new mix may start (the last one is over).
  for (let i = 0; i + 1 < details.length && i < plans.length; i++) {
    const out = details[i];
    const inc = details[i + 1];
    const plan = plans[i];
    const beats = plan.kind === "cut" ? 0 : Math.max(1, plan.beats);
    // Where the mix starts on the timeline; never over the last mix (a short track).
    let at = cur.start + (plan.outStartBeat - cur.source);
    if (at < free) at = cur.start + Math.ceil((free - cur.start) / bpb) * bpb;
    const outAt = cur.source + (at - cur.start);
    const source = Math.max(0, beatAtSeconds(inc, plan.inCueSeconds));
    const id = project.next_id;
    const lane = (project.clips.find((c) => c.id === cur.id)?.lane ?? 0) === 0 ? 1 : 0;
    const b = { ...clip(inc, id, lane, at, Math.max(1, endBeat(inc) - source), source), key_shift: plan.keyShift };
    project = { ...project, clips: [...project.clips, b], next_id: id + 1 };
    project = applyTransition(project, cur.id, id, KINDS[plan.kind], beats);
    if (plan.loopBeats > 0) project = loopOut(project, at, outAt, plan.loopBeats, cur.id);
    // Tempo: the new track follows the old one's tempo through the mix (or keeps its own).
    const segs = project.tempo.segments;
    const now = tempoAt(segs, at);
    const own = inc.bpm ?? now;
    let next = holdFrom(segs, at, plan.sync ? now : own);
    const pct = Math.abs(now / own - 1) * 100;
    if (plan.sync && opts.glide && pct > GLIDE_MIN_PCT) {
      const end = at + beats;
      const glide = Math.ceil(pct / GLIDE_PCT_PER_BAR - 1e-9) * (inc.beatsPerBar || 4);
      next = [...next.filter((s) => s.start_beat < end - 1e-9), { start_beat: end, bpm: now, end_bpm: own }, { start_beat: end + glide, bpm: own, end_bpm: own }];
    }
    project = { ...project, tempo: { ...project.tempo, segments: next }, markers: [...project.markers, { beat: at, label: `${out.track.title} into ${inc.track.title}` }] };
    cur = { id, start: at, source };
    free = at + beats;
  }
  return project;
}
