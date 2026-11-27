// Everything MixIt knows about one track: editable tags, the analysis (tempo, key,
// loudness, energy over time, sections) and saved cues.
import { vocalLabel, vocalWhere } from "../../lib/vocals";
import { AudioLines, FileDown, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import type { TrackDetail, TrackEdit } from "../../backend/types";
import { bpm as fmtBpm, clock, hex, inkColor } from "../../lib/format";
import { keyColor, keyLabel } from "../../lib/keys";
import { SECTION_COLORS } from "../../lib/waveform";
import { DECK_LETTERS, useApp, useNotation } from "../../store/app";
import { useLibrary } from "../../store/library";
import { Cover } from "../ui/Cover";
import { Btn } from "../ui/Button";
import { loadOnDeck } from "../deck/Deck";
import { refreshRows, showSoundsLike, writeTagsToFiles } from "./data";
import { BatchInspector } from "./BatchInspector";
import { TagEditor } from "./TagEditor";
import { editTracksWithUndo } from "../../lib/libraryUndo";

/** A track's analysis and details. Beside the library it only takes room once a track is
 * selected (`placeholder` keeps it, with a hint, where it is a part of its own). */
export function Inspector({ placeholder = false }: { placeholder?: boolean }) {
  const selected = useLibrary((s) => s.selected);
  if (selected.length > 1) return <BatchInspector ids={selected} />;
  return <OneTrack placeholder={placeholder} />;
}

function OneTrack({ placeholder }: { placeholder: boolean }) {
  const id = useLibrary((s) => s.inspect);
  const [d, setD] = useState<TrackDetail | null>(null);
  const notation = useNotation();
  const count = useApp((s) => s.settings?.decks ?? 2);

  useEffect(() => {
    let live = true;
    if (id == null) {
      setD(null);
      return;
    }
    backend()
      .trackDetail(id)
      .then((x) => live && setD(x))
      .catch(() => live && setD(null));
    return () => {
      live = false;
    };
  }, [id]);

  if (id == null || !d) {
    if (!placeholder) return null;
    return <aside className="flex h-full w-full items-center justify-center p-4 text-center text-xs text-zinc-500">Select a track to see its analysis.</aside>;
  }
  const t = d.track;
  const save = async (edit: TrackEdit) => {
    try {
      const row = await editTracksWithUndo([t], edit, `Edit ${t.title}`, undefined, false);
      if (!row) return;
      setD({ ...d, track: row });
      useLibrary.setState((s) => ({ rows: s.rows.map((r) => (r.id === row.id ? row : r)) }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/[0.06] p-3 text-xs">
      <div className="flex items-start gap-2.5">
        <Cover trackId={t.id} has={t.hasArt} title={t.title} artist={t.artist} size={56} />
        <div className="min-w-0 flex-1">
          <Editable value={t.title} placeholder="Title" className="text-sm font-semibold text-zinc-50" onSave={(title) => save({ title })} />
          <Editable value={t.artist} placeholder="Artist" className="text-zinc-400" onSave={(artist) => save({ artist })} />
        </div>
        <button type="button" className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200" onClick={() => useLibrary.getState().set({ inspect: null })} aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {DECK_LETTERS.slice(0, count).map((l, i) => (
          <Btn key={l} size="sm" onClick={() => loadOnDeck(i, t.id)}>
            Load {l}
          </Btn>
        ))}
        <Btn
          size="sm"
          tone="accent"
          onClick={() => {
            useLibrary.getState().set({ suggestFor: t.id, source: { type: "suggest" } });
            refreshRows();
          }}
        >
          <Sparkles size={12} /> Next
        </Btn>
        {t.analysis === "done" && (
          <Btn size="sm" onClick={() => showSoundsLike(t)} title="Tracks with a similar sound: instruments, production and groove" data-testid="inspector-sounds-like">
            <AudioLines size={12} /> Sounds like
          </Btn>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="BPM" value={fmtBpm(d.bpm)} sub={d.analysed ? `${Math.round(d.tempoConfidence * 100)}% sure` : "not analysed"} />
        <Stat label="Key" value={<span style={{ color: inkColor(keyColor(d.key)) }}>{keyLabel(d.key, notation)}</span>} sub={d.key ? `${d.key.name}, ${Math.round(d.keyConfidence * 100)}%` : ""} />
        <Stat label="Energy" value={d.energy != null ? d.energy.toFixed(1) : "–"} sub="of 10" />
        <Stat label="Loudness" value={d.lufs != null ? d.lufs.toFixed(1) : "–"} sub="LUFS" />
        <Stat label="True peak" value={d.truePeak != null ? d.truePeak.toFixed(1) : "–"} sub="dBTP" />
        <Stat label="Auto gain" value={d.autoGainDb != null ? `${d.autoGainDb > 0 ? "+" : ""}${d.autoGainDb.toFixed(1)}` : "–"} sub="dB" />
      </div>

      {d.analysed && vocalLabel(d.track.vocals) && (
        <p className="px-0.5 text-[11px] text-zinc-400" data-testid="inspector-vocals">
          <span className="text-zinc-200">{vocalLabel(d.track.vocals)}</span>
          {d.vocals?.length ? <span className="text-zinc-500">: {vocalWhere(d.vocals)}. The pink marks on the deck show where.</span> : null}
        </p>
      )}

      {d.energyCurve.length > 1 && <EnergyCurve d={d} />}

      <Group title="Your tags">
        <TagEditor ids={[t.id]} />
      </Group>

      {d.sections.length > 0 && (
        <Group title="Sections">
          {d.sections.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="size-2 rounded-sm" style={{ background: SECTION_COLORS[s.label] ?? "#71717a" }} />
              <span className="w-20 text-zinc-300">{s.label}</span>
              <span className="font-mono text-zinc-500">{clock(s.start)}</span>
              <span className="ml-auto font-mono text-zinc-500">{s.bars} bars</span>
            </div>
          ))}
        </Group>
      )}

      {d.cues.length > 0 && (
        <Group title="Cues">
          {d.cues
            .slice()
            .sort((a, b) => a.seconds - b.seconds)
            .map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="size-2 rounded-full" style={{ background: hex(c.color, c.role === "mixIn" ? "#22c55e" : c.role === "mixOut" ? "#ef4444" : "#a1a1aa") }} />
                <span className="w-20 text-zinc-300">{c.label || cueName(c.role, c.slot)}</span>
                <span className="font-mono text-zinc-500">{clock(c.seconds, true)}</span>
                {c.loopSeconds ? <span className="ml-auto text-zinc-500">loop {c.loopSeconds.toFixed(1)}s</span> : null}
              </div>
            ))}
        </Group>
      )}

      <Group title="Details">
        <Field label="Album">
          <Editable value={t.album} placeholder="–" onSave={(album) => save({ album })} />
        </Field>
        <Field label="Genre">
          <Editable value={t.genre} placeholder="–" onSave={(genre) => save({ genre })} />
        </Field>
        <Field label="Label">
          <Editable value={t.label} placeholder="–" onSave={(label) => save({ label })} />
        </Field>
        <Field label="Comment">
          <Editable value={t.comment} placeholder="–" onSave={(comment) => save({ comment })} />
        </Field>
        <Field label="Year">
          <Editable
            value={t.year != null ? String(t.year) : ""}
            placeholder="–"
            onSave={(v) => {
              if (/^\d{4}$/.test(v)) void save({ year: Number(v) });
              else if (v) toast.error("A year is four digits, like 2024.");
            }}
          />
        </Field>
        <Field label="BPM">
          <Editable value={t.bpm ? t.bpm.toFixed(2) : ""} placeholder="–" onSave={(v) => save({ bpm: v ? Number(v) : null })} />
        </Field>
        <Field label="Length">{clock(t.duration)}</Field>
        <Field label="Grid">{d.analysed ? `${d.constantGrid ? "constant" : "warped"}, ${d.beatsPerBar}/4${d.driftMs ? `, drift ${d.driftMs.toFixed(1)} ms` : ""}` : "–"}</Field>
        {d.keySecond && <Field label="Alt. key">{keyLabel(d.keySecond, notation)}</Field>}
        {d.tuningCents !== 0 && <Field label="Tuning">{`${d.tuningCents > 0 ? "+" : ""}${d.tuningCents.toFixed(0)} cents`}</Field>}
        <Field label="Plays">{t.playCount}</Field>
        <div className="break-all pt-1 font-mono text-[11px] leading-snug text-zinc-600">{t.path}</div>
        {backend().kind !== "web" && !t.missing && (
          <button type="button" onClick={() => void writeTagsToFiles([t.id])} className="mt-1 flex items-center gap-1 self-start text-[11px] text-sky-300 hover:underline" title="Put these details into the file, so other apps and DJ gear show them">
            <FileDown size={11} /> Write tags to the file
          </button>
        )}
      </Group>
    </aside>
  );
}

function cueName(role: string, slot: number | null): string {
  switch (role) {
    case "hot":
      return `Hot cue ${(slot ?? 0) + 1}`;
    case "mixIn":
      return "Mix in";
    case "mixOut":
      return "Mix out";
    case "load":
      return "Load point";
    case "main":
      return "Cue";
    default:
      return role;
  }
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg bg-white/[0.04] px-2 py-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="font-mono text-sm font-semibold text-zinc-100">{value}</div>
      {sub && <div className="truncate text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-16 shrink-0 text-zinc-500">{label}</span>
      <div className="min-w-0 flex-1 text-zinc-300">{children}</div>
    </div>
  );
}

function Editable({ value, placeholder, onSave, className }: { value: string; placeholder: string; onSave: (v: string) => void; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={`w-full truncate rounded bg-transparent px-0.5 outline-none hover:bg-white/[0.04] focus:bg-white/[0.06] ${className ?? ""}`}
    />
  );
}

/** Energy over time with the sections behind it. */
function EnergyCurve({ d }: { d: TrackDetail }) {
  const W = 260;
  const H = 54;
  const dur = d.track.duration || 1;
  const n = d.energyCurve.length;
  const step = n > 1 ? (dur - d.energyCurveStart) / n : 1;
  const max = Math.max(1e-6, ...d.energyCurve);
  const pts = d.energyCurve.map((e, i) => `${(((d.energyCurveStart + i * step) / dur) * W).toFixed(1)},${(H - 2 - (e / max) * (H - 6)).toFixed(1)}`);
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Energy</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md bg-black/30" preserveAspectRatio="none" style={{ height: H }}>
        {d.sections.map((s, i) => (
          <rect key={i} x={(s.start / dur) * W} y={0} width={Math.max(0, ((s.end - s.start) / dur) * W)} height={H} fill={SECTION_COLORS[s.label] ?? "#71717a"} opacity={0.16} />
        ))}
        <polyline points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill="rgba(244,114,182,0.18)" stroke="none" />
        <polyline points={pts.join(" ")} fill="none" stroke="#f472b6" strokeWidth={1.4} />
      </svg>
    </div>
  );
}
