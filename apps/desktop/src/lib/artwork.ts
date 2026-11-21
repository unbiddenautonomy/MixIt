// Cover art: read once per track, shrunk to a small thumbnail (a 3 MB cover should not
// sit in memory for every row), kept in a small cache, a few reads at a time.
import { useEffect, useState } from "react";
import { backend } from "../backend";

const MAX = 400;
const cache = new Map<string, string | null>();
const waiting = new Map<string, Promise<string | null>>();
let running = 0;
const queue: (() => void)[] = [];

function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => {
      running++;
      resolve(() => {
        running--;
        queue.shift()?.();
      });
    };
    if (running < 4) go();
    else queue.push(go);
  });
}

function remember(k: string, url: string | null) {
  cache.set(k, url);
  if (cache.size > MAX) {
    const [old, u] = cache.entries().next().value as [string, string | null];
    cache.delete(old);
    if (u) URL.revokeObjectURL(u);
  }
}

/** A thumbnail `px` wide (or the picture itself where the browser cannot shrink it). */
async function thumbnail(blob: Blob, px: number): Promise<string> {
  try {
    if (typeof createImageBitmap !== "function" || typeof document === "undefined") throw new Error("no canvas");
    const bmp = await createImageBitmap(blob, { resizeWidth: px, resizeHeight: px, resizeQuality: "medium" });
    const c = document.createElement("canvas");
    c.width = px;
    c.height = px;
    c.getContext("2d")?.drawImage(bmp, 0, 0, px, px);
    bmp.close();
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
    if (!out) throw new Error("no thumbnail");
    return URL.createObjectURL(out);
  } catch {
    // SVG covers (the demo) and older webviews: show the picture as it is.
    return URL.createObjectURL(blob);
  }
}

/** The cover of a track as an object URL, or null when it has none. */
export function loadArtwork(trackId: number, px: number): Promise<string | null> {
  const k = `${trackId}@${px}`;
  if (cache.has(k)) return Promise.resolve(cache.get(k) ?? null);
  const pending = waiting.get(k);
  if (pending) return pending;
  const p = (async () => {
    const done = await slot();
    try {
      const blob = await backend().artwork(trackId);
      const url = blob ? await thumbnail(blob, px) : null;
      remember(k, url);
      return url;
    } catch {
      remember(k, null);
      return null;
    } finally {
      waiting.delete(k);
      done();
    }
  })();
  waiting.set(k, p);
  return p;
}

/** Forgets covers (after files change). */
export function clearArtwork() {
  for (const u of cache.values()) if (u) URL.revokeObjectURL(u);
  cache.clear();
}

/** The cover for a track, loading it when `has` says there is one. */
export function useArtwork(trackId: number | null | undefined, has: boolean | undefined, px = 96): string | null {
  const k = trackId != null ? `${trackId}@${px}` : "";
  const [url, setUrl] = useState<string | null>(() => (k ? (cache.get(k) ?? null) : null));
  useEffect(() => {
    if (trackId == null || !has) {
      setUrl(null);
      return;
    }
    let live = true;
    const hit = cache.get(k);
    if (hit !== undefined) setUrl(hit);
    else void loadArtwork(trackId, px).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [trackId, has, px, k]);
  return url;
}

/** Two colours from a name, for tracks without a cover. */
export function placeholderColors(seed: string): [string, string] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 35% 32%)`, `hsl(${(hue + 50) % 360} 40% 18%)`];
}
