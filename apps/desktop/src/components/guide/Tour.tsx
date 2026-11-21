// The first-run walkthrough on screen: a welcome, then one card at a time next to the
// control it is about, then a "you did it" card with where to go next.
import { Disc3, FlaskConical, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../store/app";
import { showControls, useGuide } from "../../guide/model";
import { setupLab } from "../../guide/setup";
import { advance, markSeen, TOUR, useTour } from "../../guide/tour";
import { Btn } from "../ui/Button";

const W = 340;

function stop(how: "done" | "skipped") {
  markSeen(how);
  useTour.getState().set({ phase: null, index: 0 });
  useGuide.getState().set({ focus: [] });
}

export function Tour() {
  const phase = useTour((s) => s.phase);
  if (!phase) return null;
  if (phase === "welcome") return <Welcome />;
  if (phase === "setup") return <Center>Getting two practice tracks ready…</Center>;
  if (phase === "done") return <Done />;
  return <StepCard />;
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
      <div className="pointer-events-auto w-[min(440px,92vw)] rounded-2xl border border-white/10 bg-zinc-900/95 p-5 text-sm text-zinc-300 shadow-2xl backdrop-blur">{children}</div>
    </div>
  );
}

function Welcome() {
  const start = async () => {
    useTour.getState().set({ phase: "setup" });
    const ok = await setupLab(TOUR).catch(() => false);
    if (!ok) {
      useTour.getState().set({ phase: null });
      return;
    }
    useTour.getState().set({ phase: "steps", index: 0 });
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-[2px]" role="dialog" aria-label="Welcome to MixIt">
      <div className="w-[min(460px,92vw)] rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent-ink)]">
          <Disc3 size={22} />
        </div>
        <h2 className="text-lg font-semibold text-zinc-50">Welcome to MixIt</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">In about two minutes you will do your first mix: two tracks playing in time, and a smooth change from one to the other, the way club DJs do it.</p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">MixIt makes a few practice tracks for this and adds them to your library. You can take the tour again any time from the Guide.</p>
        <div className="mt-5 flex items-center gap-2">
          <Btn tone="accent" onClick={start}>
            <Sparkles size={13} /> Show me (2 minutes)
          </Btn>
          <Btn tone="ghost" onClick={() => stop("skipped")}>
            Skip, I know my way around
          </Btn>
        </div>
      </div>
    </div>
  );
}

function StepCard() {
  const index = useTour((s) => s.index);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = TOUR.steps[Math.min(index, TOUR.steps.length - 1)];

  useEffect(() => {
    useGuide.getState().set({ focus: step.controls ?? [] });
    if (useApp.getState().workspace !== "mix") useApp.getState().set({ workspace: "mix" });
    showControls(step.controls ?? [], 2500);
  }, [step]);

  useEffect(() => {
    const tick = () => {
      advance();
      const el = (step.controls ?? []).map((id) => document.querySelector(`[data-action="${CSS.escape(id)}"]`)).find(Boolean) as HTMLElement | undefined;
      const h = card.current?.offsetHeight ?? 160;
      if (!el) return setPos(null);
      const r = el.getBoundingClientRect();
      const below = r.bottom + 14 + h < window.innerHeight;
      const top = below ? r.bottom + 14 : Math.max(12, r.top - 14 - h);
      const left = Math.max(12, Math.min(window.innerWidth - W - 12, r.left + r.width / 2 - W / 2));
      setPos((p) => (p && Math.abs(p.top - top) < 1 && Math.abs(p.left - left) < 1 ? p : { top, left }));
    };
    tick();
    const t = window.setInterval(tick, 200);
    return () => window.clearInterval(t);
  }, [step]);

  return (
    <div
      ref={card}
      className="fixed z-[60] rounded-2xl border border-amber-300/40 bg-zinc-900/95 p-4 text-sm shadow-2xl backdrop-blur transition-[top,left] duration-200"
      style={pos ? { top: pos.top, left: pos.left, width: W } : { bottom: 24, left: `calc(50% - ${W / 2}px)`, width: W }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-amber-300">
          {index + 1} / {TOUR.steps.length}
        </span>
        <div className="flex flex-1 gap-1">
          {TOUR.steps.map((s, i) => (
            <span key={s.id} className={i < index ? "h-1 flex-1 rounded-full bg-amber-300" : i === index ? "h-1 flex-1 rounded-full bg-amber-300/50" : "h-1 flex-1 rounded-full bg-white/10"} />
          ))}
        </div>
        <button type="button" className="rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-200" onClick={() => stop("skipped")} aria-label="End the tour">
          <X size={13} />
        </button>
      </div>
      <div className="mt-2 font-semibold text-zinc-50">{step.title}</div>
      {step.body && <p className="mt-1 leading-snug text-zinc-300">{step.body}</p>}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="flex-1">It moves on by itself when you do it.</span>
        <button type="button" className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100" onClick={() => showControls(step.controls ?? [])}>
          Where?
        </button>
      </div>
    </div>
  );
}

function Done() {
  const openLabs = () => {
    stop("done");
    useApp.getState().set({ guideOpen: true });
    useGuide.getState().set({ tab: "labs", lab: null });
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" role="dialog" aria-label="Your first mix">
      <div className="w-[min(460px,92vw)] rounded-2xl border border-emerald-300/30 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-300">
          <Sparkles size={22} />
        </div>
        <h2 className="text-lg font-semibold text-zinc-50">That was your first blend</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-300">You matched two tracks, brought one in without its bass, swapped the basslines and faded the old one out. That is the most common transition in club music.</p>
        <ul className="mt-3 flex flex-col gap-1.5 text-sm text-zinc-400">
          <li>• Press Mix it between the decks and MixIt does a transition for you, on the beat.</li>
          <li>• Press Rec while you mix: afterwards MixIt tells you how it went.</li>
          <li>• The practice labs teach phrasing, effects, keys and more, one step at a time.</li>
        </ul>
        <div className="mt-5 flex items-center gap-2">
          <Btn tone="accent" onClick={openLabs}>
            <FlaskConical size={13} /> Open the practice labs
          </Btn>
          <Btn tone="ghost" onClick={() => stop("done")}>
            Keep mixing
          </Btn>
        </div>
      </div>
    </div>
  );
}
