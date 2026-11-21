// Keyboard shortcuts from the action registry. Keys go to momentary actions on both
// down and up (hold CUE, hold a hot cue to preview), triggers fire once per press.
import type { ActionSpec } from "../backend/types";
import { useApp } from "../store/app";
import { act, isMac } from "./actions";

type AppHandler = (id: string) => boolean;

export function keyName(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string {
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  // With Shift or Alt the number row types symbols that depend on the keyboard layout
  // ("!", "\"", "¡"), so name those keys by position: Shift+1.
  const digit = /^Digit(\d)$/.exec(e.code ?? "");
  const byPosition = !!digit && (e.shiftKey || e.altKey);
  // Shift is part of the name for named keys, chords ("Mod+Shift+Z") and the number
  // row, but not for characters it produces on its own ("?").
  if (e.shiftKey && (e.key.length > 1 || mod || e.altKey || byPosition)) parts.push("Shift");
  let k = byPosition ? digit![1] : e.key;
  if (k === " ") k = "Space";
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}

function editing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

export function installKeyboard(appHandler: AppHandler): () => void {
  const held = new Set<string>();
  const byKey = () => {
    const m = new Map<string, ActionSpec>();
    for (const a of useApp.getState().registry) if (a.shortcut) m.set(a.shortcut.toUpperCase(), a);
    return m;
  };
  let map = byKey();
  const unsub = useApp.subscribe((s, prev) => {
    if (s.registry !== prev.registry) map = byKey();
  });
  const down = (e: KeyboardEvent) => {
    const name = keyName(e);
    const isMod = name.startsWith("Mod+");
    if (editing(e) && !isMod && name !== "Escape") return;
    const a = map.get(name.toUpperCase());
    if (!a) return;
    e.preventDefault();
    if (e.repeat) return;
    held.add(name);
    // The app gets first go (app.* actions, recording, saving new hot cues).
    if (appHandler(a.id) || a.id.startsWith("app.")) return;
    act(a.id, { type: "press" });
  };
  const up = (e: KeyboardEvent) => {
    const name = keyName(e);
    if (!held.delete(name)) return;
    const a = map.get(name.toUpperCase());
    if (!a) return;
    if (a.id === "app.explain") {
      useApp.getState().set({ explainHeld: false });
      return;
    }
    if (a.kind.type === "momentary" || a.kind.type === "trigger") act(a.id, { type: "release" });
  };
  window.addEventListener("keydown", down);
  window.addEventListener("keyup", up);
  return () => {
    unsub();
    window.removeEventListener("keydown", down);
    window.removeEventListener("keyup", up);
  };
}
