// A small stand-in for the engine's sound editing (`mixit_dsp::edit`) so the demo can
// show the editor without the engine. The real one splices click-free and measures
// loudness; this one is plain sample arithmetic.
import type { EditOp, FadeShape, SoundView } from "./types";

export const DEMO_SR = 44_100;

/** A short made-up sound: a decaying chord with a click on each beat. */
export function demoSound(seconds = 4): Float32Array {
  const n = Math.round(seconds * DEMO_SR);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / DEMO_SR;
    const beat = t % 0.5;
    const env = Math.exp(-beat * 6);
    const v = env * 0.4 * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 277 * t) + 0.3 * Math.sin(2 * Math.PI * 330 * t)) / 1.8 + (beat < 0.004 ? 0.5 : 0);
    out[i * 2] = v;
    out[i * 2 + 1] = v * 0.9;
  }
  return out;
}

const gain = (shape: FadeShape, t: number) => {
  t = Math.max(0, Math.min(1, t));
  if (shape === "smooth") return t * t * (3 - 2 * t);
  if (shape === "power") return Math.sin((t * Math.PI) / 2);
  if (shape === "exponential") return t <= 0 ? 0 : Math.pow(10, 3 * (t - 1));
  return t;
};

export function applyEdits(src: Float32Array, ops: EditOp[], sr = DEMO_SR): Float32Array {
  let a = src.slice();
  let clip = new Float32Array(0);
  const at = (t: number) => Math.max(0, Math.min(a.length / 2, Math.round(t * sr)));
  const range = (s: number, e: number) => [Math.min(at(s), at(e)), Math.max(at(s), at(e))];
  const join = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  for (const op of ops) {
    if (op.op === "removeDc" || op.op === "trimSilence") continue;
    if (op.op === "normalize") {
      const peak = a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      if (peak > 0) {
        const g = Math.pow(10, (op.to === "peak" ? op.level : -1) / 20) / peak;
        a = a.map((x) => x * g);
      }
      continue;
    }
    if (op.op === "paste") {
      const p = at(op.at);
      a = join(a.subarray(0, p * 2), clip, a.subarray(p * 2));
      continue;
    }
    if (op.op === "insertSilence") {
      const p = at(op.at);
      a = join(a.subarray(0, p * 2), new Float32Array(Math.round(op.seconds * sr) * 2), a.subarray(p * 2));
      continue;
    }
    const [s, e] = range(op.start, op.end);
    if (op.op === "trim") a = a.slice(s * 2, e * 2);
    else if (op.op === "delete") a = join(a.subarray(0, s * 2), a.subarray(e * 2));
    else if (op.op === "copy") clip = a.slice(s * 2, e * 2);
    else if (op.op === "silence") a.fill(0, s * 2, e * 2);
    else if (op.op === "gain") for (let i = s * 2; i < e * 2; i++) a[i] *= Math.pow(10, op.db / 20);
    else if (op.op === "fade") for (let i = s; i < e; i++) {
      const t = (i - s) / Math.max(1, e - s);
      const g = gain(op.shape, op.fadeIn ? t : 1 - t);
      a[i * 2] *= g;
      a[i * 2 + 1] *= g;
    }
    else if (op.op === "reverse") {
      const part = a.slice(s * 2, e * 2);
      for (let i = 0; i < e - s; i++) {
        a[(s + i) * 2] = part[(e - s - 1 - i) * 2];
        a[(s + i) * 2 + 1] = part[(e - s - 1 - i) * 2 + 1];
      }
    }
  }
  return a;
}

export function viewOf(a: Float32Array, bins: number, sr = DEMO_SR): SoundView {
  const frames = a.length / 2;
  const peaks: [number, number][] = [];
  let peak = 0;
  let sum = 0;
  for (let b = 0; b < bins; b++) {
    const s = Math.floor((b * frames) / bins);
    const e = Math.max(s + 1, Math.floor(((b + 1) * frames) / bins));
    let lo = 0;
    let hi = 0;
    for (let i = s; i < Math.min(e, frames); i++) {
      const v = Math.abs(a[i * 2]) >= Math.abs(a[i * 2 + 1]) ? a[i * 2] : a[i * 2 + 1];
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    peaks.push([lo, hi]);
  }
  for (let i = 0; i < a.length; i++) {
    peak = Math.max(peak, Math.abs(a[i]));
    sum += a[i] * a[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, a.length));
  return { seconds: frames / sr, sampleRate: sr, peaks, lufs: rms > 0 ? 20 * Math.log10(rms) - 0.7 : -99, peakDb: peak > 0 ? 20 * Math.log10(peak) : -99 };
}
