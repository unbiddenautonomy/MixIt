// Library sources: the whole collection, suggestions, history, and playlists (plain,
// smart and folders), with drag-and-drop onto playlists.
import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import { BarChart3, Bot, Disc3, FolderPlus, History, Library as LibIcon, ListMusic, Plus, Sparkles, Stethoscope, Tag, TrendingUp, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { ask, askText } from "../shell/Dialogs";
import type { PlaylistDto, SessionDto, TagDto } from "../../backend/types";
import { clock, plural } from "../../lib/format";
import { useApp, usePro } from "../../store/app";
import { useLibrary, type Source } from "../../store/library";
import { useDropTarget } from "../../lib/dnd";
import { copyPlaylistFiles, copySetTracklist, duplicatePlaylist, refreshPlaylists, refreshRows, refreshSessions, refreshTags, saveSetAsPlaylist, tagTracks, tidyPlaylist } from "./data";
import { setLabel } from "../../lib/history";
import { STARTER_TAGS, tagQuery, tagStyle } from "../../lib/tags";
import { editSmartPlaylist } from "./SmartPlaylistDialog";
import { openBuildSet } from "./BuildSetDialog";
import { enqueueIds } from "../autodj/AutoDj";
import { enqueue, startAutoDj, useAutoDj } from "../../store/autodj";
import { deletePlaylistWithUndo, withPlaylistUndo } from "../../lib/libraryUndo";

const same = (a: Source, b: Source) =>
  a.type === b.type &&
  (a.type !== "playlist" || (b.type === "playlist" && a.id === b.id)) &&
  (a.type !== "tag" || (b.type === "tag" && a.name.toLowerCase() === b.name.toLowerCase())) &&
  (a.type !== "history" || (b.type === "history" && (a.session ?? null) === (b.session ?? null)));

export function Sidebar() {
  const source = useLibrary((s) => s.source);
  const playlists = useLibrary((s) => s.playlists);
  const stats = useLibrary((s) => s.stats);
  const queued = useAutoDj((s) => s.queue.length);
  const problems = useLibrary((s) => (s.missing?.length ?? 0) + (s.duplicates?.length ?? 0));
  const djOn = useAutoDj((s) => s.phase !== "off");
  const [creating, setCreating] = useState<null | "list" | "smart" | "folder">(null);
  const tags = useLibrary((s) => s.tags);
  const sessions = useLibrary((s) => s.sessions);
  const currentSession = useLibrary((s) => s.currentSession);
  // Easy keeps the list short: past sets by date, At a glance and tags are in Pro (or showing now).
  const pro = usePro();
  const pastSets = sessions.filter((s) => s.id !== currentSession && (pro || same(source, { type: "history", session: s.id })));

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
      <Item icon={<History size={14} />} label="History" hint="What you played this session" active={same(source, { type: "history" })} onClick={() => select({ type: "history" })} />
      {pastSets.slice(0, 5).map((s) => (
        <SetItem key={s.id} s={s} active={same(source, { type: "history", session: s.id })} select={select} />
      ))}
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
      {(pro || same(source, { type: "insights" })) && <Item icon={<BarChart3 size={14} />} label="At a glance" active={same(source, { type: "insights" })} onClick={() => select({ type: "insights" })} hint="Your collection's tempos, keys, energy, genres and plays, with tips on gaps" />}
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

      <div className="mt-3 flex items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Playlists
        <div className="flex gap-0.5">
          <IconBtn title="New playlist" onClick={() => setCreating("list")}>
            <Plus size={12} />
          </IconBtn>
          {pro && (
            <>
              <IconBtn title="New smart playlist (fills itself with every track that matches your rules)" onClick={() => void newSmart()}>
                <Wand2 size={12} />
              </IconBtn>
              <IconBtn title="New folder" onClick={() => setCreating("folder")}>
                <FolderPlus size={12} />
              </IconBtn>
            </>
          )}
          <IconBtn title="Build a set: MixIt picks tracks for the time you have, with the energy moving the way you choose" onClick={() => openBuildSet()}>
            <TrendingUp size={12} />
          </IconBtn>
        </div>
      </div>
      {creating && <NewPlaylist kind={creating} done={() => setCreating(null)} />}
      {roots.length === 0 && !creating && <p className="px-2 text-[11px] leading-snug text-zinc-500">Drag tracks here or press + to make a playlist.</p>}
      {roots.map((p) => (
        <PlaylistItem key={p.id} p={p} depth={0} kidsOf={children} source={source} select={select} />
      ))}

      {(pro || source.type === "tag") && (
      <>
      <div className="mt-3 flex items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
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
      </>
      )}
    </nav>
  );
}

/** Makes a smart playlist with the rule editor, starting from what is typed in the search box. */
export async function newSmart() {
  const r = await editSmartPlaylist({ title: "New smart playlist", query: useLibrary.getState().query, confirm: "Make playlist" });
  if (!r) return;
  try {
    const id = await backend().createPlaylist(r.name, "smart", { query: r.query });
    await refreshPlaylists();
    useLibrary.getState().set({ source: { type: "playlist", id }, query: "", selected: [] });
    refreshRows();
  } catch (e) {
    toast.error(String(e));
  }
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="flex size-6 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200">
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
      {count != null && <span className="font-mono text-[11px] text-zinc-500">{count}</span>}
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
          <ContextMenu.Content className="menu" onCloseAutoFocus={(e) => e.preventDefault()}>
            <ContextMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
              Rename
            </ContextMenu.Item>
            {p.kind !== "folder" && (
              <ContextMenu.Item className="menu-item" onSelect={() => openBuildSet({ playlist: p.id })}>
                Build a set from this…
              </ContextMenu.Item>
            )}
            {p.kind === "smart" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  const r = await editSmartPlaylist({ title: `Edit “${p.name}”`, name: p.name, query: p.query ?? "", confirm: "Update playlist" });
                  if (!r) return;
                  try {
                    if (r.name !== p.name) await backend().renamePlaylist(p.id, r.name);
                    if (r.query !== p.query) await backend().setPlaylistQuery(p.id, r.query);
                    await refreshPlaylists();
                    refreshRows();
                  } catch (e) {
                    toast.error(String(e));
                  }
                }}
              >
                Edit rules…
              </ContextMenu.Item>
            )}
            {p.kind === "list" && (
              <ContextMenu.Item
                className="menu-item"
                onSelect={async () => {
                  await withPlaylistUndo(p.id, `Order ${p.name} for mixing`, () => backend().orderPlaylist(p.id, useLibrary.getState().energy), `Ordered ${p.name} for smooth mixing`);
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
              <ContextMenu.Item className="menu-item" onSelect={() => void duplicatePlaylist(p.id)}>
                Duplicate
              </ContextMenu.Item>
            )}
            {p.kind === "list" && (
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className="menu-item">Tidy up</ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className="menu">
                    <ContextMenu.Item className="menu-item" onSelect={() => void tidyPlaylist(p.id, "shuffle")}>
                      Shuffle
                    </ContextMenu.Item>
                    <ContextMenu.Item className="menu-item" onSelect={() => void tidyPlaylist(p.id, "duplicates")}>
                      Take out repeats
                    </ContextMenu.Item>
                    <ContextMenu.Item className="menu-item" onSelect={() => void tidyPlaylist(p.id, "missing")}>
                      Take out missing files
                    </ContextMenu.Item>
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            )}
            <MoveToMenu p={p} />
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="menu-item">Export</ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className="menu">
                  {p.kind !== "folder" && (
                    <ContextMenu.Item className="menu-item" onSelect={() => void copyPlaylistFiles(p.id)}>
                      Copy music to a folder or USB stick…
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
                      As an M3U playlist…
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
                    For rekordbox…
                  </ContextMenu.Item>
                  <ContextMenu.Item
                    className="menu-item"
                    onSelect={async () => {
                      const path = await backend().pickSave(`${p.name}.nml`, ["nml"]);
                      if (path) {
                        await backend().exportTraktor(path, p.id);
                        toast.success(`Exported ${p.name} for Traktor`);
                      }
                    }}
                  >
                    For Traktor…
                  </ContextMenu.Item>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
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
                // A folder takes everything in it along, so it asks; a playlist can be undone.
                if (p.kind === "folder" && !(await ask({ title: `Delete the folder “${p.name}”?`, body: "The folder and every playlist in it go away. Their tracks stay in your library, and Undo brings it all back.", confirm: "Delete folder", danger: true }))) return;
                await deletePlaylistWithUndo(p.id);
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

function SetItem({ s, active, select }: { s: SessionDto; active: boolean; select: (s: Source) => void }) {
  const [renaming, setRenaming] = useState(false);
  const label = setLabel(s);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div data-testid="sidebar-set">
          {renaming ? (
            <RenameInput
              initial={s.name || label}
              done={async (name) => {
                setRenaming(false);
                if (name === (s.name || label)) return;
                await backend().renameSession(s.id, name);
                await refreshSessions();
              }}
            />
          ) : (
            <Item icon={<Disc3 size={12} />} label={label} count={s.tracks} depth={1} hint={`A set you played: ${plural(s.tracks, "track")}, from ${new Date(s.firstPlayed * 1000).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}`} active={active} onClick={() => select({ type: "history", session: s.id })} />
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenu.Item className="menu-item" onSelect={() => void saveSetAsPlaylist(s.id, label)}>
            Save as playlist
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => void copySetTracklist(s.id)}>
            Copy tracklist
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
            Rename
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-sep" />
          <ContextMenu.Item
            className="menu-item text-red-300"
            onSelect={async () => {
              const ok = await ask({ title: `Forget the set “${label}”?`, body: "Its list of plays goes away. The tracks, their play counts and your playlists stay.", confirm: "Forget set", danger: true });
              if (!ok) return;
              if (active) select({ type: "history" });
              await backend().deleteSession(s.id);
              await refreshSessions();
            }}
          >
            Forget this set
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
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
        <ContextMenu.Content className="menu" onCloseAutoFocus={(e) => e.preventDefault()}>
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
  const ref = useRef<HTMLInputElement>(null);
  // Opened from a menu: take the focus once the menu has closed and handed it back.
  useEffect(() => {
    const t = window.setTimeout(() => {
      ref.current?.focus();
      ref.current?.select();
    }, 30);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <input
      ref={ref}
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

/** Moves a playlist or folder into another folder, or back to the top. */
function MoveToMenu({ p }: { p: PlaylistDto }) {
  const playlists = useLibrary((s) => s.playlists);
  // Folders it may go into: not itself, nor anything inside it.
  const inside = (id: number | null): boolean => id != null && (id === p.id || inside(playlists.find((x) => x.id === id)?.parent ?? null));
  const folders = playlists.filter((f) => f.kind === "folder" && !inside(f.id) && f.id !== p.parent);
  if (!folders.length && p.parent == null) return null;
  const path = (f: PlaylistDto): string => {
    const up = playlists.find((x) => x.id === f.parent);
    return up ? `${path(up)} / ${f.name}` : f.name;
  };
  const move = async (parent: number | null) => {
    try {
      await backend().movePlaylist(p.id, parent, 1 << 30);
      await refreshPlaylists();
    } catch (e) {
      toast.error(String(e));
    }
  };
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="menu-item">Move to</ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent className="menu">
          {p.parent != null && (
            <ContextMenu.Item className="menu-item" onSelect={() => void move(null)}>
              The top (no folder)
            </ContextMenu.Item>
          )}
          {folders.map((f) => (
            <ContextMenu.Item key={f.id} className="menu-item" onSelect={() => void move(f.id)}>
              {path(f)}
            </ContextMenu.Item>
          ))}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}
