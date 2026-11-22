// Hearing a mix before it happens: the planned transition from one track into the next
// (the same plan Auto DJ carries out on the decks) written as a small two-clip project,
// so the renderer can play it in the preview player, in the headphones.
import type { Clip, MixProject, TrackDetail } from "../backend/types";
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
  const spbOut = 60 / outBpm;
  const spbMix = 60 / (plan.sync ? outBpm : inBpm);
  return { project, from: 0, to: pre + after, mixAt: pre * spbOut, mixEnd: pre * spbOut + beats * spbMix };
}
