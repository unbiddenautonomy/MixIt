import { describe, expect, it, vi } from "vitest";
import { DemoBackend } from "../backend/demo";
import { setBackendForTests } from "../backend";
import { editEachWithUndo, undoLibrary } from "../lib/libraryUndo";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { message: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
import type { TrackRow } from "../backend/types";
import { DEFAULT_TIDY, dropJunk, editsFor, genreSpellings, normaliseFeat, parseFileName, shouting, tidyChanges, tidySpaces, titleCase } from "../lib/tidy";

const row = (id: number, p: Partial<TrackRow>): TrackRow => ({ id, title: "", artist: "", album: "", genre: "", label: "", path: `/music/${id}.mp3`, ...p }) as TrackRow;

describe("tidying track details", () => {
  it("reads artist and title from file names", () => {
    expect(parseFileName("/m/01 Nova - Midnight Drive (Extended Mix).mp3")).toEqual({ artist: "Nova", title: "Midnight Drive (Extended Mix)" });
    expect(parseFileName("C:\\Music\\A1. Kairo – Solar Wind.flac")).toEqual({ artist: "Kairo", title: "Solar Wind" });
    expect(parseFileName("/m/Nova_-_Midnight_Drive.wav")).toEqual({ artist: "Nova", title: "Midnight Drive" });
    expect(parseFileName("/m/just a title.mp3")).toBeNull();
  });

  it("fixes spaces, clutter, feat. and shouting", () => {
    expect(tidySpaces("  Deep   House ( Dub ) ")).toBe("Deep House (Dub)");
    expect(tidySpaces("Some_Track_Name")).toBe("Some Track Name");
    expect(dropJunk("Solar Wind [Free Download] www.edm-blog.com", "title")).toBe("Solar Wind");
    expect(dropJunk("03 - Solar Wind", "title")).toBe("Solar Wind");
    expect(dropJunk("808 State", "artist")).toBe("808 State");
    expect(normaliseFeat("Up (ft. Mira) Featuring Juno")).toBe("Up (feat. Mira) feat. Juno");
    expect(normaliseFeat("Left Turn")).toBe("Left Turn");
    expect(shouting("MIDNIGHT DRIVE")).toBe(true);
    expect(shouting("midnight drive")).toBe(true);
    expect(shouting("Midnight Drive")).toBe(false);
    expect(titleCase("THE SOUND OF THE CITY")).toBe("The Sound of the City");
  });

  it("picks the genre spelling most of the library uses", () => {
    const lib = [row(1, { genre: "Deep House" }), row(2, { genre: "Deep House" }), row(3, { genre: "deep house" }), row(4, { genre: "TECHNO" })];
    const g = genreSpellings(lib);
    expect(g.get("deep house")).toBe("Deep House");
    expect(g.get("techno")).toBe("Techno");
  });

  it("proposes only real changes, as one edit per track", () => {
    const rows = [
      row(1, { path: "/m/02 Nova - Midnight Drive.mp3", title: "02 Nova - Midnight Drive" }),
      row(2, { title: "SOLAR WIND (Original Mix)", artist: "kairo ft. mira", genre: "deep house" }),
      row(3, { title: "Fine", artist: "Already Fine", genre: "Deep House" }),
      row(4, { title: "Also", artist: "Fine", genre: "Deep House" }),
    ];
    const ch = tidyChanges(rows, { ...DEFAULT_TIDY, originalMix: true });
    const of = (id: number) => Object.fromEntries(ch.filter((c) => c.id === id).map((c) => [c.field, c.after]));
    expect(of(1)).toEqual({ title: "Midnight Drive", artist: "Nova" });
    expect(of(2)).toEqual({ title: "Solar Wind", artist: "Kairo feat. Mira", genre: "Deep House" });
    expect(of(3)).toEqual({});
    const edits = editsFor(ch);
    expect(edits.get(2)).toEqual({ title: "Solar Wind", artist: "Kairo feat. Mira", genre: "Deep House" });
    expect(edits.has(3)).toBe(false);
    // Rules that are off change nothing.
    expect(tidyChanges(rows, { fromFileName: false, spaces: false, junk: false, feat: false, caps: false, originalMix: false, genres: false })).toEqual([]);
  });
});

describe("applying tidied details", () => {
  it("is one step to undo", async () => {
    const b = new DemoBackend();
    setBackendForTests(b);
    const rows = (await b.search("")).slice(0, 2);
    const edits = new Map([
      [rows[0].id, { title: "First tidy" }],
      [rows[1].id, { artist: "Second tidy", genre: "Tidy genre" }],
    ]);
    await editEachWithUndo(edits, rows, "Tidy details");
    const after = await b.search("");
    expect(after.find((r) => r.id === rows[0].id)!.title).toBe("First tidy");
    expect(after.find((r) => r.id === rows[1].id)!.genre).toBe("Tidy genre");
    expect(await undoLibrary()).toBe(true);
    const back = await b.search("");
    expect(back.find((r) => r.id === rows[0].id)!.title).toBe(rows[0].title);
    expect(back.find((r) => r.id === rows[1].id)!.artist).toBe(rows[1].artist);
    expect(back.find((r) => r.id === rows[1].id)!.genre).toBe(rows[1].genre);
  }, 30_000);
});
