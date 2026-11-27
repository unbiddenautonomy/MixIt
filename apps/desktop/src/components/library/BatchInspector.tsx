// Several tracks selected: edit what they share at once (artist, album, genre, label,
// year, comment, rating, colour), and write the tags into their files.
import { FileDown, Sparkles, Star, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { TrackEdit, TrackRow } from "../../backend/types";
import { clock, hex, plural } from "../../lib/format";
import { useLibrary } from "../../store/library";
import { Btn } from "../ui/Button";
import { refreshRows, writeTagsToFiles } from "./data";
import { openTidy } from "./TidyDialog";
import { TagEditor } from "./TagEditor";
import { editTracksWithUndo } from "../../lib/libraryUndo";

const COLORS = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899];

type TextField = "artist" | "album" | "genre" | "label" | "comment";

/** The value all the tracks share, or null when they differ. */
export function shared<T>(rows: TrackRow[], get: (r: TrackRow) => T): T | null {
  if (!rows.length) return null;
  const first = get(rows[0]);
  return rows.every((r) => get(r) === first) ? first : null;
}

export function BatchInspector({ ids }: { ids: number[] }) {
  const all = useLibrary((s) => s.rows);
  const rows = all.filter((r) => ids.includes(r.id));
  const apply = async (edit: TrackEdit, what: string) => {
    try {
      await editTracksWithUndo(rows, edit, `Set ${what.toLowerCase()} on ${plural(ids.length, "track")}`, `${what} set on ${plural(ids.length, "track")}`);
      await refreshRows();
    } catch (e) {
      toast.error(String(e));
    }
  };
  const total = rows.reduce((a, r) => a + r.duration, 0);
  const rating = shared(rows, (r) => r.rating);
  const color = shared(rows, (r) => r.color);
  const year = shared(rows, (r) => r.year);
  return (
    <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/[0.06] p-3 text-xs" data-testid="batch-inspector">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-zinc-50">{plural(ids.length, "track")} selected</div>
          <div className="text-zinc-500">{clock(total)} in all. A change here applies to every one.</div>
        </div>
        <button type="button" className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200" onClick={() => useLibrary.getState().set({ selected: [], inspect: null })} aria-label="Clear the selection">
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] p-2">
        {(["artist", "album", "genre", "label", "comment"] as TextField[]).map((f) => (
          <SharedText key={f} label={f[0].toUpperCase() + f.slice(1)} value={shared(rows, (r) => r[f])} onSave={(v) => void apply({ [f]: v }, f[0].toUpperCase() + f.slice(1))} />
        ))}
        <SharedText
          label="Year"
          value={year == null ? (rows.every((r) => r.year == null) ? "" : null) : String(year)}
          onSave={(v) => {
            const y = Number(v);
            if (!/^\d{4}$/.test(v) || y < 1900 || y > 2100) toast.error("A year is four digits, like 2024.");
            else void apply({ year: y }, "Year");
          }}
        />
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-zinc-500">Rating</span>
          <span className="flex">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="p-px" aria-label={`${n} stars for all`} onClick={() => void apply({ rating: rating === n ? 0 : n }, "Rating")}>
                <Star size={12} className={rating != null && n <= rating ? "fill-amber-400 text-amber-400" : "text-zinc-600 hover:text-zinc-300"} />
              </button>
            ))}
          </span>
          {rating == null && <span className="text-[11px] text-zinc-500">mixed</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-zinc-500">Colour</span>
          <span className="flex gap-1">
            {COLORS.map((c) => (
              <button key={c} type="button" aria-label="Colour for all" onClick={() => void apply({ color: c }, "Colour")} className={`size-3.5 rounded-full ${color === c ? "ring-2 ring-white" : ""}`} style={{ background: hex(c) }} />
            ))}
            <button type="button" aria-label="No colour" onClick={() => void apply({ color: null }, "Colour")} className="size-3.5 rounded-full border border-white/20" />
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] p-2">
        <span className="text-zinc-500">Your tags</span>
        <TagEditor ids={ids} />
      </div>
      <Btn size="sm" onClick={() => openTidy(rows)} title="Fix messy titles, artists and genres: from file names, stray spaces, clutter, SHOUTING">
        <Sparkles size={12} /> Tidy details…
      </Btn>
      <Btn size="sm" onClick={() => void writeTagsToFiles(ids)} title="Put the library's details into the files, so other apps and DJ gear show them">
        <FileDown size={12} /> Write tags to {plural(ids.length, "file")}
      </Btn>
    </aside>
  );
}

/** A text field for several tracks: shows the shared value, or "Mixed" when they differ. */
function SharedText({ label, value, onSave }: { label: string; value: string | null; onSave: (v: string) => void }) {
  const [v, setV] = useState(value ?? "");
  useEffect(() => setV(value ?? ""), [value]);
  return (
    <label className="flex items-baseline gap-2">
      <span className="w-16 shrink-0 text-zinc-500">{label}</span>
      <input
        value={v}
        placeholder={value === null ? "Mixed (type to set all)" : "–"}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() !== (value ?? "") && (v.trim() || value !== null) && onSave(v.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setV(value ?? "");
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="min-w-0 flex-1 truncate rounded bg-transparent px-0.5 text-zinc-200 outline-none placeholder:text-zinc-600 hover:bg-white/[0.04] focus:bg-white/[0.06]"
        aria-label={`${label} for all selected`}
      />
    </label>
  );
}
