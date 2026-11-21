// The sound editor's steps in plain words, and how a step moves the selection. The
// editing itself happens in the engine (`mixit_dsp::edit`); a sound is its original plus
// this list, so any step can be undone or taken out later.
import type { EditOp, FadeShape } from "../backend/types";

const t = (s: number) => (s < 10 ? `${s.toFixed(2)} s` : s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`);
const span = (a: number, b: number) => `${t(a)} to ${t(b)}`;

export const FADE_SHAPES: { value: FadeShape; label: string; hint: string }[] = [
  { value: "smooth", label: "Smooth", hint: "Eases in and out. Good for most fades." },
  { value: "exponential", label: "Natural", hint: "Even to the ear, like turning a knob steadily. Best for long fade-outs." },
  { value: "power", label: "Equal power", hint: "Keeps the level steady when two fades overlap." },
  { value: "linear", label: "Straight", hint: "A straight line. Sounds quick at the end of a fade-out." },
];

/** A step in plain words, for the list of steps. */
export function describeOp(op: EditOp): string {
  switch (op.op) {
    case "trim":
      return `Kept only ${span(op.start, op.end)}`;
    case "delete":
      return `Removed ${span(op.start, op.end)}`;
    case "copy":
      return `Copied ${span(op.start, op.end)}`;
    case "paste":
      return `Pasted at ${t(op.at)}`;
    case "silence":
      return `Silenced ${span(op.start, op.end)}`;
    case "insertSilence":
      return `Added ${t(op.seconds)} of silence at ${t(op.at)}`;
    case "fade":
      return `Fade ${op.fadeIn ? "in" : "out"} over ${span(op.start, op.end)} (${FADE_SHAPES.find((s) => s.value === op.shape)?.label.toLowerCase() ?? op.shape})`;
    case "gain":
      return `${op.db >= 0 ? "Turned up" : "Turned down"} ${span(op.start, op.end)} by ${Math.abs(op.db).toFixed(1)} dB`;
    case "normalize":
      return op.to === "peak" ? `Made the loudest point ${op.level} dB` : `Set the loudness to ${op.level} LUFS`;
    case "reverse":
      return `Reversed ${span(op.start, op.end)}`;
    case "trimSilence":
      return "Cut the silence at the start and end";
    case "removeDc":
      return "Centred the waveform (removed DC offset)";
  }
}

/** A Copy step merged with the step that follows: Cut is Copy then Delete, and shows as
 * one step. Returns the steps grouped for display: [index of first op, label]. */
export function groupSteps(ops: EditOp[]): { from: number; to: number; label: string }[] {
  const out: { from: number; to: number; label: string }[] = [];
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i];
    const b = ops[i + 1];
    if (a.op === "copy" && b?.op === "delete" && b.start === a.start && b.end === a.end) {
      out.push({ from: i, to: i + 1, label: `Cut ${span(a.start, a.end)}` });
      i++;
    } else out.push({ from: i, to: i, label: describeOp(a) });
  }
  return out;
}

/** The length (seconds) after a step, from the length before it. `clip` is the length on
 * the clipboard at that point. */
export function lengthAfter(op: EditOp, len: number, clip: number): number {
  const c = (x: number) => Math.max(0, Math.min(len, x));
  switch (op.op) {
    case "trim":
      return Math.abs(c(op.end) - c(op.start)) || len;
    case "delete":
      return len - Math.abs(c(op.end) - c(op.start));
    case "paste":
      return len + clip;
    case "insertSilence":
      return len + Math.max(0, op.seconds);
    default:
      return len;
  }
}

export type Selection = { start: number; end: number } | null;

/** Where the selection and cursor go after a step, so the next action follows on. */
export function afterStep(op: EditOp, sel: Selection, cursor: number, clip: number): { sel: Selection; cursor: number } {
  switch (op.op) {
    case "trim":
      return { sel: null, cursor: 0 };
    case "delete":
      return { sel: null, cursor: Math.min(op.start, op.end) };
    case "paste":
      return { sel: { start: op.at, end: op.at + clip }, cursor: op.at };
    case "insertSilence":
      return { sel: { start: op.at, end: op.at + op.seconds }, cursor: op.at };
    default:
      return { sel, cursor };
  }
}

/** The clipboard length after the steps (the last Copy). */
export function clipboardLength(ops: EditOp[]): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.op === "copy") return Math.abs(o.end - o.start);
  }
  return 0;
}
