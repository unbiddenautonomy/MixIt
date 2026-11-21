// "Mix it for me": runs a DJ transition between two decks in time with the music.
// The incoming deck is synced and started on the next bar, then the mixer moves along
// the outgoing deck's beat counter, exactly as a DJ's hands would.
import { create } from "zustand";
import { toast } from "sonner";
import { useApp } from "../store/app";
import { useTelemetry } from "../store/telemetry";
import { press, release, setOn, setValue } from "./actions";

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

export async function startTransition(from: number, to: number, kind: TransitionId, beats: number) {
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
    await setOn(`deck.${b}.sync`, true);
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
  // Start the incoming deck on the next bar of the outgoing one.
  const bpb = df.beatsPerBar || 4;
  const startBeat = Math.ceil((df.beat + 0.25) / bpb) * bpb;
  const echoBeats = kind === "echoOut" ? Math.min(beats, 8) : 0;
  const run: Running = { from, to, kind, beats: Math.max(beats, 1), startBeat, progress: 0 };
  useTransition.getState().set(run);
  let started = dt.playing;
  let swapped = false;
  let last: Record<string, number> = {};
  const send = (id: string, v: number) => {
    if (last[id] === undefined || Math.abs(last[id] - v) > 0.004) {
      last[id] = v;
      setValue(id, v);
    }
  };
  const step = () => {
    const t = useTelemetry.getState().t;
    const beat = t.decks[from].beat;
    const playing = t.decks[from].playing;
    // Start the incoming deck just ahead of the bar (sync aligns the phase).
    if (!started && beat >= startBeat - 0.05 && kind !== "echoOut" && kind !== "brake") {
      started = true;
      press(`deck.${b}.play`);
    }
    const x = clamp((beat - startBeat) / run.beats);
    useTransition.getState().set({ ...run, progress: x });
    if (beat >= startBeat) {
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
    const tt = useTelemetry.getState().t;
    if (tt.decks[from].playing && kind !== "brake") await press(`deck.${a}.play`);
    await press(`deck.${b}.master`);
    // Leave the old deck ready for the next track.
    setValue(`mixer.${a}.eq.low`, 0);
    setValue(`mixer.${a}.filter`, 0);
    setValue(`mixer.${a}.fader`, 1);
    useApp.getState().set({ targetDeck: from });
  };
  stamp = performance.now();
  last = {};
  raf = requestAnimationFrame(step);
}
