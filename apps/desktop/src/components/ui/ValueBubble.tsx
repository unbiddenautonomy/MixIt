// A small readout above a knob or fader while it changes. It sits on the page's top layer
// (a portal) so panels that clip their contents can't cut it off.
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

export function ValueBubble({ anchor, text, show }: { anchor: HTMLElement | null; text: string; show: boolean }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (!show || !anchor) return;
    const r = anchor.getBoundingClientRect();
    setAt({ x: r.left + r.width / 2, y: r.top });
  }, [show, anchor, text]);
  if (!show || !at || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-white/15 bg-zinc-950/95 px-1.5 py-0.5 font-mono text-[11px] leading-tight text-zinc-100 shadow-lg"
      style={{ left: Math.max(24, Math.min(window.innerWidth - 24, at.x)), top: Math.max(22, at.y - 6) }}
    >
      {text}
    </div>,
    document.body,
  );
}
