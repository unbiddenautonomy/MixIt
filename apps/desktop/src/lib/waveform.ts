// Waveform drawing: a level pyramid over the 5-byte columns (peak, rms, low, mid, high)
// so any zoom draws about one column per pixel, and three-band colouring (bass, mids,
// highs) in the style DJs read at a glance.
import type { TrackDetail, WaveformData } from "../backend/types";

export interface Pyramid {
  sampleRate: number;
  /** Seconds per column for each level. */
  secs: number[];
  levels: Uint8Array[];
  duration: number;
}

const cache = new WeakMap<WaveformData, Pyramid>();

export function pyramid(w: WaveformData): Pyramid {
  const hit = cache.get(w);
  if (hit) return hit;
  const levels = [w.columns];
  const secs = [w.framesPerColumn / w.sampleRate];
  while (levels[levels.length - 1].length / 5 > 512) {
    const src = levels[levels.length - 1];
    const n = Math.ceil(src.length / 5 / 4);
    const dst = new Uint8Array(n * 5);
    for (let i = 0; i < n; i++) {
      for (let b = 0; b < 5; b++) {
        let m = 0;
        let sum = 0;
        let cnt = 0;
        for (let k = 0; k < 4; k++) {
          const j = (i * 4 + k) * 5 + b;
          if (j >= src.length) break;
          m = Math.max(m, src[j]);
          sum += src[j];
          cnt++;
        }
        // Peak keeps the maximum; the others the mean, so dense music does not saturate.
        dst[i * 5 + b] = b === 0 ? m : Math.round(sum / Math.max(1, cnt));
      }
    }
    levels.push(dst);
    secs.push(secs[secs.length - 1] * 4);
  }
  const p = { sampleRate: w.sampleRate, secs, levels, duration: (w.columns.length / 5) * secs[0] };
  cache.set(w, p);
  return p;
}

export const BAND_COLORS = {
  low: [64, 92, 255],
  mid: [255, 166, 48],
  high: [236, 246, 255],
};

/**
 * Draws seconds [t0, t1) into `width` px of `ctx` (height h, centred vertically).
 * `dim` darkens what is already played.
 */
export function drawWave(ctx: CanvasRenderingContext2D, p: Pyramid, t0: number, t1: number, x0: number, width: number, h: number, opts: { playhead?: number; dimPlayed?: boolean; gain?: number; mono?: string } = {}) {
  const spp = (t1 - t0) / width; // seconds per pixel
  let lv = 0;
  while (lv + 1 < p.levels.length && p.secs[lv + 1] <= spp) lv++;
  const L = p.levels[lv];
  const sc = p.secs[lv];
  const n = L.length / 5;
  const mid = h / 2;
  const g = opts.gain ?? 1;
  for (let px = 0; px < width; px++) {
    const a = t0 + px * spp;
    const b = a + spp;
    let i0 = Math.floor(a / sc);
    let i1 = Math.max(i0 + 1, Math.floor(b / sc));
    if (i1 <= 0 || i0 >= n) continue;
    i0 = Math.max(0, i0);
    i1 = Math.min(n, i1);
    let peak = 0;
    let low = 0;
    let midv = 0;
    let high = 0;
    for (let i = i0; i < i1; i++) {
      const o = i * 5;
      peak = Math.max(peak, L[o]);
      low = Math.max(low, L[o + 2]);
      midv = Math.max(midv, L[o + 3]);
      high = Math.max(high, L[o + 4]);
    }
    const played = opts.dimPlayed && opts.playhead !== undefined && a < opts.playhead;
    const alpha = played ? 0.38 : 1;
    const x = x0 + px;
    if (opts.mono) {
      const ph = (peak / 255) * mid * g;
      ctx.fillStyle = opts.mono;
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, mid - ph, 1, ph * 2);
      continue;
    }
    // Stacked bands: bass widest at the back, highs as a bright core.
    // Scale the bands so the widest reaches the peak: the outline follows the true
    // level and the colours show which band carries it.
    const norm = peak / Math.max(1, low, midv, high);
    const lh = ((low * norm) / 255) * mid * 0.98 * g;
    const mh = ((midv * norm) / 255) * mid * 0.82 * g;
    const hh = ((high * norm) / 255) * mid * 0.6 * g;
    const [lr, lg, lb] = BAND_COLORS.low;
    const [mr, mg, mb] = BAND_COLORS.mid;
    const [hr, hg, hb] = BAND_COLORS.high;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `rgb(${lr},${lg},${lb})`;
    ctx.fillRect(x, mid - lh, 1, lh * 2);
    ctx.fillStyle = `rgb(${mr},${mg},${mb})`;
    ctx.fillRect(x, mid - mh, 1, mh * 2);
    ctx.fillStyle = `rgb(${hr},${hg},${hb})`;
    ctx.fillRect(x, mid - hh, 1, hh * 2);
  }
  ctx.globalAlpha = 1;
}

/** Beat times (seconds) in [t0, t1] with their beat numbers. */
export function beatsIn(d: TrackDetail, t0: number, t1: number): [number, number][] {
  const out: [number, number][] = [];
  if (!d.analysed) return out;
  if (!d.constantGrid && d.beats.length > 0) {
    // Warped grid: binary search the beat list.
    let lo = 0;
    let hi = d.beats.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (d.beats[m] < t0) lo = m + 1;
      else hi = m;
    }
    const b0 = Math.round((d.beats[0] - d.firstBeat) / d.beatPeriod);
    for (let i = lo; i < d.beats.length && d.beats[i] <= t1; i++) out.push([d.beats[i], b0 + i]);
    return out;
  }
  if (d.beatPeriod <= 0) return out;
  const k0 = Math.ceil((t0 - d.firstBeat) / d.beatPeriod);
  const k1 = Math.floor((t1 - d.firstBeat) / d.beatPeriod);
  for (let k = k0; k <= k1 && out.length < 4000; k++) out.push([d.firstBeat + k * d.beatPeriod, k]);
  return out;
}

export function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export const SECTION_COLORS: Record<string, string> = {
  Intro: "#64748b",
  Build: "#a855f7",
  "Build-up": "#a855f7",
  Drop: "#f43f5e",
  Breakdown: "#0ea5e9",
  Main: "#10b981",
  Outro: "#64748b",
};

export const HOT_CUE_COLORS = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899];
