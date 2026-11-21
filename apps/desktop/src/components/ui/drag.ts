// Shared pointer handling for knobs and faders: drag to change, Shift for fine control,
// double-click to reset, wheel to step.
import { useRef } from "react";

export function useValueDrag(opts: {
  value: number;
  min: number;
  max: number;
  def: number;
  onChange: (v: number) => void;
  /** Pixels of travel for the full range. */
  travel?: number;
  axis?: "y" | "x";
  onRelease?: () => void;
}) {
  const start = useRef<{ p: number; v: number } | null>(null);
  const { value, min, max, def, onChange, travel = 160, axis = "y", onRelease } = opts;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return {
    onPointerDown(e: React.PointerEvent) {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      start.current = { p: axis === "y" ? e.clientY : e.clientX, v: value };
      e.preventDefault();
    },
    onPointerMove(e: React.PointerEvent) {
      const s = start.current;
      if (!s) return;
      const d = axis === "y" ? s.p - e.clientY : e.clientX - s.p;
      const fine = e.shiftKey ? 0.15 : 1;
      let v = clamp(s.v + (d / travel) * (max - min) * fine);
      // A gentle detent at the default (centre for EQs and filters).
      if (Math.abs(v - def) < (max - min) * 0.015) v = def;
      onChange(v);
    },
    onPointerUp(e: React.PointerEvent) {
      if (start.current) {
        start.current = null;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        onRelease?.();
      }
    },
    onDoubleClick() {
      onChange(def);
    },
    onWheel(e: React.WheelEvent) {
      const step = (max - min) / (e.shiftKey ? 200 : 50);
      onChange(clamp(value + (e.deltaY < 0 ? step : -step)));
    },
    onKeyDown(e: React.KeyboardEvent) {
      const step = (max - min) / (e.shiftKey ? 200 : 40);
      if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        onChange(clamp(value + step));
        e.preventDefault();
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        onChange(clamp(value - step));
        e.preventDefault();
      } else if (e.key === "Home") onChange(def);
    },
  };
}
