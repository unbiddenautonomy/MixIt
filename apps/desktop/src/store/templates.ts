// Transition templates the user saved in Arrange, kept in this browser profile (the
// desktop app's webview keeps it too).
import { create } from "zustand";
import type { TransitionTemplate } from "../lib/arrangeOps";

const KEY = "mixit.transitionTemplates";

function load(): TransitionTemplate[] {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as TransitionTemplate[]).filter((t) => t && typeof t.id === "string" && Array.isArray(t.out) && Array.isArray(t.in)) : [];
  } catch {
    return [];
  }
}

function store(list: TransitionTemplate[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private windows and blocked storage: the templates last for this session.
  }
}

export const useTemplates = create<{ list: TransitionTemplate[]; add: (t: TransitionTemplate) => void; remove: (id: string) => void }>((set, get) => ({
  list: load(),
  add: (t) => {
    const list = [...get().list.filter((x) => x.name !== t.name), t];
    store(list);
    set({ list });
  },
  remove: (id) => {
    const list = get().list.filter((x) => x.id !== id);
    store(list);
    set({ list });
  },
}));
