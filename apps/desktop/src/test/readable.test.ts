// Readable from a step back: no text in the UI is drawn smaller than 11 px, whether by a
// class, an inline style or on a canvas.
import { describe, expect, it } from "vitest";

describe("text sizes", () => {
  it("never go below 11 px", () => {
    const files = import.meta.glob(["../**/*.ts", "../**/*.tsx", "../**/*.css", "!../test/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(50);
    const small = /text-\[(?:[0-9]|10)(?:\.\d+)?px\]|font-size:\s*(?:[0-9]|10)(?:\.\d+)?px|fontSize:\s*["']?(?:[0-9]|10)(?:\.\d+)?(?:px)?["']?[,\s}]|\.font\s*=\s*["'`][^"'`]*\b(?:[0-9]|10)(?:\.\d+)?px/;
    const bad: string[] = [];
    for (const [f, text] of Object.entries(files))
      text.split("\n").forEach((line, i) => {
        if (small.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    expect(bad).toEqual([]);
  });
});
