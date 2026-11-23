// Keeps the app's windows in step. The engine reports deck positions, levels and loads to
// every window itself, but some values only live in the UI (mixer and effect settings,
// the sampler pads, the step sequencer's pattern, the mic's controls; see
// lib/actions.ts). When one window changes them, the others get the change, and a new
// window asks for all of them when it opens.
//
// Recording and its feedback belong to the main window (it keeps the moves you make
// while recording), so a part window asks the main window to start, stop or show them.
import type { StoreApi, UseBoundStore } from "zustand";
import { backend } from "../backend";
import type { WindowMessage } from "../backend/types";
import { useApp } from "../store/app";
import { useMic } from "../store/mic";
import { useSequencer } from "../store/sequencer";

type AnyStore = UseBoundStore<StoreApi<object>>;

/** The stores shared between windows, and which of their values. */
const SHARED: Record<string, { store: AnyStore; keys: string[] | null }> = {
  app: { store: useApp as unknown as AnyStore, keys: ["mixer", "pads", "kit", "settings", "targetDeck", "decks", "padTabs", "toolTab"] },
  // null: every value that is not a function.
  seq: { store: useSequencer as unknown as AnyStore, keys: null },
  mic: { store: useMic as unknown as AnyStore, keys: null },
};

const LOCAL_ONLY = new Set(["page"]);

function shared(name: string, state: object): Record<string, unknown> {
  const { keys } = SHARED[name];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === "function" || LOCAL_ONLY.has(k)) continue;
    if (keys && !keys.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Which shared values differ (by reference) between two states. */
export function changed(name: string, next: object, prev: object): Record<string, unknown> | null {
  const a = shared(name, next);
  const b = shared(name, prev);
  let patch: Record<string, unknown> | null = null;
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) (patch ??= {})[k] = a[k];
  }
  return patch;
}

/** Things a part window asks the main window to do. */
export type MainRun = "global.record" | "app.feedback";

/**
 * Starts sharing with the other windows. `main` answers new windows with everything and
 * runs what part windows ask it to (`run`). Returns a stop function.
 */
export function startWindowSync(main: boolean, run: (id: MainRun) => void): () => void {
  const b = backend();
  if (!b.broadcast || !b.onBroadcast) return () => undefined;
  const send = (m: WindowMessage) => b.broadcast?.(m);
  let applying = false;
  const offs = Object.entries(SHARED).map(([name, { store }]) =>
    store.subscribe((next, prev) => {
      if (applying) return;
      const patch = changed(name, next, prev);
      if (patch) send({ kind: "sync", store: name, patch });
    }),
  );
  const offBus = b.onBroadcast((m) => {
    if (m.kind === "sync" && SHARED[m.store]) {
      applying = true;
      try {
        SHARED[m.store].store.setState(m.patch);
      } finally {
        applying = false;
      }
    } else if (m.kind === "hello" && main) {
      for (const [name, { store }] of Object.entries(SHARED)) send({ kind: "sync", store: name, patch: shared(name, store.getState()) });
    } else if (m.kind === "run" && main) {
      run(m.id as MainRun);
    }
  });
  if (!main) send({ kind: "hello" });
  return () => {
    offs.forEach((f) => f());
    offBus();
  };
}

/** In a part window: asks the main window to run something. */
export function runInMain(id: MainRun) {
  backend().broadcast?.({ kind: "run", id });
}
