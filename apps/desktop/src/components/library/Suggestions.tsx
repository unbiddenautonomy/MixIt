// "What should I play next?": ranked tracks that mix well after the seed, with the
// reasons in plain words and what you would need to change (tempo, key).
import clsx from "clsx";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { bpm as fmtBpm, clock, signedPct, inkColor } from "../../lib/format";
import { keyColor, keyLabel, shiftedKey } from "../../lib/keys";
import { deckCount, useApp, useNotation } from "../../store/app";
import { useLibrary } from "../../store/library";
import { Segmented } from "../ui/Button";
import { beginTrackDrag } from "../../lib/dnd";
import { loadOnDeck } from "../deck/Deck";
import { refreshRows, suggestionSeed } from "./data";
import { useTelemetry } from "../../store/telemetry";
import { PreviewButton } from "./PreviewBar";

const GENERIC_TAGS = new Set(["tempo", "key", "energy", "genre", "keyShift", "rating"]);
/** Plain words for the reason chips. */
const TAG_LABEL: Record<string, string> = { sound: "sounds alike", history: "played next before", instrumental: "instrumental", half: "half-time", double: "double-time", clash: "key clash", unknown: "not analysed" };

/** The deck to load a suggestion onto: the first one that is not playing. */
export function freeDeck(): number {
  const t = useTelemetry.getState().t;
  const n = deckCount();
  const decks = useApp.getState().decks;
  for (let i = 0; i < n; i++) if (!decks[i]) return i;
  for (let i = 0; i < n; i++) if (!t.decks[i].playing) return i;
  return useApp.getState().targetDeck;
}

export function Suggestions() {
  const rows = useLibrary((s) => s.suggestions);
  const energy = useLibrary((s) => s.energy);
  const suggestFor = useLibrary((s) => s.suggestFor);
  const decks = useApp((s) => s.decks);
  const notation = useNotation();
  const seedId = suggestionSeed();
  const seed = decks.find((d) => d?.detail.track.id === seedId)?.detail.track ?? useLibrary.getState().rows.find((r) => r.id === seedId);

  // Follow the decks: new suggestions whenever the seed changes.
  useEffect(() => {
    refreshRows();
  }, [seedId, energy]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <Sparkles size={14} className="text-sky-300" />
        <div className="min-w-0 text-xs text-zinc-300">
          {seed ? (
            <>
              After <span className="font-medium text-zinc-100">{seed.title}</span>
              <span className="text-zinc-500"> · {seed.artist}</span>
            </>
          ) : (
            "Load a track to get suggestions"
          )}
        </div>
        {suggestFor != null && (
          <button type="button" className="text-[11px] text-sky-300 hover:underline" onClick={() => useLibrary.getState().set({ suggestFor: null })}>
            follow the decks
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-zinc-500">Energy</span>
          <Segmented
            value={energy}
            onChange={(e) => useLibrary.getState().set({ energy: e })}
            options={[
              { value: "down", label: <ArrowDownRight size={12} />, title: "Bring the energy down" },
              { value: "steady", label: <ArrowRight size={12} />, title: "Keep the energy" },
              { value: "up", label: <ArrowUpRight size={12} />, title: "Build the energy" },
            ]}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rows.length === 0 && <p className="p-6 text-center text-sm text-zinc-500">{seed ? "Nothing analysed fits yet. Analyse more of your library." : "Load a track on a deck, or right-click a track and choose “What mixes well after this?”."}</p>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2">
          {rows.map((s, i) => {
            const t = s.track;
            const key = s.keyShift ? shiftedKey(t.key, s.keyShift) : t.key;
            return (
              <div
                key={t.id}
                onPointerDown={(e) => beginTrackDrag(e, [t.id], `${t.artist} – ${t.title}`)}
                onDoubleClick={() => loadOnDeck(freeDeck(), t.id)}
                onClick={() => useLibrary.getState().set({ inspect: t.id, selected: [t.id] })}
                className="group flex cursor-default flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.025] p-2.5 hover:border-white/[0.12] hover:bg-white/[0.05]"
              >
                <div className="flex items-start gap-2">
                  <div className="relative w-5 pt-0.5 text-right font-mono text-[10px] text-zinc-600">
                    <span className="group-hover:invisible">{i + 1}</span>
                    <PreviewButton row={t} className="absolute right-0 top-0" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-zinc-100">{t.title}</div>
                    <div className="truncate text-[11px] text-zinc-400">{t.artist}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xs text-zinc-200">{fmtBpm(t.bpm)}</div>
                    <div className="font-mono text-[11px] font-semibold" style={{ color: inkColor(keyColor(key)) }}>
                      {keyLabel(key, notation)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-7">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className={clsx("h-full rounded-full", s.score > 0.75 ? "bg-emerald-400" : s.score > 0.5 ? "bg-sky-400" : "bg-zinc-400")} style={{ width: `${Math.round(Math.max(0, Math.min(1, s.score)) * 100)}%` }} />
                  </div>
                  <span className="font-mono text-[10px] text-zinc-500">{Math.round(s.score * 100)}</span>
                </div>
                <div className="flex flex-wrap gap-1 pl-7">
                  {s.tempoChangePct != null && Math.abs(s.tempoChangePct) >= 0.05 && <Chip tone="zinc">{signedPct(s.tempoChangePct / 100)} tempo</Chip>}
                  {s.keyShift !== 0 && <Chip tone="sky">{s.keyShift > 0 ? `+${s.keyShift}` : s.keyShift} key</Chip>}
                  {s.tags.filter((tag) => !GENERIC_TAGS.has(tag)).map((tag) => (
                    <Chip key={tag} tone={tag === "history" || tag === "sound" ? "emerald" : "zinc"}>
                      {TAG_LABEL[tag] ?? tag}
                    </Chip>
                  ))}
                  <span className="ml-auto font-mono text-[10px] text-zinc-600">{clock(t.duration)}</span>
                </div>
                {s.reasons.length > 0 && <p className="pl-7 text-[11px] leading-snug text-zinc-400">{s.reasons.join(" · ")}</p>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Chip({ tone, children }: { tone: "zinc" | "sky" | "emerald"; children: React.ReactNode }) {
  return (
    <span
      className={clsx(
        "rounded px-1.5 py-px text-[10px] font-medium",
        tone === "sky" ? "bg-sky-400/15 text-sky-300" : tone === "emerald" ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.07] text-zinc-300",
      )}
    >
      {children}
    </span>
  );
}
