// Two club-mixer habits the app handles itself:
// - Fader start: raising a channel's volume fader from the bottom starts its deck, and
//   pulling it all the way down stops the deck and takes it back to its cue point.
// - Instant double: the track playing on one deck, loaded onto another at the same spot,
//   in time, so you can loop, scratch or effect one copy while the other keeps going.
import { toast } from "sonner";
import { backend } from "../backend";
import { useApp } from "../store/app";
import { livePosition, useTelemetry } from "../store/telemetry";
import { setOn, tap } from "./actions";

/** Below this the fader counts as closed. */
const CLOSED = 0.02;

/** Called when a channel fader moves from `before` to `after`. */
export function faderMoved(deck: number, before: number, after: number) {
  if (!useApp.getState().settings?.faderStart) return;
  const d = useTelemetry.getState().t.decks[deck];
  if (!d?.loaded) return;
  const L = String.fromCharCode(65 + deck);
  if (before <= CLOSED && after > CLOSED && !d.playing) void tap(`deck.${L}.play`);
  else if (before > CLOSED && after <= CLOSED && d.playing) {
    const cue = d.cue;
    void tap(`deck.${L}.play`).then(() => backend().seek(deck, cue));
  }
}

const letter = (d: number) => String.fromCharCode(65 + d);

/** Loads the track on deck `from` onto deck `to` at the same spot, synced, and playing if `from` is. */
export async function instantDouble(from: number, to: number) {
  const src = useApp.getState().decks[from];
  const t = useTelemetry.getState().t.decks;
  if (!src) {
    toast.message(`Deck ${letter(from)} is empty`);
    return;
  }
  if (t[to]?.playing) {
    toast.warning(`Deck ${letter(to)} is playing. Pause it first, or double onto another deck.`);
    return;
  }
  try {
    const info = await backend().loadTrack(to, src.detail.track.id);
    useApp.getState().setDeck(info);
    await setOn(`deck.${letter(to)}.sync`, true);
    // Read the position as late as possible: loading took a moment.
    await backend().seek(to, livePosition(from));
    if (useTelemetry.getState().t.decks[from]?.playing) await tap(`deck.${letter(to)}.play`);
    toast.message(`Deck ${letter(from)} doubled onto deck ${letter(to)}`, { description: "Same track, same spot, in time. Bring its fader up to hear it." });
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
  }
}
