// The mix assistant: a panel off the top bar that listens to the live mix and lists
// what to fix, why, and a button that fixes it. It keeps a rolling window of samples
// while open and turns the master spectrum analyser on so it can judge the tone.
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { AlertTriangle, BookOpen, Check, Lightbulb, Stethoscope, Wand2, X } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";
import { backend } from "../../backend";
import { useGuide } from "../../guide/model";
import { choose, setValue } from "../../lib/actions";
import { RATE, WINDOW_S, assess, sample, windowLufs, withMasterEq, type Finding, type Fix, type Sample } from "../../lib/assistant";
import { LOUDNESS_TARGETS } from "../../lib/studio";
import { DECK_LETTERS, useApp } from "../../store/app";
import { MASTER_STRIP, matchGainDb, updateStudio, useStudio } from "../../store/studio";
import { useTelemetry } from "../../store/telemetry";
import { Btn } from "../ui/Button";
import { Ctl } from "../ui/Ctl";

interface AssistantState {
  open: boolean;
  samples: Sample[];
  findings: Finding[];
  /** Fixes applied (finding id → when), so the list says so while it listens again. */
  fixed: Record<string, number>;
}

export const useAssistant = create<AssistantState>(() => ({ open: false, samples: [], findings: [], fixed: {} }));

export function setAssistantOpen(open: boolean) {
  useAssistant.setState(open ? { open, samples: [], findings: [] } : { open });
  // The master analyser runs while the assistant listens, unless a studio panel has
  // the analyser on a channel.
  if (useStudio.getState().open === null) void backend().setScope(open ? "master" : "off").catch(() => undefined);
}

const target = () => LOUDNESS_TARGETS.find((t) => t.id === useStudio.getState().target) ?? LOUDNESS_TARGETS[0];

function tick() {
  const t = useTelemetry.getState().t;
  const app = useApp.getState();
  const now = performance.now() / 1000;
  const s = sample(t, app.mixer, Math.min(4, t.decks.length), now);
  // A studio panel open on a channel points the analyser at that channel, not the mix.
  const studio = useStudio.getState().open;
  if (studio !== null && studio !== MASTER_STRIP) s.spectrum = null;
  const st = useAssistant.getState();
  const samples = [...st.samples.filter((x) => now - x.t <= WINDOW_S), s];
  const tg = target();
  const findings = assess(samples, { mixer: app.mixer, master: useStudio.getState().settings[MASTER_STRIP], targetLufs: tg.lufs, targetName: tg.name });
  const fixed = Object.fromEntries(Object.entries(st.fixed).filter(([, at]) => now - at < WINDOW_S));
  useAssistant.setState({ samples, findings, fixed });
  // Keep the analyser on (another panel may have turned it off when it closed).
  if (studio === null && !s.spectrum && Math.round(now * RATE) % (RATE * 2) === 0) void backend().setScope("master").catch(() => undefined);
}

/** Carries out a finding's fix, then starts listening afresh. */
export async function applyFix(f: Finding) {
  const fix = f.fix?.do;
  if (!fix) return;
  await runFix(fix, useAssistant.getState().samples);
  const now = performance.now() / 1000;
  useAssistant.setState((s) => ({ samples: [], findings: [], fixed: { ...s.fixed, [f.id]: now } }));
}

async function runFix(fix: Fix, samples: Sample[]) {
  const m = useApp.getState().mixer;
  switch (fix.kind) {
    case "action":
      await setValue(fix.id, fix.value);
      return;
    case "master-db":
      await setValue("mixer.master", Math.max(-60, Math.min(6, m.master + fix.delta)));
      return;
    case "match-loudness": {
      const measured = windowLufs(samples);
      await updateStudio(MASTER_STRIP, (s) => {
        const g = matchGainDb(measured, fix.targetLufs, s.outputDb);
        return g === null ? s : { ...s, outputDb: g };
      });
      return;
    }
    case "master-eq":
      await updateStudio(MASTER_STRIP, (s) => withMasterEq(s, fix.preset));
      return;
    case "duck": {
      const L = DECK_LETTERS[fix.deck];
      await choose(`mixer.${L}.duck_source`, fix.under + 1);
      if ((m.channels[fix.deck]?.duck ?? 0) < 0.05) await setValue(`mixer.${L}.duck`, 0.5);
      return;
    }
  }
}

function openConcept(id: string) {
  useApp.getState().set({ guideOpen: true });
  useGuide.getState().set({ tab: "learn", topic: id });
}

export function AssistantButton() {
  const open = useAssistant((s) => s.open);
  const problems = useAssistant((s) => s.findings.filter((f) => f.level === "problem").length);
  useEffect(() => {
    if (!open) return;
    const h = window.setInterval(tick, 1000 / RATE);
    return () => window.clearInterval(h);
  }, [open]);
  return (
    <Popover.Root open={open} onOpenChange={setAssistantOpen}>
      <Ctl id="app.assistant" side="bottom">
        <Popover.Trigger asChild>
          <Btn size="sm" tone="ghost" active={open} aria-label="Mix assistant">
            <Stethoscope size={14} />
            {open && problems > 0 && <span className="rounded-full bg-red-500 px-1 text-[9px] font-bold leading-[14px] text-white">{problems}</span>}
          </Btn>
        </Popover.Trigger>
      </Ctl>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          // Stays open while you mix, so the list updates as you change things.
          onInteractOutside={(e) => e.preventDefault()}
          className="z-50 flex max-h-[min(36rem,80vh)] w-[24rem] flex-col rounded-xl border border-white/10 bg-zinc-900/95 text-xs shadow-2xl backdrop-blur"
          style={{ ["--accent" as string]: "#a78bfa", ["--accent-ink" as string]: "#ddd6fe" }}
        >
          <AssistantPanel />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AssistantPanel() {
  const findings = useAssistant((s) => s.findings);
  const fixed = useAssistant((s) => s.fixed);
  const heard = useAssistant((s) => s.samples.filter((x) => x.decks.some((d) => d.on) && x.lufs > -50).length);
  const targetId = useStudio((s) => s.target);
  const need = RATE * 3;
  const fixedNames = Object.keys(fixed);
  return (
    <>
      <div className="flex items-start gap-2 border-b border-white/[0.06] p-3">
        <Stethoscope size={16} className="mt-0.5 text-violet-300" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-zinc-100">Mix assistant</div>
          <div className="leading-snug text-zinc-400">Listens to the last {WINDOW_S} seconds of your mix and tells you what would make it sound better.</div>
        </div>
        <Popover.Close asChild>
          <button type="button" className="rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200" aria-label="Close">
            <X size={14} />
          </button>
        </Popover.Close>
      </div>
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-zinc-400">Loudness target</span>
        <select value={targetId} onChange={(e) => useStudio.getState().set({ target: e.target.value })} className="h-6 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none" aria-label="Loudness target">
          {LOUDNESS_TARGETS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.lufs} LUFS)
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {fixedNames.length > 0 && findings.length === 0 && <div className="flex items-center gap-1.5 text-emerald-300"><Check size={13} /> Fix applied. Listening again…</div>}
        {findings.length === 0 && (
          <div className="space-y-2">
            <div className="text-zinc-300">{heard === 0 ? "Play some music with a fader up to start." : "Listening…"}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full bg-violet-400 transition-[width]" style={{ width: `${Math.min(100, (heard / need) * 100)}%` }} />
            </div>
          </div>
        )}
        {findings.map((f) => (
          <FindingCard key={f.id} f={f} />
        ))}
        {findings.length > 0 && findings.every((f) => f.level === "good") && <div className="text-emerald-300">Nothing to fix right now. Keep mixing and this list updates as you go.</div>}
      </div>
    </>
  );
}

function FindingCard({ f }: { f: Finding }) {
  const Icon = f.level === "problem" ? AlertTriangle : f.level === "tip" ? Lightbulb : Check;
  return (
    <div
      className={clsx(
        "rounded-lg border p-2.5",
        f.level === "problem" ? "border-red-400/25 bg-red-500/[0.06]" : f.level === "tip" ? "border-amber-400/20 bg-amber-500/[0.05]" : "border-emerald-400/20 bg-emerald-500/[0.05]",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon size={14} className={clsx("mt-0.5 shrink-0", f.level === "problem" ? "text-red-300" : f.level === "tip" ? "text-amber-300" : "text-emerald-300")} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-zinc-100">{f.title}</div>
          <div className="mt-0.5 leading-snug text-zinc-400">{f.why}</div>
          {(f.fix || f.concept) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {f.fix && (
                <Btn size="sm" tone="accent" onClick={() => void applyFix(f)}>
                  <Wand2 size={12} /> {f.fix.label}
                </Btn>
              )}
              {f.concept && (
                <Btn size="sm" tone="ghost" onClick={() => openConcept(f.concept!)}>
                  <BookOpen size={12} /> Learn why
                </Btn>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
