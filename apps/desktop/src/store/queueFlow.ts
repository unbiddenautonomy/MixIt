// The Auto DJ queue's flow: put it in the order that mixes best, and fill a rough change
// with a track from the library that goes with both sides.
import { toast } from "sonner";
import { backend } from "../backend";
import { refreshPlaylists } from "../components/library/data";
import type { TrackRow } from "../backend/types";
import { bestOrder, orderCost } from "../lib/queueOrder";
import { bridges, flow, summary } from "../lib/setFlow";
import { useApp } from "./app";
import { useAutoDj } from "./autodj";
import { useLibrary } from "./library";

/** The track the queue continues from: the one waiting on a deck, else the one playing. */
export function queueStart(): TrackRow | null {
  const s = useAutoDj.getState();
  if (s.next) return s.next.track;
  if (s.phase !== "off" && s.current !== null) return useApp.getState().decks[s.current]?.detail.track ?? null;
  return null;
}

/** Reorders the queue for the easiest mixes, with the energy going Auto DJ's way. */
export function orderQueue(): boolean {
  const { queue, energy } = useAutoDj.getState();
  if (queue.length < 2) return false;
  const from = queueStart();
  const order = bestOrder(queue, energy, from);
  const head = from ? [from] : [];
  if (orderCost([...head, ...order], energy) >= orderCost([...head, ...queue], energy) - 1e-9 || order.every((t, i) => t.id === queue[i].id)) {
    toast("The queue is already in the best order for mixing.");
    return false;
  }
  const before = queue;
  const was = summary(flow([...head, ...before]));
  const now = summary(flow([...head, ...order]));
  useAutoDj.setState({ queue: order });
  const rough = now.rough < was.rough ? ` Rough changes: ${was.rough} before, ${now.rough} now.` : "";
  toast.success(`Put the queue in the order that mixes best.${rough}`, { action: { label: "Undo", onClick: () => useAutoDj.setState({ queue: before }) } });
  return true;
}

/** The library tracks that could go between queue entries `i` and `i + 1` (or between the
 * track playing and the first entry, for `i` = -1). */
export function bridgeChoices(i: number, limit = 5) {
  const { queue, played } = useAutoDj.getState();
  const a = i < 0 ? queueStart() : queue[i];
  const b = queue[i + 1];
  if (!a || !b) return [];
  const exclude = new Set([...queue.map((t) => t.id), ...played, ...useApp.getState().decks.filter((d) => d).map((d) => d!.detail.track.id)]);
  return bridges(a, b, useLibrary.getState().rows, exclude, limit);
}

/** Puts the best bridge (or `pick`) between queue entries `i` and `i + 1`. */
export function addBridge(i: number, pick?: TrackRow): TrackRow | null {
  const t = pick ?? bridgeChoices(i, 1)[0]?.track;
  if (!t) {
    toast("No track in your library goes well with both. Try another order, or let it echo out.");
    return null;
  }
  useAutoDj.setState((s) => {
    const q = [...s.queue];
    q.splice(i + 1, 0, t);
    return { queue: q };
  });
  toast.success(`Added ${t.title} in between, so both changes mix well.`, {
    action: { label: "Undo", onClick: () => useAutoDj.setState((s) => ({ queue: s.queue.filter((x) => x.id !== t.id) })) },
  });
  return t;
}

/** The playlist name for a saved queue: "Auto DJ set, 22 Nov" (from `when`). */
export function queueListName(when = new Date()): string {
  return `Auto DJ set, ${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Saves the queue (after the track waiting or playing, if any) as a playlist, in order. */
export async function saveQueue(): Promise<number | null> {
  const { queue } = useAutoDj.getState();
  const start = queueStart();
  const ids = [...(start ? [start] : []), ...queue].map((t) => t.id);
  if (ids.length === 0) {
    toast("The queue is empty.");
    return null;
  }
  try {
    const name = queueListName();
    const id = await backend().createPlaylist(name, "list", { tracks: ids });
    await refreshPlaylists();
    toast.success(`Saved the queue as “${name}”`, { description: `${ids.length} track${ids.length === 1 ? "" : "s"} in this order. Rename it in the sidebar, and play it with Auto DJ again any time.` });
    return id;
  } catch (e) {
    toast.error(`Could not save the queue: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
