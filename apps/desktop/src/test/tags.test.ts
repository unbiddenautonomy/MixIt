import { describe, expect, it } from "vitest";
import { DemoBackend, searchTerms } from "../backend/demo";
import { starterCategory, tagMatches, tagQuery, tagTally } from "../lib/tags";

describe("your own tags", () => {
  it("quotes tags with spaces in searches, and splits searches around quotes", () => {
    expect(tagQuery("vocal")).toBe("tag:vocal");
    expect(tagQuery("peak time")).toBe('tag:"peak time"');
    expect(searchTerms('tag:"peak time" bpm:~124 -"deep house"')).toEqual(['tag:"peak time"', "bpm:~124", '-"deep house"']);
  });

  it("counts tags over a selection and offers matches as you type", () => {
    const tally = tagTally([1, 2, 3], { 1: ["Vocal", "Dark"], 2: ["vocal"], 3: [] });
    expect(tally).toEqual([
      { name: "Vocal", count: 2 },
      { name: "Dark", count: 1 },
    ]);
    // Starts-with first, then contains; tags already on are left out; your tags and starters merge.
    expect(tagMatches("o", ["Sunset", "Opener"], ["Vocal"])).toEqual(["Opener", "Closer", "Groovy", "Emotional", "Tool", "Long intro"]);
    expect(tagMatches("peak", [], [])).toEqual(["Peak time"]);
    expect(starterCategory("peak TIME")).toBe("Moment");
    expect(starterCategory("sunset")).toBe("");
  });

  it("tags, searches, renames (merging) and deletes in the demo library", async () => {
    const b = new DemoBackend();
    const before = await b.listTags();
    expect(before.find((t) => t.name === "Vocal")?.count).toBe(6);
    await b.setTag([50, 51], "Sunset", true);
    await b.setTag([51], "sunset", true);
    expect((await b.search("tag:sunset")).map((r) => r.id)).toEqual([50, 51]);
    expect((await b.search('tag:"peak time" -tag:dark')).map((r) => r.id)).toEqual([22, 24, 33]);
    expect(await b.tagsOf([3, 50, 99])).toEqual([
      // By group ("Moment" before "Vibe"), then name.
      [3, ["Peak time", "Dark"]],
      [50, ["Sunset"]],
    ]);
    const sunset = (await b.listTags()).find((t) => t.name === "Sunset")!;
    const warm = (await b.listTags()).find((t) => t.name === "Warm-up")!;
    expect(await b.renameTag(sunset.id, "warm-up")).toBe(warm.id);
    expect((await b.search("tag:warm-up")).length).toBe(6);
    await b.deleteTag(warm.id);
    expect(await b.search("tag:warm-up")).toEqual([]);
    await expect(b.setTag([1], "  ", true)).rejects.toThrow();
    // Making the demo library's 120 tracks takes a few seconds.
  }, 30_000);
});
