// Keyboard shortcuts from the action registry. Keys go to momentary actions on both
// down and up (hold CUE, hold a hot cue to preview), triggers fire once per press.
import type { ActionSpec } from "../backend/types";
import { useApp } from "../store/app";
import { act } from "./actions";
import { platform } from "./platform";

type AppHandler = (id: string) => boolean;

/** Arrange's editing keys. Anywhere else (and while typing) they keep their usual
 * meaning: copy and paste text, Space presses the focused button. */
const ARRANGE_KEYS = new Set(["app.clip_copy", "app.clip_cut", "app.clip_paste", "app.clip_duplicate", "app.clip_delete", "app.clip_split", "app.select_all", "app.arrange_loop", "app.arrange_play"]);
/** Keys that stand in for another (the Mac's delete key is Backspace). */
const ALIASES: Record<string, string> = { BACKSPACE: "DELETE" };

export function keyName(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string {
  const parts: string[] = [];
  const mod = platform.modIsMeta ? e.metaKey : e.ctrlKey;
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
    const a = map.get(name.toUpperCase()) ?? map.get(ALIASES[name.toUpperCase()] ?? "");
    if (!a) return;
    if (ARRANGE_KEYS.has(a.id) && (useApp.getState().workspace !== "arrange" || editing(e))) return;
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
    const a = map.get(name.toUpperCase()) ?? map.get(ALIASES[name.toUpperCase()] ?? "");
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
