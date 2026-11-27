import clsx from "clsx";
import { useCallback, useRef } from "react";
import { defaultReadout } from "../../lib/knobDrag";
import { useValueDrag } from "./drag";
import { bubbleText } from "./Knob";
import { ValueBubble } from "./ValueBubble";

export function Fader({ value, min = 0, max = 1, def, onChange, orientation = "vertical", length = 120, color = "var(--accent)", label, className, onRelease, readout }: {
  value: number;
  min?: number;
  max?: number;
  def?: number;
  onChange: (v: number) => void;
  orientation?: "vertical" | "horizontal";
  length?: number;
  color?: string;
  label?: string;
  className?: string;
  onRelease?: () => void;
  /** What the bubble says while it moves (a percentage when left out). */
  readout?: (v: number) => string;
}) {
  const vertical = orientation === "vertical";
  const track = useRef<HTMLDivElement>(null);
  const n = (value - min) / (max - min);
  // A press on the track away from the thumb jumps there first; on the thumb, it just drags.
  const press = (e: PointerEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const span = (vertical ? r.height : r.width) - 16;
    const at = vertical ? r.bottom - 8 - e.clientY : e.clientX - r.left - 8;
    if (Math.abs(at - n * span) <= 10) return undefined;
    return min + Math.max(0, Math.min(1, at / span)) * (max - min);
  };
  const { ref, handlers, busy } = useValueDrag({ value, min, max, def: def ?? (min + max) / 2, onChange, fader: { travel: length - 16, axis: vertical ? "y" : "x" }, onRelease, onPress: press });
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      track.current = el;
      ref(el);
    },
    [ref],
  );
  return (
    <div className={clsx("flex select-none items-center gap-1", vertical ? "flex-col" : "flex-row", className)}>
      <div
        ref={setRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation={orientation}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        {...handlers}
        className="relative cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        style={vertical ? { width: 28, height: length, touchAction: "none" } : { height: 28, width: length, touchAction: "none" }}
      >
        <div className={clsx("pointer-events-none absolute rounded-full bg-black/50 ring-1 ring-white/10", vertical ? "left-1/2 top-2 bottom-2 w-1.5 -translate-x-1/2" : "top-1/2 left-2 right-2 h-1.5 -translate-y-1/2")} />
        <div
          className={clsx("pointer-events-none absolute rounded-full", vertical ? "left-1/2 bottom-2 w-1.5 -translate-x-1/2" : "top-1/2 left-2 h-1.5 -translate-y-1/2")}
          style={vertical ? { height: `calc((100% - 16px) * ${n})`, background: color, opacity: 0.6 } : { width: `calc((100% - 16px) * ${n})`, background: color, opacity: 0.6 }}
        />
        <div
          className={clsx("pointer-events-none absolute rounded-md border border-white/20 bg-gradient-to-b from-zinc-300 to-zinc-500 shadow-md", vertical ? "left-1/2 h-4 w-7 -translate-x-1/2" : "top-1/2 h-7 w-4 -translate-y-1/2")}
          style={vertical ? { bottom: `calc((100% - 16px) * ${n})` } : { left: `calc((100% - 16px) * ${n})` }}
        >
          <div className={clsx("absolute bg-zinc-800", vertical ? "inset-x-1 top-1/2 h-px" : "inset-y-1 left-1/2 w-px")} />
        </div>
      </div>
      <ValueBubble anchor={track.current} show={busy} text={bubbleText(label, readout ? readout(value) : defaultReadout(n, min < 0 && max > 0))} />
      {label && <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</div>}
    </div>
  );
}
