// The library panel: sources on the left, search and the track list in the middle,
// the inspector on the right.
import * as Popover from "@radix-ui/react-popover";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { FolderPlus, HelpCircle, Import, Loader2, Search, Upload, Wand2, X, Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { plural } from "../../lib/format";
import { useApp } from "../../store/app";
import { useLibrary } from "../../store/library";
import { Btn } from "../ui/Button";
import { keepSoundsLike, refreshAll, refreshPlaylists, refreshRows, refreshStats } from "./data";
import { Inspector } from "./Inspector";
import { newSmart, Sidebar } from "./Sidebar";
import { Suggestions } from "./Suggestions";
import { TrackTable } from "./TrackTable";
import { AutoDjView } from "../autodj/AutoDj";
import { LibraryCare } from "./LibraryCare";
import { InsightsView } from "./Insights";
import { PreviewBar } from "./PreviewBar";
import { RehearsalBar } from "./RehearsalBar";
import { SetFlow, SetFlowToggle } from "./SetFlow";
import { HistoryBar } from "./HistoryBar";

export async function addMusicFolder() {
  const dirs = await backend().pickFolders();
  if (!dirs || dirs.length === 0) return;
  await backend().addToLibrary(dirs);
  toast.message(`Scanning ${plural(dirs.length, "folder")}…`, { description: "Tracks appear as they are found, then MixIt analyses tempo, key and structure." });
}

export function Library({ full = false }: { full?: boolean }) {
  const source = useLibrary((s) => s.source);
  useEffect(() => {
    refreshAll();
  }, []);
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border border-white/[0.06] bg-zinc-900/40">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar />
        <SetFlow />
        <HistoryBar />
        {source.type === "suggest" ? <Suggestions /> : source.type === "autodj" ? <AutoDjView /> : source.type === "care" ? <LibraryCare /> : source.type === "insights" ? <InsightsView /> : <TrackTable />}
        <PreviewBar />
        <RehearsalBar />
      </div>
      {source.type !== "autodj" && source.type !== "care" && source.type !== "insights" && (full || source.type !== "suggest") && <Inspector />}
    </div>
  );
}

function Toolbar() {
  const query = useLibrary((s) => s.query);
  const currentSession = useLibrary((s) => s.currentSession);
  const rows = useLibrary((s) => s.rows.length);
  const selected = useLibrary((s) => s.selected.length);
  const source = useLibrary((s) => s.source);
  const playlists = useLibrary((s) => s.playlists);
  const stats = useLibrary((s) => s.stats);
  const jobs = useApp((s) => s.jobs);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef(0);

  useEffect(() => {
    const focus = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, []);

  const title =
    source.type === "all" ? "Collection" : source.type === "history" ? (source.session != null && source.session !== currentSession ? "Past set" : "History") : source.type === "suggest" ? "Suggestions" : source.type === "autodj" ? "Auto DJ" : source.type === "care" ? "Fix library" : source.type === "insights" ? "Your collection at a glance" : source.type === "tag" ? `Tagged “${source.name}”` : source.type === "similar" ? `Sounds like “${source.title}”` : (playlists.find((p) => p.id === source.id)?.name ?? "Playlist");
  const job = Object.values(jobs).find((j) => !j.finished && j.kind !== "render");

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-zinc-100">{title}</div>
      </div>
      {/* Auto DJ shows its own queue count; the library row count there would read as the queue's. */}
      {source.type !== "care" && source.type !== "insights" && source.type !== "autodj" && (
        <span className="font-mono text-[10px] text-zinc-500">
          {rows}
          {selected > 1 && ` · ${selected} selected`}
        </span>
      )}
      {source.type !== "suggest" && source.type !== "autodj" && source.type !== "care" && source.type !== "insights" && (
        <div className="relative ml-2 flex max-w-md flex-1 items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-zinc-500" />
          <input
            ref={input}
            value={query}
            placeholder="Search… try bpm:120-128 key:~8A energy:6+"
            onChange={(e) => {
              useLibrary.getState().set({ query: e.target.value });
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(refreshRows, 140);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                useLibrary.getState().set({ query: "" });
                refreshRows();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                (document.querySelector("[data-testid=track-table]") as HTMLElement | null)?.focus();
              }
            }}
            className="input h-7 w-full pl-7 pr-12"
            data-testid="library-search"
          />
          {query && (
            <button
              type="button"
              className="absolute right-7 text-zinc-500 hover:text-zinc-200"
              onClick={() => {
                useLibrary.getState().set({ query: "" });
                refreshRows();
              }}
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
          <QueryHelp />
          {query.trim() && source.type === "all" && (
            <button type="button" onClick={() => void newSmart()} title="Make a smart playlist from this search: it keeps every track that matches, now and later" aria-label="Save search as a smart playlist" className="absolute -right-7 flex size-6 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-100" data-testid="save-smart">
              <Wand2 size={13} />
            </button>
          )}
        </div>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {source.type === "playlist" && <SetFlowToggle />}
        {source.type === "similar" && (
          <Btn size="sm" onClick={() => void keepSoundsLike()} title="A smart playlist that keeps every track sounding like this one, including tracks you add later" data-testid="keep-sounds-like">
            <Wand2 size={12} /> Keep as smart playlist
          </Btn>
        )}
        {job && (
          <div className="flex items-center gap-2 rounded-md bg-white/[0.05] px-2 py-1 text-[11px] text-zinc-300">
            <Loader2 size={12} className="animate-spin text-sky-300" />
            <span className="max-w-48 truncate">{job.message || (job.kind === "scan" ? "Scanning" : "Analysing")}</span>
            {job.total > 0 && <span className="font-mono text-zinc-500">{job.done}/{job.total}</span>}
            <button type="button" className="text-zinc-500 hover:text-zinc-100" onClick={() => backend().cancelJob()} aria-label="Cancel">
              <X size={11} />
            </button>
          </div>
        )}
        {!job && stats && stats.pending > 0 && (
          <Btn size="sm" tone="accent" style={{ ["--accent" as string]: "#38bdf8" }} onClick={() => backend().analyzePending()}>
            <Zap size={12} /> Analyse {stats.pending}
          </Btn>
        )}
        <Btn size="sm" onClick={addMusicFolder}>
          <FolderPlus size={12} /> Add music
        </Btn>
        <ImportExport />
      </div>
    </div>
  );
}

export type DjApp = "rekordbox" | "traktor" | "serato" | "virtualdj";

/** Other DJ apps whose libraries MixIt imports, and how each is picked. */
export const DJ_APPS: Record<DjApp, { name: string; menu: string; pick: () => Promise<string[] | null>; run: (path: string) => Promise<void> }> = {
  rekordbox: { name: "rekordbox", menu: "Import rekordbox XML…", pick: () => backend().pickFiles(["xml"], "rekordbox collection (XML)"), run: (p) => backend().importRekordbox(p) },
  traktor: { name: "Traktor", menu: "Import Traktor collection…", pick: () => backend().pickFiles(["nml"], "Traktor collection (collection.nml)"), run: (p) => backend().importTraktor(p) },
  serato: { name: "Serato", menu: "Import Serato library (the _Serato_ folder)…", pick: () => backend().pickFolders("Choose the _Serato_ folder"), run: (p) => backend().importSerato(p) },
  virtualdj: { name: "VirtualDJ", menu: "Import VirtualDJ library (the VirtualDJ folder)…", pick: () => backend().pickFolders("Choose the VirtualDJ folder"), run: (p) => backend().importVirtualDj(p) },
};

/** Asks for another app's library and imports it (tracks, cues, grids, playlists). */
export async function importFromApp(app: DjApp) {
  const a = DJ_APPS[app];
  if (backend().kind === "web") {
    // The browser gets the collection file but cannot reach the music it points to.
    toast.message(`Importing from ${a.name} needs the desktop app`, { description: "A web page cannot open the music files a DJ library points to." });
    return;
  }
  try {
    const picked = await a.pick();
    if (!picked?.[0]) return;
    await a.run(picked[0]);
    await refreshAll();
    toast.message(`Importing from ${a.name}…`, { description: "Tracks, cues, beat grids and playlists come in first, then MixIt analyses anything new." });
  } catch (e) {
    toast.error(String(e));
  }
}

function ImportExport() {
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try {
      const r = await f();
      if (r !== false) toast.success(ok);
    } catch (e) {
      toast.error(String(e));
    }
  };
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Btn size="sm" tone="ghost" aria-label="Import and export">
          <Import size={13} />
        </Btn>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={4}>
          {(Object.keys(DJ_APPS) as DjApp[]).map((app) => (
            <Dropdown.Item key={app} className="menu-item" onSelect={() => void importFromApp(app)}>
              <Import size={12} /> {DJ_APPS[app].menu}
            </Dropdown.Item>
          ))}
          <Dropdown.Item
            className="menu-item"
            onSelect={() =>
              run(async () => {
                const f = await backend().pickFiles(["m3u", "m3u8"], "Playlist (M3U)");
                if (!f?.[0]) return false;
                await backend().importM3u(f[0]);
                await refreshPlaylists();
              }, "Imported playlist")
            }
          >
            <Import size={12} /> Import M3U playlist…
          </Dropdown.Item>
          <Dropdown.Separator className="menu-sep" />
          <Dropdown.Item
            className="menu-item"
            onSelect={() =>
              run(async () => {
                const p = await backend().pickSave("MixIt collection.xml", ["xml"]);
                if (!p) return false;
                await backend().exportRekordbox(p, null);
              }, "Exported for rekordbox")
            }
          >
            <Upload size={12} /> Export collection for rekordbox…
          </Dropdown.Item>
          <Dropdown.Item
            className="menu-item"
            onSelect={() =>
              run(async () => {
                const p = await backend().pickSave("MixIt collection.nml", ["nml"]);
                if (!p) return false;
                await backend().exportTraktor(p, null);
              }, "Exported for Traktor")
            }
          >
            <Upload size={12} /> Export collection for Traktor…
          </Dropdown.Item>
          <Dropdown.Separator className="menu-sep" />
          <Dropdown.Item
            className="menu-item"
            onSelect={() =>
              run(async () => {
                await backend().rescan();
                await refreshStats();
              }, "Rescanning your music folders")
            }
          >
            Rescan folders
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

const HELP: [string, string][] = [
  ["deep house", "words match title, artist, album, genre, label…"],
  ['"sweet dreams"', "an exact phrase"],
  ["bpm:120-128", "tempo range (also >120, <=128)"],
  ["bpm:~128", "mixable with 128 (±6%, half and double time)"],
  ["key:8A", "exact key (Camelot, Open Key or Am, F#)"],
  ["key:~8A", "keys that mix well with 8A"],
  ["energy:6+", "energy 6 or more"],
  ["rating:4+", "4 stars or more"],
  ["genre:techno", "any text field: artist: title: album: label: comment:"],
  ['tag:"peak time"', "tracks with your tag (quote tags with spaces)"],
  ["-genre:trance", "a leading - excludes"],
  ["played:never", "never played (also played:<7d, played:>30d)"],
  ["like:42", "sounds like track 42 (right-click a track: Find tracks that sound like this)"],
  ["vocals:no", "instrumentals; vocals:yes has singing, vocals:30+ sings in at least 30%"],
  ["added:<2w", "added in the last two weeks"],
  ["sort:-energy", "sort (bpm key energy added plays random …)"],
];

function QueryHelp() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="absolute right-2 text-zinc-500 hover:text-zinc-200" aria-label="Search help">
          <HelpCircle size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-96 rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur">
          <div className="mb-2 font-medium text-zinc-100">Search language</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {HELP.map(([q, d]) => (
              <button
                key={q}
                type="button"
                className="contents text-left"
                onClick={() => {
                  const cur = useLibrary.getState().query;
                  useLibrary.getState().set({ query: `${cur} ${q}`.trim() });
                  refreshRows();
                }}
              >
                <code className="rounded bg-white/[0.06] px-1 font-mono text-[11px] text-sky-300">{q}</code>
                <span className="text-zinc-400">{d}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">The same language makes smart playlists: press the wand beside the search to keep a search as one.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
