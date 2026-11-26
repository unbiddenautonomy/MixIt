// Three beat-synced effect slots per deck. Easy view shows type, on and amount; Pro adds
// the beat length and two parameters per effect.
import clsx from "clsx";
import { Power } from "lucide-react";
import { choose, setOn, setValue } from "../../lib/actions";
import { FX_BEAT_LABELS, fxUnitName, useApp, usePro } from "../../store/app";
import { Ctl } from "../ui/Ctl";
import { Knob } from "../ui/Knob";

/** What p1 and p2 mean for each effect type (index matches the engine's FX list). */
const PARAMS: Record<string, [string, string]> = {
  Echo: ["Feedback", "Tone"],
  "Ping-pong delay": ["Feedback", "Width"],
  Reverb: ["Size", "Damping"],
  "Filter LFO": ["Depth", "Resonance"],
  Flanger: ["Depth", "Feedback"],
  Phaser: ["Depth", "Feedback"],
  Chorus: ["Depth", "Voices"],
  Gater: ["Depth", "Shape"],
  Slicer: ["Pattern", "Smooth"],
  "Beat repeat": ["Decay", "Pitch"],
  Bitcrusher: ["Bits", "Rate"],
  Distortion: ["Drive", "Tone"],
  "Tape stop": ["Curve", "Pitch"],
  "Pitch delay": ["Pitch", "Feedback"],
  "Ring modulator": ["Frequency", "Spread"],
  "Noise riser": ["Colour", "Sweep"],
  "Dub echo": ["Feedback", "Saturation"],
};

/** One FX unit: `unit` 0 to 3 is a deck's, MASTER_FX the effects on the whole mix. */
export function FxUnit({ unit, stacked }: { unit: number; stacked?: boolean }) {
  const pro = usePro();
  const slots = useApp((s) => s.mixer.fx[unit]);
  const types = useApp((s) => s.fxTypes);
  const L = fxUnitName(unit);
  return (
    <div className="flex flex-col gap-1">
      {slots.map((f, i) => {
        const base = `fx.${L}.${i + 1}`;
        const name = types[f.type] ?? "None";
        const params = PARAMS[name] ?? ["Param 1", "Param 2"];
        return (
          <div key={i} className={clsx("flex items-center gap-2 rounded-lg border px-2 py-1", stacked && "flex-wrap", f.on ? "border-[var(--accent)]/40 bg-[var(--accent)]/[0.06]" : "border-white/[0.06] bg-white/[0.02]")}>
            <Ctl id={`${base}.on`}>
              <button
                type="button"
                aria-label={`FX ${i + 1} on`}
                onClick={() => setOn(`${base}.on`, !f.on)}
                disabled={f.type === 0}
                className={clsx("flex size-6 items-center justify-center rounded-md border transition-colors disabled:opacity-30", f.on ? "border-transparent bg-[var(--accent)] text-zinc-950" : "border-white/10 text-zinc-400 hover:text-zinc-100")}
              >
                <Power size={12} />
              </button>
            </Ctl>
            <Ctl id={`${base}.type`}>
              <select
                value={f.type}
                onChange={(e) => choose(`${base}.type`, Number(e.target.value))}
                className="h-6 w-28 rounded-md border border-white/10 bg-zinc-900 px-1 text-[11px] text-zinc-200 outline-none focus:border-[var(--accent)]"
              >
                {types.map((t, j) => (
                  <option key={j} value={j}>
                    {t}
                  </option>
                ))}
              </select>
            </Ctl>
            {pro && (
              <Ctl id={`${base}.beats`}>
                <select
                  value={f.beats}
                  onChange={(e) => choose(`${base}.beats`, Number(e.target.value))}
                  className="h-6 w-14 rounded-md border border-white/10 bg-zinc-900 px-1 font-mono text-[11px] text-zinc-300 outline-none"
                  title="Effect length in beats"
                >
                  {FX_BEAT_LABELS.map((b, j) => (
                    <option key={j} value={j}>
                      {b}
                    </option>
                  ))}
                </select>
              </Ctl>
            )}
            <div className={clsx("flex items-center gap-2.5", stacked && pro ? "w-full justify-around" : "ml-auto")}>
              <Ctl id={`${base}.mix`}>
                <Knob value={f.mix} min={0} max={1} def={0.5} size={30} label={stacked && pro ? "Amount" : undefined} readout={(v) => `Amount ${Math.round(v * 100)}%`} onChange={(v) => setValue(`${base}.mix`, v)} />
              </Ctl>
              {pro && (
                <>
                  <Ctl id={`${base}.p1`} label={params[0]}>
                    <Knob value={f.p1} min={0} max={1} def={0.5} size={30} label={stacked ? params[0] : undefined} readout={(v) => `${params[0]} ${Math.round(v * 100)}%`} onChange={(v) => setValue(`${base}.p1`, v)} />
                  </Ctl>
                  <Ctl id={`${base}.p2`} label={params[1]}>
                    <Knob value={f.p2} min={0} max={1} def={0.5} size={30} label={stacked ? params[1] : undefined} readout={(v) => `${params[1]} ${Math.round(v * 100)}%`} onChange={(v) => setValue(`${base}.p2`, v)} />
                  </Ctl>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
