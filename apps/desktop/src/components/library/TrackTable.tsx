// The track list: virtualised (100k tracks scroll smoothly), sortable, multi-select,
// drag to decks and playlists, double-click or Enter to load. Key and BPM cells light
// up when a track mixes well with what is playing.
import { enqueueIds } from "../autodj/AutoDj";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { AlertTriangle, ArrowDown, ArrowUp, Columns3, Loader2, Star } from "lucide-react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { ask, askText } from "../shell/Dialogs";
import type { TrackRow } from "../../backend/types";
import { bpm as fmtBpm, clock, hex, plural, inkColor } from "../../lib/format";
import { compatibility, keyColor, keyFromIndex, keyLabel, type Compat } from "../../lib/keys";
import { DECK_LETTERS, deckCount, useApp, useNotation, usePro } from "../../store/app";
import { sortRows, useLibrary, type SortKey } from "../../store/library";
import { useTelemetry } from "../../store/telemetry";
import { beginTrackDrag } from "../../lib/dnd";
import { loadOnDeck } from "../deck/Deck";
import { refreshPlaylists, refreshRows, refreshStats, showSoundsLike, tagTracks, writeCuesForSerato, writeTagsToFiles } from "./data";
import { editTrack } from "../editor/TrackEditor";
import { PreviewButton } from "./PreviewBar";
import { togglePreview } from "../../store/trackPreview";
import { tagStyle } from "../../lib/tags";
import { isShown, resetColumns, setShown, setWidth, track, useColumns, type ColumnLevel } from "../../lib/columns";
import { editTracksWithUndo, withPlaylistUndo } from "../../lib/libraryUndo";
import { Cover } from "../ui/Cover";
import { openBuildSet } from "./BuildSetDialog";
import { openTidy } from "./TidyDialog";
import { vocalLabel } from "../../lib/vocals";

interface Column {
  key: string;
  label: string;
  sort: SortKey;
  width: string;
  /** Shown from Pro view on (unless you choose otherwise). */
  pro?: boolean;
  /** Off until you turn it on. */
  extra?: boolean;
  align?: "right" | "center";
  cell: (r: TrackRow, ctx: Ctx) => ReactNode;
}

interface Ctx {
  notation: "camelot" | "openKey" | "standard";
  refKey: number | null;
  refBpm: number | null;
  index: number;
  tags: Record<number, string[]>;
  matches: Record<number, number>;
}

const COMPAT_STYLE: Record<Compat, string> = {
  same: "ring-1 ring-emerald-400",
  match: "ring-1 ring-emerald-400/70",
  boost: "ring-1 ring-sky-400/70",
  shift: "",
  clash: "opacity-60",
};

export function bpmFits(a: number | null, ref: number | null): boolean {
  if (!a || !ref) return false;
  return [ref, ref * 2, ref / 2].some((r) => Math.abs(a / r - 1) <= 0.06);
}

/** Only in "Sounds like": how alike each track sounds to the chosen one. */
const MATCH: Column = {
  key: "match",
  label: "Match",
  sort: null,
  width: "64px",
  align: "right",
  cell: (r, c) => {
    const m = c.matches[r.id];
    if (m == null) return null;
    return (
      <span className="flex items-center justify-end gap-1.5" title={`Sounds ${Math.round(m * 100)} % alike`}>
        <span className="h-1 w-6 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full rounded-full bg-sky-400" style={{ width: `${Math.round(m * 100)}%` }} />
        </span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-300">{Math.round(m * 100)}</span>
      </span>
    );
  },
};

const COLUMNS: Column[] = [
  { key: "n", label: "#", sort: null, width: "36px", align: "right", cell: (_r, c) => <span className="font-mono text-[10px] text-zinc-600">{c.index + 1}</span> },
  { key: "art", label: "Art", sort: null, width: "32px", align: "center", cell: (r) => <Cover trackId={r.id} has={r.hasArt} title={r.title} artist={r.artist} size={22} rounded="rounded" quiet /> },
  {
    key: "title",
    label: "Title",
    sort: "title",
    width: "minmax(160px,2.2fr)",
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
        {!r.missing && <PreviewButton row={r} className="-ml-1" />}
        {r.color != null && <span className="size-2 shrink-0 rounded-full" style={{ background: hex(r.color) }} />}
        {r.missing && <AlertTriangle size={12} className="shrink-0 text-amber-400" aria-label="File missing" />}
        <span className={clsx("truncate", r.missing ? "text-zinc-500 line-through" : "text-zinc-100")}>{r.title || r.path.split(/[\\/]/).pop()}</span>
      </span>
    ),
  },
  { key: "artist", label: "Artist", sort: "artist", width: "minmax(120px,1.4fr)", cell: (r) => <span className="truncate text-zinc-400">{r.artist}</span> },
  {
    key: "bpm",
    label: "BPM",
    sort: "bpm",
    width: "58px",
    align: "right",
    cell: (r, c) =>
      r.analysis === "pending" ? (
        <Loader2 size={11} className="ml-auto animate-spin text-zinc-600" />
      ) : (
        <span className={clsx("font-mono tabular-nums", bpmFits(r.bpm, c.refBpm) ? "text-emerald-300" : "text-zinc-300")}>{fmtBpm(r.bpm)}</span>
      ),
  },
  {
    key: "key",
    label: "Key",
    sort: "key",
    width: "52px",
    align: "center",
    cell: (r, c) => {
      if (!r.key) return <span className="text-zinc-600">–</span>;
      const compat = c.refKey != null ? compatibility(keyFromIndex(c.refKey), keyFromIndex(r.key.index)) : null;
      return (
        <span className={clsx("rounded px-1 font-mono text-[11px] font-semibold", compat && COMPAT_STYLE[compat])} style={{ color: inkColor(keyColor(r.key)) }}>
          {keyLabel(r.key, c.notation)}
        </span>
      );
    },
  },
  { key: "energy", label: "Energy", sort: "energy", width: "62px", cell: (r) => <EnergyBar v={r.energy} /> },
  {
    key: "vocals",
    label: "Vocals",
    sort: null,
    width: "64px",
    extra: true,
    cell: (r) => (r.vocals == null ? <span className="text-zinc-600">–</span> : <span className="text-zinc-400" title={vocalLabel(r.vocals) ?? ""}>{r.vocals < 5 ? "None" : `${r.vocals}%`}</span>),
  },
  { key: "duration", label: "Time", sort: "duration", width: "52px", align: "right", cell: (r) => <span className="font-mono tabular-nums text-zinc-400">{clock(r.duration)}</span> },
  { key: "rating", label: "Rating", sort: "rating", width: "76px", cell: (r) => <Stars track={r} /> },
  { key: "genre", label: "Genre", sort: "genre", width: "minmax(80px,0.8fr)", cell: (r) => <span className="truncate text-zinc-500">{r.genre}</span> },
  {
    key: "tags",
    label: "Tags",
    sort: null,
    width: "minmax(80px,1fr)",
    pro: true,
    cell: (r, c) => (
      <span className="flex min-w-0 gap-1 overflow-hidden" title={c.tags[r.id]?.join(", ")}>
        {(c.tags[r.id] ?? []).map((n) => (
          <span key={n} className="shrink-0 rounded-full px-1.5 text-[10px] leading-4" style={tagStyle(n, null)}>
            {n}
          </span>
        ))}
      </span>
    ),
  },
  { key: "album", label: "Album", sort: "album", width: "minmax(90px,1fr)", extra: true, cell: (r) => <span className="truncate text-zinc-500">{r.album}</span> },
  { key: "label", label: "Label", sort: "label", width: "minmax(80px,0.8fr)", extra: true, cell: (r) => <span className="truncate text-zinc-500">{r.label}</span> },
  { key: "year", label: "Year", sort: "year", width: "48px", align: "right", extra: true, cell: (r) => <span className="font-mono text-[11px] text-zinc-500">{r.year ?? ""}</span> },
  { key: "comment", label: "Comment", sort: "comment", width: "minmax(100px,1.2fr)", extra: true, cell: (r) => <span className="truncate text-zinc-500" title={r.comment}>{r.comment}</span> },
  { key: "played", label: "Last played", sort: "lastPlayed", width: "86px", align: "right", extra: true, cell: (r) => <span className="text-[11px] text-zinc-500">{r.lastPlayed ? new Date(r.lastPlayed * 1000).toLocaleDateString() : "never"}</span> },
  { key: "lufs", label: "LUFS", sort: "lufs", width: "48px", align: "right", pro: true, cell: (r) => <span className="font-mono text-[11px] text-zinc-500">{r.lufs != null ? r.lufs.toFixed(1) : "–"}</span> },
  { key: "plays", label: "Plays", sort: "playCount", width: "44px", align: "right", pro: true, cell: (r) => <span className="font-mono text-[11px] text-zinc-500">{r.playCount || ""}</span> },
  { key: "added", label: "Added", sort: "addedAt", width: "78px", align: "right", pro: true, cell: (r) => <span className="text-[11px] text-zinc-500">{new Date(r.addedAt * 1000).toLocaleDateString()}</span> },
];

const LEVEL = (c: Column): ColumnLevel => (c.extra ? "extra" : c.pro ? "pro" : "always");

function ColumnChoices({ pro, Item, Sep }: { pro: boolean; Item: typeof ContextMenu.CheckboxItem | typeof Dropdown.CheckboxItem; Sep: typeof ContextMenu.Separator | typeof Dropdown.Separator }) {
  const prefs = useColumns();
  return (
    <>
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Columns</div>
      {COLUMNS.filter((c) => c.key !== "title" && c.key !== "n").map((c) => {
        const on = isShown(c.key, LEVEL(c), pro, prefs);
        return (
          <Item key={c.key} className="menu-item" checked={on} onSelect={(e: Event) => { e.preventDefault(); setShown(c.key, !on); }} data-testid="column-choice">
            <span className="mr-2 inline-block w-3 text-sky-300">{on ? "✓" : ""}</span>
            {c.label}
          </Item>
        );
      })}
      <Sep className="menu-sep" />
      <Item className="menu-item" checked={false} onSelect={() => resetColumns()}>
        <span className="mr-2 inline-block w-3" />
        Back to the default columns and widths
      </Item>
    </>
  );
}

/** Right-click the header to choose columns. */
function ColumnsMenu({ pro, children }: { pro: boolean; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu">
          <ColumnChoices pro={pro} Item={ContextMenu.CheckboxItem} Sep={ContextMenu.Separator} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The same choices from a button at the end of the header, for anyone who does not right-click. */
function ColumnsButton({ pro }: { pro: boolean }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" aria-label="Choose columns" title="Choose which columns show" className="mx-auto flex size-5 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200" data-testid="columns-button">
          <Columns3 size={12} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu" align="end" sideOffset={4}>
          <ColumnChoices pro={pro} Item={Dropdown.CheckboxItem} Sep={Dropdown.Separator} />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Drag a header's right edge to resize its column; double-click to put it back. */
function ResizeHandle({ col, label }: { col: string; label: string }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      title="Drag to resize. Double-click for the usual width."
      className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize after:absolute after:left-1/2 after:top-1.5 after:h-4 after:w-px after:bg-white/0 hover:after:bg-sky-400/70"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const cell = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const x0 = e.clientX;
        const move = (ev: PointerEvent) => setWidth(col, cell.width + ev.clientX - x0);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onDoubleClick={() => setWidth(col, null)}
      onClick={(e) => e.stopPropagation()}
      data-testid="column-resize"
    />
  );
}

function EnergyBar({ v }: { v: number | null }) {
  if (v == null) return <span className="text-zinc-600">–</span>;
  const n = Math.max(0, Math.min(10, v));
  return (
    <span className="flex items-center gap-1" title={`Energy ${n.toFixed(1)} / 10`}>
      <span className="h-1.5 w-8 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full" style={{ width: `${n * 10}%`, background: `hsl(${120 - n * 12}, 80%, 55%)` }} />
      </span>
      <span className="font-mono text-[10px] text-zinc-500">{Math.round(n)}</span>
    </span>
  );
}

function Stars({ track }: { track: TrackRow }) {
  return (
    <span className="flex">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={async (e) => {
            e.stopPropagation();
            const rating = track.rating === n ? 0 : n;
            const row = await editTracksWithUndo([track], { rating }, rating ? `Rate ${track.title} ${rating} stars` : `Clear the rating of ${track.title}`, undefined, false);
            if (row) useLibrary.setState((s) => ({ rows: s.rows.map((r) => (r.id === row.id ? row : r)) }));
          }}
          className="p-px"
          aria-label={`${n} stars`}
        >
          <Star size={11} className={n <= track.rating ? "fill-amber-400 text-amber-400" : "text-zinc-700 hover:text-zinc-400"} />
        </button>
      ))}
    </span>
  );
}

/** Key and BPM of the master (or playing) deck, after tempo and key shift. */
function useReference(): { key: number | null; bpm: number | null } {
  const decks = useApp((s) => s.decks);
  const sig = useTelemetry((s) => {
    const t = s.t;
    const i = t.masterDeck ?? t.decks.findIndex((d) => d.playing);
    if (i == null || i < 0) return "";
    return `${i}|${Math.round(t.decks[i].bpm * 10)}|${Math.round(t.decks[i].keyShift)}`;
  });
  return useMemo(() => {
    if (!sig) return { key: null, bpm: null };
    const [i, b, shift] = sig.split("|").map(Number);
    const k = decks[i]?.detail.key;
    const key = k ? (((k.index % 12) + shift + 120) % 12) + (k.index >= 12 ? 12 : 0) : null;
    return { key, bpm: b / 10 || null };
  }, [sig, decks]);
}

export function TrackTable() {
  const rows = useLibrary((s) => s.rows);
  const sort = useLibrary((s) => s.sort);
  const sortDir = useLibrary((s) => s.sortDir);
  const selected = useLibrary((s) => s.selected);
  const loading = useLibrary((s) => s.loading);
  const source = useLibrary((s) => s.source);
  const pro = usePro();
  const notation = useNotation();
  const ref = useReference();
  const rowTags = useLibrary((s) => s.rowTags);
  const prefs = useColumns();
  const matches = useLibrary((s) => s.matches);
  const shown = COLUMNS.filter((c) => isShown(c.key, c.extra ? "extra" : c.pro ? "pro" : "always", pro, prefs));
  // "Sounds like" puts its match right after the title.
  const cols = source.type === "similar" ? shown.flatMap((c) => (c.key === "title" ? [c, MATCH] : [c])) : shown;
  // A last narrow track holds the columns button in the header (and stays empty in rows).
  const template = `${cols.map((c) => track(c.key, c.width, prefs)).join(" ")} 24px`;
  const sorted = useMemo(() => sortRows(rows, sort, sortDir), [rows, sort, sortDir]);
  const selSet = useMemo(() => new Set(selected), [selected]);
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: sorted.length, getScrollElement: () => parent.current, estimateSize: () => 30, overscan: 12 });

  const clickRow = (e: React.MouseEvent, i: number) => {
    const s = useLibrary.getState();
    const id = sorted[i].id;
    if (e.shiftKey && s.anchor != null) {
      const [a, b] = [Math.min(s.anchor, i), Math.max(s.anchor, i)];
      s.set({ selected: sorted.slice(a, b + 1).map((r) => r.id) });
    } else if (e.metaKey || e.ctrlKey) {
      s.set({ selected: selSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id], anchor: i });
    } else s.set({ selected: [id], anchor: i, inspect: id });
  };

  // Arrow keys move the selection; Enter loads into the target deck.
  useEffect(() => {
    const el = parent.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      const s = useLibrary.getState();
      const cur = s.anchor ?? -1;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = Math.max(0, Math.min(sorted.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        if (!sorted[i]) return;
        s.set({ selected: [sorted[i].id], anchor: i, inspect: sorted[i].id });
        v.scrollToIndex(i, { align: "auto" });
      } else if (e.key === "Enter" && s.selected[0] != null) {
        e.preventDefault();
        const deck = e.shiftKey ? (useApp.getState().targetDeck + 1) % deckCount() : useApp.getState().targetDeck;
        loadOnDeck(deck, s.selected[0]);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [sorted, v]);

  const header = (c: Column, i: number) => (
    <div key={c.key} className="relative flex h-full min-w-0 items-center">
    <button
      type="button"
      disabled={!c.sort}
      onClick={() => {
        const s = useLibrary.getState();
        if (s.sort === c.sort) s.set(s.sortDir === 1 ? { sortDir: -1 } : { sort: null, sortDir: 1 });
        else s.set({ sort: c.sort, sortDir: 1 });
      }}
      className={clsx("flex items-center gap-0.5 truncate px-2 text-[10px] font-semibold uppercase tracking-wider", c.align === "right" && "justify-end", c.align === "center" && "justify-center", sort === c.sort && c.sort ? "text-zinc-200" : "text-zinc-500 hover:text-zinc-300")}
    >
      {c.label}
      {sort === c.sort && c.sort && (sortDir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
    </button>
    {i < cols.length - 1 && <ResizeHandle col={c.key} label={c.label} />}
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ColumnsMenu pro={pro}>
        <div className="grid h-7 shrink-0 items-center border-b border-white/[0.06]" style={{ gridTemplateColumns: template }} data-testid="table-header">
          {cols.map(header)}
          <ColumnsButton pro={pro} />
        </div>
      </ColumnsMenu>
      <div ref={parent} tabIndex={0} className="relative min-h-0 flex-1 overflow-y-auto outline-none" data-testid="track-table">
        {sorted.length === 0 && !loading && <Empty source={source.type} />}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((it) => {
            const r = sorted[it.index];
            const sel = selSet.has(r.id);
            return (
              <RowMenu key={r.id} track={r}>
                <div
                  onPointerDown={(e) => {
                    const ids = sel ? selected : [r.id];
                    beginTrackDrag(e, ids, ids.length === 1 ? `${r.artist} – ${r.title}` : plural(ids.length, "track"));
                  }}
                  onClick={(e) => clickRow(e, it.index)}
                  onDoubleClick={() => loadOnDeck(useApp.getState().targetDeck, r.id)}
                  onContextMenu={() => {
                    if (!sel) useLibrary.getState().set({ selected: [r.id], anchor: it.index });
                  }}
                  className={clsx("group absolute left-0 right-0 grid cursor-default items-center text-[12px]", sel ? "bg-sky-500/20" : it.index % 2 ? "bg-white/[0.015] hover:bg-white/[0.05]" : "hover:bg-white/[0.05]")}
                  style={{ top: it.start, height: it.size, gridTemplateColumns: template }}
                  data-track={r.id}
                >
                  {cols.map((c) => (
                    <div key={c.key} className={clsx("flex min-w-0 items-center px-2", c.align === "right" && "justify-end", c.align === "center" && "justify-center")}>
                      {c.cell(r, { notation, refKey: ref.key, refBpm: ref.bpm, index: it.index, tags: rowTags, matches })}
                    </div>
                  ))}
                </div>
              </RowMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Empty({ source }: { source: string }) {
  const msg =
    source === "suggest"
      ? "Load a track on a deck to see what mixes well after it."
      : source === "history"
        ? "Tracks you play for more than 30 seconds show up here."
        : source === "playlist"
          ? "This playlist is empty. Drag tracks onto it in the sidebar."
          : "No tracks match. Add a music folder to get started.";
  return <div className="absolute inset-x-0 top-12 text-center text-sm text-zinc-500">{msg}</div>;
}

function RowMenu({ track, children }: { track: TrackRow; children: ReactNode }) {
  const playlists = useLibrary((s) => s.playlists);
  const source = useLibrary((s) => s.source);
  const tags = useLibrary((s) => s.tags);
  const rowTags = useLibrary((s) => s.rowTags);
  const count = useApp((s) => s.settings?.decks ?? 2);
  const ids = () => {
    const s = useLibrary.getState().selected;
    return s.includes(track.id) ? s : [track.id];
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu">
          {DECK_LETTERS.slice(0, count).map((l, i) => (
            <ContextMenu.Item key={l} className="menu-item" onSelect={() => loadOnDeck(i, track.id)}>
              Load on deck {l}
            </ContextMenu.Item>
          ))}
          {!track.missing && (
            <ContextMenu.Item className="menu-item" onSelect={() => togglePreview(track)}>
              Preview in headphones
            </ContextMenu.Item>
          )}
          <ContextMenu.Item className="menu-item" onSelect={() => enqueueIds(ids())}>
            Add to Auto DJ
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => enqueueIds(ids(), "next")}>
            Play next in Auto DJ
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              useLibrary.getState().set({ suggestFor: track.id, source: { type: "suggest" } });
              refreshRows();
            }}
          >
            What mixes well after this?
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" disabled={track.analysis !== "done"} onSelect={() => showSoundsLike(track)} data-testid="menu-sounds-like">
            Find tracks that sound like this
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => openBuildSet({ seed: track })}>
            Build a set starting with this…
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => openTidy(useLibrary.getState().rows.filter((r) => ids().includes(r.id)))} data-testid="menu-tidy">
            {ids().length > 1 ? `Tidy details of ${ids().length} tracks…` : "Tidy details…"}
          </ContextMenu.Item>
          {backend().kind !== "web" && (
            <ContextMenu.Item className="menu-item" onSelect={() => void writeTagsToFiles(ids().filter((id) => !useLibrary.getState().rows.find((r) => r.id === id)?.missing))}>
              {ids().length > 1 ? `Write tags to ${ids().length} files` : "Write tags to the file"}
            </ContextMenu.Item>
          )}
          {backend().kind !== "web" && (
            <ContextMenu.Item className="menu-item" onSelect={() => void writeCuesForSerato(ids().filter((id) => !useLibrary.getState().rows.find((r) => r.id === id)?.missing))}>
              {ids().length > 1 ? `Write cues for Serato to ${ids().length} files` : "Write cues for Serato"}
            </ContextMenu.Item>
          )}
          <ContextMenu.Item className="menu-item" onSelect={() => void editTrack(track.id)}>
            Edit track (beat grid, cues, start point)
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => void import("../editor/SoundEditor").then((m) => m.openSoundEditor({ type: "track", trackId: track.id, start: null, seconds: null }, { name: `${track.title} (edit)` }))}>
            Edit sound (cut, fade, normalise, save a copy)
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-sep" />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="menu-item">Add to playlist</ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="menu">
                {playlists.filter((p) => p.kind === "list").length === 0 && <div className="px-2 py-1 text-xs text-zinc-500">No playlists yet</div>}
                {playlists
                  .filter((p) => p.kind === "list")
                  .map((p) => (
                    <ContextMenu.Item
                      key={p.id}
                      className="menu-item"
                      onSelect={async () => {
                        const list = ids();
                        await backend().addToPlaylist(p.id, list);
                        toast.success(`Added ${plural(list.length, "track")} to ${p.name}`);
                        refreshPlaylists();
                      }}
                    >
                      {p.name}
                    </ContextMenu.Item>
                  ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="menu-item">Tag</ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="menu">
                {tags.map((t) => {
                  const on = (rowTags[track.id] ?? []).some((n) => n.toLowerCase() === t.name.toLowerCase());
                  return (
                    <ContextMenu.CheckboxItem key={t.id} className="menu-item" checked={on} onSelect={() => void tagTracks(ids(), t.name, !on)}>
                      <span className="mr-1.5 inline-block size-1.5 rounded-full" style={{ background: tagStyle(t.name, t.color).color }} />
                      {t.name}
                      {on && <span className="ml-auto pl-3 text-[10px] text-zinc-500">on</span>}
                    </ContextMenu.CheckboxItem>
                  );
                })}
                {tags.length > 0 && <ContextMenu.Separator className="menu-sep" />}
                <ContextMenu.Item
                  className="menu-item"
                  onSelect={async () => {
                    const name = await askText({ title: "New tag", placeholder: "vocal, peak time, sunset…", help: "A word or two to find these tracks by later. Search for it with tag:word.", confirm: "Tag" });
                    if (name?.trim()) await tagTracks(ids(), name, true);
                  }}
                >
                  New tag…
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              useApp.getState().set({ automixOpen: true });
              window.dispatchEvent(new CustomEvent("mixit:automix", { detail: ids() }));
            }}
          >
            Automix selection…
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="menu-item">Colour</ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="menu flex gap-1 p-1.5">
                {[null, 0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899].map((c) => (
                  <ContextMenu.Item
                    key={String(c)}
                    className="size-4 cursor-pointer rounded-full border border-white/20 outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-white"
                    style={{ background: c == null ? "transparent" : hex(c) }}
                    onSelect={async () => {
                      const sel = new Set(ids());
                      const rows = useLibrary.getState().rows.filter((r) => sel.has(r.id));
                      await editTracksWithUndo(rows, { color: c }, c == null ? "Clear the colour" : `Colour ${plural(rows.length, "track")}`, undefined, false);
                      await refreshRows();
                    }}
                  />
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="menu-sep" />
          {source.type === "playlist" && (
            <ContextMenu.Item
              className="menu-item"
              onSelect={async () => {
                const sel = new Set(ids());
                const rows = useLibrary.getState().rows;
                const idx = rows.map((r, i) => (sel.has(r.id) ? i : -1)).filter((i) => i >= 0);
                await withPlaylistUndo(source.id, `Remove ${plural(idx.length, "track")} from the playlist`, () => backend().removeFromPlaylist(source.id, idx), `Removed ${plural(idx.length, "track")} from the playlist`);
                refreshPlaylists();
                refreshRows();
              }}
            >
              Remove from playlist
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className="menu-item text-red-300"
            onSelect={async () => {
              const list = ids();
              const ok = await ask({
                title: `Remove ${plural(list.length, "track")} from the library?`,
                body: "They disappear from MixIt, its playlists and history. The music files on your disk are not touched, and adding the folder again brings them back.",
                confirm: "Remove",
                danger: true,
              });
              if (!ok) return;
              await backend().removeTracks(list);
              useLibrary.getState().set({ selected: [] });
              refreshStats();
              refreshRows();
            }}
          >
            Remove from library
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
