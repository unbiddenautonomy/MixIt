// Every control goes through here: it updates the UI-owned mixer state and sends the
// action to the engine by its registry ID.
import { toast } from "sonner";
import { backend } from "../backend";
import type { ActionInput, ActionSpec } from "../backend/types";
import { MASTER_FX, useApp } from "../store/app";
import { mirrorMic, startMicRecording, stopMicRecording, toggleMicRecording } from "../store/mic";
import { mirrorStudio } from "../store/studio";
import { faderMoved } from "./performance";
import { keyLabel } from "./platform";

function report(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/handled by the app/.test(msg)) toast.error(msg);
}

export function act(id: string, input: ActionInput): Promise<void> {
  if (id === "mic.record") {
    // Recording the mic needs the app: it collects the take and puts it on a pad or in
    // the library.
    if (input.type === "press") void toggleMicRecording();
    else if (input.type === "set") void (input.value ? startMicRecording() : stopMicRecording());
    return Promise.resolve();
  }
  mirror(id, input);
  return backend().action(id, input).catch(report);
}

export const press = (id: string) => act(id, { type: "press" });
export const release = (id: string) => act(id, { type: "release" });
export const setValue = (id: string, value: number) => act(id, { type: "value", value });
export const setOn = (id: string, value: boolean) => act(id, { type: "set", value });
export const choose = (id: string, value: number) => act(id, { type: "choice", value });

/** A click on a trigger or momentary control. */
export async function tap(id: string) {
  await press(id);
  await release(id);
}

/** Keeps the mixer store in step with actions from any source (keys, palette, coach). */
function mirror(id: string, input: ActionInput) {
  const p = id.split(".");
  const s = useApp.getState();
  const v = input.type === "value" || input.type === "choice" ? input.value : input.type === "set" ? Number(input.value) : null;
  if (id === "mixer.bypass") {
    if (input.type !== "release") s.setMixer({ bypass: input.type === "press" ? !s.mixer.bypass : Boolean(v) });
    return;
  }
  if (p[0] === "mixer" && p[1].length === 1) {
    const deck = p[1].charCodeAt(0) - 65;
    const ch = s.mixer.channels[deck];
    if (!ch) return;
    const c = p.slice(2).join(".");
    if (v !== null) {
      if (c === "trim") s.setChannel(deck, { trim: v });
      else if (c === "eq.high") s.setChannel(deck, { high: v });
      else if (c === "eq.mid") s.setChannel(deck, { mid: v });
      else if (c === "eq.low") s.setChannel(deck, { low: v });
      else if (c === "filter") s.setChannel(deck, { filter: v });
      else if (c === "fader") {
        faderMoved(deck, ch.fader, v);
        s.setChannel(deck, { fader: v });
      }
      else if (c === "pan") s.setChannel(deck, { pan: v });
      else if (c === "punch") s.setChannel(deck, { punch: v });
      else if (c === "warmth") s.setChannel(deck, { warmth: v });
      else if (c === "width") s.setChannel(deck, { width: v });
      else if (c === "space") s.setChannel(deck, { space: v });
      else if (c === "echo") s.setChannel(deck, { echo: v });
      else if (c === "duck_source") s.setChannel(deck, { duckSource: v });
      else if (c === "duck") s.setChannel(deck, { duck: v });
    }
    if (c === "gate") s.setChannel(deck, { gate: input.type === "press" ? !ch.gate : Boolean(v) });
    mirrorStudio(deck, c, input.type === "press" ? null : v);
    if (c === "cue") s.setChannel(deck, { cue: input.type === "press" ? !ch.cue : Boolean(v) });
    if (c === "assign" && v !== null) s.setMixer({ assign: s.mixer.assign.map((x, i) => (i === deck ? v : x)) });
    if (c.startsWith("eq.kill.")) {
      const band = ["low", "mid", "high"].indexOf(p[4]);
      const kills = [...ch.kills] as [boolean, boolean, boolean];
      kills[band] = input.type === "press" ? !kills[band] : Boolean(v);
      s.setChannel(deck, { kills });
    }
  } else if (p[0] === "mixer" && v !== null) {
    if (p[1] === "crossfader") s.setMixer({ crossfader: v });
    else if (p[1] === "master") s.setMixer({ master: v });
    else if (p[1] === "headphones") s.setMixer({ headphones: v });
    else if (p[1] === "cue_mix") s.setMixer({ cueMix: v });
    else if (p[1] === "crossfader_curve") s.setMixer({ crossfaderCurve: v });
    else if (p[1] === "fader_curve") s.setMixer({ faderCurve: v });
    else if (p[1] === "eq_mode") s.setMixer({ eqMode: v });
    else if (p[1] === "split_cue") s.setMixer({ splitCue: Boolean(v) });
    else if (p[1] === "crossfader_reverse") s.setMixer({ crossfaderReverse: Boolean(v) });
    else if (p[1] === "glue") {
      s.setMixer({ glue: v });
      mirrorStudio(null, "glue", v);
    } else if (id === "mixer.space.level") s.setMixer({ spaceLevel: v });
    else if (id === "mixer.space.size") s.setMixer({ spaceSize: v });
    else if (id === "mixer.echo.level") s.setMixer({ echoLevel: v });
    else if (id === "mixer.echo.feedback") s.setMixer({ echoFeedback: v });
    else if (id === "mixer.echo.time") s.setMixer({ echoTime: v });
  } else if (p[0] === "mic") {
    mirrorMic(p.slice(1).join("."), input);
  } else if (p[0] === "sampler" && p[1] === "volume" && v !== null) {
    s.setMixer({ samplerVolume: v });
  } else if (p[0] === "fx") {
    const deck = p[1] === "master" ? MASTER_FX : p[1].charCodeAt(0) - 65;
    const slot = Number(p[2]) - 1;
    const f = s.mixer.fx[deck]?.[slot];
    if (!f) return;
    if (p[3] === "type" && v !== null) s.setFx(deck, slot, { type: v });
    else if (p[3] === "on") s.setFx(deck, slot, { on: input.type === "press" ? !f.on : Boolean(v) });
    else if (p[3] === "mix" && v !== null) s.setFx(deck, slot, { mix: v });
    else if (p[3] === "beats" && v !== null) s.setFx(deck, slot, { beats: v });
    else if (p[3] === "p1" && v !== null) s.setFx(deck, slot, { p1: v });
    else if (p[3] === "p2" && v !== null) s.setFx(deck, slot, { p2: v });
  } else if (p[0] === "deck" && v !== null) {
    const deck = p[1].charCodeAt(0) - 65;
    if (p[2] === "loop" && p[3] === "size") s.setMixer({ loopSize: s.mixer.loopSize.map((x, i) => (i === deck ? v : x)) });
    if (p[2] === "slice" && p[3] === "size") s.setMixer({ sliceSize: s.mixer.sliceSize.map((x, i) => (i === deck ? v : x)) });
    if (p[2] === "keypad" && p[3] === "cue") s.setMixer({ keypadCue: s.mixer.keypadCue.map((x, i) => (i === deck ? v : x)) });
    if (p[2] === "keypad" && p[3] === "range") s.setMixer({ keypadRange: s.mixer.keypadRange.map((x, i) => (i === deck ? v : x)) });
    if (p[2] === "beatjump" && p[3] === "size") s.setMixer({ jumpSize: s.mixer.jumpSize.map((x, i) => (i === deck ? v : x)) });
  } else if (p[0] === "deck" && p[2] === "hotcue" && /^\d+$/.test(p[3] ?? "") && p.length === 4 && input.type === "press") {
    // A hot cue press also picks it for the key pads (as the engine does).
    const deck = p[1].charCodeAt(0) - 65;
    s.setMixer({ keypadCue: s.mixer.keypadCue.map((x, i) => (i === deck ? Number(p[3]) - 1 : x)) });
  } else if (p[0] === "deck" && p[2] === "loop" && (p[3] === "halve" || p[3] === "double") && input.type === "press") {
    const deck = p[1].charCodeAt(0) - 65;
    const d = p[3] === "halve" ? -1 : 1;
    s.setMixer({ loopSize: s.mixer.loopSize.map((x, i) => (i === deck ? Math.max(0, Math.min(10, x + d)) : x)) });
  }
}

export function findAction(id: string): ActionSpec | undefined {
  return useApp.getState().registry.find((a) => a.id === id);
}

/** "Mod+K" → "⌘K" on macOS, "Ctrl+K" elsewhere (see lib/platform). */
export const shortcutLabel = (s: string | null | undefined): string => keyLabel(s);
