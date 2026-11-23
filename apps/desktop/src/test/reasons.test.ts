import { describe, expect, it } from "vitest";
import { cardReasons } from "../lib/reasons";

describe("suggestion card reasons", () => {
  const all = ["Needs a +0.4 % tempo change.", "Shift its key by +2 semitone(s) with keylock to make it fit.", "Lifts the energy by 1.", "Same genre."];
  it("drops sentences the chips already show", () => {
    expect(cardReasons(all, { tempo: true, keyShift: true })).toEqual(["Lifts the energy by 1.", "Same genre."]);
  });
  it("keeps them when there is no chip for them", () => {
    expect(cardReasons(all, { tempo: false, keyShift: false })).toEqual(all);
  });
  it("always drops 'Same tempo', which needs no chip or sentence", () => {
    expect(cardReasons(["Same tempo.", "Same key: the harmonies will blend perfectly."], { tempo: false, keyShift: false })).toEqual(["Same key: the harmonies will blend perfectly."]);
  });
});
