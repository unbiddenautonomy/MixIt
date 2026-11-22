// "Mix it for me": runs a DJ transition between two decks in time with the music.
// The incoming deck is synced and started at the top of the next phrase, then the mixer moves along
// the outgoing deck's beat counter, exactly as a DJ's hands would.
import { create } from "zustand";
import { toast } from "sonner";
import { useApp } from "../store/app";
import { useTelemetry } from "../store/telemetry";
import { press, release, setOn, setValue } from "./actions";
import { singingAt } from "./coach";
import { vocalClearStart } from "./vocalTiming";

/** How far the outgoing deck's mids dip while both decks sing during a blend (dB). */
export const VOCAL_DIP_DB = -12;

/** Whether both decks are singing now (half a second ahead for the incoming one). */
export function bothSinging(from: number, to: number): boolean {
  const t = useTelemetry.getState().t;
  const decks = useApp.getState().decks;
  return singingAt(decks[from], t.decks[from].position) && singingAt(decks[to], t.decks[to].position, 0.5);
}

/** The deck loop sizes in beats, in the order of the `loop.size` choice. */
export const LOOP_CHOICES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];

export type TransitionId = "blend" | "bassSwap" | "filterFade" | "echoOut" | "cut" | "brake";

interface Running {
  from: number;
  to: number;
  kind: TransitionId;
  beats: number;
  startBeat: number;
  progress: number;
}

export const useTransition = create<{ running: Running | null; set: (r: Running | null) => void }>((set) => ({
  running: null,
  set: (running) => set({ running }),
}));

const L = (d: number) => String.fromCharCode(65 + d);
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp = (x: number) => Math.max(0, Math.min(1, x));

let raf = 0;

export function cancelTransition() {
  cancelAnimationFrame(raf);
  useTransition.getState().set(null);
}

/** Runs a transition. `opts.atBeat` fixes the outgoing beat where it starts (Auto DJ plans
 * it ahead); otherwise it starts at the next phrase that lines both tracks up.
 * `opts.sync: false` lets the incoming track keep its own tempo (for an echo out or cut
 * between very different tempos). */
export async function startTransition(from: number, to: number, kind: TransitionId, beats: number, opts: { atBeat?: number; sync?: boolean; loopBeats?: number } = {}) {
  const tele = useTelemetry.getState().t;
  const df = tele.decks[from];
  const dt = tele.decks[to];
  if (!dt.loaded) {
    toast.error(`Load a track on deck ${L(to)} first.`);
    return;
  }
  cancelTransition();
  const a = L(from);
  const b = L(to);
  // Prepare the incoming deck: synced, silent, bass cut for a bass swap.
  await setValue("mixer.crossfader", 0);
  if (df.playing) {
    await press(`deck.${a}.master`);
    if (opts.sync === false) {
      await setOn(`deck.${b}.sync`, false);
      await press(`deck.${b}.tempo_reset`);
    } else await setOn(`deck.${b}.sync`, true);
  }
  await setValue(`mixer.${b}.fader`, 0);
  if (kind === "bassSwap") await setValue(`mixer.${b}.eq.low`, -26);
  if (kind === "filterFade") await setValue(`mixer.${b}.filter`, -0.75);
  if (!df.playing) {
    // Nothing to mix from: just start.
    await setValue(`mixer.${b}.fader`, 1);
    await setValue(`mixer.${b}.eq.low`, 0);
    await setValue(`mixer.${b}.filter`, 0);
    if (!dt.playing) await press(`deck.${b}.play`);
    return;
  }
  // Start the incoming deck at the top of the outgoing track's next 8-bar phrase, lined up
  // with the incoming track's own phrases, so builds and drops land together. When the
  // outgoing track would run out first, the next bar has to do.
  const bpb = df.beatsPerBar || 4;
  const nextBar = Math.ceil((df.beat + 0.25) / bpb) * bpb;
  const planned = opts.atBeat !== undefined && opts.atBeat > df.beat;
  let startBeat = planned ? opts.atBeat! : (phraseStart(df.beat, dt.beat, bpb, df.remaining * (df.bpm / 60) - beats) ?? nextBar);
  if (!planned) {
    // Don't start over the middle of a sung line: wait up to a phrase for it to end.
    const clear = mixItStart(useApp.getState().decks[from]?.detail.vocals, df, startBeat, beats, nextBar);
    if (clear.moved) {
      startBeat = clear.start;
      const wait = Math.max(0, Math.round(((startBeat - df.beat) * 60) / Math.max(1, df.bpm)));
      toast(`Deck ${a} is singing, so the mix waits for the line to end: it starts in ${wait} s.`);
    }
  }
  const echoBeats = kind === "echoOut" ? Math.min(beats, 8) : 0;
  const run: Running = { from, to, kind, beats: Math.max(beats, 1), startBeat, progress: 0 };
  useTransition.getState().set(run);
  let started = dt.playing;
  let swapped = false;
  let dipped = false;
  // A short ending loops from the start of the transition (Auto DJ plans when).
  const loopIndex = opts.loopBeats ? LOOP_CHOICES.indexOf(opts.loopBeats) : -1;
  let looped = false;
  let prevRaw: number | null = null;
  let wraps = 0;
  let last: Record<string, number> = {};
  const send = (id: string, v: number) => {
    if (last[id] === undefined || Math.abs(last[id] - v) > 0.004) {
      last[id] = v;
      setValue(id, v);
    }
  };
  const step = () => {
    const t = useTelemetry.getState().t;
    // The outgoing deck's beat, counted on through its loop: a loop jumps the deck back,
    // but the transition keeps going.
    const raw = t.decks[from].beat;
    if (prevRaw !== null && looped && raw < prevRaw - 0.5) wraps += opts.loopBeats ?? 0;
    prevRaw = raw;
    const beat = raw + wraps;
    const playing = t.decks[from].playing;
    // Start the incoming deck just ahead of the bar (sync aligns the phase).
    if (!started && beat >= startBeat - 0.05 && kind !== "echoOut" && kind !== "brake") {
      started = true;
      press(`deck.${b}.play`);
    }
    const x = clamp((beat - startBeat) / run.beats);
    useTransition.getState().set({ ...run, progress: x });
    if (beat >= startBeat) {
      if (loopIndex >= 0 && !looped && kind !== "cut" && kind !== "brake") {
        looped = true;
        void setValue(`deck.${a}.loop.size`, loopIndex).then(() => setOn(`deck.${a}.loop.auto`, true));
      }
      // Two voices at once: the outgoing deck's mids step back while both sing.
      if (kind === "blend" || kind === "bassSwap" || kind === "filterFade") {
        const dip = x < 1 && bothSinging(from, to);
        if (dip !== dipped) {
          dipped = dip;
          setValue(`mixer.${a}.eq.mid`, dip ? VOCAL_DIP_DB : 0);
        }
      }
      switch (kind) {
        case "blend":
          send(`mixer.${b}.fader`, smooth(clamp(x * 2)));
          send(`mixer.${a}.fader`, 1 - smooth(clamp(x * 2 - 1)));
          break;
        case "bassSwap":
          send(`mixer.${b}.fader`, smooth(clamp(x * 2.2)));
          if (!swapped && x >= 0.5) {
            swapped = true;
            setValue(`mixer.${a}.eq.low`, -26);
            setValue(`mixer.${b}.eq.low`, 0);
          }
          if (x > 0.5) send(`mixer.${a}.fader`, 1 - smooth(clamp((x - 0.5) * 2)));
          break;
        case "filterFade":
          send(`mixer.${a}.filter`, 0.8 * smooth(x));
          send(`mixer.${b}.filter`, -0.75 * (1 - smooth(clamp(x * 1.4))));
          send(`mixer.${b}.fader`, smooth(clamp(x * 2)));
          send(`mixer.${a}.fader`, 1 - smooth(clamp(x * 1.6 - 0.6)));
          break;
        case "echoOut":
          if (!swapped) {
            swapped = true;
            setValue(`fx.${a}.1.type`, 1);
            setValue(`fx.${a}.1.mix`, 0.55);
            setOn(`fx.${a}.1.on`, true);
            setValue(`mixer.${a}.fader`, 0.0001);
          }
          if (!started && beat >= startBeat + echoBeats / 2) {
            started = true;
            setValue(`mixer.${b}.fader`, 1);
            press(`deck.${b}.play`);
          }
          break;
        case "brake":
          if (!swapped) {
            swapped = true;
            press(`deck.${a}.brake`);
            release(`deck.${a}.brake`);
          }
          // The brake slows the beat counter, so the next track starts on the clock.
          if (!started && performance.now() - stamp > 1300) {
            started = true;
            setValue(`mixer.${b}.fader`, 1);
            press(`deck.${b}.play`);
          }
          break;
        case "cut":
          setValue(`mixer.${b}.fader`, 1);
          setValue(`mixer.${a}.fader`, 0);
          break;
      }
    }
    const done = kind === "cut" ? beat >= startBeat : kind === "brake" ? started : x >= 1 || !playing;
    if (done) {
      finish();
      return;
    }
    raf = requestAnimationFrame(step);
  };
  let stamp = performance.now();
  const finish = async () => {
    useTransition.getState().set(null);
    setValue(`mixer.${b}.fader`, 1);
    setValue(`mixer.${b}.eq.low`, 0);
    setValue(`mixer.${b}.filter`, 0);
    if (kind === "echoOut") {
      setTimeout(() => setOn(`fx.${a}.1.on`, false), 4000);
    }
    if (looped) await setOn(`deck.${a}.loop.auto`, false);
    const tt = useTelemetry.getState().t;
    if (tt.decks[from].playing && kind !== "brake") await press(`deck.${a}.play`);
    await press(`deck.${b}.master`);
    // Leave the old deck ready for the next track.
    setValue(`mixer.${a}.eq.low`, 0);
    if (dipped) setValue(`mixer.${a}.eq.mid`, 0);
    setValue(`mixer.${a}.filter`, 0);
    setValue(`mixer.${a}.fader`, 1);
    useApp.getState().set({ targetDeck: from });
  };
  stamp = performance.now();
  last = {};
  raf = requestAnimationFrame(step);
}

/**
 * Where Mix it starts once the outgoing deck's singing is taken into account: the planned
 * start, or up to one phrase later when that gets the transition clear of a sung line.
 * `d` is the outgoing deck's telemetry; it never starts before `earliest`.
 */
export function mixItStart(
  vocals: [number, number][] | undefined,
  d: { beat: number; position: number; baseBpm: number; bpm: number; remaining: number; beatsPerBar: number },
  candidate: number,
  beats: number,
  earliest: number,
) {
  const bpb = d.beatsPerBar || 4;
  const perBeat = 60 / Math.max(1, d.baseBpm);
  return vocalClearStart({
    regions: vocals,
    secondsAt: (b) => d.position + (b - d.beat) * perBeat,
    candidate,
    beats,
    beatsPerBar: bpb,
    endBeat: d.beat + (d.remaining * d.bpm) / 60,
    earliest: Math.max(candidate, earliest),
    maxMove: bpb * 8,
  });
}

/**
 * The outgoing deck's beat at which to start the incoming deck so both tracks' 8-bar
 * phrases line up: the incoming deck starts from `inBeat` (rounded to its bar). Null when
 * that is more than `room` beats away.
 */
export function phraseStart(outBeat: number, inBeat: number, beatsPerBar: number, room: number): number | null {
  const phrase = beatsPerBar * 8;
  const inPhase = (((Math.round(inBeat / beatsPerBar) * beatsPerBar) % phrase) + phrase) % phrase;
  const from = outBeat + 0.25;
  const k = Math.ceil((from - inPhase) / phrase);
  const start = inPhase + k * phrase;
  return start - outBeat <= Math.max(0, room) ? start : null;
}
