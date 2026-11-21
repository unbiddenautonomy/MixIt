import { beforeEach, describe, expect, it } from "vitest";
import type { ActionSpec } from "../backend/types";
import { holderOf, installRegistry, resetAllShortcuts, resetShortcut, setShortcut, useShortcuts, withOverrides } from "../lib/shortcuts";
import { useApp } from "../store/app";

const spec = (id: string, shortcut: string | null, kind: ActionSpec["kind"] = { type: "trigger" }): ActionSpec => ({ id, label: id, group: "G", kind, explain: "", easy: true, shortcut, glossary: null });
const REG = [spec("deck.A.play", "Z"), spec("deck.A.cue", "X", { type: "momentary" }), spec("app.preview", "P"), spec("app.sampler", null)];
const key = (id: string) => useApp.getState().registry.find((a) => a.id === id)?.shortcut ?? null;

describe("custom shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAllShortcuts();
    installRegistry(REG);
  });

  it("lays your keys over the defaults", () => {
    expect(withOverrides(REG, { "app.sampler": "S" }).find((a) => a.id === "app.sampler")?.shortcut).toBe("S");
    expect(withOverrides(REG, { "deck.A.play": null }).find((a) => a.id === "deck.A.play")?.shortcut).toBeNull();
  });

  it("moves a key from the action that had it", () => {
    setShortcut("app.sampler", "Z");
    expect(key("app.sampler")).toBe("Z");
    expect(key("deck.A.play")).toBeNull();
    expect(holderOf("z")?.id).toBe("app.sampler");
    // The keys survive a restart.
    expect(JSON.parse(localStorage.getItem("mixit.shortcuts")!)).toEqual({ "app.sampler": "Z" });
    // Giving the key to a third action takes it from the second.
    setShortcut("app.preview", "Z");
    expect(key("app.preview")).toBe("Z");
    expect(key("app.sampler")).toBeNull();
    expect(useShortcuts.getState().overrides).toEqual({ "app.sampler": null, "app.preview": "Z" });
  });

  it("resets one action or all of them", () => {
    setShortcut("deck.A.play", "Space");
    setShortcut("deck.A.cue", null);
    expect(key("deck.A.play")).toBe("Space");
    expect(key("deck.A.cue")).toBeNull();
    resetShortcut("deck.A.cue");
    expect(key("deck.A.cue")).toBe("X");
    resetAllShortcuts();
    expect(key("deck.A.play")).toBe("Z");
    expect(useShortcuts.getState().overrides).toEqual({});
  });

  it("forgets an override that matches the default", () => {
    setShortcut("deck.A.play", "Q");
    setShortcut("deck.A.play", "Z");
    expect(useShortcuts.getState().overrides).toEqual({});
  });
});
