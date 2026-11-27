// The unit registry: what doesn't change from one layout to another. Like the action
// registry, it is the one list that menus, presets, the palette and tests read from.
import { UNIT_IDS, type Env, type PageId, type UnitId } from "./model";

export type Side = "tab" | "left" | "right" | "above" | "below";

export interface UnitInfo {
  id: UnitId;
  /** What people call it, in plain words. */
  name: string;
  /** Controls change the music; a control unit lives in one place only. Views only show things. */
  kind: "control" | "view";
  /** A view that may also be shown in another window. */
  mirrorable: boolean;
  /** Smallest useful size in CSS pixels, open. */
  min: { easy: { w: number; h: number }; pro: { w: number; h: number } };
  /** When a window is too small, units with a higher number fold first; 0 never folds by itself. */
  foldPriority: number;
  /**
   * Where the unit goes when it is sent home: a page of the main window, beside the first
   * anchor that is there. With no anchor present, it joins the page at the end.
   */
  home: { page: PageId; anchors: { unit: UnitId; side: Side }[] };
}

/** The thickness of a folded unit's bar, and the handle between split areas. */
export const BAR_PX = 28;
export const HANDLE_PX = 4;

const size = (w: number, h: number, pw = w, ph = h) => ({ easy: { w, h }, pro: { w: pw, h: ph } });

const SIDE_COLUMN: { unit: UnitId; side: Side }[] = [
  { unit: "details", side: "tab" },
  { unit: "tool.pads", side: "tab" },
  { unit: "library", side: "right" },
  { unit: "mixer", side: "below" },
];

const list: UnitInfo[] = [
  { id: "waves", name: "Waveforms", kind: "view", mirrorable: true, min: size(320, 60), foldPriority: 3, home: { page: "mix", anchors: [{ unit: "mixer", side: "above" }, { unit: "deck.A", side: "above" }] } },
  { id: "deck.A", name: "Deck A", kind: "control", mirrorable: false, min: size(300, 150), foldPriority: 0, home: { page: "mix", anchors: [{ unit: "mixer", side: "left" }, { unit: "deck.B", side: "left" }, { unit: "waves", side: "below" }] } },
  { id: "deck.B", name: "Deck B", kind: "control", mirrorable: false, min: size(300, 150), foldPriority: 0, home: { page: "mix", anchors: [{ unit: "mixer", side: "right" }, { unit: "deck.A", side: "right" }, { unit: "waves", side: "below" }] } },
  { id: "deck.C", name: "Deck C", kind: "control", mirrorable: false, min: size(300, 120), foldPriority: 4, home: { page: "mix", anchors: [{ unit: "deck.A", side: "below" }, { unit: "mixer", side: "left" }] } },
  { id: "deck.D", name: "Deck D", kind: "control", mirrorable: false, min: size(300, 120), foldPriority: 4, home: { page: "mix", anchors: [{ unit: "deck.B", side: "below" }, { unit: "mixer", side: "right" }] } },
  { id: "mixer", name: "Mixer", kind: "control", mirrorable: false, min: size(200, 260, 240, 260), foldPriority: 1, home: { page: "mix", anchors: [{ unit: "deck.A", side: "right" }, { unit: "deck.B", side: "left" }, { unit: "waves", side: "below" }] } },
  { id: "library", name: "Library", kind: "control", mirrorable: false, min: size(360, 160), foldPriority: 2, home: { page: "mix", anchors: [{ unit: "sidebar", side: "right" }, { unit: "details", side: "left" }, { unit: "mixer", side: "below" }] } },
  { id: "sidebar", name: "Collections and playlists", kind: "control", mirrorable: false, min: size(160, 160), foldPriority: 5, home: { page: "mix", anchors: [{ unit: "library", side: "left" }] } },
  { id: "details", name: "Track details", kind: "view", mirrorable: true, min: size(240, 160), foldPriority: 6, home: { page: "mix", anchors: [{ unit: "tool.pads", side: "tab" }, { unit: "library", side: "right" }, { unit: "mixer", side: "below" }] } },
  { id: "autodj", name: "Auto DJ queue", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "suggestions", name: "Suggestions", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "tool.pads", name: "Pads", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "tool.steps", name: "Steps", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "tool.effects", name: "Effects", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "tool.mic", name: "Mic", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "tool.record", name: "Record", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "tool.make", name: "Make a track", kind: "control", mirrorable: false, min: size(280, 160), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "studio", name: "Studio", kind: "control", mirrorable: false, min: size(320, 240), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "arrange", name: "Arrange", kind: "control", mirrorable: false, min: size(600, 300), foldPriority: 2, home: { page: "arrange", anchors: [{ unit: "library", side: "left" }] } },
  { id: "guide", name: "Guide", kind: "view", mirrorable: false, min: size(280, 240), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
  { id: "clock", name: "Clock and meters", kind: "view", mirrorable: true, min: size(160, 40), foldPriority: 6, home: { page: "mix", anchors: SIDE_COLUMN } },
];

export const UNITS: Record<UnitId, UnitInfo> = Object.fromEntries(list.map((u) => [u.id, u])) as Record<UnitId, UnitInfo>;

// The list above must name every unit exactly once.
if (list.length !== UNIT_IDS.length || UNIT_IDS.some((id) => !UNITS[id])) throw new Error("unit registry out of step with UNIT_IDS");

export const isUnitId = (x: unknown): x is UnitId => typeof x === "string" && (UNIT_IDS as readonly string[]).includes(x);

/**
 * Units that aren't drawn yet: Make a track isn't built, Studio is still a dialog, the
 * guide is still the side panel, the clock is still in the top bar, and Auto DJ and
 * Suggestions are still pages of the library. They keep their places in every layout,
 * so each one appears where it belongs the day it becomes a part of its own.
 */
export const NOT_YET: ReadonlySet<UnitId> = new Set<UnitId>(["tool.make", "studio", "guide", "clock", "autodj", "suggestions"]);

/** Decks C and D take part only with four decks. A disabled unit keeps its place but isn't drawn. */
export function enabled(unit: UnitId, env: Pick<Env, "decks">): boolean {
  if (NOT_YET.has(unit)) return false;
  return env.decks === 4 || (unit !== "deck.C" && unit !== "deck.D");
}

/** Units that must always be on a Mix page somewhere, so Play is never more than a click away. */
export function required(unit: UnitId, env: Pick<Env, "decks">): boolean {
  return (unit === "mixer" || unit.startsWith("deck.")) && enabled(unit, env);
}

export const isControl = (unit: UnitId) => UNITS[unit].kind === "control";

/** The page a unit opens on in a new window of its own. */
export function pageFor(unit: UnitId): PageId {
  if (unit === "arrange") return "arrange";
  if (unit === "library" || unit === "sidebar") return "library";
  return "mix";
}
