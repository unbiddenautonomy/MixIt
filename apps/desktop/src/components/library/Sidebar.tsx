// Library sources: the whole collection, suggestions, history, and playlists (plain,
// smart and folders), with drag-and-drop onto playlists.
import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import { FolderPlus, History, Library as LibIcon, ListMusic, Plus, Sparkles, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { ask, askText } from "../shell/Dialogs";
import type { PlaylistDto } from "../../backend/types";
import { clock, plural } from "../../lib/format";
import { useApp } from "../../store/app";
import { useLibrary, type Source } from "../../store/library";
import { useDropTarget } from "../../lib/dnd";
import { refreshPlaylists, refreshRows } from "./data";

const same = (a: Source, b: Source) => a.type === b.type && (a.type !== "playlist" || (b.type === "playlist" && a.id === b.id));

export function Sidebar() {
  const source = useLibrary((s) => s.source);
  const playlists = useLibrary((s) => s.playlists);
  const stats = useLibrary((s) => s.stats);
  const [creating, setCreating] = useState<null | "list" | "smart" | "folder">(null);

  const select = (s: Source) => {
    useLibrary.getState().set({ source: s, selected: [], anchor: null });
    refreshRows();
  };

  const roots = playlists.filter((p) => p.parent == null);
  const children = (id: number) => playlists.filter((p) => p.parent === id);

  return (
    <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-white/[0.06] p-2 text-[13px]">
      <Item icon={<LibIcon size={14} />} label="Collection" count={stats?.tracks} active={same(source, { type: "all" })} onClick={() => select({ type: "all" })} />
      <Item icon={<Sparkles size={14} />} label="Suggestions" active={same(source, { type: "suggest" })} onClick={() => select({ type: "suggest" })} hint="Tracks that mix well after the one playing" />
      <Item icon={<History size={14} />} label="History" active={same(source, { type: "history" })} onClick={() => select({ type: "history" })} />

      <div className="mt-3 flex items-center justify-between px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Playlists
        <div className="flex gap-0.5">
          <IconBtn title="New playlist" onClick={() => setCreating("list")}>
            <Plus size={12} />
          </IconBtn>
          <IconBtn title="New smart playlist (from a search)" onClick={() => setCreating("smart")}>
            <Wand2 size={12} />
          </IconBtn>
          <IconBtn title="New folder" onClick={() => setCreating("folder")}>
            <FolderPlus size={12} />
          </IconBtn>
        </div>
      </div>
      {creating && <NewPlaylist kind={creating} done={() => setCreating(null)} />}
      {roots.length === 0 && !creating && <p className="px-2 text-[11px] leading-snug text-zinc-500">Drag tracks here or press + to make a playlist.</p>}
      {roots.map((p) => (
        <PlaylistItem key={p.id} p={p} depth={0} kidsOf={children} source={source} select={select} />
      ))}
    </nav>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200">
      {children}
    </button>
  );
}

function Item({ icon, label, count, active, onClick, hint, depth = 0, onDrop, dropOk }: { icon: ReactNode; label: string; count?: number; active: boolean; onClick: () => void; hint?: string; depth?: number; onDrop?: (ids: number[]) => void; dropOk?: boolean }) {
  const drop = useDropTarget(`sidebar-${label}-${depth}`, { label: `Add to ${label}`, tracks: dropOk && onDrop ? (ids) => onDrop(ids) : undefined });
  const over = drop.over && !!dropOk;
  return (
    <button
      type="button"
      title={hint}
      onClick={onClick}
      {...(dropOk ? drop.props : {})}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={clsx(
        "flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left transition-colors",
        active ? "bg-white/10 text-zinc-50" : "text-zinc-300 hover:bg-white/[0.05]",
        over && "ring-1 ring-sky-400 bg-sky-400/10",
      )}
    >
      <span className="text-zinc-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className="font-mono text-[10px] text-zinc-500">{count}</span>}
    </button>
  );
}

function PlaylistItem({ p, depth, kidsOf, source, select }: { p: PlaylistDto; depth: number; kidsOf: (id: number) => PlaylistDto[]; source: Source; select: (s: Source) => void }) {
  const [renaming, setRenaming] = useState(false);
  const kids = kidsOf(p.id);
  const icon = p.kind === "smart" ? <Wand2 size={14} /> : p.kind === "folder" ? <FolderPlus size={14} /> : <ListMusic size={14} />;
  const add = async (ids: number[]) => {
    await backend().addToPlaylist(p.id, ids);
    toast.success(`Added ${plural(ids.length, "track")} to ${p.name}`);
    refreshPlaylists();
    if (same(source, { type: "playlist", id: p.id })) refreshRows();
  };
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div>
            {renaming ? (
              <RenameInput
                initial={p.name}
                done={async (name) => {
                  setRenaming(false);
                  if (name && name !== p.name) {
                    await backend().renamePlaylist(p.id, name);
                    refreshPlaylists();
                  }
                }}
              />
            ) : (
              <Item
                icon={icon}
                label={p.name}
                count={p.kind === "folder" ? undefined : p.count}
                depth={depth}
                hint={p.kind === "smart" ? `Smart: ${p.query}` : `${plural(p.count, "track")}, ${clock(p.duration)}`}
                active={same(source, { type: "playlist", id: p.id })}
                onClick={() => p.kind !== "folder" && select({ type: "playlist", id: p.id })}
                dropOk={p.kind === "list"}
                onDrop={add}
              />
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="menu">
            <ContextMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
              Rename
            </ContextMenu.Item>
            {p.kind === "smart" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  const q = await askText({
                    title: `Search for “${p.name}”`,
                    initial: p.query ?? "",
                    placeholder: "bpm:120-128 key:~8A energy:6+",
                    help: "The playlist always holds every track that matches. Examples: genre:house played:never, rating:4+, bpm:~124.",
                    confirm: "Update playlist",
                    code: true,
                  });
                  if (q != null) {
                    await backend().setPlaylistQuery(p.id, q);
                    await refreshPlaylists();
                    refreshRows();
                  }
                }}
              >
                Edit search…
              </ContextMenu.Item>
            )}
            {p.kind === "list" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  await backend().orderPlaylist(p.id, useLibrary.getState().energy);
                  toast.success(`Ordered ${p.name} for smooth mixing`);
                  refreshRows();
                }}
              >
                Order for mixing
              </ContextMenu.Item>
            )}
            {p.kind !== "folder" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  const tracks = await backend().playlistTracks(p.id);
                  useApp.getState().set({ automixOpen: true });
                  window.dispatchEvent(new CustomEvent("mixit:automix", { detail: tracks.map((t) => t.id) }));
                }}
              >
                Automix this playlist…
              </ContextMenu.Item>
            )}
            {p.kind !== "folder" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  const path = await backend().pickSave(`${p.name}.m3u8`, ["m3u8", "m3u"]);
                  if (path) {
                    await backend().exportPlaylist(p.id, path);
                    toast.success(`Exported ${p.name}`);
                  }
                }}
              >
                Export as M3U…
              </ContextMenu.Item>
            )}
            <ContextMenu.Item
              className="menu-item"
              onSelect={async () => {
                const path = await backend().pickSave(`${p.name}.xml`, ["xml"]);
                if (path) {
                  await backend().exportRekordbox(path, p.id);
                  toast.success(`Exported ${p.name} for rekordbox`);
                }
              }}
            >
              Export for rekordbox…
            </ContextMenu.Item>
            <ContextMenu.Separator className="menu-sep" />
            <ContextMenu.Item
              className="menu-item text-red-300"
              onSelect={async () => {
                const ok = await ask({ title: `Delete “${p.name}”?`, body: "The playlist goes away. Its tracks stay in your library.", confirm: "Delete playlist", danger: true });
                if (!ok) return;
                await backend().deletePlaylist(p.id);
                if (same(source, { type: "playlist", id: p.id })) select({ type: "all" });
                refreshPlaylists();
              }}
            >
              Delete
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {kids.map((c) => (
        <PlaylistItem key={c.id} p={c} depth={depth + 1} kidsOf={kidsOf} source={source} select={select} />
      ))}
    </>
  );
}

function RenameInput({ initial, done }: { initial: string; done: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => done(v.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(v.trim());
        if (e.key === "Escape") done(initial);
      }}
      className="input h-7 w-full"
    />
  );
}

function NewPlaylist({ kind, done }: { kind: "list" | "smart" | "folder"; done: () => void }) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState(kind === "smart" ? useLibrary.getState().query : "");
  const submit = async () => {
    const n = name.trim();
    if (!n) return done();
    try {
      const selected = kind === "list" ? useLibrary.getState().selected : [];
      const id = await backend().createPlaylist(n, kind, { query: kind === "smart" ? query.trim() : null, tracks: selected });
      await refreshPlaylists();
      if (kind !== "folder") {
        useLibrary.getState().set({ source: { type: "playlist", id } });
        refreshRows();
      }
      if (selected.length) toast.success(`Made “${n}” with ${plural(selected.length, "selected track")}`);
    } catch (e) {
      toast.error(String(e));
    }
    done();
  };
  return (
    <div className="flex flex-col gap-1 rounded-md bg-white/[0.04] p-1.5">
      <input autoFocus placeholder={kind === "folder" ? "Folder name" : kind === "smart" ? "Smart playlist name" : "Playlist name"} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? submit() : e.key === "Escape" && done())} className="input h-7" />
      {kind === "smart" && <input placeholder="bpm:120-128 key:~8A energy:6+" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} className="input h-7 font-mono text-[11px]" />}
      <div className="flex justify-end gap-1">
        <button type="button" className="rounded px-2 text-[11px] text-zinc-400 hover:text-zinc-100" onClick={done}>
          Cancel
        </button>
        <button type="button" className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-zinc-100 hover:bg-white/15" onClick={submit}>
          Create
        </button>
      </div>
    </div>
  );
}
