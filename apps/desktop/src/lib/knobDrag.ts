// The maths behind dragging knobs and faders, kept free of React and the DOM so it can be
// tested on its own. Everything works on the control's position from 0 to 1 (what the
// arc shows), not on its value, so a bipolar knob with uneven halves still moves evenly.

/** How a knob follows the pointer. */
export type KnobDragMode = "linear" | "aim" | "turn";

export const KNOB_DRAG_MODES: { value: KnobDragMode; label: string; hint: string }[] = [
  { value: "linear", label: "Up and down", hint: "Drag up or right to turn it up, down or left to turn it down." },
  { value: "aim", label: "Aim", hint: "The knob points at wherever you pull it. Pull farther away for finer control." },
  { value: "turn", label: "Turn", hint: "Circle around the knob like turning a real one." },
];

/** The arc: from 135° left of straight up, clockwise through 270°. */
export const START_DEG = -135;
export const SWEEP_DEG = 270;

/** Fine adjust (Shift or ⌘) moves this much slower. */
export const FINE = 0.2;

/** Pixels of linear travel for the whole range, from the knob's size. */
export function knobTravel(size: number) {
  return Math.max(120, Math.min(200, size * 5));
}

/** Pixels the pointer must move before a drag changes anything, so a click never does. */
export const DEAD_PX = 3;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Position (0–1) ↔ value, with an optional default that sits in the middle of the arc. */
export function scale(min: number, max: number, def: number, bipolar: boolean) {
  const split = bipolar && def > min && def < max;
  return {
    toPos(v: number) {
      if (split) return v < def ? 0.5 * ((v - min) / (def - min)) : 0.5 + 0.5 * ((v - def) / (max - def));
      return clamp01((v - min) / (max - min));
    },
    toValue(p: number) {
      p = clamp01(p);
      if (split) return p < 0.5 ? min + (p / 0.5) * (def - min) : def + ((p - 0.5) / 0.5) * (max - def);
      return min + p * (max - min);
    },
  };
}

/**
 * A relative drag (linear or turn) with a soft notch at the default: the control stops
 * there for a short stretch of travel, then carries on. You can feel it and push through,
 * instead of being pulled onto it.
 *
 * `raw` runs along the travel with the notch stretched out: [0, def] maps to itself,
 * [def, def + notch] holds the default, the rest is shifted back by `notch`.
 */
export class RelativeDrag {
  private raw: number;
  constructor(
    start: number,
    private readonly def: number | null,
    private readonly notch: number,
  ) {
    this.raw = def !== null && start > def ? start + notch : start;
  }

  get pos() {
    const { raw, def, notch } = this;
    if (def === null) return raw;
    if (raw <= def) return raw;
    if (raw <= def + notch) return def;
    return raw - notch;
  }

  /** Moves by `delta` (in positions) and returns the new position. */
  move(delta: number) {
    const top = this.def === null ? 1 : 1 + this.notch;
    this.raw = Math.max(0, Math.min(top, this.raw + delta));
    return this.pos;
  }
}

/** Linear: up and right both count as more, so a pull south-west turns it down at full speed. */
export function linearDelta(dx: number, dy: number, travel: number, fine: boolean) {
  return ((dx - dy) / travel) * (fine ? FINE : 1);
}

/** Angle of a point from the centre: 0 straight up, clockwise positive, in (−180, 180]. */
export function angleOf(dx: number, dy: number) {
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

/**
 * Point: the position the knob shows when it points at (dx, dy) from its centre. The gap
 * at the bottom is a wall: a pointer in it keeps the end it came from (`prev` below the
 * middle means the bottom end), so sweeping past the minimum never flips to the maximum.
 */
export function aimPos(dx: number, dy: number, prev: number) {
  const a = angleOf(dx, dy);
  const p = (a - START_DEG) / SWEEP_DEG;
  if (p < 0 || p > 1) return prev < 0.5 ? 0 : 1;
  return p;
}

/** Turn: how far the pointer went round the centre between two points, in positions. */
export function turnDelta(x0: number, y0: number, x1: number, y1: number, fine: boolean) {
  let d = angleOf(x1, y1) - angleOf(x0, y0);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (d / SWEEP_DEG) * (fine ? FINE : 1);
}

/** Close to the centre the angle jumps about; turn ignores the pointer there. */
export const TURN_MIN_RADIUS = 8;

/**
 * A wheel or two-finger swipe, in positions. Swiping up or right turns it up whatever the
 * scroll direction setting (`inverted` is WebKit's "natural scrolling" flag), and the step
 * follows how far the fingers went, so a light swipe makes a small change.
 */
export function wheelDelta(e: { deltaX: number; deltaY: number; deltaMode: number; shiftKey?: boolean; metaKey?: boolean }, inverted: boolean) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dy = e.deltaY * unit;
  const dx = e.deltaX * unit;
  // Natural scrolling: fingers up gives a positive deltaY, fingers right a negative deltaX.
  const up = inverted ? dy - dx : dx - dy;
  // A notched mouse wheel sends about 100 px a click; make that 1/25 of the range.
  const px = Math.max(-120, Math.min(120, up));
  return (px / 2500) * (e.shiftKey || e.metaKey ? FINE : 1);
}

/** The number shown in the value bubble when a control has no format of its own. */
export function defaultReadout(pos: number, bipolar: boolean) {
  if (bipolar) {
    const p = Math.round((pos - 0.5) * 200);
    return p === 0 ? "Centre" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`;
  }
  return `${Math.round(pos * 100)}%`;
}
