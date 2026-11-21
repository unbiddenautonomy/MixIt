// ⌘K: every action in the registry, the app's own commands and a quick track search,
// in one fuzzy list.
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import { BookOpen, FlaskConical, Music2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { backend } from "../../backend";
import type { ActionSpec, TrackRow } from "../../backend/types";
import { shortcutLabel } from "../../lib/actions";
import { choose } from "../../lib/actions";
import { runCommand } from "../../lib/appCommands";
import { bpm as fmtBpm } from "../../lib/format";
import { keyLabel } from "../../lib/keys";
import { deckCount, DECK_LETTERS, useApp, useNotation } from "../../store/app";
import { loadOnDeck } from "../deck/Deck";
import { useLibrary } from "../../store/library";
import { addMusicFolder, DJ_APPS, importFromApp, type DjApp } from "../library/Library";
import { showSoundsLike } from "../library/data";
import { openBuildSet } from "../library/BuildSetDialog";
import { toast } from "sonner";
import { openProject, saveProject, renderProject, renderStems } from "../arrange/projectIo";
import { CONCEPTS } from "../../guide/concepts";
import { LABS } from "../../guide/labs";
import { useGuide } from "../../guide/model";

interface Extra {
  id: string;
  label: string;
  group: string;
  run: () => void;
  keywords?: string[];
}

function openGuide(p: Parameters<ReturnType<typeof useGuide.getState>["set"]>[0]) {
  useGuide.getState().set(p);
  useApp.getState().set({ guideOpen: true });
}

function extras(): Extra[] {
  const s = useApp.getState();
  return [
    { id: "x.add", label: "Add music folder…", group: "Library", run: addMusicFolder, keywords: ["import", "scan"] },
    ...(Object.keys(DJ_APPS) as DjApp[]).map((app) => ({ id: `x.import.${app}`, label: DJ_APPS[app].menu, group: "Library", run: () => importFromApp(app), keywords: ["import", "collection", "library", "dj", app] })),
    { id: "x.insights", label: "Collection at a glance", group: "Library", run: () => (s.set({ workspace: "library" }), useLibrary.getState().set({ source: { type: "insights" } })), keywords: ["stats", "insights", "overview", "keys", "tempo", "genres"] },
    { id: "x.build_set", label: "Build a set…", group: "Library", run: () => (s.set({ workspace: "library" }), openBuildSet()), keywords: ["set", "plan", "warm-up", "peak", "energy", "playlist", "generate"] },
    {
      id: "x.sounds_like",
      label: "Find tracks that sound like the selected one",
      group: "Library",
      run: () => {
        const lib = useLibrary.getState();
        const row = lib.rows.find((r) => r.id === lib.selected[0]);
        if (row) showSoundsLike(row);
        else toast.message("Select a track in the library first");
      },
      keywords: ["similar", "alike", "related", "timbre", "sound"],
    },
    { id: "x.analyse", label: "Analyse new tracks", group: "Library", run: () => backend().analyzePending(), keywords: ["bpm", "key"] },
    { id: "x.rescan", label: "Rescan music folders", group: "Library", run: () => backend().rescan() },
    { id: "x.automix", label: "Automix: make a mix from tracks…", group: "Mix", run: () => s.set({ automixOpen: true }), keywords: ["auto", "dj", "playlist"] },
    { id: "x.open", label: "Open mix project…", group: "Mix", run: openProject },
    { id: "x.save", label: "Save mix project", group: "Mix", run: () => saveProject(false) },
    { id: "x.render", label: "Render mix to a file…", group: "Mix", run: () => void renderProject(), keywords: ["export", "bounce", "wav", "mp3", "flac"] },
    { id: "x.stems", label: "Export stems (one file per deck)…", group: "Mix", run: () => void renderStems("flac"), keywords: ["export", "stems", "multitrack", "flac", "wav"] },
    { id: "x.tracklist", label: "Copy tracklist of this session", group: "Mix", run: async () => navigator.clipboard?.writeText(await backend().tracklist()) },
    { id: "x.ws.mix", label: "Go to Mix", group: "View", run: () => s.set({ workspace: "mix" }) },
    { id: "x.ws.lib", label: "Go to Library", group: "View", run: () => s.set({ workspace: "library" }) },
    { id: "x.ws.arr", label: "Go to Arrange", group: "View", run: () => s.set({ workspace: "arrange" }) },
  ];
}

/** Every typed word must appear in the item; earlier and word-start matches rank higher. */
export function paletteFilter(value: string, search: string): number {
  const v = value.toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let score = 1;
  for (const w of words) {
    const i = v.indexOf(w);
    if (i < 0) return 0;
    const atWord = i === 0 || /[\s.:·(-]/.test(v[i - 1]);
    score *= (atWord ? 1 : 0.6) * (1 - Math.min(i, 200) / 400);
  }
  return score;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const registry = useApp((s) => s.registry);
  const notation = useNotation();
  const [q, setQ] = useState("");
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const close = () => useApp.getState().set({ paletteOpen: false });

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setTracks([]);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      backend()
        .search(q, 8)
        .then((r) => live && setTracks(r))
        .catch(() => {});
    }, 90);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q]);

  const groups = useMemo(() => {
    const n = deckCount();
    const m = new Map<string, ActionSpec[]>();
    for (const a of registry) {
      if (a.kind.type === "continuous") continue;
      const d = /^(?:deck|mixer|fx)\.([A-D])\./.exec(a.id);
      if (d && d[1].charCodeAt(0) - 65 >= n) continue;
      const list = m.get(a.group) ?? [];
      list.push(a);
      m.set(a.group, list);
    }
    return [...m.entries()];
  }, [registry, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (f: () => void) => {
    close();
    window.setTimeout(f, 0);
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => useApp.getState().set({ paletteOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-[14vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command label="Command palette" loop filter={paletteFilter} className="flex flex-col">
            <Command.Input value={q} onValueChange={setQ} autoFocus placeholder="Type a command or search tracks…" className="h-12 border-b border-white/[0.06] bg-transparent px-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-500" />
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="p-6 text-center text-sm text-zinc-500">Nothing matches.</Command.Empty>
              {tracks.length > 0 && (
                <Command.Group heading="Tracks" className="cmdk-group">
                  {tracks.map((t) =>
                    DECK_LETTERS.slice(0, deckCount()).map((l, i) => (
                      <Command.Item key={`${t.id}-${l}`} value={`track ${t.id} ${l} ${t.title} ${t.artist}`} onSelect={() => run(() => loadOnDeck(i, t.id))} className="cmdk-item">
                        <Music2 size={13} className="text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate">
                          {t.title} <span className="text-zinc-500">· {t.artist}</span>
                        </span>
                        <span className="font-mono text-[11px] text-zinc-500">
                          {fmtBpm(t.bpm)} {keyLabel(t.key, notation)}
                        </span>
                        <span className="rounded bg-white/[0.07] px-1.5 text-[10px] text-zinc-300">Load {l}</span>
                      </Command.Item>
                    )),
                  )}
                </Command.Group>
              )}
              {["Library", "Mix", "View"].map((g) => (
                <Command.Group key={g} heading={g} className="cmdk-group">
                  {extras()
                    .filter((e) => e.group === g)
                    .map((e) => (
                      <Command.Item key={e.id} value={`${e.label} ${(e.keywords ?? []).join(" ")}`} onSelect={() => run(e.run)} className="cmdk-item">
                        <span className="flex-1">{e.label}</span>
                      </Command.Item>
                    ))}
                </Command.Group>
              ))}
              {q.trim().length >= 2 && (
                <Command.Group heading="Learn" className="cmdk-group">
                  {CONCEPTS.map((c) => (
                    <Command.Item key={c.id} value={`learn ${c.title} ${c.summary}`} onSelect={() => run(() => openGuide({ tab: "learn", topic: c.id }))} className="cmdk-item">
                      <BookOpen size={13} className="text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate">
                        {c.title}
                        <span className="ml-2 text-[11px] text-zinc-500">{c.summary}</span>
                      </span>
                    </Command.Item>
                  ))}
                  {LABS.map((l) => (
                    <Command.Item key={l.id} value={`lab practice ${l.number} ${l.title}`} onSelect={() => run(() => openGuide({ tab: "labs", lab: l.id }))} className="cmdk-item">
                      <FlaskConical size={13} className="text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate">
                        Lab {l.number}: {l.title}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {groups.map(([group, actions]) => (
                <Command.Group key={group} heading={group} className="cmdk-group">
                  {actions.flatMap((a) =>
                    a.kind.type === "choice"
                      ? a.kind.options.map((o, i) => (
                          <Command.Item key={`${a.id}:${i}`} value={`${group} ${a.label} ${o}`} onSelect={() => run(() => choose(a.id, i))} className="cmdk-item">
                            <span className="flex-1">
                              {a.label}: <span className="text-zinc-400">{o}</span>
                            </span>
                          </Command.Item>
                        ))
                      : [
                          <Command.Item key={a.id} value={`${group} ${a.label} ${a.id}`} onSelect={() => run(() => runCommand(a.id))} className="cmdk-item">
                            <span className="min-w-0 flex-1 truncate">
                              {a.label}
                              <span className="ml-2 text-[11px] text-zinc-500">{a.explain}</span>
                            </span>
                            {a.shortcut && <kbd className="rounded border border-white/10 px-1.5 font-mono text-[10px] text-zinc-400">{shortcutLabel(a.shortcut)}</kbd>}
                          </Command.Item>,
                        ],
                  )}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
