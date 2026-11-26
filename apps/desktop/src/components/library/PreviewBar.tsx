// The preview player under the track list: the whole track's waveform (click or drag to
// jump), play and pause, jumps to its sections, the volume and where it is heard, and
// loading it on a deck at the point you are listening to.
import clsx from "clsx";
import { Headphones, Link2, Loader2, Pause, Play, Speaker, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { backend } from "../../backend";
import { clock } from "../../lib/format";
import { drawWave, pyramid, SECTION_COLORS, setupCanvas } from "../../lib/waveform";
import { DECK_LETTERS, useApp } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { closePreview, resolveRoute, seekPreview, setPreviewGain, setPreviewRoute, setPreviewSync, togglePreview, useTrackPreview, type RouteChoice } from "../../store/trackPreview";
import { loadOnDeck } from "../deck/Deck";
import { useWaveform } from "../deck/useWaveform";
import { Cover } from "../ui/Cover";
import { useDevicePixelRatio } from "../../lib/dpr";

/** Where the preview is now, moved on by the time since the last snapshot. */
export function previewPosition(): number {
  const { t, at } = useTelemetry.getState();
  const p = t.preview;
  if (!p) return 0;
  if (!p.playing) return p.position;
  return Math.min(p.duration || Infinity, p.position + Math.min(0.05, (performance.now() - at) / 1000) * (p.rate || 1));
}

export function PreviewBar() {
  const track = useTrackPreview((s) => s.track);
  if (!track) return null;
  return <Bar />;
}

function Bar() {
  const track = useTrackPreview((s) => s.track)!;
  const loading = useTrackPreview((s) => s.loading);
  const duration = useTrackPreview((s) => s.duration);
  const sections = useTrackPreview((s) => s.sections);
  const gain = useTrackPreview((s) => s.gain);
  const route = useTrackPreview((s) => s.route);
  const playing = useTelemetry((s) => !!s.t.preview?.playing);
  const sync = useTrackPreview((s) => s.sync);
  const synced = useTelemetry((s) => !!s.t.preview?.synced);
  const ratePct = useTelemetry((s) => Math.round(((s.t.preview?.rate ?? 1) - 1) * 1000) / 10);
  const decks = useApp((s) => s.settings?.decks ?? 2);
  const heard = resolveRoute(route);

  const loadHere = async (deck: number) => {
    const at = previewPosition();
    closePreview();
    await loadOnDeck(deck, track.id);
    if (useApp.getState().decks[deck]?.detail.track.id === track.id) await backend().seek(deck, at);
  };

  const nextRoute: Record<RouteChoice, RouteChoice> = { auto: heard === "headphones" ? "speakers" : "headphones", headphones: "speakers", speakers: "headphones" };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-white/[0.06] bg-zinc-900/80 px-3 py-2" data-testid="preview-bar">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={playing ? "Pause preview" : "Play preview"}
          onClick={() => togglePreview()}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-zinc-950 hover:brightness-110"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : playing ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
        </button>
        <Cover trackId={track.id} has={track.hasArt} title={track.title} artist={track.artist} size={28} rounded="rounded" />
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium text-zinc-100">{track.title}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {track.artist}
            <span className="ml-1.5 text-zinc-600">· preview, {heard === "headphones" ? "in your headphones" : "on the speakers"}</span>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {sections.length > 0 &&
            sections.slice(0, 8).map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => seekPreview(s.start)}
                title={`Jump to ${s.label.toLowerCase()} (${clock(s.start)})`}
                className="hidden h-6 items-center gap-1 rounded-md border border-white/[0.06] px-1.5 text-[10px] text-zinc-400 hover:text-zinc-100 xl:flex"
              >
                <span className="size-1.5 rounded-full" style={{ background: SECTION_COLORS[s.label] ?? "#52525b" }} />
                {s.label}
              </button>
            ))}
          <span className="mx-1 h-4 w-px bg-white/[0.06]" />
          <button
            type="button"
            onClick={() => setPreviewSync(!sync)}
            aria-pressed={sync}
            title={
              sync
                ? synced
                  ? "Playing in time with the decks: its tempo is matched and its bars line up with the music playing, so you can hear how the two would mix. Click to hear it at its own speed."
                  : "In time with the decks is on, but this track plays at its own speed: its tempo is too far from the music playing (more than 16%), or it has no beat grid yet."
                : "Play in time with the decks: match its tempo and line its bars up with the music playing, to hear how the two would sound mixed."
            }
            className={clsx("flex h-7 items-center gap-1 rounded-md border px-1.5 text-[11px]", sync ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-white/[0.06] text-zinc-400 hover:text-zinc-100")}
            data-testid="preview-sync"
          >
            <Link2 size={12} />
            In time
            {sync && synced && ratePct !== 0 && <span className="tabular-nums text-sky-300/80">{ratePct > 0 ? `+${ratePct.toFixed(1)}` : ratePct.toFixed(1)}%</span>}
          </button>
          <button
            type="button"
            onClick={() => setPreviewRoute(nextRoute[route])}
            title={heard === "headphones" ? "Heard in your headphones. Click to hear it on the speakers." : "Heard on the speakers. Click to hear it in your headphones (set the headphone output in Settings)."}
            aria-label="Where the preview is heard"
            className={clsx("flex size-7 items-center justify-center rounded-md border border-white/[0.06]", heard === "headphones" ? "text-sky-300" : "text-amber-300")}
          >
            {heard === "headphones" ? <Headphones size={14} /> : <Speaker size={14} />}
          </button>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={gain}
            onChange={(e) => setPreviewGain(Number(e.target.value))}
            aria-label="Preview volume"
            title="Preview volume"
            className="w-20 accent-[var(--accent)]"
          />
          {DECK_LETTERS.slice(0, decks).map((l, i) => (
            <button
              key={l}
              type="button"
              onClick={() => void loadHere(i)}
              title={`Load on deck ${l}, starting where you are listening`}
              className="h-7 rounded-md border border-white/[0.06] px-2 text-[11px] font-semibold text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-50"
            >
              {l}
            </button>
          ))}
          <button type="button" onClick={closePreview} aria-label="Close preview" title="Stop and close" className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100">
            <X size={14} />
          </button>
        </div>
      </div>
      <Strip trackId={track.id} duration={duration} />
    </div>
  );
}

function Strip({ trackId, duration }: { trackId: number; duration: number }) {
  const wave = useWaveform(trackId);
  const sections = useTrackPreview((s) => s.sections);
  const cues = useTrackPreview((s) => s.cues);
  const ref = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);
  const ratio = useDevicePixelRatio();

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const paint = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round(r.width * dpr));
      off.height = Math.max(1, Math.round(r.height * dpr));
      const g = off.getContext("2d")!;
      g.scale(dpr, dpr);
      const dur = duration || 1;
      if (wave) drawWave(g, pyramid(wave), 0, dur, 0, Math.round(r.width), r.height - 5, {});
      else {
        g.fillStyle = "rgba(255,255,255,0.05)";
        g.fillRect(0, (r.height - 5) / 2 - 1, r.width, 2);
      }
      for (const s of sections) {
        g.fillStyle = SECTION_COLORS[s.label] ?? "#52525b";
        g.globalAlpha = 0.85;
        g.fillRect((s.start / dur) * r.width + 0.5, r.height - 3, Math.max(1, ((s.end - s.start) / dur) * r.width - 1), 3);
      }
      g.globalAlpha = 1;
      for (const cu of cues) {
        if (cu.role !== "hot" && cu.role !== "mixIn" && cu.role !== "mixOut") continue;
        g.fillStyle = cu.role === "mixIn" ? "#1abc9c" : cu.role === "mixOut" ? "#e67e22" : "#e4e4e7";
        g.fillRect((cu.seconds / dur) * r.width - 0.5, 0, 1, r.height - 5);
      }
      bg.current = off;
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
  }, [wave, duration, sections, cues, ratio]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      if (c) {
        const g = setupCanvas(c);
        const r = c.getBoundingClientRect();
        g.clearRect(0, 0, r.width, r.height);
        if (bg.current) g.drawImage(bg.current, 0, 0, r.width, r.height);
        const x = (previewPosition() / (duration || 1)) * r.width;
        g.fillStyle = "rgba(9,9,11,0.5)";
        g.fillRect(0, 0, x, r.height - 4);
        g.fillStyle = "#fafafa";
        g.fillRect(x - 0.75, 0, 1.5, r.height);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

  const seekAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekPreview(((e.clientX - r.left) / r.width) * duration);
  };

  return (
    <canvas
      ref={ref}
      className="h-8 w-full cursor-pointer rounded"
      aria-label="Preview position: click to jump"
      data-testid="preview-wave"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekAt(e);
      }}
    />
  );
}

/** A small play button for a track row: hear it in the preview player. */
export function PreviewButton({ row, className }: { row: import("../../backend/types").TrackRow; className?: string }) {
  const current = useTrackPreview((s) => s.track?.id === row.id);
  const playing = useTelemetry((s) => !!s.t.preview?.playing);
  const on = current && playing;
  return (
    <button
      type="button"
      aria-label={on ? `Pause preview of ${row.title}` : `Preview ${row.title}`}
      title={on ? "Pause the preview" : "Preview in your headphones (P)"}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        togglePreview(row);
      }}
      className={clsx(
        "flex size-5 shrink-0 items-center justify-center rounded-full transition-opacity",
        on ? "bg-[var(--accent)] text-zinc-950 opacity-100" : current ? "bg-zinc-700 text-zinc-100 opacity-100" : "bg-white/10 text-zinc-200 opacity-0 hover:bg-white/20 group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
      data-testid="preview-button"
    >
      {on ? <Pause size={10} /> : <Play size={10} className="translate-x-px" />}
    </button>
  );
}
