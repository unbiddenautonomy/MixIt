import { describe, expect, it } from "vitest";
import { DemoBackend } from "../backend/demo";
import { fromQuery, newRule, ruleTerm, toQuery } from "../lib/smartRules";

describe("smart playlist rules", () => {
  it("turns rules into a search", () => {
    expect(
      toQuery({
        rules: [
          { field: "genre", op: "has", a: "deep house" },
          { field: "bpm", op: "between", a: "120", b: "126" },
          { field: "key", op: "mixes", a: "8A" },
          { field: "energy", op: "atleast", a: "6" },
          { field: "tag", op: "not", a: "vocal" },
          { field: "played", op: "notwithin", a: "30" },
          { field: "rating", op: "atleast", a: "4" },
        ],
        sort: "-energy",
        rest: "",
      }),
    ).toBe('genre:"deep house" bpm:120-126 key:~8A energy:6+ -tag:vocal played:>30d rating:4+ sort:-energy');
  });

  it("leaves out rules that are not finished", () => {
    expect(ruleTerm(newRule("bpm"))).toBeNull();
    expect(ruleTerm({ field: "bpm", op: "between", a: "120", b: "" })).toBeNull();
    expect(ruleTerm({ field: "key", op: "is", a: "banana" })).toBeNull();
    expect(ruleTerm({ field: "played", op: "never", a: "" })).toBe("played:never");
    expect(ruleTerm({ field: "bpm", op: "around", a: "124,5" })).toBe("bpm:~124.5");
  });

  it("reads a search back into rules, keeping what no rule shows", () => {
    const q = 'genre:"deep house" bpm:~124 key:8A -key:5A energy:<=4 year:2015-2020 added:<14d played:never sunset "warm vibes" sort:random';
    const s = fromQuery(q);
    expect(s.rules.map(ruleTerm)).toEqual(['genre:"deep house"', "bpm:~124", "key:8A", "-key:5A", "energy:<=4", "year:2015-2020", "added:<14d", "played:never"]);
    expect(s.rest).toBe('sunset "warm vibes"');
    expect(s.sort).toBe("random");
    // And round trips.
    expect(fromQuery(toQuery(s))).toEqual(s);
    // Terms the rules cannot show stay as text.
    expect(fromQuery("-bpm:120-128 missing:yes").rest).toBe("-bpm:120-128 missing:yes");
  });

  it("finds the same tracks in the demo library as the search would", async () => {
    const b = new DemoBackend();
    const q = toQuery({ rules: [{ field: "bpm", op: "between", a: "120", b: "126" }, { field: "energy", op: "atleast", a: "6" }], sort: "bpm", rest: "" });
    const rows = await b.search(q);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.bpm! >= 120 && r.bpm! <= 126 && r.energy! >= 6)).toBe(true);
    expect(rows.map((r) => r.bpm)).toEqual([...rows.map((r) => r.bpm)].sort((x, y) => x! - y!));
    const fresh = await b.search("added:<14d");
    expect(fresh).toEqual([]);
  }, 30_000);

  it("vocals rules turn into searches and back", () => {
    expect(ruleTerm({ field: "vocals", op: "no", a: "" })).toBe("vocals:no");
    expect(ruleTerm({ field: "vocals", op: "yes", a: "" })).toBe("vocals:yes");
    expect(ruleTerm({ field: "vocals", op: "atleast", a: "30" })).toBe("vocals:30+");
    expect(ruleTerm({ field: "vocals", op: "atleast", a: "" })).toBeNull();
    for (const q of ["vocals:no", "vocals:yes", "vocals:30+"]) expect(toQuery(fromQuery(q))).toBe(q);
  });
});

