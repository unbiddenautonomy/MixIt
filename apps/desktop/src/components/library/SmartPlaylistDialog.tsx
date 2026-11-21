// Making or changing a smart playlist with rules instead of the search language: pick
// what to match ("Tempo is between 120 and 128", "Tag is vocal"), see how many tracks
// match as you go, and switch to the search text at any time.
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { backend } from "../../backend";
import { plural } from "../../lib/format";
import { FIELDS, fromQuery, newRule, ruleTerm, SORTS, toQuery, type Rule, type RuleField, type Smart } from "../../lib/smartRules";
import { useLibrary } from "../../store/library";
import { Btn } from "../ui/Button";

interface Req {
  title: string;
  name: string;
  query: string;
  confirm: string;
  resolve: (v: { name: string; query: string } | null) => void;
}

const useSmart = create<{ req: Req | null }>(() => ({ req: null }));

/** Opens the rule editor. Resolves with the name and search, or null when cancelled. */
export function editSmartPlaylist(opts: { title: string; name?: string; query?: string; confirm?: string }): Promise<{ name: string; query: string } | null> {
  return new Promise((resolve) => useSmart.setState({ req: { name: "", query: "", confirm: "Save", ...opts, resolve } }));
}

const FIELD_ORDER: RuleField[] = ["genre", "bpm", "key", "energy", "rating", "tag", "played", "added", "year", "artist", "title", "label", "album", "comment"];

export function SmartPlaylistHost() {
  const req = useSmart((s) => s.req);
  return req ? <Editor key={req.title + req.query} req={req} /> : null;
}

function Editor({ req }: { req: Req }) {
  const [name, setName] = useState(req.name);
  const [smart, setSmart] = useState<Smart>(() => {
    const s = fromQuery(req.query);
    return s.rules.length || s.rest || s.sort ? s : { rules: [newRule("bpm")], sort: "", rest: "" };
  });
  const [asText, setAsText] = useState(false);
  const [text, setText] = useState(req.query);
  const [count, setCount] = useState<number | null>(null);
  const query = asText ? text.trim() : toQuery(smart);
  const tags = useLibrary((s) => s.tags);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      backend()
        .search(query, 20000)
        .then((r) => live && setCount(r.length))
        .catch(() => live && setCount(null));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const finish = (v: { name: string; query: string } | null) => {
    useSmart.setState({ req: null });
    req.resolve(v);
  };
  const setRule = (i: number, r: Rule) => setSmart((s) => ({ ...s, rules: s.rules.map((x, j) => (j === i ? r : x)) }));
  const ok = () => name.trim() && finish({ name: name.trim(), query });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && finish(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[86vh] w-[min(640px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-5 text-sm shadow-2xl" data-testid="smart-dialog">
          <Dialog.Title className="text-base font-semibold text-zinc-50">{req.title}</Dialog.Title>
          <Dialog.Description className="text-xs leading-relaxed text-zinc-400">A smart playlist fills itself: it always holds every track that matches all the rules, including tracks you add later.</Dialog.Description>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, like Warm-up house" aria-label="Playlist name" className="input h-9 text-sm" autoFocus={!req.name} />

          {asText ? (
            <div className="flex flex-col gap-1">
              <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" placeholder="bpm:120-128 key:~8A energy:6+" className="input h-9 font-mono text-[12px]" />
              <span className="text-[11px] text-zinc-500">The search language: see the ? in the search box for everything it understands.</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Tracks where</span>
              {smart.rules.map((r, i) => (
                <RuleRow key={i} rule={r} onChange={(x) => setRule(i, x)} onRemove={() => setSmart((s) => ({ ...s, rules: s.rules.filter((_, j) => j !== i) }))} tags={tags.map((t) => t.name)} first={i === 0} />
              ))}
              <button type="button" onClick={() => setSmart((s) => ({ ...s, rules: [...s.rules, newRule("genre")] }))} className="flex h-7 w-fit items-center gap-1 rounded-md px-2 text-xs text-sky-300 hover:bg-sky-400/10" data-testid="smart-add-rule">
                <Plus size={12} /> Add a rule
              </button>
              {smart.rest && (
                <label className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-zinc-500">Also matching</span>
                  <input value={smart.rest} onChange={(e) => setSmart((s) => ({ ...s, rest: e.target.value }))} className="input h-8 flex-1 font-mono text-[11px]" aria-label="Other search terms" />
                </label>
              )}
              <label className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 text-zinc-500">In order of</span>
                <select value={smart.sort} onChange={(e) => setSmart((s) => ({ ...s, sort: e.target.value }))} className="input h-8 w-60" aria-label="Order">
                  {SORTS.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <div className="flex items-center gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-xs">
            <span className="font-medium text-zinc-100" data-testid="smart-count">
              {count == null ? "…" : count === 0 ? "No tracks match yet" : `${plural(count, "track")} match`}
            </span>
            <code className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-zinc-500" title={query}>
              {query || "every track"}
            </code>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (asText) setSmart(fromQuery(text));
                else setText(query);
                setAsText(!asText);
              }}
              className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline"
              data-testid="smart-as-text"
            >
              {asText ? "Edit as rules" : "Edit as search text"}
            </button>
            <div className="ml-auto flex gap-2">
              <Btn onClick={() => finish(null)}>Cancel</Btn>
              <Btn tone="accent" onClick={ok} disabled={!name.trim()} data-testid="smart-save">
                {req.confirm}
              </Btn>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RuleRow({ rule, onChange, onRemove, tags, first }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void; tags: string[]; first: boolean }) {
  const spec = FIELDS[rule.field];
  const op = spec.ops.find((o) => o.op === rule.op) ?? spec.ops[0];
  const incomplete = ruleTerm(rule) === null;
  const listId = `smart-tags-${rule.field}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="smart-rule">
      <span className="w-8 shrink-0 text-right text-[11px] text-zinc-500">{first ? "" : "and"}</span>
      <select value={rule.field} onChange={(e) => onChange(newRule(e.target.value as RuleField))} className="input h-8 w-32" aria-label="What to match">
        {FIELD_ORDER.map((f) => (
          <option key={f} value={f}>
            {FIELDS[f].label}
          </option>
        ))}
      </select>
      <select value={op.op} onChange={(e) => onChange({ ...rule, op: e.target.value })} className="input h-8 w-36" aria-label="How to match">
        {spec.ops.map((o) => (
          <option key={o.op} value={o.op}>
            {o.label}
          </option>
        ))}
      </select>
      {op.values >= 1 && (
        <input
          value={rule.a}
          onChange={(e) => onChange({ ...rule, a: e.target.value })}
          placeholder={spec.placeholder}
          list={rule.field === "tag" ? listId : undefined}
          className={`input h-8 ${op.values === 2 || op.unit ? "w-20" : "w-40"} ${incomplete && rule.a ? "ring-1 ring-amber-400/60" : ""}`}
          aria-label="Value"
        />
      )}
      {op.values === 2 && (
        <>
          <span className="text-xs text-zinc-500">and</span>
          <input value={rule.b ?? ""} onChange={(e) => onChange({ ...rule, b: e.target.value })} placeholder={spec.placeholder} className="input h-8 w-20" aria-label="Second value" />
        </>
      )}
      {op.unit && <span className="text-xs text-zinc-500">{op.unit}</span>}
      {rule.field === "tag" && (
        <datalist id={listId}>
          {tags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
      <button type="button" onClick={onRemove} aria-label="Remove this rule" className="ml-auto rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200">
        <X size={12} />
      </button>
    </div>
  );
}
