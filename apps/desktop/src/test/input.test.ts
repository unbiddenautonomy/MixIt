import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackendForTests, type Backend } from "../backend";
import { classify, dropFiles, useDropTarget, type DropHandlers } from "../lib/dnd";
import { MIC_DEFAULTS, mirrorMic, useMic } from "../store/mic";
import { trimSilence } from "../web/engine";

describe("classify", () => {
  it("sorts dropped paths by what they are", () => {
    const c = classify(["C:\\Music\\a.MP3", "/m/b.flac", "/m/set.mixit", "/m/rekordbox.xml", "/m/collection.nml", "/m/list.m3u8", "/m/Crates", "/m/cover.jpg", "browser:3/Folder/c.wav"]);
    expect(c.audio).toEqual(["C:\\Music\\a.MP3", "/m/b.flac", "browser:3/Folder/c.wav"]);
    expect(c.projects).toEqual(["/m/set.mixit"]);
    expect(c.rekordbox).toEqual(["/m/rekordbox.xml"]);
    expect(c.traktor).toEqual(["/m/collection.nml"]);
    expect(c.playlists).toEqual(["/m/list.m3u8"]);
    expect(c.folders).toEqual(["/m/Crates"]);
    expect(c.other).toEqual(["/m/cover.jpg"]);
  });
});

describe("trimSilence", () => {
  const sr = 1000;
  // 2 s of silence, 1 s of a full-scale tone, 2 s of silence (interleaved stereo).
  const take = () => {
    const x = new Float32Array(5 * sr * 2);
    for (let i = 2 * sr; i < 3 * sr; i++) x[2 * i] = x[2 * i + 1] = Math.sin(i) > 0 ? 0.5 : -0.5;
    return x;
  };

  it("keeps 10 ms before the sound and 200 ms after it", () => {
    const out = trimSilence(take(), sr);
    expect(out.length / 2).toBe(10 + sr + 200);
  });

  it("fades the edges so the cut does not click", () => {
    const out = trimSilence(take(), sr);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(0);
  });

  it("returns nothing for a silent take", () => {
    expect(trimSilence(new Float32Array(2000), sr).length).toBe(0);
  });
});

describe("mirrorMic", () => {
  beforeEach(() => useMic.getState().set({ ...MIC_DEFAULTS }));

  it("follows presses, sets and values", () => {
    mirrorMic("on_air", { type: "press" });
    expect(useMic.getState().onAir).toBe(true);
    mirrorMic("on_air", { type: "press" });
    expect(useMic.getState().onAir).toBe(false);
    mirrorMic("talkover", { type: "set", value: false });
    expect(useMic.getState().talkover).toBe(false);
    mirrorMic("gain", { type: "value", value: 12 });
    mirrorMic("talkover_depth", { type: "value", value: -20 });
    mirrorMic("eq.low", { type: "value", value: -6 });
    expect(useMic.getState()).toMatchObject({ gain: 12, depth: -20, low: -6 });
  });

  it("ignores a value for a control it does not know", () => {
    mirrorMic("volume", { type: "value", value: 3 });
    expect(useMic.getState()).toMatchObject(MIC_DEFAULTS);
  });
});

describe("dropFiles", () => {
  let host: HTMLDivElement;
  let unmount: () => void;
  const calls: string[] = [];

  const backend = {
    importTrack: vi.fn(async (path: string) => ({ id: path.length })),
    addToLibrary: vi.fn(async (paths: string[]) => void calls.push(`library ${paths.join(",")}`)),
    importRekordbox: vi.fn(async () => undefined),
    importTraktor: vi.fn(async () => undefined),
    importM3u: vi.fn(async () => 3),
  };

  function Target({ id, h, children }: { id: string; h: DropHandlers; children?: ReactNode }) {
    const d = useDropTarget(id, h);
    return createElement("div", { ...d.props, id }, children);
  }

  beforeEach(async () => {
    calls.length = 0;
    vi.clearAllMocks();
    setBackendForTests(backend as unknown as Backend);
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(Target, { id: "deck", h: { label: "Load", tracks: (ids) => void calls.push(`deck ${ids.join(",")}`) } }, createElement("span", { id: "inside" })),
          createElement(Target, { id: "pad", h: { label: "Pad", files: (p) => void calls.push(`pad ${p.join(",")}`), tracks: () => void calls.push("pad tracks") } }),
          createElement("div", { id: "nowhere" }),
        ),
      );
    });
    unmount = () => act(() => root.unmount());
  });

  afterEach(() => {
    unmount();
    host.remove();
  });

  const at = (id: string) => {
    document.elementFromPoint = () => document.getElementById(id);
  };

  it("imports audio dropped on a deck and loads the first track", async () => {
    at("inside");
    await dropFiles(["/m/a.wav", "/m/bb.mp3"], 1, 1);
    expect(backend.importTrack).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["deck 8,9"]);
  });

  it("gives a pad the file itself", async () => {
    at("pad");
    await dropFiles(["/m/hit.wav"], 1, 1);
    expect(backend.importTrack).not.toHaveBeenCalled();
    expect(calls).toEqual(["pad /m/hit.wav"]);
  });

  it("adds files and folders dropped anywhere else to the library", async () => {
    at("nowhere");
    await dropFiles(["/m/Crate", "/m/a.wav"], 1, 1);
    expect(calls).toEqual(["library /m/Crate,/m/a.wav"]);
  });

  it("does not import playlists in a browser", async () => {
    at("nowhere");
    await dropFiles(["/m/list.m3u", "/m/rekordbox.xml", "/m/collection.nml"], 1, 1);
    expect(backend.importM3u).not.toHaveBeenCalled();
    expect(backend.importRekordbox).not.toHaveBeenCalled();
    expect(backend.importTraktor).not.toHaveBeenCalled();
  });
});
