// The UI owns mixer and FX values (the engine does not report them back), so it sends
// them all at start-up and after the audio engine restarts on new device settings.
import { backend } from "../backend";
import type { ActionInput } from "../backend/types";
import { DECK_LETTERS, fxUnitName, STEMS, useApp } from "../store/app";
import { pushStudio } from "../store/studio";

export function engineStateActions(): [string, ActionInput][] {
  const { mixer, settings } = useApp.getState();
  const out: [string, ActionInput][] = [];
  const val = (id: string, value: number) => out.push([id, { type: "value", value }]);
  const pick = (id: string, value: number) => out.push([id, { type: "choice", value }]);
  const on = (id: string, value: boolean) => out.push([id, { type: "set", value }]);
  const decks = settings?.decks ?? 2;
  mixer.stems.slice(0, Math.max(2, decks)).forEach((st, i) => {
    STEMS.forEach((name, k) => {
      val(`deck.${DECK_LETTERS[i]}.stem.${name}`, st.level[k]);
      on(`deck.${DECK_LETTERS[i]}.stem.${name}.mute`, st.mute[k]);
    });
  });
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
    val(`${m}.pan`, c.pan);
    val(`${m}.punch`, c.punch);
    val(`${m}.warmth`, c.warmth);
    val(`${m}.width`, c.width);
    on(`${m}.gate`, c.gate);
    val(`${m}.space`, c.space);
    val(`${m}.echo`, c.echo);
    pick(`${m}.duck_source`, c.duckSource);
    val(`${m}.duck`, c.duck);
  });
  on("global.safety_loop", settings?.safetyLoop !== false);
  val("mixer.glue", mixer.glue);
  val("mixer.space.level", mixer.spaceLevel);
  val("mixer.space.size", mixer.spaceSize);
  val("mixer.echo.level", mixer.echoLevel);
  val("mixer.echo.feedback", mixer.echoFeedback);
  pick("mixer.echo.time", mixer.echoTime);
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

/** Sends every UI-owned mixer and FX value to the engine, then the detailed studio
 * settings (which already include the one-knob values). */
export async function pushEngineState() {
  const b = backend();
  for (const [id, input] of engineStateActions()) {
    await b.action(id, input).catch(() => {});
  }
  await pushStudio();
}
