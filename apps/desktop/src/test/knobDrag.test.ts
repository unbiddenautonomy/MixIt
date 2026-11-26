import { describe, expect, it } from "vitest";
import { knobAt } from "../components/ui/drag";
import { FINE, RelativeDrag, aimPos, angleOf, defaultReadout, knobTravel, linearDelta, scale, turnDelta, wheelDelta } from "../lib/knobDrag";

describe("knob drag maths", () => {
  it("maps values to the arc and back, with a bipolar default straight up", () => {
    const eq = scale(-26, 6, 0, true);
    expect(eq.toPos(0)).toBe(0.5);
    expect(eq.toPos(-26)).toBe(0);
    expect(eq.toPos(6)).toBe(1);
    expect(eq.toPos(-13)).toBeCloseTo(0.25, 9);
    for (const v of [-26, -20, -3, 0, 2.5, 6]) expect(eq.toValue(eq.toPos(v))).toBeCloseTo(v, 9);
    const plain = scale(0, 1, 0.5, false);
    expect(plain.toPos(0.25)).toBe(0.25);
    expect(plain.toValue(2)).toBe(1);
  });

  it("counts up and right as more, so pulling south-west turns it down at full speed", () => {
    const t = 150;
    expect(linearDelta(0, -150, t, false)).toBe(1); // straight up: the whole range
    expect(linearDelta(150, 0, t, false)).toBe(1); // straight right: the same
    expect(linearDelta(-50, 50, t, false)).toBeCloseTo(-100 / 150, 9); // south-west: both count
    expect(linearDelta(50, 50, t, false)).toBe(0); // south-east cancels out
    expect(linearDelta(0, -150, t, true)).toBeCloseTo(FINE, 9);
  });

  it("gives small knobs a shorter travel and big ones a longer one, within limits", () => {
    expect(knobTravel(22)).toBe(120);
    expect(knobTravel(30)).toBe(150);
    expect(knobTravel(60)).toBe(200);
  });

  it("fine adjust changes speed from the moment it is pressed, without a jump", () => {
    const d = new RelativeDrag(0.3, null, 0);
    d.move(linearDelta(0, -30, 150, false)); // +0.2
    expect(d.pos).toBeCloseTo(0.5, 9);
    d.move(linearDelta(0, -30, 150, true)); // Shift down: +0.04
    expect(d.pos).toBeCloseTo(0.54, 9);
    d.move(linearDelta(0, -15, 150, false)); // Shift up: +0.1
    expect(d.pos).toBeCloseTo(0.64, 9);
  });

  it("stops at the ends and answers straight away when you come back", () => {
    const d = new RelativeDrag(0.9, null, 0);
    d.move(0.5);
    expect(d.pos).toBe(1);
    d.move(-0.1);
    expect(d.pos).toBeCloseTo(0.9, 9);
  });

  it("holds the default for a short stretch, then lets you push through", () => {
    const notch = 0.04;
    const d = new RelativeDrag(0.4, 0.5, notch);
    expect(d.move(0.1)).toBeCloseTo(0.5, 9);
    expect(d.move(0.03)).toBeCloseTo(0.5, 9); // still in the notch
    expect(d.move(0.03)).toBeCloseTo(0.52, 9); // through it
    expect(d.move(-0.1)).toBeCloseTo(0.46, 9); // and back across
    // Starting above the default works the same way going down.
    const up = new RelativeDrag(0.8, 0.5, notch);
    expect(up.pos).toBeCloseTo(0.8, 9);
    expect(up.move(-0.32)).toBeCloseTo(0.5, 9);
    expect(up.move(-0.04)).toBeCloseTo(0.48, 9);
    // The ends are still reachable.
    expect(new RelativeDrag(0.5, 0.5, notch).move(5)).toBe(1);
    expect(new RelativeDrag(0.5, 0.5, notch).move(-5)).toBe(0);
  });

  it("measures angles from straight up, clockwise", () => {
    expect(angleOf(0, -10)).toBeCloseTo(0, 9);
    expect(angleOf(10, 0)).toBeCloseTo(90, 9);
    expect(angleOf(-10, 0)).toBeCloseTo(-90, 9);
    expect(Math.abs(angleOf(0, 10))).toBeCloseTo(180, 9);
  });

  it("aim points the knob at the pointer, and the bottom gap is a wall", () => {
    expect(aimPos(-10, 10, 0.5)).toBeCloseTo(0, 9); // south-west: the minimum
    expect(aimPos(0, -10, 0.2)).toBeCloseTo(0.5, 9); // straight up: the middle
    expect(aimPos(10, 0, 0.5)).toBeCloseTo((90 + 135) / 270, 9); // east
    expect(aimPos(10, 10, 0.5)).toBeCloseTo(1, 9); // south-east: the maximum
    // Straight down sits in the gap: keep the end you came from.
    expect(aimPos(0.01, 10, 0.05)).toBe(0);
    expect(aimPos(-0.01, 10, 0.95)).toBe(1);
  });

  it("turn follows the pointer round the centre, across the bottom too", () => {
    expect(turnDelta(0, -10, 10, 0, false)).toBeCloseTo(90 / 270, 9);
    expect(turnDelta(10, 0, 0, -10, false)).toBeCloseTo(-90 / 270, 9);
    // From just left of straight down to just right of it is a small step back, not a full turn.
    expect(turnDelta(-1, 10, 1, 10, false)).toBeLessThan(0);
    expect(Math.abs(turnDelta(-1, 10, 1, 10, false))).toBeLessThan(0.05);
    expect(turnDelta(0, -10, 10, 0, true)).toBeCloseTo((90 / 270) * FINE, 9);
  });

  it("turns up when the fingers go up, whichever way scrolling is set", () => {
    // Natural scrolling (WebKit marks it inverted): fingers up give a positive deltaY.
    expect(wheelDelta({ deltaX: 0, deltaY: 10, deltaMode: 0 }, true)).toBeGreaterThan(0);
    // Classic: a wheel turned away from you gives a negative deltaY.
    expect(wheelDelta({ deltaX: 0, deltaY: -10, deltaMode: 0 }, false)).toBeGreaterThan(0);
    // A light swipe is a small step, a wheel click a bigger one, and nothing flies off.
    const light = wheelDelta({ deltaX: 0, deltaY: -2, deltaMode: 0 }, false);
    const click = wheelDelta({ deltaX: 0, deltaY: -100, deltaMode: 0 }, false);
    expect(light).toBeLessThan(0.002);
    expect(click).toBeCloseTo(0.04, 9);
    expect(wheelDelta({ deltaX: 0, deltaY: -3, deltaMode: 1 }, false)).toBeCloseTo(48 / 2500, 9);
    expect(wheelDelta({ deltaX: 0, deltaY: -5000, deltaMode: 0 }, false)).toBeCloseTo(120 / 2500, 9);
    expect(wheelDelta({ deltaX: 0, deltaY: -100, deltaMode: 0, shiftKey: true }, false)).toBeCloseTo(0.04 * FINE, 9);
  });

  it("says the value in the bubble", () => {
    expect(defaultReadout(0.42, false)).toBe("42%");
    expect(defaultReadout(0.5, true)).toBe("Centre");
    expect(defaultReadout(0.25, true)).toBe("−50%");
    expect(defaultReadout(1, true)).toBe("+100%");
  });
});

describe("the grab ring", () => {
  const knob = (x: number, y: number, size = 24) => ({ rect: { left: x - size / 2, top: y - size / 2, width: size, height: size }, radius: size / 2 });

  it("grabs a knob a few pixels outside its drawing", () => {
    expect(knobAt(100 + 12 + 6, 100, [knob(100, 100)])).toBe(0);
    expect(knobAt(100 + 12 + 10, 100, [knob(100, 100)])).toBeNull();
  });

  it("picks the nearest knob when two rings meet, so they never share a spot", () => {
    const two = [knob(100, 100), knob(130, 100)];
    expect(knobAt(114, 100, two)).toBe(0);
    expect(knobAt(116, 100, two)).toBe(1);
  });

  it("ignores knobs that are hidden", () => {
    expect(knobAt(0, 0, [{ rect: { left: 0, top: 0, width: 0, height: 0 }, radius: 12 }])).toBeNull();
  });
});
