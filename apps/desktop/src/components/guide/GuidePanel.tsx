// The built-in guide: plain-English concepts with "Show me", the seven practice labs that
// tick themselves off as you do them, live troubleshooting, the signal chain and the
// keyboard shortcuts. It sits beside the decks, so you can follow it while you play.
import clsx from "clsx";
import { ArrowLeft, BookOpen, Check, ChevronRight, Circle, Eye, FlaskConical, Headphones, Lightbulb, Loader2, Play, RotateCcw, Search, TriangleAlert, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { shortcutLabel } from "../../lib/actions";
import { updateSettings } from "../../lib/appCommands";
import { CONCEPT_GROUPS, CONCEPTS, conceptById, type Concept } from "../../guide/concepts";
import { labById, LABS } from "../../guide/labs";
import { currentStep, labMemory, PRACTICE_TITLES, runLab, showControls, useGuide, type GuideTab, type Lab, type Step } from "../../guide/model";
import { loadPractice, setupLab } from "../../guide/setup";
import { startTour } from "../../guide/tour";
import { deckList, detectProblems, PROBLEMS, problemControls, type Problem } from "../../guide/troubleshoot";
import { useApp } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { Btn, Segmented } from "../ui/Button";

const L = (d: number) => String.fromCharCode(65 + d);
const EMPTY: string[] = [];

/** Controls that live on the Mix screen (decks, mixer, deck FX). */
const onMixScreen = (id: string) => /^(deck|mixer|fx)\./.test(id);

/**
 * Lights up controls: switches to the screen and pad tab they are on, and offers Pro view
 * when they are hidden in Easy.
 */
export function reveal(ids: string[], tab?: [number, string]) {
  if (ids.length === 0) return;
  const s = useApp.getState();
  if (ids.some(onMixScreen) && s.workspace !== "mix") s.set({ workspace: "mix" });
  if (ids.some((id) => id.startsWith("fx.master") || id.startsWith("sampler."))) s.set({ samplerOpen: true });
  const fxDeck = ids.map((id) => /^fx\.([A-D])\./.exec(id)?.[1]).find(Boolean);
  const t = tab ?? (fxDeck ? [fxDeck.charCodeAt(0) - 65, "fx"] : undefined);
  if (t) s.set({ padTabs: s.padTabs.map((x, i) => (i === t[0] ? t[1] : x)) });
  // Let React draw the screen and tab first.
  window.setTimeout(() => {
    showControls(ids);
    const found = ids.some((id) => document.querySelector(`[data-action="${CSS.escape(id)}"]`));
    if (!found) {
      if (useApp.getState().settings?.viewMode !== "pro") {
        toast.message("That control is in Pro view", { action: { label: "Switch to Pro", onClick: () => updateSettings({ viewMode: "pro" }).then(() => window.setTimeout(() => showControls(ids), 120)) } });
      } else {
        toast.message("Load a track on that deck to see its controls.");
      }
    }
  }, 60);
}

export function GuidePanel() {
  const tab = useGuide((s) => s.tab);
  const set = useGuide((s) => s.set);
  const live = useLiveProblemCount();
  return (
    <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden border-l border-white/[0.06] bg-zinc-950" aria-label="Guide">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3">
        <BookOpen size={15} className="text-[var(--accent-ink)]" />
        <span className="text-sm font-semibold text-zinc-100">Guide</span>
        <button type="button" onClick={() => useApp.getState().set({ guideOpen: false })} aria-label="Close the guide" className="ml-auto flex size-7 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
          <X size={15} />
        </button>
      </div>
      <div className="shrink-0 px-3 pt-2.5">
        <Segmented<GuideTab>
          className="w-full [&>button]:flex-1"
          value={tab}
          onChange={(t) => set({ tab: t })}
          options={[
            { value: "learn", label: "Learn", title: "What each part of DJing means" },
            { value: "labs", label: "Labs", title: "Step-by-step practice" },
            {
              value: "fix",
              label: (
                <span className="inline-flex items-center gap-1">
                  Fix{live > 0 && <span className="rounded-full bg-amber-400 px-1 text-[9px] font-bold leading-[14px] text-zinc-950">{live}</span>}
                </span>
              ),
              title: "Common problems and how to fix them",
            },
            { value: "chain", label: "Signal", title: "How sound flows through MixIt" },
            { value: "keys", label: "Keys", title: "Keyboard shortcuts" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {tab === "learn" && <LearnTab />}
        {tab === "labs" && <LabsTab />}
        {tab === "fix" && <FixTab />}
        {tab === "chain" && <ChainTab />}
        {tab === "keys" && <KeysTab />}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ learn

function LearnTab() {
  const topic = useGuide((s) => s.topic);
  const [q, setQ] = useState("");
  const concept = conceptById(topic);
  if (concept) return <ConceptView c={concept} />;
  const needle = q.trim().toLowerCase();
  const hits = needle ? CONCEPTS.filter((c) => `${c.title} ${c.summary} ${c.body.join(" ")}`.toLowerCase().includes(needle)) : CONCEPTS;
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: bass, key lock, loops…" aria-label="Search the guide" className="input h-8 w-full pl-7" />
      </label>
      {!needle && <StartHere />}
      {CONCEPT_GROUPS.map((g) => {
        const list = hits.filter((c) => c.group === g);
        if (list.length === 0) return null;
        return (
          <div key={g}>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{g}</div>
            <div className="flex flex-col">
              {list.map((c) => (
                <button key={c.id} type="button" onClick={() => useGuide.getState().set({ topic: c.id })} className="group flex items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-zinc-100">{c.title}</div>
                    <div className="text-xs leading-snug text-zinc-400">{c.summary}</div>
                  </div>
                  <ChevronRight size={14} className="mt-1 shrink-0 text-zinc-600 group-hover:text-zinc-300" />
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {hits.length === 0 && <p className="px-2 text-xs text-zinc-500">Nothing matches “{q}”. Try the Fix tab for problems.</p>}
    </div>
  );
}

function StartHere() {
  const done = useGuide((s) => s.done);
  const next = LABS.find((l) => (done[l.id]?.length ?? 0) < l.steps.length);
  return (
    <div className="rounded-xl border border-[var(--accent)]/25 bg-[var(--accent)]/[0.06] p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-100">
        <Lightbulb size={14} className="text-[var(--accent-ink)]" /> New to DJing?
      </div>
      <p className="mt-1 text-xs leading-snug text-zinc-300">Read the Basics below, then try the labs. Each lab loads practice tracks, tells you what to do, and ticks off steps as you do them.</p>
      {next && (
        <Btn size="sm" tone="accent" className="mt-2" onClick={() => useGuide.getState().set({ tab: "labs", lab: next.id })}>
          <FlaskConical size={13} /> {done[next.id]?.length ? "Continue" : "Start"} lab {next.number}: {next.title}
        </Btn>
      )}
    </div>
  );
}

function ConceptView({ c }: { c: Concept }) {
  const lab = labById(c.lab ?? null);
  const related = CONCEPTS.filter((x) => x.group === c.group && x.id !== c.id).slice(0, 4);
  return (
    <div className="flex flex-col gap-3">
      <BackLink onClick={() => useGuide.getState().set({ topic: null })}>All topics</BackLink>
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{c.group}</div>
        <h2 className="text-base font-semibold text-zinc-50">{c.title}</h2>
        <p className="mt-0.5 text-[13px] text-zinc-300">{c.summary}</p>
      </div>
      {c.body.map((p, i) => (
        <p key={i} className="text-[13px] leading-relaxed text-zinc-300">
          {p}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        {c.controls?.length ? (
          <Btn size="sm" tone="accent" onClick={() => reveal(c.controls!, c.tab ? [0, c.tab] : undefined)}>
            <Eye size={13} /> Show me
          </Btn>
        ) : null}
        {lab && (
          <Btn size="sm" onClick={() => useGuide.getState().set({ tab: "labs", lab: lab.id })}>
            <FlaskConical size={13} /> Practise it: lab {lab.number}
          </Btn>
        )}
      </div>
      {related.length > 0 && (
        <div className="mt-1 border-t border-white/[0.06] pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Related</div>
          {related.map((r) => (
            <button key={r.id} type="button" onClick={() => useGuide.getState().set({ topic: r.id })} className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-xs text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100">
              <ChevronRight size={12} className="text-zinc-600" /> {r.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="-ml-1 inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs text-zinc-400 hover:text-zinc-100">
      <ArrowLeft size={13} /> {children}
    </button>
  );
}

// ------------------------------------------------------------------ labs

function LabsTab() {
  const id = useGuide((s) => s.lab);
  const lab = labById(id);
  if (lab) return <LabView lab={lab} />;
  return <LabList />;
}

function LabList() {
  const done = useGuide((s) => s.done);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-snug text-zinc-400">Seven short practice sessions, from your first clean transition to a rendered mix. Each uses practice tracks MixIt makes for you, built to make the lesson easy to hear.</p>
      <button type="button" onClick={() => (useApp.getState().set({ guideOpen: false }), startTour())} className="group flex items-center gap-3 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] p-2.5 text-left hover:bg-[var(--accent)]/10">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/20 text-[var(--accent-ink)]">
          <Play size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-100">New here? Take the 2-minute tour</div>
          <div className="text-[11px] text-zinc-400">Your first blend, one control at a time.</div>
        </div>
        <ChevronRight size={14} className="shrink-0 text-zinc-600 group-hover:text-zinc-300" />
      </button>
      {LABS.map((l) => {
        const n = done[l.id]?.length ?? 0;
        const complete = n >= l.steps.length;
        return (
          <button key={l.id} type="button" onClick={() => useGuide.getState().set({ lab: l.id })} className="group flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5 text-left hover:border-white/15 hover:bg-white/[0.04]">
            <div className={clsx("flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold", complete ? "bg-emerald-400/20 text-emerald-300" : "bg-white/[0.06] text-zinc-300")}>{complete ? <Check size={15} /> : l.number}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-100">
                <span className="truncate">{l.title}</span>
                {l.pro && <ProBadge />}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div className={clsx("h-full rounded-full", complete ? "bg-emerald-400" : "bg-[var(--accent)]")} style={{ width: `${(n / l.steps.length) * 100}%` }} />
                </div>
                <span className="font-mono text-[10px] text-zinc-500">
                  {n}/{l.steps.length}
                </span>
              </div>
            </div>
            <ChevronRight size={14} className="shrink-0 text-zinc-600 group-hover:text-zinc-300" />
          </button>
        );
      })}
    </div>
  );
}

function ProBadge() {
  return <span className="rounded bg-white/[0.08] px-1 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">Pro</span>;
}

function LabView({ lab }: { lab: Lab }) {
  const done = useGuide((s) => s.done[lab.id]) ?? EMPTY;
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const cur = currentStep(lab, done);
  const complete = !cur;
  const next = LABS.find((l) => l.number === lab.number + 1);

  // Check the steps four times a second while the lab is open.
  useEffect(() => {
    const id = window.setInterval(() => runLab(lab), 250);
    return () => window.clearInterval(id);
  }, [lab]);

  // Mark the current step's controls, and open the pad tab it needs.
  useEffect(() => {
    useGuide.getState().set({ focus: cur?.controls ?? [] });
    if (cur?.tab) {
      const [d, t] = cur.tab;
      const s = useApp.getState();
      if (s.padTabs[d] !== t) s.set({ padTabs: s.padTabs.map((x, i) => (i === d ? t : x)) });
    }
  }, [cur]);
  useEffect(() => () => useGuide.getState().set({ focus: [] }), []);

  const setup = async () => {
    setBusy(true);
    try {
      if (await setupLab(lab)) setReady(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <BackLink onClick={() => useGuide.getState().set({ lab: null })}>All labs</BackLink>
      <div>
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Lab {lab.number} {lab.pro && <ProBadge />}
        </div>
        <h2 className="text-base font-semibold text-zinc-50">{lab.title}</h2>
        <p className="mt-1 text-[13px] leading-snug text-zinc-300">{lab.goal}</p>
      </div>
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-2">
        <div className="min-w-0 flex-1 text-xs leading-snug text-zinc-400">
          {lab.arrange ? "Builds a timeline with Practice 1 and Practice 2." : `Loads ${(lab.decks ?? []).map((p, i) => `${PRACTICE_TITLES[p].replace(/^Practice (\d) - /, "Practice $1 ")} on deck ${L(i)}`).join(", ")}.`}
          {lab.pro && " Switches to Pro view."}
        </div>
        <Btn size="sm" tone={ready || done.length > 0 ? "default" : "accent"} onClick={setup} disabled={busy}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={12} />} {ready ? "Set up again" : "Set up"}
        </Btn>
      </div>
      <ol className="flex flex-col gap-1">
        {lab.steps.map((s, i) => (
          <StepRow key={s.id} lab={lab} step={s} index={i} state={done.includes(s.id) ? "done" : s === cur ? "current" : "todo"} />
        ))}
      </ol>
      {lab.id === "bass-swap" && <MudMeter lab={lab} />}
      {complete && (
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.07] p-3 text-[13px] text-emerald-100">
          <div className="font-semibold">Lab complete</div>
          <p className="mt-0.5 text-xs text-emerald-100/80">Run it again with your own tracks: the same moves work on any two songs.</p>
          {next && (
            <Btn size="sm" tone="accent" className="mt-2" onClick={() => useGuide.getState().set({ lab: next.id })}>
              Next: lab {next.number} <ChevronRight size={13} />
            </Btn>
          )}
        </div>
      )}
      <Note icon={<Headphones size={13} />} title="Listen for">
        {lab.listen}
      </Note>
      <Note icon={<TriangleAlert size={13} />} title="Common mistake">
        {lab.mistake}
      </Note>
      <button type="button" onClick={() => useGuide.getState().resetLab(lab.id)} className="inline-flex w-fit items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
        <RotateCcw size={12} /> Start this lab over
      </button>
    </div>
  );
}

function StepRow({ lab, step, index, state }: { lab: Lab; step: Step; index: number; state: "done" | "current" | "todo" }) {
  const pro = useApp((s) => s.settings?.viewMode === "pro");
  const [loading, setLoading] = useState(false);
  const current = state === "current";
  return (
    <li className={clsx("rounded-xl border p-2.5", current ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]" : "border-transparent")}>
      <div className="flex items-start gap-2">
        <span className={clsx("mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", state === "done" ? "bg-emerald-400 text-zinc-950" : current ? "bg-[var(--accent)] text-zinc-950" : "border border-white/15 text-zinc-500")}>
          {state === "done" ? <Check size={12} strokeWidth={3} /> : index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className={clsx("text-[13px] leading-snug", state === "done" ? "text-zinc-500 line-through decoration-zinc-600" : current ? "font-medium text-zinc-50" : "text-zinc-400")}>{step.title}</div>
          {current && step.body && <p className="mt-1 text-xs leading-relaxed text-zinc-300">{step.body}</p>}
          {current && step.pro && !pro && (
            <p className="mt-1 text-xs text-amber-300">
              This uses controls from Pro view.{" "}
              <button type="button" className="underline" onClick={() => updateSettings({ viewMode: "pro" })}>
                Switch to Pro
              </button>
            </p>
          )}
          {current && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {step.controls?.length ? (
                <Btn size="sm" tone="accent" onClick={() => reveal(step.controls!, step.tab)}>
                  <Eye size={13} /> Show me
                </Btn>
              ) : null}
              {step.load && (
                <Btn
                  size="sm"
                  disabled={loading}
                  onClick={async () => {
                    setLoading(true);
                    try {
                      await loadPractice(step.load![0], step.load![1]);
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  {loading && <Loader2 size={12} className="animate-spin" />}
                  Load {PRACTICE_TITLES[step.load[1]].split(" - ")[0]} on deck {L(step.load[0])}
                </Btn>
              )}
              {!step.check ? (
                <Btn size="sm" onClick={() => useGuide.getState().markDone(lab.id, step.id)}>
                  <Check size={13} /> Done
                </Btn>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                  <Circle size={8} className="animate-pulse fill-current" /> Ticks off when you do it
                </span>
              )}
              {step.check && (
                <button type="button" onClick={() => useGuide.getState().markDone(lab.id, step.id)} className="ml-auto text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
                  Skip
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** Lab 2: how long both basslines were up at once. */
function MudMeter({ lab }: { lab: Lab }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSecs(Math.round(((labMemory(lab.id).mud as number) ?? 0) * 10) / 10), 500);
    return () => window.clearInterval(id);
  }, [lab.id]);
  const good = secs < 2;
  return (
    <div className={clsx("flex items-center gap-2 rounded-xl border px-3 py-2 text-xs", good ? "border-white/[0.06] text-zinc-400" : "border-amber-400/25 bg-amber-400/[0.06] text-amber-200")}>
      <span className="font-mono text-base font-semibold tabular-nums">{secs.toFixed(1)}s</span>
      <span>with both basslines up at once. {good ? "Keep it under 2 seconds." : "Cut one deck's low EQ while both play."}</span>
    </div>
  );
}

function Note({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
        {icon} {title}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-zinc-300">{children}</p>
    </div>
  );
}

// ------------------------------------------------------------------ troubleshoot

function fixCtx() {
  const s = useApp.getState();
  return { t: useTelemetry.getState().t, decks: s.decks, mixer: s.mixer, audio: s.audio, count: s.settings?.decks ?? 2 };
}

/** Live problems, refreshed twice a second. */
function useLiveProblems(): Map<string, number[]> {
  const [live, setLive] = useState<Map<string, number[]>>(new Map());
  useEffect(() => {
    const tick = () =>
      setLive((prev) => {
        const next = detectProblems(fixCtx());
        const same = prev.size === next.size && [...next].every(([k, v]) => prev.get(k)?.join() === v.join());
        return same ? prev : next;
      });
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, []);
  return live;
}

function useLiveProblemCount(): number {
  return useLiveProblems().size;
}

function FixTab() {
  const live = useLiveProblems();
  const sorted = useMemo(() => [...PROBLEMS].sort((a, b) => Number(live.has(b.id)) - Number(live.has(a.id))), [live]);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-snug text-zinc-400">Something sounds wrong? Find it below. MixIt watches your mix and moves anything it notices to the top.</p>
      {sorted.map((p) => (
        <ProblemRow key={p.id} p={p} now={live.get(p.id)} />
      ))}
    </div>
  );
}

function ProblemRow({ p, now }: { p: Problem; now?: number[] }) {
  const [open, setOpen] = useState(false);
  const show = open || !!now;
  const controls = problemControls(p, now ?? []);
  return (
    <div className={clsx("rounded-xl border", now ? "border-amber-400/35 bg-amber-400/[0.06]" : "border-white/[0.06] bg-white/[0.02]")}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 p-2.5 text-left" aria-expanded={show}>
        {now ? <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-300" /> : <Wrench size={13} className="mt-0.5 shrink-0 text-zinc-500" />}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-snug text-zinc-100">{p.symptom}</div>
          {now && <div className="mt-0.5 text-[11px] font-semibold text-amber-300">Happening now{now.length ? ` on deck ${deckList(now)}` : ""}</div>}
        </div>
        <ChevronRight size={14} className={clsx("mt-0.5 shrink-0 text-zinc-600 transition-transform", show && "rotate-90")} />
      </button>
      {show && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pl-8 text-xs leading-relaxed">
          <p className="text-zinc-400">
            <span className="font-semibold text-zinc-300">Why: </span>
            {p.cause}
          </p>
          <p className="text-zinc-300">
            <span className="font-semibold text-zinc-200">Fix: </span>
            {p.fix}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {controls.length > 0 && (
              <Btn size="sm" tone="accent" onClick={() => (controls.includes("app.settings") ? useApp.getState().set({ settingsOpen: true }) : reveal(controls))}>
                <Eye size={13} /> {controls.includes("app.settings") ? "Open Settings" : "Show me"}
              </Btn>
            )}
            {p.concept && (
              <Btn size="sm" onClick={() => useGuide.getState().set({ tab: "learn", topic: p.concept })}>
                <BookOpen size={13} /> Learn more
              </Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ signal chain

interface Node {
  id: string;
  name: string;
  what: string;
  controls: (l: string) => string[];
  /** Live state for the chosen deck, as a short label. */
  state?: (d: number) => string | null;
  concept?: string;
}

function ChainTab() {
  const [deck, setDeck] = useState(0);
  const count = useApp((s) => s.settings?.decks ?? 2);
  // Re-render a few times a second for the live labels.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((x) => x + 1), 400);
    return () => window.clearInterval(id);
  }, []);
  const l = L(deck);
  const s = useApp.getState();
  const t = useTelemetry.getState().t;
  const ch = s.mixer.channels[deck];
  const td = t.decks[deck];
  const fxNames = s.fxTypes;
  const db = (v: number) => (v <= -25.5 ? "cut" : `${v > 0 ? "+" : ""}${v.toFixed(0)} dB`);
  const chain: Node[] = [
    { id: "deck", name: `Deck ${l}`, what: "Plays the track. Tempo, key lock and key shift change it here, before anything else.", controls: (x) => [`deck.${x}.play`, `deck.${x}.tempo`, `deck.${x}.keylock`], state: () => (td?.loaded ? `${td.playing ? "playing" : "paused"} · ${td.bpm.toFixed(1)} BPM${td.keylock ? " · key lock" : ""}` : "empty"), concept: "decks" },
    { id: "gain", name: "Gain", what: "Evens out loudness between tracks.", controls: (x) => [`mixer.${x}.trim`], state: () => `${ch.trim > 0 ? "+" : ""}${ch.trim.toFixed(1)} dB`, concept: "gain" },
    { id: "eq", name: "EQ", what: "Low, mid and high: bass, body and top of the sound.", controls: (x) => [`mixer.${x}.eq.low`, `mixer.${x}.eq.mid`, `mixer.${x}.eq.high`], state: () => `L ${ch.kills[0] ? "kill" : db(ch.low)} · M ${ch.kills[1] ? "kill" : db(ch.mid)} · H ${ch.kills[2] ? "kill" : db(ch.high)}`, concept: "eq" },
    { id: "filter", name: "Filter", what: "Muffles (left) or thins out (right) the whole channel.", controls: (x) => [`mixer.${x}.filter`], state: () => (Math.abs(ch.filter) < 0.02 ? "off" : ch.filter < 0 ? `low-pass ${Math.round(-ch.filter * 100)}%` : `high-pass ${Math.round(ch.filter * 100)}%`), concept: "filter" },
    { id: "fader", name: "Fader and crossfader", what: "Sets how much of this deck reaches the mix.", controls: (x) => [`mixer.${x}.fader`, "mixer.crossfader"], state: () => `fader ${Math.round(ch.fader * 100)}%`, concept: "fader" },
    {
      id: "fx",
      name: "Deck FX",
      what: "Echo, reverb and the rest. After the fader, so echoes keep ringing when you pull it down.",
      controls: (x) => [`fx.${x}.1.on`, `fx.${x}.2.on`, `fx.${x}.3.on`],
      state: () => {
        const on = (s.mixer.fx[deck] ?? []).filter((f) => f.on && f.type !== 0).map((f) => fxNames[f.type] ?? "effect");
        return on.length ? on.join(", ") : "none on";
      },
      concept: "fx",
    },
  ];
  const master: Node[] = [
    { id: "bus", name: "Mix bus", what: "Every deck and the sampler pads add up here.", controls: () => ["app.sampler"], concept: "sampler" },
    {
      id: "mfx",
      name: "Master FX",
      what: "Effects on the whole mix, in the sampler panel.",
      controls: () => ["fx.master.1.on", "fx.master.2.on", "fx.master.3.on"],
      state: () => {
        const on = (s.mixer.fx[4] ?? []).filter((f) => f.on && f.type !== 0).map((f) => fxNames[f.type] ?? "effect");
        return on.length ? on.join(", ") : "none on";
      },
    },
    { id: "master", name: "Master volume", what: "The level of the whole mix.", controls: () => ["mixer.master"], state: () => `${s.mixer.master > 0 ? "+" : ""}${s.mixer.master.toFixed(1)} dB`, concept: "master" },
    { id: "limiter", name: "Limiter", what: "Catches peaks so the output never distorts.", controls: () => ["mixer.master"], state: () => (t.master.limiterGrDb < -0.5 ? `working: ${t.master.limiterGrDb.toFixed(1)} dB` : "resting"), concept: "master" },
    { id: "out", name: "Speakers and recording", what: "What the audience hears, and what Rec saves.", controls: () => ["global.record"], state: () => `${t.master.shortTermLufs > -70 ? `${t.master.shortTermLufs.toFixed(0)} LUFS` : "silent"}${t.recording ? " · recording" : ""}`, concept: "recording" },
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-snug text-zinc-400">The path sound takes from a deck to your speakers. Each box shows what it is doing right now; click one to find its controls.</p>
      <Segmented value={deck} onChange={setDeck} options={Array.from({ length: count }, (_, i) => ({ value: i, label: `Deck ${L(i)}` }))} />
      <div className="flex flex-col">
        {chain.map((n, i) => (
          <ChainNode key={n.id} n={n} l={l} deck={deck} last={false} tap={i === 3 ? <CueTap on={ch.cue} l={l} /> : null} />
        ))}
        {master.map((n, i) => (
          <ChainNode key={n.id} n={n} l={l} deck={deck} last={i === master.length - 1} master />
        ))}
      </div>
    </div>
  );
}

function ChainNode({ n, l, deck, last, master, tap }: { n: Node; l: string; deck: number; last: boolean; master?: boolean; tap?: ReactNode }) {
  const state = n.state?.(deck);
  return (
    <div className="flex flex-col items-stretch">
      <button type="button" onClick={() => reveal(n.controls(l))} className={clsx("rounded-xl border px-3 py-2 text-left transition-colors hover:border-[var(--accent)]/50", master ? "border-white/10 bg-white/[0.04]" : "border-white/[0.06] bg-white/[0.02]")}>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-zinc-100">{n.name}</span>
          {state && <span className="ml-auto truncate font-mono text-[10px] text-[var(--accent-ink)]">{state}</span>}
        </div>
        <div className="text-[11px] leading-snug text-zinc-400">{n.what}</div>
      </button>
      {tap}
      {!last && <div className="mx-auto h-3 w-px bg-white/15" aria-hidden />}
    </div>
  );
}

/** The headphone cue taps the channel after the filter, before the fader. */
function CueTap({ on, l }: { on: boolean; l: string }) {
  return (
    <div className="flex items-center gap-1.5 pl-6 pt-1">
      <span className="h-px w-3 bg-white/15" aria-hidden />
      <button type="button" onClick={() => reveal([`mixer.${l}.cue`, "mixer.headphones", "mixer.cue_mix"])} className={clsx("flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]", on ? "border-amber-400/40 bg-amber-400/10 text-amber-200" : "border-dashed border-white/15 text-zinc-400 hover:text-zinc-200")}>
        <Headphones size={12} /> Headphones {on ? "listening here" : "can listen here, before the fader"}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ keys

function KeysTab() {
  const registry = useApp((s) => s.registry);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const withKeys = registry.filter((a) => a.shortcut && (!needle || `${a.label} ${a.group} ${a.shortcut}`.toLowerCase().includes(needle)));
  const groups = [...new Set(withKeys.map((a) => a.group))];
  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts" className="input h-8 w-full pl-7" />
      </label>
      <p className="text-xs leading-snug text-zinc-400">
        Hold <Kbd>F1</Kbd> or <Kbd>?</Kbd> to see what every control does. <Kbd>{shortcutLabel("Mod+K")}</Kbd> finds any action by name.
      </p>
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{g}</div>
          {withKeys
            .filter((a) => a.group === g)
            .map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 py-0.5 text-xs">
                <span className="truncate text-zinc-300">{a.label}</span>
                <Kbd>{shortcutLabel(a.shortcut)}</Kbd>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[11px] text-zinc-300">{children}</kbd>;
}
