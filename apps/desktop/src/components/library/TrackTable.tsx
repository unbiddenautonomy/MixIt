// The track list: virtualised (100k tracks scroll smoothly), sortable, multi-select,
// drag to decks and playlists, double-click or Enter to load. Key and BPM cells light
// up when a track mixes well with what is playing.
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { AlertTriangle, ArrowDown, ArrowUp, Loader2, Star } from "lucide-react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { ask } from "../shell/Dialogs";
import type { TrackRow } from "../../backend/types";
import { bpm as fmtBpm, clock, hex, plural, inkColor } from "../../lib/format";
import { compatibility, keyColor, keyFromIndex, keyLabel, type Compat } from "../../lib/keys";
import { DECK_LETTERS, deckCount, useApp, useNotation, usePro } from "../../store/app";
import { sortRows, useLibrary, type SortKey } from "../../store/library";
import { useTelemetry } from "../../store/telemetry";
import { beginTrackDrag } from "../../lib/dnd";
import { loadOnDeck } from "../deck/Deck";
import { refreshPlaylists, refreshRows, refreshStats } from "./data";
import { editTrack } from "../editor/TrackEditor";

interface Column {
  key: string;
  label: string;
  sort: SortKey;
  width: string;
  pro?: boolean;
  align?: "right" | "center";
  cell: (r: TrackRow, ctx: Ctx) => ReactNode;
}

interface Ctx {
  notation: "camelot" | "openKey" | "standard";
  refKey: number | null;
  refBpm: number | null;
  index: number;
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

const COLUMNS: Column[] = [
  { key: "n", label: "#", sort: null, width: "36px", align: "right", cell: (_r, c) => <span className="font-mono text-[10px] text-zinc-600">{c.index + 1}</span> },
  {
    key: "title",
    label: "Title",
    sort: "title",
    width: "minmax(160px,2.2fr)",
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2">
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
  { key: "duration", label: "Time", sort: "duration", width: "52px", align: "right", cell: (r) => <span className="font-mono tabular-nums text-zinc-400">{clock(r.duration)}</span> },
  { key: "rating", label: "Rating", sort: "rating", width: "76px", cell: (r) => <Stars track={r} /> },
  { key: "genre", label: "Genre", sort: "genre", width: "minmax(80px,0.8fr)", cell: (r) => <span className="truncate text-zinc-500">{r.genre}</span> },
  { key: "lufs", label: "LUFS", sort: null, width: "48px", align: "right", pro: true, cell: (r) => <span className="font-mono text-[11px] text-zinc-500">{r.lufs != null ? r.lufs.toFixed(1) : "–"}</span> },
  { key: "plays", label: "Plays", sort: "playCount", width: "44px", align: "right", pro: true, cell: (r) => <span className="font-mono text-[11px] text-zinc-500">{r.playCount || ""}</span> },
  { key: "added", label: "Added", sort: "addedAt", width: "78px", align: "right", pro: true, cell: (r) => <span className="text-[11px] text-zinc-500">{new Date(r.addedAt * 1000).toLocaleDateString()}</span> },
];

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
            const row = await backend().editTrack(track.id, { rating });
            useLibrary.setState((s) => ({ rows: s.rows.map((r) => (r.id === row.id ? row : r)) }));
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
  const cols = COLUMNS.filter((c) => pro || !c.pro);
  const template = cols.map((c) => c.width).join(" ");
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

  const header = (c: Column) => (
    <button
      key={c.key}
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
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="grid h-7 shrink-0 items-center border-b border-white/[0.06]" style={{ gridTemplateColumns: template }}>
        {cols.map(header)}
      </div>
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
                  className={clsx("absolute left-0 right-0 grid cursor-default items-center text-[12px]", sel ? "bg-sky-500/20" : it.index % 2 ? "bg-white/[0.015] hover:bg-white/[0.05]" : "hover:bg-white/[0.05]")}
                  style={{ top: it.start, height: it.size, gridTemplateColumns: template }}
                  data-track={r.id}
                >
                  {cols.map((c) => (
                    <div key={c.key} className={clsx("flex min-w-0 items-center px-2", c.align === "right" && "justify-end", c.align === "center" && "justify-center")}>
                      {c.cell(r, { notation, refKey: ref.key, refBpm: ref.bpm, index: it.index })}
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
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              useLibrary.getState().set({ suggestFor: track.id, source: { type: "suggest" } });
              refreshRows();
            }}
          >
            What mixes well after this?
          </ContextMenu.Item>
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
                      const list = ids();
                      const updated = await Promise.all(list.map((id) => backend().editTrack(id, { color: c })));
                      const by = new Map(updated.map((r) => [r.id, r]));
                      useLibrary.setState((s) => ({ rows: s.rows.map((r) => by.get(r.id) ?? r) }));
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
                await backend().removeFromPlaylist(source.id, idx);
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
