// Setting up a lab: make sure the practice tracks exist, load them on the decks, put the
// mixer in a known state, and switch to the right view.
import { toast } from "sonner";
import { backend } from "../backend";
import type { TrackRow } from "../backend/types";
import { clipFromTrack } from "../components/arrange/Arrange";
import { confirmDiscard, emptyProject, setProject } from "../components/arrange/projectIo";
import { loadOnDeck } from "../components/deck/Deck";
import { ask } from "../components/shell/Dialogs";
import { setOn, setValue, tap } from "../lib/actions";
import { updateSettings } from "../lib/appCommands";
import { useApp } from "../store/app";
import { useTelemetry } from "../store/telemetry";
import { PRACTICE_TITLES, useGuide, type Lab, type PracticeId } from "./model";

const L = (d: number) => String.fromCharCode(65 + d);

/** The practice tracks in the library, by id. */
export async function findPractice(): Promise<Partial<Record<PracticeId, TrackRow>>> {
  const rows = await backend().search("Practice", 200);
  const out: Partial<Record<PracticeId, TrackRow>> = {};
  for (const [id, title] of Object.entries(PRACTICE_TITLES) as [PracticeId, string][]) {
    const r = rows.find((x) => x.title === title && !x.missing);
    if (r) out[id] = r;
  }
  return out;
}

/** Resolves when the next library job (scan) finishes, with its error if any. */
function nextScanJob(): Promise<string | null> {
  const before = useApp.getState().jobs.scan;
  return new Promise((resolve) => {
    const off = useApp.subscribe((s) => {
      const j = s.jobs.scan;
      if (j && j !== before && j.finished) {
        off();
        resolve(j.error);
      }
    });
  });
}

/** Makes the practice tracks (asking first) and returns them, or null if the person declined. */
export async function ensurePractice(ids: PracticeId[]): Promise<Partial<Record<PracticeId, TrackRow>> | null> {
  let have = await findPractice();
  if (ids.every((id) => have[id])) return have;
  const ok = await ask({
    title: "Add the practice tracks?",
    body: "The labs use six short tracks that MixIt makes for you, each built to teach one thing. They are added to your library in a Practice folder (about 150 MB) and analysed. This takes a minute.",
    confirm: "Add practice tracks",
  });
  if (!ok) return null;
  const done = nextScanJob();
  const t = toast.loading("Making the practice tracks…");
  try {
    await backend().addPracticeTracks();
    const err = await done;
    if (err) throw new Error(err);
  } catch (e) {
    toast.error(`Could not add the practice tracks: ${e instanceof Error ? e.message : String(e)}`, { id: t });
    return null;
  }
  toast.success("Practice tracks are ready", { id: t });
  have = await findPractice();
  return have;
}

/** Pauses a deck if it is playing (loading onto a playing deck is refused). */
async function pause(d: number) {
  if (useTelemetry.getState().t.decks[d]?.playing) await tap(`deck.${L(d)}.play`);
}

/** Flat EQs, filters centred, effects off, deck A up and the other lab decks down. */
async function resetMixer(decks: number) {
  const s = useApp.getState();
  const t = useTelemetry.getState().t;
  const jobs: Promise<unknown>[] = [setValue("mixer.crossfader", 0)];
  for (let d = 0; d < Math.max(2, decks); d++) {
    const l = L(d);
    for (const band of ["low", "mid", "high"]) {
      jobs.push(setValue(`mixer.${l}.eq.${band}`, 0));
      if (s.mixer.channels[d]?.kills[["low", "mid", "high"].indexOf(band)]) jobs.push(setOn(`mixer.${l}.eq.kill.${band}`, false));
    }
    jobs.push(setValue(`mixer.${l}.filter`, 0), setValue(`mixer.${l}.fader`, d === 0 ? 1 : 0));
    s.mixer.fx[d]?.forEach((f, i) => f.on && jobs.push(setOn(`fx.${l}.${i + 1}.on`, false)));
    const td = t.decks[d];
    if (td?.sync) jobs.push(setOn(`deck.${l}.sync`, false));
    if (td?.slip) jobs.push(setOn(`deck.${l}.slip`, false));
    if (td && Math.abs(td.rate - 1) > 0.001) jobs.push(tap(`deck.${l}.tempo_reset`));
    jobs.push(setOn(`deck.${l}.keylock`, true));
  }
  await Promise.all(jobs.map((j) => j.catch(() => undefined)));
}

/** Loads one practice track on a deck, making the tracks first if needed. */
export async function loadPractice(deck: number, id: PracticeId) {
  const have = await ensurePractice([id]);
  const row = have?.[id];
  if (!row) return;
  await pause(deck);
  await loadOnDeck(deck, row.id);
}

/** Gets everything ready for a lab. Returns false if it could not. */
export async function setupLab(lab: Lab): Promise<boolean> {
  const g = useGuide.getState();
  g.resetLab(lab.id);
  if (lab.pro && useApp.getState().settings?.viewMode !== "pro") await updateSettings({ viewMode: "pro" });

  if (lab.arrange) {
    const have = await ensurePractice(["p1", "p2"]);
    if (!have?.p1 || !have.p2) return false;
    if (useApp.getState().project && !(await confirmDiscard("set up the lab"))) return false;
    const p = emptyProject("Practice transition", 124);
    const a = clipFromTrack(have.p1, 1, 0, 0);
    // Practice 2 starts 8 bars before Practice 1 ends, on a phrase line.
    const b = clipFromTrack(have.p2, 2, 1, Math.max(0, a.length - 32));
    setProject({ ...p, clips: [a, b], next_id: 3 }, null);
    useApp.getState().set({ workspace: "arrange" });
    return true;
  }

  const ids = lab.decks ?? [];
  const have = await ensurePractice(ids);
  if (!have || ids.some((id) => !have[id])) return false;
  const app = useApp.getState();
  app.set({ workspace: "mix" });
  for (let d = 0; d < 4; d++) await pause(d);
  await resetMixer(ids.length);
  for (const [d, id] of ids.entries()) {
    if (app.decks[d]?.detail.track.id !== have[id]!.id) await loadOnDeck(d, have[id]!.id);
    await backend().seek(d, 0);
  }
  for (const d of lab.freshCues ?? []) {
    const cues = useApp.getState().decks[d]?.detail.cues.filter((q) => q.role === "hot") ?? [];
    for (const q of cues) if (q.slot != null) await backend().deleteHotCue(d, q.slot).catch(() => undefined);
  }
  for (const [id, v] of lab.prepare ?? []) await (typeof v === "boolean" ? setOn(id, v) : setValue(id, v)).catch(() => undefined);
  // Show each deck's hot cues to start with; steps open other tabs when they need them.
  useApp.getState().set({ padTabs: useApp.getState().padTabs.map((t, i) => (i < ids.length ? "cues" : t)), targetDeck: ids.length > 1 ? 1 : 0 });
  return true;
}
