// The UI owns mixer and FX values (the engine does not report them back), so it sends
// them all at start-up and after the audio engine restarts on new device settings.
import { backend } from "../backend";
import type { ActionInput } from "../backend/types";
import { DECK_LETTERS, fxUnitName, useApp } from "../store/app";

export function engineStateActions(): [string, ActionInput][] {
  const { mixer, settings } = useApp.getState();
  const out: [string, ActionInput][] = [];
  const val = (id: string, value: number) => out.push([id, { type: "value", value }]);
  const pick = (id: string, value: number) => out.push([id, { type: "choice", value }]);
  const on = (id: string, value: boolean) => out.push([id, { type: "set", value }]);
  const decks = settings?.decks ?? 2;
  mixer.channels.slice(0, Math.max(2, decks)).forEach((c, i) => {
    const m = `mixer.${DECK_LETTERS[i]}`;
    val(`${m}.trim`, c.trim);
    val(`${m}.eq.high`, c.high);
    val(`${m}.eq.mid`, c.mid);
    val(`${m}.eq.low`, c.low);
    val(`${m}.filter`, c.filter);
    val(`${m}.fader`, c.fader);
    on(`${m}.cue`, c.cue);
    pick(`${m}.assign`, mixer.assign[i]);
  });
  val("mixer.crossfader", mixer.crossfader);
  val("mixer.master", mixer.master);
  val("mixer.headphones", mixer.headphones);
  val("mixer.cue_mix", mixer.cueMix);
  pick("mixer.crossfader_curve", mixer.crossfaderCurve);
  pick("mixer.fader_curve", mixer.faderCurve);
  pick("mixer.eq_mode", mixer.eqMode);
  on("mixer.split_cue", mixer.splitCue);
  on("mixer.crossfader_reverse", mixer.crossfaderReverse);
  val("sampler.volume", mixer.samplerVolume);
  mixer.fx.forEach((unit, u) => {
    if (u < 4 && u >= Math.max(2, decks)) return;
    unit.forEach((f, i) => {
      const base = `fx.${fxUnitName(u)}.${i + 1}`;
      // The type first: it creates the effect the other values apply to.
      pick(`${base}.type`, f.type);
      pick(`${base}.beats`, f.beats);
      val(`${base}.mix`, f.mix);
      val(`${base}.p1`, f.p1);
      val(`${base}.p2`, f.p2);
      on(`${base}.on`, f.on);
    });
  });
  return out;
}

/** Sends every UI-owned mixer and FX value to the engine. */
export async function pushEngineState() {
  const b = backend();
  for (const [id, input] of engineStateActions()) {
    await b.action(id, input).catch(() => {});
  }
}
