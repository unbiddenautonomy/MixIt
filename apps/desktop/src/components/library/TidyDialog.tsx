// "Tidy details": proposes fixes for messy titles, artists and genres (from file names,
// spaces, clutter, "ft.", SHOUTING, genre spellings), shows each change before anything is
// saved, and applies the ones you keep as one step you can undo.
import { keyLabel } from "../../lib/platform";
import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { ArrowRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { backend } from "../../backend";
import type { TrackRow } from "../../backend/types";
import { plural } from "../../lib/format";
import { editEachWithUndo } from "../../lib/libraryUndo";
import { DEFAULT_TIDY, editsFor, TIDY_RULES, tidyChanges, type TidyChange, type TidyField, type TidyOptions } from "../../lib/tidy";
import { Btn } from "../ui/Button";
import { refreshRows, refreshStats } from "./data";
import { fileName } from "../../lib/platform";

const useTidy = create<{ rows: TrackRow[] | null }>(() => ({ rows: null }));

/** Opens the tidy window for these tracks. */
export function openTidy(rows: TrackRow[]) {
  useTidy.setState({ rows });
}

export function TidyHost() {
  const rows = useTidy((s) => s.rows);
  return rows ? <Tidy rows={rows} /> : null;
}

const FIELD_LABEL: Record<TidyField, string> = { title: "Title", artist: "Artist", album: "Album", genre: "Genre", label: "Label" };
const SHOWN = 400;
const keyOf = (c: TidyChange) => `${c.id}:${c.field}`;

function Tidy({ rows }: { rows: TrackRow[] }) {
  const [opts, setOpts] = useState<TidyOptions>(DEFAULT_TIDY);
  const [library, setLibrary] = useState<TrackRow[] | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const close = () => useTidy.setState({ rows: null });

  // Genre spellings come from the whole library, not just these tracks.
  useEffect(() => {
    let live = true;
    backend()
      .search("")
      .then((all) => live && setLibrary(all))
      .catch(() => live && setLibrary(rows));
    return () => {
      live = false;
    };
  }, [rows]);

  const changes = useMemo(() => (library ? tidyChanges(rows, opts, library) : []), [rows, opts, library]);
  const kept = changes.filter((c) => !skipped.has(keyOf(c)));
  const tracks = new Set(kept.map((c) => c.id)).size;
  const byTrack = useMemo(() => {
    const m = new Map<number, TidyChange[]>();
    for (const c of changes.slice(0, SHOWN)) m.set(c.id, [...(m.get(c.id) ?? []), c]);
    return [...m.entries()];
  }, [changes]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const apply = async () => {
    if (!kept.length) return;
    setBusy(true);
    try {
      await editEachWithUndo(editsFor(kept), rows, "Tidy details", `Tidied ${plural(tracks, "track")}`);
      refreshRows();
      refreshStats();
      close();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (c: TidyChange) =>
    setSkipped((s) => {
      const n = new Set(s);
      if (n.has(keyOf(c))) n.delete(keyOf(c));
      else n.add(keyOf(c));
      return n;
    });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[88vh] w-[min(860px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-white/10 bg-zinc-900 p-5 text-sm shadow-2xl" data-testid="tidy-dialog">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-semibold text-zinc-50">Tidy track details</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-relaxed text-zinc-400">
                {plural(rows.length, "track")}. See every change before it is saved, untick any you want to keep as it is, and undo it all afterwards with {keyLabel("Mod+Z")}. Your files are not changed until you choose Write tags to the file.
              </Dialog.Description>
            </div>
            <Dialog.Close className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-[230px_1fr]">
            <div className="flex flex-col gap-1.5">
              {TIDY_RULES.map((r) => (
                <label key={r.key} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-white/[0.04]" title={r.about}>
                  <input type="checkbox" checked={opts[r.key]} onChange={(e) => setOpts({ ...opts, [r.key]: e.target.checked })} className="mt-0.5 accent-sky-400" data-testid={`tidy-rule-${r.key}`} />
                  <span className="min-w-0">
                    <span className="block text-xs text-zinc-200">{r.label}</span>
                    <span className="block text-[11px] leading-snug text-zinc-500">{r.about}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="flex min-h-[240px] min-w-0 flex-col overflow-hidden rounded-xl border border-white/[0.06] bg-black/20">
              {!library ? (
                <p className="p-6 text-center text-xs text-zinc-500">Looking at your library…</p>
              ) : changes.length === 0 ? (
                <p className="p-6 text-center text-xs text-zinc-500" data-testid="tidy-nothing">
                  Nothing to tidy with these rules. The details look clean.
                </p>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="tidy-changes">
                  {byTrack.map(([id, list]) => {
                    const r = rowById.get(id);
                    return (
                      <div key={id} className="border-b border-white/[0.04] px-1 py-1.5 last:border-0">
                        <div className="truncate text-[11px] text-zinc-500" title={r?.path}>
                          {r ? fileName(r.path) : null}
                        </div>
                        {list.map((c) => (
                          <label key={c.field} className="grid cursor-pointer grid-cols-[16px_52px_minmax(0,1fr)_14px_minmax(0,1fr)] items-center gap-2 py-0.5 text-xs">
                            <input type="checkbox" checked={!skipped.has(keyOf(c))} onChange={() => toggle(c)} className="accent-sky-400" aria-label={`Change ${FIELD_LABEL[c.field]}`} />
                            <span className="text-zinc-500">{FIELD_LABEL[c.field]}</span>
                            <span className={clsx("truncate", c.before ? "text-zinc-500 line-through decoration-zinc-600" : "italic text-zinc-600")} title={c.before}>
                              {c.before || "empty"}
                            </span>
                            <ArrowRight size={11} className="text-zinc-600" />
                            <span className={clsx("truncate", skipped.has(keyOf(c)) ? "text-zinc-500" : "text-zinc-100")} title={c.after}>
                              {c.after}
                            </span>
                          </label>
                        ))}
                      </div>
                    );
                  })}
                  {changes.length > SHOWN && <p className="p-2 text-center text-[11px] text-zinc-500">and {plural(changes.length - SHOWN, "more change")}, applied the same way.</p>}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400" data-testid="tidy-count">
              {kept.length ? `${plural(kept.length, "change")} to ${plural(tracks, "track")}` : "No changes chosen"}
            </span>
            <div className="ml-auto flex gap-2">
              <Btn onClick={close}>Cancel</Btn>
              <Btn tone="accent" onClick={() => void apply()} disabled={busy || !kept.length} data-testid="tidy-apply">
                Apply {kept.length ? plural(kept.length, "change") : ""}
              </Btn>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
