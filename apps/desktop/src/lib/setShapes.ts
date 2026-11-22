// The energy shapes a built set can follow (the same curves as mixit-library's
// setbuild.rs), with their names and plain-language descriptions.
import type { SetShape } from "../backend/types";

export const SET_SHAPES: { id: SetShape; label: string; about: string }[] = [
  { id: "warmUp", label: "Warm-up", about: "Opening a night: calm, rising gently so the room settles in." },
  { id: "build", label: "Build to the peak", about: "From easy to full power, holding the peak at the end." },
  { id: "peak", label: "Peak time", about: "High energy all the way, with a short breather in the middle." },
  { id: "journey", label: "Journey", about: "Up to a peak about two-thirds in, then back down." },
  { id: "coolDown", label: "Cool-down", about: "From high to calm, to close a night." },
  { id: "steady", label: "Steady", about: "About the same energy throughout." },
];

const lerp = (a: number, b: number, x: number) => a + (b - a) * Math.min(1, Math.max(0, x));

/** Target energy (1..10) at `t` (0 = start, 1 = end). `steady` is the level a steady set keeps. */
export function shapeTarget(shape: SetShape, t: number, steady = 6): number {
  t = Math.min(1, Math.max(0, t));
  switch (shape) {
    case "warmUp":
      return lerp(3, 6, t);
    case "build":
      return lerp(4, 9, t / 0.85);
    case "peak":
      return t >= 0.45 && t < 0.6 ? 7 : lerp(7.5, 9, t / 0.3);
    case "journey":
      return t < 0.65 ? lerp(4, 9, t / 0.65) : lerp(9, 5, (t - 0.65) / 0.35);
    case "coolDown":
      return lerp(8, 3, t);
    case "steady":
      return steady;
  }
}
