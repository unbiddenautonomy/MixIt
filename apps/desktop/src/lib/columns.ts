// Which columns the track list shows and how wide they are. Easy view starts with the
// essentials and Pro with more; any column can be turned on or off, and widths dragged,
// on this computer.
import { create } from "zustand";

export interface ColumnPrefs {
  /** Column key to shown (true) or hidden (false); missing keys follow the view's default. */
  shown: Record<string, boolean>;
  /** Column key to width in pixels; missing keys use the column's own width. */
  widths: Record<string, number>;
}

const KEY = "mixit.columns";

function load(): ColumnPrefs {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ColumnPrefs> | null;
    const pick = <T>(x: unknown, ok: (v: unknown) => v is T): Record<string, T> =>
      x && typeof x === "object" ? (Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, v]) => ok(v))) as Record<string, T>) : {};
    return { shown: pick(o?.shown, (v): v is boolean => typeof v === "boolean"), widths: pick(o?.widths, (v): v is number => typeof v === "number" && v > 0) };
  } catch {
    return { shown: {}, widths: {} };
  }
}

export const useColumns = create<ColumnPrefs>(() => load());

function save() {
  const { shown, widths } = useColumns.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ shown, widths }));
  } catch {
    // Kept for this session.
  }
}

/** Where a column shows by default: always, from Pro view, or only when turned on. */
export type ColumnLevel = "always" | "pro" | "extra";

/** Whether a column shows, given the view and your choices. The title always shows. */
export function isShown(key: string, level: ColumnLevel, pro: boolean, prefs: ColumnPrefs = useColumns.getState()): boolean {
  if (key === "title") return true;
  if (key in prefs.shown) return prefs.shown[key];
  return level === "always" || (level === "pro" && pro);
}

export function setShown(key: string, on: boolean) {
  useColumns.setState((s) => ({ shown: { ...s.shown, [key]: on } }));
  save();
}

export const MIN_WIDTH = 36;

export function setWidth(key: string, px: number | null) {
  useColumns.setState((s) => {
    const widths = { ...s.widths };
    if (px == null) delete widths[key];
    else widths[key] = Math.max(MIN_WIDTH, Math.round(px));
    return { widths };
  });
  save();
}

export function resetColumns() {
  useColumns.setState({ shown: {}, widths: {} });
  save();
}

/** The CSS grid track for a column: your width when you dragged it, else its own. */
export function track(key: string, own: string, prefs: ColumnPrefs = useColumns.getState()): string {
  const w = prefs.widths[key];
  return w ? `${w}px` : own;
}
