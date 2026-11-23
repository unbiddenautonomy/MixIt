// "Mix it" on Smart: the same choices Auto DJ makes (transition, length, key shift, a
// loop for a short ending, between sung lines), for a mix that starts now rather than at
// the track's mix-out point. The plan is pure; `smartMix` carries it out on the decks.
import { toast } from "sonner";
import type { TrackDetail } from "../backend/types";
import { deckCount, useApp } from "../store/app";
import { useAutoDj } from "../store/autodj";
import { hearMix, hearNext } from "../store/rehearse";
import { useTelemetry } from "../store/telemetry";
import { setOn, setValue } from "./actions";
import { DEFAULT_OPTIONS, planMix, secondsAtBeat, transitionName, type MixPlan, type PlanOptions } from "./autodj";
import { mixItBeat, startTransition, transitionPair, type TransitionId } from "./transition";

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
  if (!d?.playing) {
    await startTransition(from, to, "blend", 32);
    return null;
  }
  if (!out?.bpm || !inc?.bpm) {
    // No measured tempo to sync to (not analysed yet): echo out, the next track at its own speed.
    toast("Echo out over 8 beats", { description: `${!inc?.bpm ? (inc?.track.title ?? "The next track") : out!.track.title} has not been analysed yet, so the tempos can't be matched.` });
    await startTransition(from, to, "echoOut", 8, { sync: false });
    return null;
  }
  const plan = { ...planNow(out, inc, d.beat), inCueSeconds: useTelemetry.getState().t.decks[to]?.position ?? 0 };
  if (plan.keyShift !== 0) {
    await setOn(`deck.${L(to)}.keylock`, true);
    await setValue(`deck.${L(to)}.key_shift`, plan.keyShift);
  }
  toast(`${plan.summary}`, { description: plan.reasons.slice(0, 2).join(" ") });
  await startTransition(from, to, plan.kind, plan.beats, { atBeat: plan.outStartBeat, sync: plan.sync, loopBeats: plan.loopBeats });
  return plan;
}

/**
 * What Mix it would do from deck `from` into deck `to` right now, as a plan the preview can
 * play: on Smart the plan Auto DJ would make, otherwise the chosen transition and length from
 * where Mix it would start it. The incoming track starts from where its deck is cued. Null
 * when the outgoing deck is not playing or either track has no tempo.
 */
export function mixItPlan(from: number, to: number, kind: TransitionId | "smart", len: number): { out: TrackDetail; inc: TrackDetail; plan: MixPlan } | null {
  if (from === to) return null;
  const decks = useApp.getState().decks;
  const out = decks[from]?.detail;
  const inc = decks[to]?.detail;
  const t = useTelemetry.getState().t;
  const df = t.decks[from];
  const dt = t.decks[to];
  if (!out?.bpm || !inc?.bpm || !df?.playing || !dt?.loaded) return null;
  const inCueSeconds = dt.position;
  if (kind === "smart") return { out, inc, plan: { ...planNow(out, inc, df.beat), inCueSeconds } };
  const beats = kind === "cut" ? 0 : len;
  const start = mixItBeat(df, dt, beats, out.vocals).start;
  const summary = kind === "cut" ? "Cut on the bar" : kind === "brake" ? "Brake stop" : `${transitionName(kind)} over ${beats} beats`;
  const plan: MixPlan = {
    kind,
    beats,
    outStartBeat: start,
    outStartSeconds: secondsAtBeat(out, start),
    inCueSeconds,
    tempoChangePct: inc.bpm ? ((out.bpm - inc.bpm) / inc.bpm) * 100 : 0,
    keyShift: 0,
    loopBeats: 0,
    sync: true,
    summary,
    reasons: [],
  };
  return { out, inc, plan };
}

/** Mix it from the keyboard or the command palette: a smart mix between the decks the
 * mixer's Mix it button would use (the playing deck into the loaded one). */
export function mixItNow(): void {
  const pair = transitionPair(deckCount());
  if (!pair) {
    toast("Load a track on a deck first.");
    return;
  }
  if (pair[0] === pair[1]) void startTransition(pair[0], pair[1], "blend", 32);
  else void smartMix(pair[0], pair[1]);
}

/** Hears the coming mix first: Auto DJ's next one while it plays, else Mix it's smart mix. */
export function hearComingMix(): void {
  const s = useAutoDj.getState();
  if (s.phase !== "off" && s.next) {
    void hearNext();
    return;
  }
  const pair = transitionPair(deckCount());
  const m = pair ? mixItPlan(pair[0], pair[1], "smart", 32) : null;
  if (!m) toast("Play the deck you are mixing out of first, with an analysed track loaded on another deck.");
  else void hearMix("mixer", m.out, m.inc, m.plan);
}
