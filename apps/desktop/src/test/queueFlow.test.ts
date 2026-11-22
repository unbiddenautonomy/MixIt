import { beforeEach, describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import type { TrackRow } from "../backend/types";
import { fromCamelot, keyDto } from "../lib/keys";
import { bestOrder, changeCost, orderCost } from "../lib/queueOrder";
import { flow, summary } from "../lib/setFlow";
import { useAutoDj } from "../store/autodj";
import { addBridge, bridgeChoices, orderQueue } from "../store/queueFlow";
import { useLibrary } from "../store/library";

let next = 1;
function row(bpm: number, camelot: [number, "A" | "B"], energy = 6): TrackRow {
  const id = next++;
  return { id, title: `T${id}`, artist: "", path: `/m/${id}.flac`, duration: 300, bpm, key: keyDto(fromCamelot(...camelot)), energy, rating: 0, missing: false } as unknown as TrackRow;
}

const ids = (rows: TrackRow[]) => rows.map((r) => r.id);

describe("the best order for a queue", () => {
  it("walks the Camelot wheel and steps the tempo instead of jumping", () => {
    const a = row(120, [8, "A"]);
    const b = row(122, [9, "A"]);
    const c = row(124, [10, "A"]);
    const d = row(126, [11, "A"]);
    const shuffled = [c, a, d, b];
    const best = bestOrder(shuffled);
    expect([ids([a, b, c, d]).join(), ids([d, c, b, a]).join()]).toContain(ids(best).join());
    expect(orderCost(best)).toBeLessThan(orderCost(shuffled));
    expect(new Set(ids(best))).toEqual(new Set(ids(shuffled)));
  });

  it("continues from the track playing and keeps the first tracks where they are", () => {
    const now = row(124, [8, "A"]);
    const far = row(124, [2, "B"]);
    const near = row(124, [8, "A"]);
    const mid = row(124, [9, "A"]);
    const best = bestOrder([far, mid, near], "steady", now);
    expect(best[0].id).toBe(near.id);
    expect(bestOrder([far, mid, near], "steady", now, 1)[0].id).toBe(far.id);
  });

  it("follows the energy the listener asked for", () => {
    const lo = row(124, [8, "A"], 3);
    const mid = row(124, [8, "A"], 5);
    const hi = row(124, [8, "A"], 7);
    expect(ids(bestOrder([hi, lo, mid], "up"))).toEqual(ids([lo, mid, hi]));
    expect(ids(bestOrder([lo, hi, mid], "down"))).toEqual(ids([hi, mid, lo]));
    expect(changeCost(lo, hi, "up")).toBeLessThan(changeCost(hi, lo, "up"));
  });

  it("orders a long queue (greedy and 2-opt) no worse than it was", () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(118 + ((i * 7) % 12), [((i * 5) % 12) + 1, i % 2 ? "A" : "B"], 3 + (i % 6)));
    const best = bestOrder(rows);
    expect(best).toHaveLength(14);
    expect(new Set(ids(best))).toEqual(new Set(ids(rows)));
    expect(orderCost(best)).toBeLessThan(orderCost(rows));
    expect(summary(flow(best)).rough).toBeLessThanOrEqual(summary(flow(rows)).rough);
  });
});

describe("the Auto DJ queue", () => {
  beforeEach(() => {
    toast.mockClear();
    toast.success.mockClear();
    useAutoDj.setState({ phase: "off", next: null, current: null, played: [], energy: "steady" });
  });

  it("reorders for the easiest mixes, with undo", () => {
    const a = row(120, [8, "A"]);
    const b = row(140, [3, "B"]);
    const c = row(121, [9, "A"]);
    useAutoDj.setState({ queue: [a, b, c] });
    expect(orderQueue()).toBe(true);
    const q = useAutoDj.getState().queue;
    expect(summary(flow(q)).rough).toBeLessThan(summary(flow([a, b, c])).rough);
    const undo = toast.success.mock.calls[0][1].action.onClick;
    undo();
    expect(ids(useAutoDj.getState().queue)).toEqual(ids([a, b, c]));
    // Already the best: says so and leaves it.
    useAutoDj.setState({ queue: q });
    expect(orderQueue()).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already in the best order/));
  });

  it("fills a rough change with a library track that goes with both", () => {
    // A 10% tempo jump: rough. 126 BPM is 5% from each side.
    const a = row(120, [8, "A"]);
    const b = row(132, [8, "A"]);
    const bridge = row(126, [8, "A"]);
    const clash = row(150, [3, "B"]);
    useLibrary.setState({ rows: [a, b, bridge, clash] });
    useAutoDj.setState({ queue: [a, b] });
    expect(flow([a, b])[0].grade).toBe("rough");
    expect(bridgeChoices(0).map((x) => x.track.id)).toEqual([bridge.id]);
    expect(addBridge(0)?.id).toBe(bridge.id);
    expect(ids(useAutoDj.getState().queue)).toEqual(ids([a, bridge, b]));
    expect(summary(flow(useAutoDj.getState().queue)).rough).toBe(0);
    // Nothing fits: says so.
    useLibrary.setState({ rows: [clash] });
    useAutoDj.setState({ queue: [a, row(150, [2, "B"])] });
    expect(addBridge(0)).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/No track in your library/));
  });
});
