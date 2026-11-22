import { describe, expect, it } from "vitest";
import type { TrackRow } from "../backend/types";
import { shared } from "../components/library/BatchInspector";

const r = (genre: string, rating: number) => ({ genre, rating }) as TrackRow;

describe("editing several tracks", () => {
  it("shows a value only when every track shares it", () => {
    expect(shared([r("House", 3), r("House", 4)], (x) => x.genre)).toBe("House");
    expect(shared([r("House", 3), r("Techno", 3)], (x) => x.genre)).toBeNull();
    expect(shared([r("House", 3), r("Techno", 3)], (x) => x.rating)).toBe(3);
    expect(shared([], (x: TrackRow) => x.genre)).toBeNull();
  });
});
