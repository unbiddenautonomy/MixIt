// Hearing a mix before it happens: the planned transition from one track into the next
// (the same plan Auto DJ carries out on the decks) written as a small two-clip project,
// so the renderer can play it in the preview player, in the headphones.
import type { Clip, MixProject, TempoSegment, TrackDetail } from "../backend/types";
import { applyTransition, toProjectKey, type TransitionKind } from "./arrangeOps";
import { beatAtSeconds, type MixPlan } from "./autodj";
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
function loopOut(p: MixProject, at: number, source: number, loop: number): MixProject {
  const o = p.clips.find((c) => c.id === 1);
  if (!o) return p;
  const end = o.start + o.length;
  const pieces: Clip[] = [{ ...o, length: Math.min(o.length, at + loop - o.start) }];
  let id = p.next_id;
  for (let s = at + loop; s < end - 1e-9; s += loop) pieces.push({ ...o, id: id++, start: s, length: Math.min(loop, end - s), source_start: source });
  return { ...p, clips: [...pieces, ...p.clips.filter((c) => c.id !== 1)], next_id: id };
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
