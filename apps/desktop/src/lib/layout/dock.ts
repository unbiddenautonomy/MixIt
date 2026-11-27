// Where a dragged part would go, from where the pointer is over another part (Edit layout
// mode). Near an edge it goes beside that part on that side; in the middle it joins it as
// a tab. Plain functions of the pointer and the part's box, so tests can check them.
import type { UnitId } from "./model";
import type { Side } from "./units";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far in from an edge (as a share of the part's size) still means "beside it". */
export const EDGE = 0.25;

/** The side the pointer means over a part's box. */
export function sideAt(x: number, y: number, b: Box): Side {
  const dx = (x - b.left) / Math.max(1, b.width);
  const dy = (y - b.top) / Math.max(1, b.height);
  const near = Math.min(dx, 1 - dx, dy, 1 - dy);
  if (near > EDGE) return "tab";
  if (near === dx) return "left";
  if (near === 1 - dx) return "right";
  return near === dy ? "above" : "below";
}

/**
 * What dropping `dragged` there does: beside or into the stack showing `shown` (holding
 * `units`). Null when it would change nothing, such as a part dropped on its own tab.
 */
export function dropOn(dragged: UnitId, side: Side, units: UnitId[], shown: UnitId): { unit: UnitId; side: Side } | null {
  const inIt = units.includes(dragged);
  if (side === "tab") return inIt ? null : { unit: shown, side };
  // Beside its own stack: only if the stack has something else to stand beside.
  if (shown !== dragged) return { unit: shown, side };
  const other = units.find((u) => u !== dragged);
  return other ? { unit: other, side } : null;
}

/** The part of the box a drop would fill, to draw where it will go. */
export function previewBox(side: Side, b: Box): Box {
  switch (side) {
    case "left":
      return { ...b, width: b.width / 2 };
    case "right":
      return { ...b, left: b.left + b.width / 2, width: b.width / 2 };
    case "above":
      return { ...b, height: b.height / 2 };
    case "below":
      return { ...b, top: b.top + b.height / 2, height: b.height / 2 };
    default:
      return b;
  }
}
