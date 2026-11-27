// The screen's pixel ratio, as React state. Moving a window from a Retina laptop to a
// 1080p monitor changes it without changing any size, so canvases that draw once (rather
// than every frame) list it among their effect's dependencies to redraw sharp.
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  let mq: MediaQueryList | null = null;
  const arm = () => {
    mq?.removeEventListener("change", fire);
    // Matches only the ratio it was made for, so it fires once when the ratio changes; re-arm for the new one.
    mq = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
    mq?.addEventListener("change", fire);
  };
  const fire = () => {
    arm();
    onChange();
  };
  arm();
  return () => mq?.removeEventListener("change", fire);
}

const read = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);

export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, read, () => 1);
}
