// The beat counter on a deck: a light for each beat of the bar, which bar of the 8-bar
// phrase the music is on, and how many bars until the next part (the drop, the
// breakdown). Mixing on phrases is what makes a transition sound planned.
import clsx from "clsx";
import { phraseInfo } from "../../lib/phrase";
import { SECTION_COLORS } from "../../lib/waveform";
import { useApp } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { Ctl } from "../ui/Ctl";

export function BeatCounter({ deck }: { deck: number }) {
  const detail = useApp((s) => s.decks[deck]?.detail ?? null);
  // A string of primitives, so the deck only redraws when the count changes.
  const sig = useTelemetry((s) => {
    const d = s.t.decks[deck];
    if (!detail || !d?.loaded) return "";
    const p = phraseInfo(detail, d.position);
    if (!p) return "";
    return `${p.beatInBar}|${p.barInPhrase}|${p.next?.label ?? ""}|${p.next?.bars ?? 0}`;
  });
  if (!detail || !sig) return null;
  const [beat, bar, nextLabel, nextBars] = sig.split("|");
  const b = Number(beat);
  const bpb = Math.max(1, detail.beatsPerBar);
  const left = Number(nextBars);
  const soon = nextLabel && left <= 4;
  return (
    <Ctl
      label="Beat counter"
      explain="Dance music comes in 8-bar phrases. The lights count the beats of the bar (red on the first), the number is the bar of the phrase, and below it how long until the next part. Start the next track or swap the bass on bar 1 and it sounds planned."
    >
      <div className="flex flex-col items-end gap-0.5" data-testid={`beat-counter-${deck}`}>
        <div className="flex items-center gap-1.5">
          <div className="flex gap-[3px]">
            {Array.from({ length: Math.min(bpb, 7) }, (_, i) => (
              <span key={i} className={clsx("size-[7px] rounded-full", i === b ? (i === 0 ? "bg-rose-400" : "bg-[var(--accent)]") : "bg-white/10")} />
            ))}
          </div>
          <span className={clsx("font-mono text-[11px] font-semibold tabular-nums", bar === "1" ? "text-rose-300" : "text-zinc-300")} title="Bar of the 8-bar phrase">
            {bar}/8
          </span>
        </div>
        {nextLabel ? (
          <span className={clsx("flex items-center gap-1 text-[10px] leading-none", soon ? "text-zinc-100" : "text-zinc-500")}>
            <span className="size-1.5 rounded-full" style={{ background: SECTION_COLORS[nextLabel] ?? "#71717a" }} />
            {nextLabel} {left <= 1 ? "next bar" : `in ${left} bars`}
          </span>
        ) : (
          <span className="text-[10px] leading-none text-zinc-600">last part</span>
        )}
      </div>
    </Ctl>
  );
}
