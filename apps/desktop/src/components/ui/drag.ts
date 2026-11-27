// Shared pointer handling for knobs and faders.
//
// - The control keeps the pointer from press to release (pointer capture), wherever it
//   goes; Esc cancels the drag and puts the value back.
// - Shift or ⌘ is fine adjust, and pressing or letting go of it mid-drag carries on from
//   where the control is (moves are added one at a time, never re-scaled afterwards).
// - Knobs follow the "Knob drag" setting: up and down (up or right is more), aim (point
//   at where you want it) or turn (circle round it).
// - Double-click or Option-click resets; the default is a soft notch you can push through.
// - A wheel or two-finger swipe follows the fingers, stops the page scrolling behind, and
//   only takes a scroll that started on the control.
// - Knobs can be grabbed a little outside their drawing (see the ring below), and show
//   their value in a bubble while they change.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEAD_PX,
  FINE,
  RelativeDrag,
  TURN_MIN_RADIUS,
  aimPos,
  type KnobDragMode,
  knobTravel,
  linearDelta,
  scale,
  turnDelta,
  wheelDelta,
} from "../../lib/knobDrag";

export interface ValueDragOptions {
  value: number;
  min: number;
  max: number;
  def: number;
  bipolar?: boolean;
  onChange: (v: number) => void;
  onRelease?: () => void;
  /** A knob of this size (px), dragged the given way. */
  knob?: { size: number; mode: KnobDragMode };
  /** A fader: its travel in pixels and direction. */
  fader?: { travel: number; axis: "x" | "y" };
  /** Called on press, before dragging; returns a value to jump to first (a click on a fader's track). */
  onPress?: (e: PointerEvent, el: HTMLElement) => number | undefined;
}

interface DragState {
  pointerId: number;
  /** Where the press was, and the control's centre. */
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  lastX: number;
  lastY: number;
  /** What to go back to on Esc. */
  startValue: number;
  engaged: boolean;
  pos: number;
  rel: RelativeDrag;
}

/** Notch at the default, in pixels of travel (linear) or degrees (turn). */
const NOTCH_PX = 6;
const NOTCH_DEG = 5;
/** How long the bubble stays after the last change. */
const BUBBLE_MS = 700;
/** A wheel gesture is one stream of events with gaps shorter than this. */
const WHEEL_GAP_MS = 220;

const fine = (e: { shiftKey: boolean; metaKey: boolean }) => e.shiftKey || e.metaKey;

export function useValueDrag(opts: ValueDragOptions) {
  const live = useRef(opts);
  live.current = opts;
  const elRef = useRef<HTMLElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const wheel = useRef<{ t: number; rel: RelativeDrag } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyTimer = useRef<number | undefined>(undefined);

  const flash = useCallback((on: boolean) => {
    window.clearTimeout(busyTimer.current);
    if (on) setBusy(true);
    else busyTimer.current = window.setTimeout(() => setBusy(false), BUBBLE_MS);
  }, []);

  const tools = () => {
    const o = live.current;
    const sc = scale(o.min, o.max, o.def, !!o.bipolar);
    const defPos = sc.toPos(o.def);
    const hasNotch = defPos > 0.001 && defPos < 0.999;
    return { o, sc, defPos, hasNotch };
  };

  const emit = (pos: number) => {
    const { o, sc } = tools();
    const v = sc.toValue(pos);
    if (v !== o.value) o.onChange(v);
  };

  const notchFor = (o: ValueDragOptions) => {
    if (o.knob?.mode === "turn") return NOTCH_DEG / 270;
    const travel = o.knob ? knobTravel(o.knob.size) : (o.fader?.travel ?? 160);
    return NOTCH_PX / travel;
  };

  const end = useCallback(
    (cancel: boolean) => {
      const s = drag.current;
      if (!s) return;
      drag.current = null;
      window.removeEventListener("keydown", onEscape, true);
      delete document.documentElement.dataset.controlDrag;
      try {
        elRef.current?.releasePointerCapture(s.pointerId);
      } catch {
        /* already released */
      }
      if (cancel) live.current.onChange(s.startValue);
      live.current.onRelease?.();
      flash(false);
    },
    [],
  );

  // A stable Esc handler for the window while a drag is on.
  const onEscape = useRef((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    endRef.current(true);
  }).current;
  const endRef = useRef(end);
  endRef.current = end;

  const begin = useCallback((e: PointerEvent) => {
    const el = elRef.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const { o, sc, defPos, hasNotch } = tools();
    if (e.altKey) {
      o.onChange(o.def);
      return;
    }
    let value = o.value;
    const jumped = o.onPress?.(e, el);
    if (jumped !== undefined) {
      value = jumped;
      o.onChange(jumped);
    }
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    const pos = sc.toPos(value);
    drag.current = {
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      lastX: e.clientX,
      lastY: e.clientY,
      startValue: o.value,
      engaged: false,
      pos,
      rel: new RelativeDrag(pos, hasNotch ? defPos : null, notchFor(o)),
    };
    window.addEventListener("keydown", onEscape, true);
    // Tooltips stay out of the way while a control is held (see styles.css).
    document.documentElement.dataset.controlDrag = "";
    flash(true);
  }, []);

  const move = (e: PointerEvent) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.pointerId) return;
    // Keep hover effects (tooltips) around the control from waking up mid-drag.
    e.stopPropagation();
    // A button let go outside the window, without an up event reaching us.
    if (e.buttons === 0 && e.pointerType === "mouse") return end(false);
    const { o, defPos, hasNotch } = tools();
    if (!s.engaged) {
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < DEAD_PX) return;
      s.engaged = true;
    }
    const dx = e.clientX - s.lastX;
    const dy = e.clientY - s.lastY;
    let pos = s.pos;
    if (o.fader) {
      const d = o.fader.axis === "y" ? -dy : dx;
      pos = s.rel.move((d / o.fader.travel) * (fine(e) ? FINE : 1));
    } else if (o.knob?.mode === "aim" && !fine(e)) {
      pos = aimPos(e.clientX - s.cx, e.clientY - s.cy, s.pos);
      if (hasNotch && Math.abs(pos - defPos) < 0.012) pos = defPos;
      // Fine adjust then continues from here.
      s.rel = new RelativeDrag(pos, hasNotch ? defPos : null, NOTCH_DEG / 270);
    } else if (o.knob?.mode === "aim" || o.knob?.mode === "turn") {
      const ax = s.lastX - s.cx;
      const ay = s.lastY - s.cy;
      const bx = e.clientX - s.cx;
      const by = e.clientY - s.cy;
      // Near the centre the angle is unreliable: wait until the pointer is out again.
      if (Math.hypot(bx, by) < TURN_MIN_RADIUS || Math.hypot(ax, ay) < TURN_MIN_RADIUS) {
        s.lastX = e.clientX;
        s.lastY = e.clientY;
        return;
      }
      pos = s.rel.move(turnDelta(ax, ay, bx, by, fine(e)));
    } else {
      pos = s.rel.move(linearDelta(dx, dy, knobTravel(o.knob?.size ?? 32), fine(e)));
    }
    s.lastX = e.clientX;
    s.lastY = e.clientY;
    s.pos = pos;
    emit(pos);
  };

  const onWheel = (e: WheelEvent) => {
    const el = elRef.current;
    if (!el || drag.current) return;
    // Only a scroll that started on this control turns it; one passing over scrolls the page.
    if (wheelGesture.target !== el) return;
    e.preventDefault();
    const { o, sc, defPos, hasNotch } = tools();
    const now = performance.now();
    if (!wheel.current || now - wheel.current.t > WHEEL_GAP_MS) {
      wheel.current = { t: now, rel: new RelativeDrag(sc.toPos(o.value), hasNotch ? defPos : null, 0.015) };
    }
    wheel.current.t = now;
    const inverted = !!(e as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean }).webkitDirectionInvertedFromDevice;
    emit(wheel.current.rel.move(wheelDelta(e, inverted)));
    flash(true);
    flash(false);
  };

  // Native listeners: the wheel must not be passive (to stop the page scrolling), and the
  // ring can start a drag from outside the element.
  const ref = useCallback((el: HTMLElement | null) => {
    const old = elRef.current;
    if (old === el) return;
    if (old) {
      old.removeEventListener("pointerdown", onDown);
      old.removeEventListener("pointermove", onMove);
      old.removeEventListener("pointerup", onUp);
      old.removeEventListener("pointercancel", onUp);
      old.removeEventListener("lostpointercapture", onUp);
      old.removeEventListener("wheel", onWheelRef);
      unregister(old);
    }
    elRef.current = el;
    if (el) {
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
      el.addEventListener("lostpointercapture", onUp);
      el.addEventListener("wheel", onWheelRef, { passive: false });
      registerWheel(el);
      if (live.current.knob) register(el, (e) => beginRef.current(e), () => (live.current.knob?.size ?? 0) / 2);
    }
  }, []);

  // Handlers bound once; they call through refs so they always see the latest props.
  const moveRef = useRef(move);
  moveRef.current = move;
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const onDown = useRef((e: PointerEvent) => beginRef.current(e)).current;
  const onMove = useRef((e: PointerEvent) => moveRef.current(e)).current;
  const onUp = useRef((e: PointerEvent) => {
    if (drag.current && e.pointerId === drag.current.pointerId) endRef.current(false);
  }).current;
  const onWheelRef = useRef((e: WheelEvent) => wheelRef.current(e)).current;

  useEffect(
    () => () => {
      endRef.current(false);
      window.clearTimeout(busyTimer.current);
      if (elRef.current) unregister(elRef.current);
    },
    [],
  );

  const handlers = {
    onDoubleClick() {
      live.current.onChange(live.current.def);
    },
    onKeyDown(e: React.KeyboardEvent) {
      const { o, sc } = tools();
      const step = e.shiftKey || e.metaKey ? 1 / 200 : 1 / 40;
      const p = sc.toPos(o.value);
      let next: number | null = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") next = p + step;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = p - step;
      else if (e.key === "Home") next = sc.toPos(o.def);
      if (next === null) return;
      e.preventDefault();
      emit(Math.max(0, Math.min(1, next)));
      flash(true);
      flash(false);
    },
  };

  return { ref, handlers, busy };
}

// ---------------------------------------------------------------------------------------
// The grab ring. A press on empty space (not a button, field or other control) within a
// few pixels of a knob grabs the nearest knob, so the small ones are easier to hit and two
// knobs never fight over the same spot.

export const RING_PX = 8;

const knobs = new Map<HTMLElement, { begin: (e: PointerEvent) => void; radius: () => number }>();
const INTERACTIVE = "button, a, input, select, textarea, label, canvas, [role=slider], [role=button], [role=tab], [contenteditable=true], [data-no-knob-ring]";

function register(el: HTMLElement, begin: (e: PointerEvent) => void, radius: () => number) {
  knobs.set(el, { begin, radius });
  installDocumentListeners();
}

function unregister(el: HTMLElement) {
  knobs.delete(el);
  wheelTargets.delete(el);
}

/** The knob whose ring holds the point, nearest centre first, or null. */
export function knobAt(x: number, y: number, entries: Iterable<{ rect: { left: number; top: number; width: number; height: number }; radius: number }>, ring = RING_PX) {
  let best: number | null = null;
  let bestD = Infinity;
  let i = 0;
  for (const k of entries) {
    const { rect, radius } = k;
    if (rect.width > 0) {
      const d = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
      if (d <= radius + ring && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    i++;
  }
  return best;
}

// Wheel gestures: which control the current stream of wheel events started on.
const wheelTargets = new Set<HTMLElement>();
const wheelGesture: { t: number; target: HTMLElement | null } = { t: -Infinity, target: null };

function registerWheel(el: HTMLElement) {
  wheelTargets.add(el);
  installDocumentListeners();
}

let installed = false;
function installDocumentListeners() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "wheel",
    (e) => {
      const now = performance.now();
      if (now - wheelGesture.t > WHEEL_GAP_MS) {
        let target: HTMLElement | null = null;
        for (let n = e.target as Node | null; n; n = n.parentNode) {
          if (wheelTargets.has(n as HTMLElement)) {
            target = n as HTMLElement;
            break;
          }
        }
        wheelGesture.target = target;
      }
      wheelGesture.t = now;
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || knobs.size === 0) return;
      const t = e.target as Element | null;
      if (!t || t.closest?.(INTERACTIVE)) return;
      const list = [...knobs.entries()];
      const i = knobAt(
        e.clientX,
        e.clientY,
        list.map(([el, k]) => ({ rect: el.getBoundingClientRect(), radius: k.radius() })),
      );
      if (i === null) return;
      e.stopPropagation();
      list[i][1].begin(e);
    },
    { capture: true },
  );
}
