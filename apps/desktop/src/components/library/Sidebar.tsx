// Library sources: the whole collection, suggestions, history, and playlists (plain,
// smart and folders), with drag-and-drop onto playlists.
import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import { Bot, FolderPlus, History, Library as LibIcon, ListMusic, Plus, Sparkles, Stethoscope, Tag, Wand2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { ask, askText } from "../shell/Dialogs";
import type { PlaylistDto, TagDto } from "../../backend/types";
import { clock, plural } from "../../lib/format";
import { useApp } from "../../store/app";
import { useLibrary, type Source } from "../../store/library";
import { useDropTarget } from "../../lib/dnd";
import { refreshPlaylists, refreshRows, refreshTags, tagTracks } from "./data";
import { STARTER_TAGS, tagQuery, tagStyle } from "../../lib/tags";
import { enqueueIds } from "../autodj/AutoDj";
import { enqueue, startAutoDj, useAutoDj } from "../../store/autodj";

const same = (a: Source, b: Source) =>
  a.type === b.type && (a.type !== "playlist" || (b.type === "playlist" && a.id === b.id)) && (a.type !== "tag" || (b.type === "tag" && a.name.toLowerCase() === b.name.toLowerCase()));

export function Sidebar() {
  const source = useLibrary((s) => s.source);
  const playlists = useLibrary((s) => s.playlists);
  const stats = useLibrary((s) => s.stats);
  const queued = useAutoDj((s) => s.queue.length);
  const problems = useLibrary((s) => (s.missing?.length ?? 0) + (s.duplicates?.length ?? 0));
  const djOn = useAutoDj((s) => s.phase !== "off");
  const [creating, setCreating] = useState<null | "list" | "smart" | "folder">(null);
  const tags = useLibrary((s) => s.tags);

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
      <Item
        icon={<Bot size={14} className={djOn ? "text-sky-300" : undefined} />}
        label="Auto DJ"
        count={queued || undefined}
        active={same(source, { type: "autodj" })}
        onClick={() => select({ type: "autodj" })}
        hint="Let MixIt mix a queue of tracks for you, and see why it mixes the way it does"
        dropOk
        onDrop={(ids) => enqueueIds(ids)}
      />
      {(problems > 0 || same(source, { type: "care" })) && (
        <Item
          icon={<Stethoscope size={14} className={problems ? "text-amber-300" : undefined} />}
          label="Fix library"
          count={problems || undefined}
          active={same(source, { type: "care" })}
          onClick={() => select({ type: "care" })}
          hint="Find tracks whose files moved, and fold duplicate copies into one"
        />
      )}

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

      <div className="mt-3 flex items-center justify-between px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Tags
        <IconBtn
          title="New tag"
          onClick={async () => {
            const name = await askText({ title: "New tag", placeholder: "vocal, peak time, sunset…", help: "A word or two to find tracks by later. Drag tracks onto it, or add it in a track's details.", confirm: "Make tag" });
            if (!name?.trim()) return;
            try {
              await backend().setTag([], name.trim(), true, STARTER_TAGS.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())?.category ?? "");
              await refreshTags();
            } catch (e) {
              toast.error(String(e));
            }
          }}
        >
          <Plus size={12} />
        </IconBtn>
      </div>
      {tags.length === 0 && <p className="px-2 text-[11px] leading-snug text-zinc-500">Tag tracks with your own words (vocal, peak time, dark) to find them by feel. Right-click a track, or use its details.</p>}
      {tags.map((t) => (
        <TagItem key={t.id} t={t} source={source} select={select} />
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
            {p.kind !== "folder" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  const rows = p.kind === "smart" && p.query ? await backend().search(p.query) : await backend().playlistTracks(p.id);
                  enqueue(rows.filter((r) => !r.missing));
                  select({ type: "autodj" });
                  if (useAutoDj.getState().phase === "off") void startAutoDj();
                }}
              >
                Play with Auto DJ
              </ContextMenu.Item>
            )}
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

const TAG_COLORS = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899];

function TagItem({ t, source, select }: { t: TagDto; source: Source; select: (s: Source) => void }) {
  const [renaming, setRenaming] = useState(false);
  const active = same(source, { type: "tag", name: t.name });
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await refreshTags();
    } catch (e) {
      toast.error(String(e));
    }
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div data-testid="sidebar-tag">
          {renaming ? (
            <RenameInput
              initial={t.name}
              done={(name) => {
                setRenaming(false);
                if (!name || name === t.name) return;
                const merging = useLibrary.getState().tags.some((o) => o.id !== t.id && o.name.toLowerCase() === name.toLowerCase());
                void run(async () => {
                  await backend().renameTag(t.id, name);
                  if (merging) toast.success(`Merged “${t.name}” into “${name}”`);
                  if (active) select({ type: "tag", name });
                });
              }}
            />
          ) : (
            <Item
              icon={<Tag size={13} style={{ color: tagStyle(t.name, t.color).color }} />}
              label={t.name}
              count={t.count}
              hint={`${t.category ? `${t.category}: ` : ""}${plural(t.count, "track")} tagged “${t.name}”. Drop tracks here to tag them.`}
              active={active}
              onClick={() => select({ type: "tag", name: t.name })}
              dropOk
              onDrop={(ids) => {
                void tagTracks(ids, t.name, true).then(() => toast.success(`Tagged ${plural(ids.length, "track")} “${t.name}”`));
              }}
            />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu">
          <ContextMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            onSelect={async () => {
              const category = await askText({ title: `Group for “${t.name}”`, initial: t.category, placeholder: "Vibe, Vocals, Moment…", help: "Tags in the same group sit together. Leave it empty for none.", confirm: "Save" });
              if (category != null) void run(() => backend().tagInfo(t.id, category, t.color));
            }}
          >
            Group…
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="menu-item">Colour</ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="menu flex gap-1 p-1.5">
                {TAG_COLORS.map((c) => (
                  <ContextMenu.Item key={c} aria-label="Tag colour" className="size-4 cursor-pointer rounded-full outline-none ring-white focus:ring-2" style={{ background: `#${c.toString(16).padStart(6, "0")}` }} onSelect={() => void run(() => backend().tagInfo(t.id, t.category, c))} />
                ))}
                <ContextMenu.Item aria-label="Automatic colour" className="size-4 cursor-pointer rounded-full border border-white/30 outline-none ring-white focus:ring-2" onSelect={() => void run(() => backend().tagInfo(t.id, t.category, null))} />
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            className="menu-item"
            onSelect={() => {
              useLibrary.getState().set({ source: { type: "all" }, query: tagQuery(t.name) });
              refreshRows();
            }}
          >
            Search for it
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-sep" />
          <ContextMenu.Item
            className="menu-item text-red-300"
            onSelect={async () => {
              const ok = await ask({ title: `Delete the tag “${t.name}”?`, body: `It comes off ${plural(t.count, "track")}. The tracks stay in your library.`, confirm: "Delete tag", danger: true });
              if (!ok) return;
              if (active) select({ type: "all" });
              void run(() => backend().deleteTag(t.id));
            }}
          >
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
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
