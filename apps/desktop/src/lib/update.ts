// Updating MixIt from the git checkout it was built from (src-tauri/src/update.rs):
// a quiet check a little after start, and what to do when the update job finishes.
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../backend";
import type { JobProgress, UpdateStatus } from "../backend/types";
import { useApp } from "../store/app";

export const useUpdate = create<{ status: UpdateStatus | null; checking: boolean; ready: boolean }>(() => ({ status: null, checking: false, ready: false }));

/** Looks for new code; returns what it found (null if checking failed outright). */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  useUpdate.setState({ checking: true });
  try {
    const status = await backend().updateCheck();
    useUpdate.setState({ status });
    return status;
  } catch (e) {
    useUpdate.setState({ status: null });
    toast.error(`Couldn't check for updates: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    useUpdate.setState({ checking: false });
  }
}

export function startUpdate() {
  useUpdate.setState({ ready: false });
  backend()
    .updateInstall()
    .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
}

/** A little after start, tells the person when new code is waiting (desktop only). */
export function checkSoonAfterStart(delayMs = 15_000) {
  if (backend().kind !== "tauri") return;
  window.setTimeout(async () => {
    if (useApp.getState().settings?.checkUpdates === false) return;
    const s = await backend()
      .updateCheck()
      .catch(() => null);
    if (!s) return;
    useUpdate.setState({ status: s });
    if (s.waiting > 0 && s.canInstall) {
      toast.message(`A MixIt update is ready (${s.waiting} ${s.waiting === 1 ? "change" : "changes"})`, {
        description: s.changes[0] ? `Newest: ${s.changes[0]}` : undefined,
        duration: 15_000,
        action: { label: "Update", onClick: startUpdate },
      });
    }
  }, delayMs);
}

/** The update job's end: offer the restart, or say what went wrong. */
export function updateFinished(j: JobProgress) {
  if (j.kind !== "update" || !j.finished) return;
  if (j.error) return; // shown like every job's error
  useUpdate.setState({ ready: true });
  toast.success("MixIt is updated", { description: j.message, duration: Infinity, action: { label: "Restart now", onClick: () => void backend().updateRestart() } });
}
