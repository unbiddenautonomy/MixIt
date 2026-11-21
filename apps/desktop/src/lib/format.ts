export function clock(seconds: number, tenths = false): string {
  if (!Number.isFinite(seconds)) return "–:––";
  const neg = seconds < 0;
  let s = Math.abs(seconds);
  if (tenths) {
    const t = Math.floor(s * 10) % 10;
    s = Math.floor(s);
    return `${neg ? "-" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${t}`;
  }
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = String(s % 60).padStart(2, "0");
  return `${neg ? "-" : ""}${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${sec}`;
}

export function bpm(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) || v <= 0 ? "–" : v.toFixed(digits);
}

export function signedPct(v: number, digits = 1): string {
  const s = (v * 100).toFixed(digits);
  return v > 0 ? `+${s}%` : `${s}%`;
}

export function db(v: number, digits = 1): string {
  if (!Number.isFinite(v) || v <= -99) return "-∞";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function linToDb(x: number): number {
  return x > 1e-6 ? 20 * Math.log10(x) : -120;
}

export function hex(color: number | null | undefined, fallback = "#3b82f6"): string {
  return color == null ? fallback : `#${color.toString(16).padStart(6, "0")}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A colour made readable as text on the current theme (darkened on the light theme). */
export function inkColor(color: string): string {
  return `color-mix(in oklab, ${color} var(--ink), black)`;
}
