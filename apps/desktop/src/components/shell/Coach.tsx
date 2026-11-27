// The coach: plain-language tips about what is happening on the decks, each with a button
// that does the suggested thing. They wait behind a lightbulb in the top bar, which shows
// how many there are; with "Pop up" a new tip also opens by itself (an info tip closes
// again after 8 seconds, a warning stays until you close it).
import clsx from "clsx";
import * as Popover from "@radix-ui/react-popover";
import { CheckCircle2, ChevronLeft, ChevronRight, Info, Lightbulb, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { runCommand } from "../../lib/appCommands";
import { coachTips, type Tip } from "../../lib/coach";
import { setSecondsLeft, useSetClock } from "../../lib/setClock";
import type { Settings } from "../../backend/types";
import { useApp } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { Btn } from "../ui/Button";
import { Ctl } from "../ui/Ctl";

export type CoachMode = "popup" | "ask" | "off";

/** The coach setting as one of its three choices. */
export function coachMode(s: Pick<Settings, "coach" | "coachPopup"> | null | undefined): CoachMode {
  if (!s || !s.coach) return "off";
  return s.coachPopup ? "popup" : "ask";
}

/** The settings that give each choice. */
export function coachSettings(mode: CoachMode): Pick<Settings, "coach" | "coachPopup"> {
  return { coach: mode !== "off", coachPopup: mode === "popup" };
}

export const COACH_MODES: { value: CoachMode; label: string }[] = [
  { value: "popup", label: "Pop up" },
  { value: "ask", label: "Only when I ask" },
  { value: "off", label: "Off" },
];

/** How long an info tip that opened by itself stays. */
export const COACH_INFO_MS = 8000;

/** Which tips to show: the ones not hidden this session. */
export const visibleTips = (tips: Tip[], hidden: ReadonlySet<string>) => tips.filter((t) => !hidden.has(t.id));

/** The first tip that wasn't there before, which is the one that pops up. */
export function newTip(tips: Tip[], seen: ReadonlySet<string>): Tip | null {
  return tips.find((t) => !seen.has(t.id)) ?? null;
}

export function CoachButton() {
  const mode = useApp((s) => coachMode(s.settings));
  const mixing = useApp((s) => s.workspace === "mix");
  const [tips, setTips] = useState<Tip[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [byItself, setByItself] = useState(false);
  const [index, setIndex] = useState(0);
  const seen = useRef(new Set<string>());

  // Twice a second is plenty for advice, and keeps React out of the 60 Hz path.
  useEffect(() => {
    if (mode === "off") return setTips([]);
    const tick = () => {
      const s = useApp.getState();
      const t = useTelemetry.getState().t;
      setTips(coachTips(t, s.decks, s.mixer, s.settings?.decks ?? 2, setSecondsLeft(useSetClock.getState().endsAt)));
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [mode]);

  const visible = visibleTips(tips, hidden);

  // A tip that is new since the last look pops up, in Pop up mode, while mixing.
  useEffect(() => {
    const fresh = newTip(visible, seen.current);
    // Tips that went away may come back later as news.
    seen.current = new Set([...[...seen.current].filter((id) => tips.some((t) => t.id === id)), ...visible.map((t) => t.id)]);
    if (!fresh || mode !== "popup" || !mixing || open) return;
    setIndex(visible.indexOf(fresh));
    setByItself(true);
    setOpen(true);
  }, [tips, hidden, mode, mixing]); // eslint-disable-line react-hooks/exhaustive-deps

  const i = Math.min(index, Math.max(0, visible.length - 1));
  const tip: Tip | undefined = visible[i];

  // An info tip that opened by itself goes again after a while; a warning waits for you.
  useEffect(() => {
    if (!open || !byItself || !tip || tip.level === "warn") return;
    const id = window.setTimeout(() => setOpen(false), COACH_INFO_MS);
    return () => window.clearTimeout(id);
  }, [open, byItself, tip?.id, tip?.level]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing left to say closes a pop-up that came by itself.
  useEffect(() => {
    if (open && byItself && visible.length === 0) setOpen(false);
  }, [open, byItself, visible.length]);

  if (mode === "off") return null;
  const warn = visible.some((t) => t.level === "warn");
  const Icon = tip?.level === "warn" ? TriangleAlert : tip?.level === "good" ? CheckCircle2 : Info;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setByItself(false);
      }}
    >
      <Ctl id="app.coach" side="bottom">
        <Popover.Trigger asChild>
          <Btn size="sm" tone="ghost" active={open} aria-label={visible.length ? `Coach tips: ${visible.length}` : "Coach tips"} data-testid="coach-button">
            <Lightbulb size={14} className={clsx(visible.length > 0 && (warn ? "text-amber-400" : "text-sky-300"))} />
            {visible.length > 0 && (
              <span className={clsx("rounded-full px-1 font-mono text-[11px] leading-4", warn ? "bg-amber-400/20 text-amber-300" : "bg-sky-400/15 text-sky-300")} data-testid="coach-count">
                {visible.length}
              </span>
            )}
          </Btn>
        </Popover.Trigger>
      </Ctl>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          // A tip that pops up must never take the keyboard away from the decks.
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={clsx(
            "z-50 flex w-80 flex-col gap-2 rounded-xl border border-l-2 border-white/10 bg-zinc-900/95 p-3 text-[13px] text-zinc-200 shadow-2xl backdrop-blur",
            !tip ? "border-l-white/10" : tip.level === "warn" ? "border-l-amber-400/70" : tip.level === "good" ? "border-l-emerald-400/70" : "border-l-sky-400/60",
          )}
          role="status"
          data-testid="coach"
        >
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
            <Lightbulb size={12} />
            <span className="flex-1">Coach</span>
            {visible.length > 1 && (
              <span className="flex items-center normal-case">
                <button type="button" className="p-1 hover:text-zinc-200" onClick={() => (setIndex((i - 1 + visible.length) % visible.length), setByItself(false))} aria-label="Previous tip">
                  <ChevronLeft size={13} />
                </button>
                <span className="font-mono">
                  {i + 1}/{visible.length}
                </span>
                <button type="button" className="p-1 hover:text-zinc-200" onClick={() => (setIndex((i + 1) % visible.length), setByItself(false))} aria-label="Next tip">
                  <ChevronRight size={13} />
                </button>
              </span>
            )}
            <Popover.Close className="p-1 hover:text-zinc-200" aria-label="Close">
              <X size={13} />
            </Popover.Close>
          </div>
          {tip ? (
            <>
              <div className="flex items-start gap-2">
                <Icon size={15} className={clsx("mt-0.5 shrink-0", tip.level === "warn" ? "text-amber-400" : tip.level === "good" ? "text-emerald-400" : "text-sky-400")} />
                <span className="min-w-0 flex-1">{tip.text}</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <button type="button" className="text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => setHidden(new Set(hidden).add(tip.id))} title="Don't show this tip again until MixIt restarts">
                  Hide this tip
                </button>
                {tip.action && (
                  <Btn size="sm" tone="accent" style={{ ["--accent" as string]: tip.level === "warn" ? "#fbbf24" : "#38bdf8" }} onClick={() => runCommand(tip.action!.run, tip.action!.arg)}>
                    {tip.action.label}
                  </Btn>
                )}
              </div>
            </>
          ) : (
            <p className="text-zinc-400">Nothing to point out right now. Tips show up here when MixIt hears something worth knowing, like two keys that clash.</p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
