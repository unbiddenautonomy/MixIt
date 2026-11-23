// The coach: one plain-language tip at a time about what is happening on the decks,
// with a button that does the suggested thing.
import clsx from "clsx";
import { CheckCircle2, ChevronLeft, ChevronRight, GraduationCap, Info, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { runCommand, updateSettings } from "../../lib/appCommands";
import { coachTips, type Tip } from "../../lib/coach";
import { setSecondsLeft, useSetClock } from "../../lib/setClock";
import { useApp } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { Btn } from "../ui/Button";

export function Coach() {
  const on = useApp((s) => s.settings?.coach ?? true);
  const [tips, setTips] = useState<Tip[]>([]);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Twice a second is plenty for advice, and keeps React out of the 60 Hz path.
  useEffect(() => {
    if (!on) return;
    const tick = () => {
      const s = useApp.getState();
      const t = useTelemetry.getState().t;
      setTips(coachTips(t, s.decks, s.mixer, s.settings?.decks ?? 2, setSecondsLeft(useSetClock.getState().endsAt)));
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [on]);

  if (!on) return null;
  const visible = tips.filter((t) => !dismissed.has(t.id));
  if (visible.length === 0) return null;
  const i = Math.min(index, visible.length - 1);
  const tip = visible[i];
  const Icon = tip.level === "warn" ? TriangleAlert : tip.level === "good" ? CheckCircle2 : Info;
  return (
    <div
      className={clsx(
        // A calm neutral bar: only the left edge and the icon carry the tip's colour, so a tip
        // reads as a hint rather than an alarm next to the decks.
        "flex h-10 shrink-0 items-center gap-2.5 rounded-xl border border-l-2 border-white/[0.06] bg-zinc-900/60 px-3 text-[13px] text-zinc-200",
        tip.level === "warn" ? "border-l-amber-400/70" : tip.level === "good" ? "border-l-emerald-400/70" : "border-l-sky-400/60",
      )}
      role="status"
      data-testid="coach"
    >
      <GraduationCap size={15} className="shrink-0 text-zinc-500" />
      <Icon size={14} className={clsx("shrink-0", tip.level === "warn" ? "text-amber-400" : tip.level === "good" ? "text-emerald-400" : "text-sky-400")} />
      <span className="min-w-0 flex-1 truncate">{tip.text}</span>
      {tip.action && (
        <Btn size="sm" tone="accent" style={{ ["--accent" as string]: tip.level === "warn" ? "#fbbf24" : "#38bdf8" }} onClick={() => runCommand(tip.action!.run, tip.action!.arg)}>
          {tip.action.label}
        </Btn>
      )}
      {visible.length > 1 && (
        <div className="flex items-center text-[11px] opacity-70">
          <button type="button" className="p-0.5 hover:opacity-100" onClick={() => setIndex((i - 1 + visible.length) % visible.length)} aria-label="Previous tip">
            <ChevronLeft size={13} />
          </button>
          <span className="font-mono">
            {i + 1}/{visible.length}
          </span>
          <button type="button" className="p-0.5 hover:opacity-100" onClick={() => setIndex((i + 1) % visible.length)} aria-label="Next tip">
            <ChevronRight size={13} />
          </button>
        </div>
      )}
      <button type="button" className="p-0.5 opacity-50 hover:opacity-100" onClick={() => setDismissed(new Set(dismissed).add(tip.id))} title="Hide this tip" aria-label="Hide tip">
        <X size={13} />
      </button>
      <button type="button" className="text-[11px] opacity-50 hover:opacity-100" onClick={() => updateSettings({ coach: false })}>
        Turn off
      </button>
    </div>
  );
}
