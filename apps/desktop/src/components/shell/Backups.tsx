// Library backups in Settings: the daily copies MixIt keeps, a button to back up now or
// save a copy elsewhere, and restoring (which first saves the library as it is, so a
// restore can be undone).
import { Download, HardDriveDownload, History, Loader2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import type { BackupInfo } from "../../backend/types";
import { plural } from "../../lib/format";
import { useApp } from "../../store/app";
import { refreshAll } from "../library/data";
import { ask } from "./Dialogs";
import { fileName } from "../../lib/platform";

const KIND: Record<BackupInfo["kind"], string> = { auto: "Daily", manual: "By hand", beforeRestore: "Before a restore" };

export function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function when(unix: number, now = Date.now()): string {
  const d = new Date(unix * 1000);
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" })}, ${time}`;
}

export function Backups() {
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    backend()
      .backups()
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try {
      await f();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const backUp = () =>
    run("now", async () => {
      await backend().backupLibrary(null);
      toast.success("Library backed up");
    });

  const saveCopy = () =>
    run("copy", async () => {
      const d = new Date();
      const name = `MixIt library ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.mixitlib`;
      const path = await backend().pickSave(name, ["mixitlib"]);
      if (!path) return;
      const out = await backend().backupLibrary(path);
      toast.success("Copy of the library saved", { description: out });
    });

  const restore = (path: string, label: string, tracks: number | null) =>
    run(path, async () => {
      const ok = await ask({
        title: `Restore the library from ${label}?`,
        body: `Your library goes back to how it was then${tracks != null ? ` (${plural(tracks, "track")})` : ""}: playlists, cues, beat grids, tags and history. Anything added or changed since is undone. Your music files are not touched, and the library as it is now is saved first, so you can undo this.`,
        confirm: "Restore",
        danger: true,
      });
      if (!ok) return;
      await backend().restoreLibrary(path);
      const info = await backend().appInfo();
      useApp.getState().set({ settings: info.settings });
      await refreshAll();
      toast.success("Library restored", { description: "The library from before is kept under Backups, marked “Before a restore”." });
    });

  const fromFile = async () => {
    const files = await backend().pickFiles(["mixitlib", "db"], "Library backup");
    const path = files?.[0];
    if (path) await restore(path, fileName(path) || "that file", null);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="backups">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={!!busy} onClick={() => void backUp()} className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50" data-testid="backup-now">
          {busy === "now" ? <Loader2 size={12} className="animate-spin" /> : <HardDriveDownload size={12} />} Back up now
        </button>
        <button type="button" disabled={!!busy} onClick={() => void saveCopy()} className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50" title="Save a copy somewhere else, like a USB stick or another drive">
          <Download size={12} /> Save a copy…
        </button>
        <button type="button" disabled={!!busy} onClick={() => void fromFile()} className="flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-xs text-zinc-200 hover:bg-white/10 disabled:opacity-50" title="Restore from a backup file you saved elsewhere">
          <Upload size={12} /> Restore from a file…
        </button>
      </div>
      {list === null ? (
        <div className="text-zinc-500">Looking for backups…</div>
      ) : list.length === 0 ? (
        <div className="text-zinc-500">No backups yet. The first daily one is made the next time MixIt starts.</div>
      ) : (
        <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {list.slice(0, 20).map((b) => (
            <div key={b.path} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1" data-testid="backup-row" title={b.path}>
              <History size={12} className="shrink-0 text-zinc-500" />
              <span className="w-36 shrink-0 text-zinc-200">{when(b.created)}</span>
              <span className="w-28 shrink-0 text-[11px] text-zinc-500">{KIND[b.kind]}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">
                {b.tracks != null ? plural(b.tracks, "track") : "unreadable"} · {size(b.bytes)}
              </span>
              <button
                type="button"
                disabled={!!busy || b.tracks == null}
                onClick={() => void restore(b.path, when(b.created).replace(/^(Today|Yesterday)/, (m) => m.toLowerCase()), b.tracks)}
                className="rounded px-1.5 py-0.5 text-[11px] text-sky-300 hover:bg-sky-400/15 disabled:opacity-40"
                data-testid="backup-restore"
              >
                {busy === b.path ? <Loader2 size={11} className="animate-spin" /> : "Restore"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
