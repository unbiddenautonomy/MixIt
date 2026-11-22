// "Mix it" on Smart: the same choices Auto DJ makes (transition, length, key shift, a
// loop for a short ending, between sung lines), for a mix that starts now rather than at
// the track's mix-out point. The plan is pure; `smartMix` carries it out on the decks.
import { toast } from "sonner";
import type { TrackDetail } from "../backend/types";
import { useApp } from "../store/app";
import { useTelemetry } from "../store/telemetry";
import { setOn, setValue } from "./actions";
import { DEFAULT_OPTIONS, planMix, secondsAtBeat, type MixPlan, type PlanOptions } from "./autodj";
import { startTransition } from "./transition";

/** The plan for mixing `out` (now at grid beat `nowBeat`) into `inc` as soon as the
 * music allows: the next phrase, or the next bar when the track ends sooner. */
export function planNow(out: TrackDetail, inc: TrackDetail, nowBeat: number, opts: PlanOptions = DEFAULT_OPTIONS): MixPlan {
  // Treat "now" as the mix-out point, so the plan starts at the next phrase from here.
  const here = secondsAtBeat(out, nowBeat + 0.25);
  const now: TrackDetail = { ...out, cues: [...out.cues.filter((c) => c.role !== "mixOut"), { role: "mixOut", slot: null, seconds: here, loopSeconds: null, label: "Now", color: null }] };
  return planMix(now, inc, opts, nowBeat);
}

const L = (d: number) => String.fromCharCode(65 + d);

/** Plans and runs a smart mix from deck `from` into deck `to`. Returns the plan, or null
 * when a deck has no analysed track (then it falls back to a blend). */
export async function smartMix(from: number, to: number): Promise<MixPlan | null> {
  const decks = useApp.getState().decks;
  const out = decks[from]?.detail;
  const inc = decks[to]?.detail;
  const d = useTelemetry.getState().t.decks[from];
  if (!out?.bpm || !inc?.bpm || !d?.playing) {
    await startTransition(from, to, "blend", 32);
    return null;
  }
  const plan = planNow(out, inc, d.beat);
  if (plan.keyShift !== 0) {
    await setOn(`deck.${L(to)}.keylock`, true);
    await setValue(`deck.${L(to)}.key_shift`, plan.keyShift);
  }
  toast(`${plan.summary}`, { description: plan.reasons.slice(0, 2).join(" ") });
  await startTransition(from, to, plan.kind, plan.beats, { atBeat: plan.outStartBeat, sync: plan.sync, loopBeats: plan.loopBeats });
  return plan;
}
