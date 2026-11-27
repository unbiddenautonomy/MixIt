// Your own tags on one track or several: chips to take a tag off, a box to add one (with
// the tags you already use and a few ready-made ones offered as you type).
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { backend } from "../../backend";
import { tagMatches, tagStyle, tagTally } from "../../lib/tags";
import { useLibrary } from "../../store/library";
import { tagTracks } from "./data";

export function TagEditor({ ids }: { ids: number[] }) {
  const tags = useLibrary((s) => s.tags);
  const [own, setOwn] = useState<Record<number, string[]>>({});
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [pick, setPick] = useState(0);
  const key = ids.join(",");

  // The tags list changes after every tag edit, so this reloads with it.
  useEffect(() => {
    let live = true;
    void backend()
      .tagsOf(ids)
      .then((pairs) => live && setOwn(Object.fromEntries(pairs)))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tags]);

  const tally = tagTally(ids, own);
  const colorOf = (n: string) => tags.find((t) => t.name.toLowerCase() === n.toLowerCase())?.color ?? null;
  const offered = tagMatches(
    text,
    tags.map((t) => t.name),
    tally.filter((t) => t.count === ids.length).map((t) => t.name),
  );
  const add = (name: string) => {
    setText("");
    setPick(0);
    void tagTracks(ids, name, true);
  };
  const many = ids.length > 1;

  return (
    <div className="flex flex-col gap-1.5" data-testid="tag-editor">
      <div className="flex flex-wrap gap-1">
        {tally.map((t) => {
          const partial = t.count < ids.length;
          return (
            <span
              key={t.name}
              className={clsx("flex h-5 items-center gap-0.5 rounded-full pl-2 pr-0.5 text-[11px]", partial && "opacity-60")}
              style={tagStyle(t.name, colorOf(t.name))}
              data-testid="tag-chip"
              title={partial ? `On ${t.count} of the ${ids.length} tracks` : undefined}
            >
              {t.name}
              {partial && <span className="ml-0.5 text-[11px] opacity-80">{t.count}/{ids.length}</span>}
              {partial && (
                <button type="button" onClick={() => add(t.name)} aria-label={`Put ${t.name} on all selected`} title="Put it on all of them" className="rounded-full p-0.5 hover:bg-white/15">
                  <Plus size={9} />
                </button>
              )}
              <button type="button" onClick={() => void tagTracks(ids, t.name, false)} aria-label={`Take ${t.name} off`} title={many ? "Take it off all of them" : "Take it off"} className="rounded-full p-0.5 hover:bg-white/15">
                <X size={9} />
              </button>
            </span>
          );
        })}
        {tally.length === 0 && !focus && <span className="text-[11px] text-zinc-600">No tags yet.</span>}
      </div>
      <div className="relative">
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPick(0);
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => window.setTimeout(() => setFocus(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setPick((p) => Math.min(p + 1, offered.length));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setPick((p) => Math.max(p - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const chosen = pick > 0 ? offered[pick - 1] : text.trim();
              if (chosen) add(chosen);
            } else if (e.key === "Escape") {
              setText("");
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
          placeholder={many ? "Tag all selected: vocal, peak time…" : "Add a tag: vocal, peak time…"}
          aria-label="Add a tag"
          className="h-6 w-full rounded bg-white/[0.04] px-1.5 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:bg-white/[0.07]"
          data-testid="tag-input"
        />
        {focus && (offered.length > 0 || text.trim() !== "") && (
          <div className="absolute inset-x-0 top-7 z-20 flex flex-col rounded-md border border-white/10 bg-zinc-900 p-1 shadow-xl" role="listbox">
            {offered.map((n, i) => (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={pick === i + 1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(n);
                }}
                className={clsx("flex h-6 items-center gap-1.5 rounded px-1.5 text-left text-[11px] text-zinc-300", pick === i + 1 ? "bg-white/10" : "hover:bg-white/[0.06]")}
                data-testid="tag-offer"
              >
                <span className="size-1.5 rounded-full" style={{ background: tagStyle(n, colorOf(n)).color }} />
                {n}
                {!tags.some((t) => t.name.toLowerCase() === n.toLowerCase()) && <span className="ml-auto text-[11px] text-zinc-600">new</span>}
              </button>
            ))}
            {text.trim() !== "" && !offered.some((n) => n.toLowerCase() === text.trim().toLowerCase()) && (
              <div className="px-1.5 py-0.5 text-[11px] text-zinc-500">Enter adds “{text.trim()}” as a new tag.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
