import clsx from "clsx";
import { useValueDrag } from "./drag";

export interface KnobProps {
  value: number;
  min: number;
  max: number;
  def?: number;
  onChange: (v: number) => void;
  label?: string;
  size?: number;
  color?: string;
  /** Arc from the default (EQs, filters) instead of from the minimum. */
  bipolar?: boolean;
  format?: (v: number) => string;
  killed?: boolean;
  className?: string;
}

const START = -135;
const SWEEP = 270;

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} ${sweep} ${x1} ${y1}`;
}

export function Knob({ value, min, max, def, onChange, label, size = 40, color = "var(--accent)", bipolar, format, killed, className }: KnobProps) {
  const d = def ?? (bipolar ? (min + max) / 2 : min);
  const h = useValueDrag({ value, min, max, def: d, onChange });
  // Map value to an angle; bipolar knobs put the default straight up.
  const norm = (v: number) => {
    if (bipolar && d > min && d < max) return v < d ? 0.5 * ((v - min) / (d - min)) : 0.5 + 0.5 * ((v - d) / (max - d));
    return (v - min) / (max - min);
  };
  const a = START + SWEEP * norm(value);
  const a0 = bipolar ? START + SWEEP * norm(d) : START;
  const c = size / 2;
  const r = c - 3;
  return (
    <div className={clsx("flex select-none flex-col items-center gap-1", className)}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        className="cursor-ns-resize rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        style={{ width: size, height: size, touchAction: "none" }}
        {...h}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <path d={arc(c, c, r, START, START + SWEEP)} style={{ stroke: "var(--knob-track)" }} strokeWidth={3} fill="none" strokeLinecap="round" />
          {Math.abs(a - a0) > 0.5 && <path d={arc(c, c, r, Math.min(a0, a), Math.max(a0, a))} style={{ stroke: killed ? "#ef4444" : color }} strokeWidth={3} fill="none" strokeLinecap="round" />}
          <circle cx={c} cy={c} r={r - 5} fill="url(#knob-face)" style={{ stroke: "var(--knob-edge)" }} />
          <line x1={c} y1={c} x2={c + (r - 8) * Math.sin((a * Math.PI) / 180)} y2={c - (r - 8) * Math.cos((a * Math.PI) / 180)} style={{ stroke: killed ? "#ef4444" : "var(--knob-pointer)" }} strokeWidth={2} strokeLinecap="round" />
          <defs>
            <radialGradient id="knob-face" cx="40%" cy="35%" r="70%">
              <stop offset="0%" style={{ stopColor: "var(--knob-face-a)" }} />
              <stop offset="100%" style={{ stopColor: "var(--knob-face-b)" }} />
            </radialGradient>
          </defs>
        </svg>
      </div>
      {label && (
        <div className="text-center text-[10px] font-medium uppercase leading-none tracking-wide text-zinc-400">
          {label}
          {format && <div className="mt-0.5 font-mono text-[10px] normal-case tracking-normal text-zinc-500">{format(value)}</div>}
        </div>
      )}
    </div>
  );
}
