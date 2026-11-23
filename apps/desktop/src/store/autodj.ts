// Auto DJ: plays a queue of tracks on decks A and B and mixes each into the next on its
// own, using the same transitions as "Mix it". The plan for each mix (where, how long,
// which transition, key shift) comes from `lib/autodj.ts`; this store loads the next
// track early, cues it, waits for the planned beat and runs the transition, and keeps a
// plain-language log so a beginner can watch what a DJ would do and why.
import { create } from "zustand";
import { toast } from "sonner";
import { backend } from "../backend";
import type { TrackDetail, TrackRow } from "../backend/types";
import { press, setOn, setValue } from "../lib/actions";
import { DEFAULT_OPTIONS, planMix, transitionName, type MixPlan, type PlanOptions } from "../lib/autodj";
import { startTransition, useTransition, type TransitionId } from "../lib/transition";
import { GLIDE_MIN_PCT, glideBars, glideFader } from "../lib/glide";
import { useApp } from "./app";
import { useTelemetry } from "./telemetry";

export type Phase = "off" | "starting" | "playing" | "waiting" | "mixing" | "ending";

export interface LogEntry {
  at: number;
  text: string;
}

interface Next {
  deck: number;
  track: TrackRow;
  detail: TrackDetail;
  plan: MixPlan;
}

interface AutoDjState {
  phase: Phase;
  queue: TrackRow[];
  /** Deck playing the current track (0 or 1), or null. */
  current: number | null;
  next: Next | null;
  /** Track ids played since Auto DJ started (not suggested again). */
  played: number[];
  options: PlanOptions;
  /** When the queue runs out, keep going with suggested tracks. */
  keepGoing: boolean;
  energy: "steady" | "up" | "down";
  /** After each mix, let the tempo drift slowly back to the new track's own. */
  glide: boolean;
  /** The glide under way: on which deck, from which fader, since which beat. */
  gliding: { deck: number; start: number; range: number; fromBeat: number; sent: number } | null;
  /** Transitions chosen by hand for single changes ("<out id>-<in id>"), over Auto DJ's choice. */
  choices: Record<string, TransitionId>;
  log: LogEntry[];
  set: (p: Partial<AutoDjState>) => void;
}

export const useAutoDj = create<AutoDjState>((set) => ({
  phase: "off",
  queue: [],
  current: null,
  next: null,
  played: [],
  options: DEFAULT_OPTIONS,
  keepGoing: true,
  energy: "steady",
  glide: true,
  gliding: null,
  choices: {},
  log: [],
  set: (p) => set(p),
}));

const L = (d: number) => String.fromCharCode(65 + d);
const other = (d: number) => (d === 0 ? 1 : 0);
const st = () => useAutoDj.getState();

function note(text: string) {
  useAutoDj.setState((s) => ({ log: [{ at: Date.now(), text }, ...s.log].slice(0, 40) }));
}

// ------------------------------------------------------------------ choices

/** The plan for the change from `out` into `inc` with Auto DJ's settings and any transition
 * chosen by hand for that change. */
export function planFor(out: TrackDetail, inc: TrackDetail, nowBeat = -Infinity): MixPlan {
  const s = st();
  const chosen = s.choices[`${out.track.id}-${inc.track.id}`];
  if (!chosen) return planMix(out, inc, s.options, nowBeat);
  const plan = planMix(out, inc, { ...s.options, style: chosen }, nowBeat);
  const name = transitionName(chosen).toLowerCase();
  return { ...plan, reasons: [`You chose ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} for this change.`, ...plan.reasons] };
}

/** Chooses the transition for the change from track `a` into track `b` (null: Auto DJ picks). */
export function chooseTransition(a: number, b: number, kind: TransitionId | null) {
  const key = `${a}-${b}`;
  useAutoDj.setState((s) => {
    const choices = { ...s.choices };
    if (kind) choices[key] = kind;
    else delete choices[key];
    return { choices };
  });
  // The coming mix is already planned: plan it again with the new choice.
  const s = st();
  const cur = s.current !== null ? useApp.getState().decks[s.current] : null;
  if (s.next && s.phase === "waiting" && cur && cur.detail.track.id === a && s.next.track.id === b) {
    const now = useTelemetry.getState().t.decks[s.current!]?.beat ?? -Infinity;
    const plan = planFor(cur.detail, s.next.detail, now);
    useAutoDj.setState({ next: { ...s.next, plan } });
    note(`New plan for ${s.next.track.title}: ${plan.summary.toLowerCase()}.`);
  }
}

// ------------------------------------------------------------------ queue

export function enqueue(tracks: TrackRow[], where: "end" | "next" = "end") {
  const have = new Set(st().queue.map((t) => t.id));
  const add = tracks.filter((t) => !have.has(t.id));
  if (add.length === 0) return;
  useAutoDj.setState((s) => ({ queue: where === "next" ? [...add, ...s.queue] : [...s.queue, ...add] }));
  toast.success(where === "next" ? `${add[0].title} plays next` : `Added ${add.length} track${add.length > 1 ? "s" : ""} to Auto DJ`);
  // A track waiting on the deck was chosen before; "play next" replaces it.
  if (where === "next" && st().next && st().phase === "waiting") void prepareNext(true);
}

export function removeFromQueue(index: number) {
  useAutoDj.setState((s) => ({ queue: s.queue.filter((_, i) => i !== index) }));
}

export function moveInQueue(from: number, to: number) {
  useAutoDj.setState((s) => {
    const q = [...s.queue];
    const [x] = q.splice(from, 1);
    q.splice(Math.max(0, Math.min(q.length, to)), 0, x);
    return { queue: q };
  });
}

export function clearQueue() {
  useAutoDj.setState({ queue: [] });
}

/** Shuffles the queue into a smooth order (each track the best match for the one before). */
export function setQueue(tracks: TrackRow[]) {
  useAutoDj.setState({ queue: tracks });
}

// ------------------------------------------------------------------ running

/** Starts Auto DJ: carries on from a deck that is already playing, or starts the queue. */
export async function startAutoDj() {
  if (st().phase !== "off") return;
  const t = useTelemetry.getState().t;
  useAutoDj.setState({ phase: "starting", played: [], next: null, log: [] });
  watch();
  const playing = [0, 1].find((d) => t.decks[d]?.playing);
  if (playing !== undefined && useApp.getState().decks[playing]) {
    const info = useApp.getState().decks[playing]!;
    useAutoDj.setState({ current: playing, phase: "playing", played: [info.detail.track.id] });
    note(`Taking over from deck ${L(playing)}: ${info.detail.track.title}.`);
    await prepareNext();
    return;
  }
  await startFrom(0);
}

/** Starts the queue on deck A from its next track, skipping up to a few that won't load. */
async function startFrom(attempt: number) {
  const first = await takeNext(null);
  if (!first) {
    useAutoDj.setState({ phase: "off" });
    toast.message("Add some tracks first", { description: "Right-click tracks in the library and choose Add to Auto DJ, or drag them onto Auto DJ in the sidebar." });
    unwatch();
    return;
  }
  const deck = 0;
  try {
    const info = await backend().loadTrack(deck, first.id);
    useApp.getState().setDeck(info);
    const cue = info.detail.cues.find((c) => c.role === "mixIn")?.seconds ?? Math.max(0, info.detail.firstBeat);
    await backend().seek(deck, cue);
    await setValue("deck.A.key_shift", 0);
    await setValue("mixer.A.fader", 1);
    await setValue("mixer.A.eq.low", 0);
    await setValue("mixer.A.filter", 0);
    await setValue("mixer.crossfader", 0);
    await press("deck.A.play");
    await press("deck.A.master");
    useAutoDj.setState({ current: deck, phase: "playing", played: [first.id] });
    note(`Started ${first.title} on deck A from its first beat.`);
    await prepareNext();
  } catch (e) {
    note(`Couldn't load ${first.title} (${reason(e)}), so I skipped it.`);
    if (attempt < 4 && st().queue.length) return startFrom(attempt + 1);
    fail(e);
    useAutoDj.setState({ phase: "off" });
    unwatch();
  }
}

/** Stops mixing automatically. The music keeps playing; a running transition finishes. */
export function stopAutoDj() {
  if (st().phase === "off") return;
  useAutoDj.setState({ phase: "off", next: null, gliding: null });
  unwatch();
  note("Auto DJ is off. The music keeps playing, and you are in control.");
}

/** Mixes into the waiting track now (on the next bar) instead of at the planned point. */
export async function mixNow() {
  const s = st();
  if (s.phase !== "waiting" || !s.next || s.current === null) return;
  const t = useTelemetry.getState().t.decks[s.current];
  const bpb = t.beatsPerBar || 4;
  const at = Math.ceil((t.beat + 0.5) / bpb) * bpb;
  await runMix(at);
}

/** Drops the waiting track and loads the one after it. */
export async function skipNext() {
  if (st().phase !== "waiting") return;
  const n = st().next;
  if (n) note(`Skipped ${n.track.title}.`);
  await prepareNext(true);
}

async function takeNext(after: number | null): Promise<TrackRow | null> {
  const s = st();
  if (s.queue.length) {
    // A track whose file is gone can't play: skip it rather than stop the set.
    const skipped = s.queue.filter((t, i) => t.missing && s.queue.slice(0, i).every((x) => x.missing));
    for (const t of skipped) note(`Skipped ${t.title}: its file is missing (moved or deleted). Find it with Fix library.`);
    const rest = s.queue.slice(skipped.length);
    if (rest.length) {
      useAutoDj.setState({ queue: rest.slice(1) });
      return rest[0];
    }
    useAutoDj.setState({ queue: [] });
  }
  if (!s.keepGoing || after === null) return null;
  try {
    const avoid = new Set([...s.played, ...useApp.getState().decks.filter((d) => d).map((d) => d!.detail.track.id)]);
    const sug = await backend().suggestNext(after, s.energy, 25);
    const pick = sug.find((r) => !avoid.has(r.track.id) && !r.track.missing);
    if (pick) note(`The queue is empty, so I picked ${pick.track.title}: ${pick.reasons.slice(0, 2).join(", ").toLowerCase() || "it mixes well"}.`);
    return pick?.track ?? null;
  } catch {
    return null;
  }
}

/** Loads the next track on the free deck, cues it and plans the mix. `replace` puts the
 * waiting track back at the head of the queue (for "play next") or drops it (skip). */
async function prepareNext(replace = false, attempt = 0) {
  const s = st();
  if (s.current === null || s.phase === "off") return;
  const deck = other(s.current);
  const tele = useTelemetry.getState().t.decks;
  if (tele[deck]?.playing) {
    // Still fading out from the last mix; try again shortly.
    window.setTimeout(() => void prepareNext(replace), 1500);
    return;
  }
  const cur = useApp.getState().decks[s.current];
  if (!cur) return;
  if (replace) useAutoDj.setState({ next: null });
  const track = await takeNext(cur.detail.track.id);
  if (!track) {
    useAutoDj.setState({ next: null, phase: "ending" });
    note(`Nothing is queued after ${cur.detail.track.title}. Add tracks to keep the mix going.`);
    return;
  }
  try {
    const info = await backend().loadTrack(deck, track.id);
    useApp.getState().setDeck(info);
    if (st().phase === "off") return;
    const now = useTelemetry.getState().t.decks[s.current]?.beat ?? -Infinity;
    const plan = planFor(cur.detail, info.detail, now);
    const D = L(deck);
    await backend().seek(deck, plan.inCueSeconds);
    await setOn(`deck.${D}.keylock`, true);
    await setValue(`deck.${D}.key_shift`, plan.keyShift);
    useAutoDj.setState({ next: { deck, track, detail: info.detail, plan }, phase: "waiting" });
    note(`Loaded ${track.title} on deck ${D}, cued at its ${info.detail.cues.some((c) => c.role === "mixIn") ? "mix-in point" : "first beat"}. Plan: ${plan.summary.toLowerCase()}.`);
  } catch (e) {
    // One track that won't load must not end the set: skip it and take the next.
    note(`Couldn't load ${track.title} (${reason(e)}), so I skipped it.`);
    if (attempt < 4 && st().phase !== "off") await prepareNext(false, attempt + 1);
    else fail(e);
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");

async function runMix(atBeat: number) {
  const s = st();
  if (!s.next || s.current === null) return;
  const { deck, plan, track } = s.next;
  useAutoDj.setState({ phase: "mixing", gliding: null });
  mixing = true;
  note(`Mixing into ${track.title}: ${plan.summary.toLowerCase()}.`);
  if (plan.loopBeats) note(`Looping the last ${plan.loopBeats} beats of the current track so the mix can run its full ${plan.beats} beats.`);
  await startTransition(s.current, deck, plan.kind, plan.beats, { atBeat, sync: plan.sync, loopBeats: plan.loopBeats });
  // A transition that could not run (nothing playing) counts as done straight away.
  if (!useTransition.getState().running) finished();
}

function finished() {
  mixing = false;
  const s = st();
  if (!s.next) return;
  const n = s.next;
  useAutoDj.setState({ current: n.deck, next: null, phase: "playing", played: [...s.played, n.track.id] });
  note(`Now playing ${n.track.title} on deck ${L(n.deck)}.`);
  startGlide(n.deck);
  void prepareNext();
}

/** Starts the tempo drifting back to the track's own on `deck`, when it is off by enough. */
export function startGlide(deck: number) {
  const d = useTelemetry.getState().t.decks[deck];
  if (!st().glide || !d?.playing || !(d.tempoRange > 0) || Math.abs(d.rate - 1) * 100 < GLIDE_MIN_PCT) return;
  const start = (d.rate - 1) / d.tempoRange;
  if (Math.abs(start) > 1) return; // Beyond the fader: leave it to the DJ.
  useAutoDj.setState({ gliding: { deck, start, range: d.tempoRange, fromBeat: d.beat, sent: start } });
  const bars = glideBars(start, d.tempoRange);
  const own = d.baseBpm;
  note(`The tempo will drift from ${d.bpm.toFixed(1)} back to this track's own ${own.toFixed(1)} BPM over about ${bars} bars, too slowly to notice.`);
}

export function glideTick(t: ReturnType<typeof useTelemetry.getState>["t"]) {
  const g = st().gliding;
  if (!g) return;
  const d = t.decks[g.deck];
  if (!d?.playing) return;
  // The DJ moved the tempo: they have it.
  if (Math.abs(d.tempo - g.sent) > 0.02) {
    useAutoDj.setState({ gliding: null });
    note("You moved the tempo, so I stopped easing it back.");
    return;
  }
  const bars = (d.beat - g.fromBeat) / (d.beatsPerBar || 4);
  const f = glideFader(g.start, g.range, bars);
  if (Math.abs(f - g.sent) * g.range * 100 < 0.02 && f !== 0) return;
  void setValue(`deck.${L(g.deck)}.tempo`, f);
  if (f === 0) {
    useAutoDj.setState({ gliding: null });
    note(`Back at ${L(g.deck)}'s own tempo of ${d.baseBpm.toFixed(1)} BPM.`);
  } else useAutoDj.setState({ gliding: { ...g, sent: f } });
}

// ------------------------------------------------------------------ the watcher

let mixing = false;
let offTele: (() => void) | null = null;
let offTrans: (() => void) | null = null;
let lastTick = 0;

function watch() {
  unwatch();
  offTele = useTelemetry.subscribe((x) => {
    const now = performance.now();
    if (now - lastTick < 100) return;
    lastTick = now;
    tick(x.t);
  });
  offTrans = useTransition.subscribe((x, prev) => {
    if (mixing && prev.running && !x.running) finished();
  });
}

function unwatch() {
  offTele?.();
  offTrans?.();
  offTele = offTrans = null;
  mixing = false;
}

function tick(t: ReturnType<typeof useTelemetry.getState>["t"]) {
  if (!mixing) glideTick(t);
  const s = st();
  if (s.current === null) return;
  const d = t.decks[s.current];
  if (!d) return;
  if (s.phase === "waiting" && s.next && d.playing) {
    // Hand over to the transition a bar before it starts: it syncs the incoming deck,
    // sets the faders and then waits for the exact beat.
    const bpb = d.beatsPerBar || 4;
    const at = s.next.plan.outStartBeat;
    // Past the planned point (the DJ seeked, or the plan was late): the next bar.
    if (d.beat >= at - bpb) void runMix(at > d.beat + 0.25 ? at : Math.ceil((d.beat + 0.5) / bpb) * bpb);
  }
  if (s.phase === "ending" && !d.playing && d.remaining < 1) {
    note("The queue has finished.");
    useAutoDj.setState({ phase: "off" });
    unwatch();
  }
}

/** Seconds until the planned mix starts (null when nothing is waiting). */
export function secondsToMix(t: ReturnType<typeof useTelemetry.getState>["t"]): number | null {
  const s = st();
  if (s.phase !== "waiting" || !s.next || s.current === null) return null;
  const d = t.decks[s.current];
  if (!d || d.bpm <= 0) return null;
  return ((s.next.plan.outStartBeat - d.beat) * 60) / d.bpm;
}

function fail(e: unknown) {
  toast.error(e instanceof Error ? e.message : String(e));
}
