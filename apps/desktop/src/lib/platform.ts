// Everything the screens do differently on Windows, macOS and Linux, in one table.
// Code asks `platform` (or passes a config to the helpers) instead of testing the
// system itself, so the tests check every system's labels on any machine.

export type Os = "windows" | "mac" | "linux";

export interface PlatformConfig {
  os: Os;
  /** The key behind "Mod" in shortcuts: Command on a Mac, Ctrl elsewhere. */
  modIsMeta: boolean;
  /** How modifier keys are written. */
  keys: { Mod: string; Shift: string; Alt: string };
  /** Between the keys of a shortcut: "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
  joiner: string;
  /** What the system calls its file browser. */
  fileManager: string;
}

export const PLATFORMS: Record<Os, PlatformConfig> = {
  windows: { os: "windows", modIsMeta: false, keys: { Mod: "Ctrl", Shift: "Shift", Alt: "Alt" }, joiner: "+", fileManager: "File Explorer" },
  mac: { os: "mac", modIsMeta: true, keys: { Mod: "⌘", Shift: "⇧", Alt: "⌥" }, joiner: "", fileManager: "Finder" },
  linux: { os: "linux", modIsMeta: false, keys: { Mod: "Ctrl", Shift: "Shift", Alt: "Alt" }, joiner: "+", fileManager: "file manager" },
};

/** The system from what the browser or webview reports (an iPad counts as a Mac). */
export function detectOs(platformName: string | undefined, userAgent = ""): Os {
  const s = `${platformName ?? ""} ${userAgent}`;
  if (/Mac|iPhone|iPad|iPod/i.test(s)) return "mac";
  if (/Win/i.test(s)) return "windows";
  if (/Linux|X11|CrOS|BSD/i.test(s)) return "linux";
  // Unknown: the most common desktop.
  return "windows";
}

function reported(): Os {
  if (typeof navigator === "undefined") return "windows";
  const uad = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return detectOs(uad?.platform || navigator.platform, navigator.userAgent);
}

/** This machine's settings. */
export const platform: PlatformConfig = PLATFORMS[reported()];

/** "Mod+Shift+Z" → "⌘⇧Z" on a Mac, "Ctrl+Shift+Z" elsewhere. */
export function keyLabel(shortcut: string | null | undefined, cfg: PlatformConfig = platform): string {
  if (!shortcut) return "";
  return shortcut
    .split("+")
    .map((k) => (k === "Mod" || k === "Shift" || k === "Alt" ? cfg.keys[k] : k))
    .join(cfg.joiner);
}

/** The last part of a path, whichever separator the system uses. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The file name without its extension (an extension is 1 to 5 characters). */
export function fileStem(path: string): string {
  return fileName(path).replace(/\.[^.]{1,5}$/, "");
}
