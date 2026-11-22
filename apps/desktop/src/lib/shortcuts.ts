// Your own keyboard shortcuts. The registry carries each action's default key; the keys you
// choose are kept on this computer and laid over it, so every place that shows or uses a
// shortcut (the keyboard, tooltips, the command palette, explain mode) follows them.
import { create } from "zustand";
import type { ActionSpec } from "../backend/types";
import { useApp } from "../store/app";

/** Action id to key ("Shift+1", "Mod+K"), or null for an action you took the key off. */
export type Overrides = Record<string, string | null>;

const KEY = "mixit.shortcuts";

function load(): Overrides {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!o || typeof o !== "object") return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter(([, v]) => v === null || typeof v === "string")) as Overrides;
  } catch {
    return {};
  }
}

export const useShortcuts = create<{ overrides: Overrides }>(() => ({ overrides: load() }));

/** The registry as the engine describes it, before your keys. */
let pristine: ActionSpec[] = [];

/** Actions a key can play: buttons and switches (a key cannot turn a knob). */
export function bindable(a: ActionSpec): boolean {
  return a.kind.type !== "continuous" || a.shortcut != null;
}

const norm = (k: string) => k.toUpperCase();

/** The registry with `overrides` laid over it. A key you gave to one action is taken off the action that had it by default. */
export function withOverrides(registry: ActionSpec[], overrides: Overrides): ActionSpec[] {
  const taken = new Set(
    Object.values(overrides)
      .filter((k): k is string => !!k)
      .map(norm),
  );
  return registry.map((a) => {
    if (a.id in overrides) return overrides[a.id] === a.shortcut ? a : { ...a, shortcut: overrides[a.id] };
    if (a.shortcut && taken.has(norm(a.shortcut))) return { ...a, shortcut: null };
    return a;
  });
}

/** Called with the registry from the engine: keeps it and publishes it with your keys. */
export function installRegistry(registry: ActionSpec[]) {
  pristine = registry;
  useApp.getState().set({ registry: withOverrides(registry, useShortcuts.getState().overrides) });
}

function commit(overrides: Overrides) {
  useShortcuts.setState({ overrides });
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    // Kept for this session only.
  }
  if (pristine.length) useApp.getState().set({ registry: withOverrides(pristine, overrides) });
}

export function defaultShortcut(id: string): string | null {
  return pristine.find((a) => a.id === id)?.shortcut ?? null;
}

/** The action that `key` plays now (other than `except`). */
export function holderOf(key: string, except?: string): ActionSpec | null {
  const k = norm(key);
  return useApp.getState().registry.find((a) => a.id !== except && a.shortcut && norm(a.shortcut) === k) ?? null;
}

/** Gives `key` to action `id` (null takes its key off). Whatever had the key loses it. */
export function setShortcut(id: string, key: string | null) {
  const o = { ...useShortcuts.getState().overrides };
  if (key) {
    for (const [other, k] of Object.entries(o)) if (other !== id && k && norm(k) === norm(key)) o[other] = null;
  }
  if (key !== null && key === defaultShortcut(id)) delete o[id];
  else o[id] = key;
  commit(o);
}

export function resetShortcut(id: string) {
  const o = { ...useShortcuts.getState().overrides };
  delete o[id];
  commit(o);
}

export function resetAllShortcuts() {
  commit({});
}

/** Keys that cannot be given to an action: they belong to the system or to typing. */
export function reservedKey(key: string): string | null {
  if (["Tab", "Shift+Tab"].includes(key)) return "Tab moves between controls.";
  if (key === "Escape") return "Escape closes windows and menus.";
  if (/^(Shift|Control|Alt|Meta|Mod|CapsLock|Dead|Unidentified)$/.test(key.split("+").pop() ?? "")) return "";
  if (["Mod+Q", "Mod+W", "Mod+T", "Mod+N", "Mod+L", "F5", "F11", "F12"].includes(key)) return "The system or the window uses this key.";
  return null;
}
