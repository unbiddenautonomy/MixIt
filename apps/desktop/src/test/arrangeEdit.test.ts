import { describe, expect, it } from "vitest";
import { addMarker, clipsInBox, copyClips, duplicateClips, fadeOf, markerNear, moveClips, moveMarker, pasteClips, removeClips, removeMarker, renameMarker, setFade, sourceBeat, splitClip, valueAt } from "../lib/arrangeOps";
import { emptyProject } from "../components/arrange/projectIo";
import type { Clip, MixProject } from "../backend/types";

const clip = (id: number, start: number, length: number, lane: number, p: Partial<Clip> = {}): Clip => ({
  id,
  track: { hash: null, path: `/m/${id}.wav`, title: `T${id}`, artist: "", bpm: 124, key: null, duration: 300 },
  lane,
  start,
  length,
  source_start: 0,
  key_shift: 0,
  keylock: true,
  gain_db: 0,
  lanes: [],
  fx: null,
  name: `T${id}`,
  ...p,
});

const set = (): MixProject => ({
  ...emptyProject("Set", 124),
  clips: [
    clip(1, 0, 64, 0, { lanes: [{ param: "Volume", points: [{ beat: 48, value: 1, curve: "Linear" }, { beat: 64, value: 0, curve: "Linear" }] }] }),
    clip(2, 48, 64, 1),
    clip(3, 96, 64, 2),
  ],
  next_id: 4,
});

describe("editing many clips", () => {
  it("moves a group together and keeps it on the timeline", () => {
    const p = moveClips(set(), [1, 2], 8, 1);
    expect(p.clips.map((c) => [c.start, c.lane])).toEqual([[8, 1], [56, 2], [96, 2]]);
    expect(p.clips[0].lanes[0].points.map((x) => x.beat)).toEqual([56, 72]);
    // Clamped: the earliest clip stops at beat 0 and the lowest lane at D.
    const q = moveClips(set(), [1, 2], -20, 5);
    expect(q.clips.map((c) => [c.start, c.lane])).toEqual([[0, 2], [48, 3], [96, 2]]);
  });

  it("copies, pastes and duplicates with automation", () => {
    const p = set();
    const board = copyClips(p, [2, 1])!;
    expect(board.span).toBe(112);
    const { project, ids } = pasteClips(p, board, 200);
    expect(ids).toEqual([4, 5]);
    expect(project.next_id).toBe(6);
    const pasted = project.clips.filter((c) => ids.includes(c.id));
    expect(pasted.map((c) => [c.start, c.lane])).toEqual([[200, 0], [248, 1]]);
    expect(pasted[0].lanes[0].points.map((x) => x.beat)).toEqual([248, 264]);
    const d = duplicateClips(p, [3]);
    expect(d.project.clips.find((c) => c.id === d.ids[0])!.start).toBe(160);
    expect(removeClips(d.project, [1, 3]).clips.map((c) => c.id)).toEqual([2, 4]);
  });

  it("splits a clip so both halves play what they played before", () => {
    const p = set();
    const { project, ids } = splitClip(p, 1, 56);
    const [a, b] = ids.map((id) => project.clips.find((c) => c.id === id)!);
    expect([a.start, a.length, b.start, b.length]).toEqual([0, 56, 56, 8]);
    expect(sourceBeat(b, 60)).toBe(sourceBeat(p.clips[0], 60));
    // The fade is cut with its value at the cut on both sides.
    expect(valueAt(a, "Volume", 56)).toBeCloseTo(0.5);
    expect(valueAt(b, "Volume", 56)).toBeCloseTo(0.5);
    expect(valueAt(b, "Volume", 60)).toBeCloseTo(valueAt(p.clips[0], "Volume", 60));
    // Reversed clips keep the music heard at every beat.
    const r = { ...set(), clips: [clip(1, 16, 32, 0, { reverse: true, source_start: 10 })] };
    const s = splitClip(r, 1, 24);
    for (const beat of [17, 23.5, 24, 30, 47]) {
      const half = s.project.clips.find((c) => beat >= c.start && beat < c.start + c.length)!;
      expect(sourceBeat(half, beat)).toBe(sourceBeat(r.clips[0], beat));
    }
    expect(splitClip(p, 1, 64).ids).toEqual([]);
  });

  it("selects the clips a box touches", () => {
    expect(clipsInBox(set(), 50, 40, 0, 1)).toEqual([1, 2]);
    expect(clipsInBox(set(), 0, 200, 2, 3)).toEqual([3]);
    expect(clipsInBox(set(), 64, 96, 0, 0)).toEqual([]);
  });

  it("sets, reads and removes fades without touching other moves", () => {
    const c = set().clips[0];
    const f = setFade(c, "in", 8);
    expect(fadeOf(f, "in")).toBe(8);
    expect(valueAt(f, "Volume", 0)).toBe(0);
    expect(valueAt(f, "Volume", 8)).toBe(1);
    expect(fadeOf(f, "out")).toBe(16);
    const g = setFade(f, "out", 4);
    expect(fadeOf(g, "out")).toBe(4);
    expect(valueAt(g, "Volume", 59)).toBe(1);
    expect(fadeOf(setFade(g, "in", 0), "in")).toBe(0);
    expect(fadeOf(setFade(g, "in", 0), "out")).toBe(4);
  });
});

describe("markers", () => {
  it("adds, moves, renames, removes and finds markers in order", () => {
    let { project: p } = addMarker(set(), 64.4, "Drop");
    ({ project: p } = addMarker(p, 16));
    expect(p.markers).toEqual([{ beat: 16, label: "Marker 2" }, { beat: 64, label: "Drop" }]);
    expect(addMarker(p, 16).index).toBe(0);
    p = moveMarker(p, 0, 100);
    expect(p.markers.map((m) => m.label)).toEqual(["Drop", "Marker 2"]);
    p = renameMarker(p, 1, "Outro");
    expect(markerNear(p, 64, 1)?.label).toBe("Outro");
    expect(markerNear(p, 64, -1)).toBeNull();
    expect(removeMarker(p, 0).markers).toEqual([{ beat: 100, label: "Outro" }]);
  });
});

describe("Arrange keys", () => {
  it("only take copy, paste, delete and Space while Arrange is open and nothing is being typed", async () => {
    const { installKeyboard } = await import("../lib/keyboard");
    const { useApp } = await import("../store/app");
    const { setBackendForTests } = await import("../backend");
    setBackendForTests({ action: async () => {} } as never);
    const spec = (id: string, shortcut: string) => ({ id, label: id, group: "App", kind: { type: "trigger" }, explain: "", easy: true, shortcut, glossary: null });
    useApp.setState({ registry: [spec("app.clip_copy", "Mod+C"), spec("app.clip_delete", "Delete"), spec("app.arrange_play", "Space")] as never, workspace: "mix" });
    const ran: string[] = [];
    const off = installKeyboard((id) => (ran.push(id), true));
    const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      window.dispatchEvent(new KeyboardEvent("keyup", { key, ...init }));
      return e.defaultPrevented;
    };
    expect(press("c", { ctrlKey: true, metaKey: true })).toBe(false);
    expect(press(" ")).toBe(false);
    expect(ran).toEqual([]);
    useApp.setState({ workspace: "arrange" });
    expect(press("c", { ctrlKey: true, metaKey: true })).toBe(true);
    expect(press("Backspace")).toBe(true);
    expect(press(" ")).toBe(true);
    expect(ran).toEqual(["app.clip_copy", "app.clip_delete", "app.arrange_play"]);
    const input = document.createElement("input");
    document.body.append(input);
    expect(press("c", { ctrlKey: true, metaKey: true }, input)).toBe(false);
    expect(ran.length).toBe(3);
    input.remove();
    off();
  });
});
