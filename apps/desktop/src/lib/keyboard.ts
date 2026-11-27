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

/** Keys named by where they sit, so the deck keys stay on their side of the keyboard on any
 * layout (AZERTY, QWERTZ, Dvorak): the QWERTY name for each position. */
const POSITION: Record<string, string> = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";" };

export function keyName(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): string {
  const parts: string[] = [];
  const mod = platform.modIsMeta ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  const code = e.code ?? "";
  // The number row is named by position: with Shift or Alt it types symbols that depend on
  // the layout ("!", "\"", "¡"), and on AZERTY even its plain keys do ("&").
  const digit = /^Digit(\d)$/.exec(code);
  // Letters too, outside Mod chords (those follow the printed letter, as the system's own
  // do): Shift+A is then a key of its own, and Option+letter on a Mac stays that letter.
  const letter = mod ? null : /^Key([A-Z])$/.exec(code);
  // Deck B's punctuation keys, unshifted (Shift+/ is still "?").
  const punct = mod || e.shiftKey || e.altKey ? undefined : POSITION[code];
  const byPosition = !!digit || !!letter;
  // Shift is part of the name for named keys, chords ("Mod+Shift+Z"), the number row and
  // letters, but not for characters it produces on its own ("?").
  if (e.shiftKey && (e.key.length > 1 || mod || e.altKey || byPosition)) parts.push("Shift");
  let k = digit ? digit[1] : letter ? letter[1] : (punct ?? e.key);
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
  // By physical key, so letting go of Shift before the key still releases what it pressed.
  const held = new Map<string, string>();
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
    held.set(e.code || name, name);
    // The app gets first go (app.* actions, recording, saving new hot cues).
    if (appHandler(a.id) || a.id.startsWith("app.")) return;
    act(a.id, { type: "press" });
  };
  const up = (e: KeyboardEvent) => {
    const name = held.get(e.code || keyName(e));
    if (!name) return;
    held.delete(e.code || keyName(e));
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
