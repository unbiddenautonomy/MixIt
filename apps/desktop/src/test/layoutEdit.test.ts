// Edit layout mode: where a dragged part goes (lib/layout/dock.ts), undo and redo of
// layout steps, and saved layouts (store/layout.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), message: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
import type { Backend } from "../backend";
import type { WindowMessage } from "../backend/types";
import { MAX_PRESETS, readBook } from "../lib/layout/book";
import { dropOn, previewBox, sideAt } from "../lib/layout/dock";
import { MAIN, placesOf, type Layout } from "../lib/layout/model";

const box = { left: 100, top: 100, width: 400, height: 200 };

describe("where a dragged part goes", () => {
  it("goes beside near an edge and into the tabs in the middle", () => {
    expect(sideAt(300, 200, box)).toBe("tab");
    expect(sideAt(110, 200, box)).toBe("left");
    expect(sideAt(490, 200, box)).toBe("right");
    expect(sideAt(300, 105, box)).toBe("above");
    expect(sideAt(300, 295, box)).toBe("below");
    // A corner goes to the nearer edge.
    expect(sideAt(105, 140, box)).toBe("left");
  });

  it("changes nothing when dropped on its own tab, and stands beside the rest of its own stack", () => {
    expect(dropOn("library", "tab", ["library", "details"], "library")).toBeNull();
    expect(dropOn("library", "tab", ["sidebar"], "sidebar")).toEqual({ unit: "sidebar", side: "tab" });
    expect(dropOn("library", "left", ["library"], "library")).toBeNull();
    expect(dropOn("library", "left", ["library", "details"], "library")).toEqual({ unit: "details", side: "left" });
    expect(dropOn("details", "below", ["library", "details"], "library")).toEqual({ unit: "library", side: "below" });
  });

  it("shows the half it will fill", () => {
    expect(previewBox("right", box)).toEqual({ left: 300, top: 100, width: 200, height: 200 });
    expect(previewBox("below", box)).toEqual({ left: 100, top: 200, width: 400, height: 100 });
    expect(previewBox("tab", box)).toEqual(box);
  });
});

// ------------------------------------------------------------------ the store

interface Fake {
  text: string | null;
  sent: WindowMessage[];
  bus: ((m: WindowMessage) => void) | null;
}

async function start(fake: Fake, url = "/") {
  vi.resetModules();
  window.history.replaceState(null, "", url);
  const b = {
    layoutsLoad: async () => fake.text,
    layoutsSave: async (t: string) => void (fake.text = t),
    broadcast: (m: WindowMessage) => fake.sent.push(m),
    onBroadcast: (cb: (m: WindowMessage) => void) => ((fake.bus = cb), () => (fake.bus = null)),
  } as unknown as Backend;
  (await import("../backend")).setBackendForTests(b);
  const app = await import("../store/app");
  app.useApp.setState({ settings: { layoutEngine: true, decks: 2, viewMode: "easy" } as never });
  const store = await import("../store/layout");
  const share = await import("../store/layoutShare");
  store.useLayout.setState({ size: { w: 1440, h: 860 } });
  if (url === "/") await store.initLayout();
  return { store, share, app };
}

const flushed = async () => {
  window.dispatchEvent(new Event("beforeunload"));
  await new Promise((r) => setTimeout(r, 0));
};
const mix = { win: MAIN, page: "mix" as const };
const folded = (l: Layout | null, unit: Parameters<typeof placesOf>[1]) => placesOf(l!, unit)[0].place.folded.noController;

describe("undo and redo in Edit layout mode", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("undoes and redoes each step, and forgets them on leaving", async () => {
    const { store } = await start({ text: null, sent: [], bus: null });
    // Outside Edit layout nothing is remembered.
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    expect(store.useLayout.getState().canUndo).toBe(false);
    store.setEditing(true);
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: mix });
    store.layoutAct({ op: "place", unit: "sidebar", target: { win: MAIN, page: "mix", unit: "library" }, side: "right" });
    expect(store.useLayout.getState().canUndo).toBe(true);
    store.editStep("undo");
    store.editStep("undo");
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(true);
    expect(store.useLayout.getState().canUndo).toBe(false);
    expect(store.useLayout.getState().canRedo).toBe(true);
    store.editStep("redo");
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(false);
    // A new step drops what was undone.
    store.layoutAct({ op: "fold", unit: "waves", folded: true, where: mix });
    expect(store.useLayout.getState().canRedo).toBe(false);
    // Undoing more than there is does nothing.
    for (let i = 0; i < 5; i++) store.editStep("undo");
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(true);
    store.setEditing(false);
    expect(store.useLayout.getState().canUndo).toBe(false);
  });

  it("keeps the last 50 steps, and never a step that changed nothing", async () => {
    const { store } = await start({ text: null, sent: [], bus: null });
    store.setEditing(true);
    for (let i = 0; i < 60; i++) store.layoutAct({ op: "fold", unit: "mixer", folded: i % 2 === 0, where: mix });
    // Folding what's already folded is not a step.
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: mix });
    let n = 0;
    while (store.useLayout.getState().canUndo) {
      store.editStep("undo");
      n++;
    }
    expect(n).toBe(50);
  });

  it("asks the main window from another window", async () => {
    const fake: Fake = { text: null, sent: [], bus: null };
    const { store, share } = await start(fake, "/?win=w2");
    const stop = share.startLayoutShare();
    store.setEditing(true);
    expect(fake.sent.at(-1)).toEqual({ kind: "layout-edit-ask", on: true });
    // Only the main window's answer turns it on here.
    expect(store.useLayout.getState().editing).toBe(false);
    fake.bus!({ kind: "layout-edit", on: true });
    expect(store.useLayout.getState().editing).toBe(true);
    store.editStep("undo");
    expect(fake.sent.at(-1)).toEqual({ kind: "layout-step", step: "undo" });
    stop();
  });

  it("tells the other windows, and does what they ask", async () => {
    const fake: Fake = { text: null, sent: [], bus: null };
    const { store, share } = await start(fake);
    const stop = share.startLayoutShare();
    fake.bus!({ kind: "layout-edit-ask", on: true });
    expect(store.useLayout.getState().editing).toBe(true);
    expect(fake.sent.at(-1)).toEqual({ kind: "layout-edit", on: true });
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    fake.bus!({ kind: "layout-step", step: "undo" });
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(false);
    // Whole layouts can't be pushed in by another window.
    const before = store.useLayout.getState().layout;
    fake.bus!({ kind: "layout-intent", id: "x", from: MAIN, basedOn: 0, op: { op: "preset", layout: before } });
    expect(fake.sent.at(-1)).toMatchObject({ kind: "layout-refused" });
    stop();
  });

  it("leaves Edit layout when the new layout is turned off", async () => {
    const { store, app } = await start({ text: null, sent: [], bus: null });
    store.setEditing(true);
    app.useApp.setState({ settings: { layoutEngine: false, decks: 2, viewMode: "easy" } as never });
    expect(store.useLayout.getState().editing).toBe(false);
  });
});

describe("saved layouts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("saves, applies with Undo, renames and deletes, and keeps them across a restart", async () => {
    const fake: Fake = { text: null, sent: [], bus: null };
    const { store } = await start(fake);
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    expect(store.savePreset("  Home   studio ")).toBeNull();
    expect(store.useLayout.getState().presets.map((p) => p.name)).toEqual(["Home studio"]);
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: mix });
    const id = store.useLayout.getState().presets[0].id;
    expect(store.applySavedPreset(id)).toBeNull();
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(true);
    const undo = toast.message.mock.calls.find((c) => String(c[0]).startsWith("Switched to"))!;
    (undo[1] as { action: { onClick: () => void } }).action.onClick();
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(false);
    // The same name replaces it rather than adding another.
    store.savePreset("home studio");
    expect(store.useLayout.getState().presets).toHaveLength(1);
    store.renameSavedPreset(id, "Club");
    await flushed();
    expect(readBook(fake.text).book.presets.map((p) => p.name)).toEqual(["Club"]);
    // After a restart they're still there.
    const again = await start(fake);
    expect(again.store.useLayout.getState().presets.map((p) => p.name)).toEqual(["Club"]);
    again.store.deletePreset(id);
    expect(again.store.useLayout.getState().presets).toEqual([]);
    expect(again.store.applySavedPreset(id)).toMatch(/gone/);
  });

  it("stops at the most it keeps", async () => {
    const { store } = await start({ text: null, sent: [], bus: null });
    for (let i = 0; i < MAX_PRESETS; i++) expect(store.savePreset(`L${i}`)).toBeNull();
    expect(store.savePreset("one more")).toMatch(/Delete one first/);
    // Replacing one by name still works when full.
    expect(store.savePreset("L3")).toBeNull();
  });

  it("duplicates, exports and imports a saved layout as a small file", async () => {
    const { store } = await start({ text: null, sent: [], bus: null });
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    store.savePreset("Club");
    const id = store.useLayout.getState().presets[0].id;
    expect(store.duplicatePreset(id)).toBeNull();
    expect(store.duplicatePreset(id)).toBeNull();
    expect(store.useLayout.getState().presets.map((p) => p.name)).toEqual(["Club", "Club copy", "Club copy 2"]);
    const file = store.exportPreset(id)!;
    expect(file.name).toBe("Club");
    // On another computer (here: after deleting it), the file brings it back, folds and all.
    for (const p of store.useLayout.getState().presets) store.deletePreset(p.id);
    store.layoutAct({ op: "fold", unit: "mixer", folded: false, where: mix });
    expect(store.importPreset(file.text)).toEqual({ name: "Club" });
    expect(store.importPreset(file.text)).toEqual({ name: "Club 2" });
    const back = store.useLayout.getState().presets[0];
    expect(store.applySavedPreset(back.id)).toBeNull();
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(true);
    expect(store.importPreset("not a layout")).toEqual({ why: "That file isn't a MixIt layout." });
    expect(store.importPreset(JSON.stringify({ kind: "mixit-layout", version: 9, layout: {} }))).toEqual({ why: expect.stringMatching(/newer MixIt/) });
    expect(store.importPreset(JSON.stringify({ kind: "mixit-layout", version: 1, name: "x", layout: { nonsense: true } }))).toEqual({ why: expect.stringMatching(/couldn't read/) });
  });

  it("names the layout showing, and says (changed) once it is changed", async () => {
    const { store } = await start({ text: null, sent: [], bus: null });
    const name = () => store.layoutName(store.useLayout.getState().layout, store.useLayout.getState().presets);
    expect(name()).toBe("Laptop");
    store.applyBuiltIn("prepare");
    expect(name()).toBe("Prepare");
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    expect(name()).toBe("Prepare (changed)");
    store.savePreset("Mine");
    expect(store.applySavedPreset(store.useLayout.getState().presets[0].id)).toBeNull();
    expect(name()).toBe("Mine");
  });

  it("goes back to the standard layout with Undo", async () => {
    const { store } = await start({ text: null, sent: [], bus: null });
    store.layoutAct({ op: "fold", unit: "mixer", folded: true, where: mix });
    store.applyStandard();
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(false);
    const undo = toast.message.mock.calls.find((c) => c[0] === "Switched to the standard layout.")!;
    (undo[1] as { action: { onClick: () => void } }).action.onClick();
    expect(folded(store.useLayout.getState().layout, "mixer")).toBe(true);
  });
});
