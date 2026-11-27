// The deck's stems: split the loaded track into vocals, drums, bass and melody, then
// switch each part on and off (Pro adds a level knob for each). The engine does not
// report the levels back, so they come from the store that lib/actions.ts mirrors.
import clsx from "clsx";
import { Scissors, X } from "lucide-react";
import { toast } from "sonner";
import { backend } from "../../backend";
import { setOn, setValue } from "../../lib/actions";
import { STEM_NAMES, STEMS, useApp, usePro, type Stem } from "../../store/app";
import { useDeckTele } from "../../store/telemetry";
import { Btn } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Knob } from "../ui/Knob";

const EXPLAIN: Record<Stem, string> = {
  vocals: "Switch the singing and rapping on or off.",
  drums: "Switch the drums on or off.",
  bass: "Switch the bassline (and the deepest part of the kick) on or off.",
  melody: "Switch everything else on or off: chords, synths, guitars and pads.",
};

export function Stems({ deck, compact = false }: { deck: number; compact?: boolean }) {
  const L = String.fromCharCode(65 + deck);
  const trackId = useApp((s) => s.decks[deck]?.detail.track.id ?? null);
  const has = useDeckTele(deck, (d) => !!d.stems);
  const mute = useApp((s) => s.mixer.stems[deck].mute);
  const level = useApp((s) => s.mixer.stems[deck].level);
  const job = useApp((s) => s.jobs.stems);
  const pro = usePro();
  if (trackId === null) return compact ? null : <p className="py-2 text-[11px] text-zinc-500">Load a track, then split it into vocals, drums, bass and melody to switch each part on and off.</p>;
  const running = !!job && !job.finished;

  if (!has) {
    const split = () => backend().splitStems(trackId).catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    return (
      <div className="flex items-center gap-2" data-testid={`stems-${L}`}>
        {running ? (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-zinc-400">{job.message || "Splitting into stems…"}</div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${job.total ? Math.round((100 * job.done) / job.total) : 0}%` }} />
              </div>
            </div>
            <Btn size="sm" tone="ghost" onClick={() => void backend().cancelStems()} aria-label="Stop splitting">
              <X size={12} /> Stop
            </Btn>
          </>
        ) : (
          <Ctl label="Split into stems" explain="Separate this track into vocals, drums, bass and melody, so you can switch each part on and off. It takes a little while the first time and is remembered after that.">
            <Btn size="sm" tone="ghost" onClick={split} data-testid={`stems-split-${L}`}>
              <Scissors size={12} /> {compact ? "Stems" : "Split into stems"}
            </Btn>
          </Ctl>
        )}
      </div>
    );
  }

  const only = (keep: Stem[]) => STEMS.forEach((s) => void setOn(`deck.${L}.stem.${s}.mute`, !keep.includes(s)));
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`stems-${L}`}>
      {STEMS.map((s, i) => (
        <div key={s} className="flex items-center gap-1">
          <Ctl id={`deck.${L}.stem.${s}.mute`} label={STEM_NAMES[s]} explain={EXPLAIN[s]}>
            <Btn size="sm" active={!mute[i]} onClick={() => setOn(`deck.${L}.stem.${s}.mute`, !mute[i])} className={clsx(mute[i] && "text-zinc-500 line-through")} data-testid={`stem-${L}-${s}`} aria-pressed={!mute[i]}>
              {STEM_NAMES[s]}
            </Btn>
          </Ctl>
          {pro && !compact && (
            <Ctl id={`deck.${L}.stem.${s}`}>
              <Knob value={level[i]} min={0} max={1} def={1} size={22} onChange={(v) => setValue(`deck.${L}.stem.${s}`, v)} />
            </Ctl>
          )}
        </div>
      ))}
      {!compact && (
        <div className="ml-auto flex items-center gap-1">
          <Ctl label="Vocals only" explain="Hear only the vocals: an a cappella to lay over another track.">
            <Btn size="sm" tone="ghost" onClick={() => only(["vocals"])}>
              Vocals only
            </Btn>
          </Ctl>
          <Ctl label="No vocals" explain="Hear the track without its vocals: an instrumental.">
            <Btn size="sm" tone="ghost" onClick={() => only(["drums", "bass", "melody"])}>
              No vocals
            </Btn>
          </Ctl>
          {mute.some(Boolean) && (
            <Ctl label="All parts" explain="Switch every part back on.">
              <Btn size="sm" tone="ghost" onClick={() => only([...STEMS])}>
                All
              </Btn>
            </Ctl>
          )}
        </div>
      )}
    </div>
  );
}
