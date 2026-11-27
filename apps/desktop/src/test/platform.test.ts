import { describe, expect, it } from "vitest";
import { PLATFORMS, detectOs, fileName, fileStem, keyLabel, keysIn, modName, type Os } from "../lib/platform";
import { CONCEPTS } from "../guide/concepts";

describe("platform table", () => {
  it("recognises each system from what the webview reports", () => {
    expect(detectOs("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectOs("Windows")).toBe("windows");
    expect(detectOs("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe("mac");
    expect(detectOs("macOS")).toBe("mac");
    expect(detectOs("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(detectOs("", "")).toBe("windows");
    expect(detectOs(undefined)).toBe("windows");
  });

  it("writes shortcuts the way each system does", () => {
    expect(keyLabel("Mod+Shift+Z", PLATFORMS.mac)).toBe("⌘⇧Z");
    expect(keyLabel("Mod+Shift+Z", PLATFORMS.windows)).toBe("Ctrl+Shift+Z");
    expect(keyLabel("Alt+Mod+K", PLATFORMS.linux)).toBe("Alt+Ctrl+K");
    expect(keyLabel("Shift+1", PLATFORMS.mac)).toBe("⇧1");
    expect(keyLabel("Space", PLATFORMS.windows)).toBe("Space");
    expect(keyLabel(null)).toBe("");
  });

  it("has a complete entry for every system", () => {
    for (const os of ["windows", "mac", "linux"] as Os[]) {
      const p = PLATFORMS[os];
      expect(p.os).toBe(os);
      expect(p.fileManager.length).toBeGreaterThan(0);
      expect(p.modIsMeta).toBe(os === "mac");
    }
  });

  it("reads file names from Windows and Unix paths", () => {
    expect(fileName("C:\\Users\\dj\\Music\\Night Drive.mp3")).toBe("Night Drive.mp3");
    expect(fileName("/Users/dj/Music/Night Drive.flac")).toBe("Night Drive.flac");
    expect(fileName("\\\\nas\\share\\a.wav")).toBe("a.wav");
    expect(fileName("plain.wav")).toBe("plain.wav");
    expect(fileStem("D:/Sets/Mr. Brown - Live.mp3")).toBe("Mr. Brown - Live");
    expect(fileStem("C:\\x\\no extension")).toBe("no extension");
  });
});

describe("shortcuts written in text", () => {
  it("writes each one for the system", () => {
    expect(keysIn("Paste with {Mod+V}, {Mod}-click to add more, undo with {Mod+Shift+Z}.", PLATFORMS.mac)).toBe("Paste with ⌘V, ⌘-click to add more, undo with ⌘⇧Z.");
    expect(keysIn("Paste with {Mod+V}, {Mod}-click to add more, undo with {Mod+Shift+Z}.", PLATFORMS.windows)).toBe("Paste with Ctrl+V, Ctrl-click to add more, undo with Ctrl+Shift+Z.");
    expect(keysIn("{artist} - {title}", PLATFORMS.mac)).toBe("{artist} - {title}");
    expect(modName(PLATFORMS.linux)).toBe("Ctrl");
  });

  it("never names one system's keys in what people read", () => {
    // Text shown to people goes through keyLabel or keysIn, so a Mac shows ⌘ and Windows Ctrl.
    const files = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../test/**", "!../lib/platform.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const [f, text] of Object.entries(files))
      text
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
          if (/\bCtrl[+/-]|\bCmd\+|⌘/.test(line)) bad.push(`${f}:${i + 1}`);
        });
    expect(bad).toEqual([]);
    for (const c of CONCEPTS) for (const t of [c.summary, ...c.body]) expect(t, c.id).not.toMatch(/\bCtrl[+/-]|\bCmd\+|⌘/);
  });
});

