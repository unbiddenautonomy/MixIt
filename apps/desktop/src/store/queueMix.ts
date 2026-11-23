// Make a mix from the Auto DJ queue: the whole set as an Arrange project, every change as
// Auto DJ plans it, to edit, listen to and render to a file.
import { toast } from "sonner";
import { backend } from "../backend";
import { beatToSeconds, confirmDiscard, projectBeats, setProject } from "../components/arrange/projectIo";
import { clock } from "../lib/format";
import { setMix } from "../lib/rehearse";
import { useApp } from "./app";
import { planFor, useAutoDj } from "./autodj";
import { queueStart } from "./queueFlow";

/** Turns the queue (from the track waiting or playing) into a mix project and opens Arrange. */
export async function mixQueue(): Promise<boolean> {
  const { queue, glide } = useAutoDj.getState();
  const start = queueStart();
  const rows = [...(start ? [start] : []), ...queue];
  if (rows.length < 2) {
    toast("Add at least two tracks to the queue to make a mix.");
    return false;
  }
  if (!(await confirmDiscard("make a new mix"))) return false;
  try {
    const details = await Promise.all(rows.map((r) => backend().trackDetail(r.id)));
    const ready = details.filter((d) => d.bpm);
    if (ready.length < 2) {
      toast.error("Making a mix needs at least two analysed tracks.");
      return false;
    }
    const plans = ready.slice(1).map((inc, i) => planFor(ready[i], inc));
    const p = setMix(ready, plans, { glide, name: `Auto DJ set: ${ready[0].track.title} to ${ready[ready.length - 1].track.title}` });
    setProject(p, null);
    useApp.getState().set({ workspace: "arrange" });
    const skipped = details.length - ready.length;
    toast.success(`Made a mix of ${ready.length} tracks, ${clock(beatToSeconds(p, projectBeats(p)))}`, {
      description: `Every change as Auto DJ would mix it.${skipped ? ` ${skipped} track${skipped === 1 ? " is" : "s are"} not analysed yet, so left out.` : ""} Listen, tweak, then render it to a file.`,
    });
    return true;
  } catch (e) {
    toast.error(`Could not make the mix: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
