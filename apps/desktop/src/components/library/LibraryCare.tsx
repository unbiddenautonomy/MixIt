// Fix library: tracks whose files moved or vanished, and duplicate copies of the same
// audio. Both are common in a collection that has lived on more than one drive.
import clsx from "clsx";
import { Check, CopyX, FileSearch, FolderSearch, Loader2, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import type { TrackRow } from "../../backend/types";
import { clock, plural } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { AUDIO_EXTENSIONS } from "../sampler/SamplerPanel";
import { ask } from "../shell/Dialogs";
import { Btn } from "../ui/Button";
import { refreshCare, refreshStats } from "./data";

function report(e: unknown) {
  toast.error(e instanceof Error ? e.message : String(e));
}

/** The copy to keep from a group of duplicates: one whose file is there, then the best rated, most played, oldest. */
export function bestCopy(g: TrackRow[]): TrackRow {
  return [...g].sort((a, b) => Number(a.missing) - Number(b.missing) || b.rating - a.rating || b.playCount - a.playCount || a.addedAt - b.addedAt || a.id - b.id)[0];
}

export function LibraryCare() {
  const missing = useLibrary((s) => s.missing);
  const dupes = useLibrary((s) => s.duplicates);
  useEffect(() => {
    void refreshCare();
  }, []);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" data-testid="library-care">
      <p className="max-w-2xl text-[12px] leading-snug text-zinc-400">
        Keep your collection tidy. When music moves to another drive or folder, MixIt can find it again and keep its cues, beat grid and history. Copies of the same track can be folded into one, so playlists and cues are not split between them.
      </p>
      <Missing rows={missing} />
      <Duplicates groups={dupes} />
    </div>
  );
}

function Section({ icon, title, count, children, actions }: { icon: React.ReactNode; title: string; count: number | null; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-zinc-900/50 p-3">
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">{icon}</span>
        <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
        {count != null && <span className={clsx("rounded-full px-1.5 font-mono text-[10px]", count ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/10 text-emerald-300")}>{count}</span>}
        <div className="ml-auto flex gap-1.5">{actions}</div>
      </div>
      {children}
    </section>
  );
}

function Missing({ rows }: { rows: TrackRow[] | null }) {
  const [busy, setBusy] = useState(false);
  const searchFolder = async () => {
    const dirs = await backend().pickFolders();
    if (!dirs?.length) return;
    setBusy(true);
    try {
      let n = 0;
      for (const d of dirs) n += await backend().findMissing(d);
      const left = rows ? rows.length - n : 0;
      if (n) toast.success(`Found ${plural(n, "track")}`, { description: left > 0 ? `${plural(left, "track")} still missing.` : "Every track is back, with its cues and grid." });
      else toast.message("No missing tracks there", { description: "MixIt looks for the same file name, or the same audio under another name, in that folder and every folder inside it." });
      await refreshCare();
      refreshStats();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };
  const locate = async (t: TrackRow) => {
    const f = await backend().pickFiles(AUDIO_EXTENSIONS, `Where is “${t.title}” now?`);
    if (!f?.length) return;
    try {
      await backend().relocateTrack(t.id, f[0]);
      toast.success(`Found “${t.title}”`);
      await refreshCare();
    } catch (e) {
      report(e);
    }
  };
  const remove = async (ids: number[]) => {
    const ok = await ask({
      title: ids.length === 1 ? "Remove this track from the library?" : `Remove ${ids.length} missing tracks from the library?`,
      body: "Their cues, beat grids and places in playlists are lost. Files on disk are not touched.",
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await backend().removeTracks(ids);
      await refreshCare();
      refreshStats();
    } catch (e) {
      report(e);
    }
  };
  return (
    <Section
      icon={<FileSearch size={15} />}
      title="Missing files"
      count={rows?.length ?? null}
      actions={
        rows?.length ? (
          <>
            <Btn size="sm" tone="accent" onClick={searchFolder} disabled={busy}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <FolderSearch size={12} />} Search a folder…
            </Btn>
            <Btn size="sm" tone="ghost" onClick={() => remove(rows.map((r) => r.id))}>
              <Trash2 size={12} /> Remove all
            </Btn>
          </>
        ) : null
      }
    >
      {rows == null ? (
        <p className="text-[12px] text-zinc-500">Checking…</p>
      ) : rows.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[12px] text-emerald-300">
          <Check size={13} /> Every track's file is where MixIt expects it.
        </p>
      ) : (
        <>
          <p className="text-[12px] leading-snug text-zinc-400">These files were moved, renamed or deleted. Pick the folder they are in now (a drive or your music folder) and MixIt finds them, even under a new name.</p>
          <ul className="flex flex-col divide-y divide-white/[0.04]">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-1.5" data-missing={t.id}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-zinc-100">
                    {t.title} <span className="text-zinc-500">· {t.artist}</span>
                  </div>
                  <div className="truncate font-mono text-[10px] text-zinc-500" title={t.path}>
                    {t.path}
                  </div>
                </div>
                <Btn size="sm" onClick={() => locate(t)}>
                  Locate…
                </Btn>
                <Btn size="sm" tone="ghost" onClick={() => remove([t.id])} aria-label={`Remove ${t.title}`}>
                  <Trash2 size={12} />
                </Btn>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Duplicates({ groups }: { groups: TrackRow[][] | null }) {
  const [keep, setKeep] = useState<Record<string, number>>({});
  const keyOf = (g: TrackRow[]) => g.map((t) => t.id).join(",");
  const keeper = (g: TrackRow[]) => keep[keyOf(g)] ?? bestCopy(g).id;
  const merge = async (list: TrackRow[][]) => {
    try {
      for (const g of list) {
        const k = keeper(g);
        await backend().mergeTracks(
          k,
          g.map((t) => t.id).filter((id) => id !== k),
        );
      }
      toast.success(list.length === 1 ? "Copies folded into one" : `${plural(list.length, "group")} of copies folded`, { description: "Playlists, tags, history and cues now point at the copy you kept. Files on disk are not touched." });
      await refreshCare();
      refreshStats();
    } catch (e) {
      report(e);
    }
  };
  return (
    <Section
      icon={<CopyX size={15} />}
      title="Duplicates"
      count={groups?.length ?? null}
      actions={
        groups && groups.length > 1 ? (
          <Btn size="sm" tone="accent" onClick={() => merge(groups)} title="Keeps the chosen copy in every group">
            Fold all
          </Btn>
        ) : null
      }
    >
      {groups == null ? (
        <p className="text-[12px] text-zinc-500">Checking…</p>
      ) : groups.length === 0 ? (
        <p className="flex items-center gap-1.5 text-[12px] text-emerald-300">
          <Check size={13} /> No track is in the library twice.
        </p>
      ) : (
        <>
          <p className="text-[12px] leading-snug text-zinc-400">The same audio is in the library more than once. Choose the copy to keep: the others' playlist places, tags, history and cues move to it, and they leave the library (their files stay on disk).</p>
          {groups.map((g) => {
            const k = keeper(g);
            return (
              <div key={keyOf(g)} className="flex flex-col gap-1 rounded-lg border border-white/[0.05] p-2" data-dupes={keyOf(g)}>
                <div className="flex items-center gap-2 text-[12px] text-zinc-100">
                  <span className="truncate font-medium">{g[0].title}</span>
                  <span className="truncate text-zinc-500">{g[0].artist}</span>
                  <span className="font-mono text-[10px] text-zinc-500">{clock(g[0].duration)}</span>
                  <Btn size="sm" className="ml-auto" onClick={() => merge([g])}>
                    Keep one, fold the rest
                  </Btn>
                </div>
                {g.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-white/[0.03]">
                    <input type="radio" name={`keep-${keyOf(g)}`} checked={k === t.id} onChange={() => setKeep((s) => ({ ...s, [keyOf(g)]: t.id }))} className="accent-[var(--accent)]" />
                    <span className={clsx("min-w-0 flex-1 truncate font-mono", t.missing ? "text-red-300/70 line-through" : "text-zinc-400")} title={t.path}>
                      {t.path}
                    </span>
                    <span className="flex items-center gap-0.5 text-zinc-500">
                      <Star size={10} /> {t.rating}
                    </span>
                    <span className="w-16 text-right text-zinc-500">{plural(t.playCount, "play")}</span>
                    {k === t.id && <span className="rounded bg-emerald-400/15 px-1 text-[10px] text-emerald-300">keep</span>}
                  </label>
                ))}
              </div>
            );
          })}
        </>
      )}
    </Section>
  );
}
