// The whole track: three-band waveform, sections, cue markers and the play head.
// Click or drag to jump.
import { useEffect, useRef } from "react";
import { backend } from "../../backend";
import { useApp } from "../../store/app";
import { livePosition, useTelemetry } from "../../store/telemetry";
import { hex } from "../../lib/format";
import { drawWave, pyramid, SECTION_COLORS, setupCanvas } from "../../lib/waveform";
import { useWaveform } from "./useWaveform";

export function Overview({ deck, height = 46 }: { deck: number; height?: number }) {
  const info = useApp((s) => s.decks[deck]);
  const wave = useWaveform(info?.detail.track.id);
  const ref = useRef<HTMLCanvasElement>(null);
  const bg = useRef<HTMLCanvasElement | null>(null);

  // Static layer: waveform and sections, redrawn when the track or size changes.
  useEffect(() => {
    const c = ref.current;
    if (!c || !info) return;
    const paint = () => {
      const r = c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const off = document.createElement("canvas");
      off.width = Math.round(r.width * dpr);
      off.height = Math.round(r.height * dpr);
      const g = off.getContext("2d")!;
      g.scale(dpr, dpr);
      const dur = info.detail.track.duration || 1;
      const waveH = r.height - 7;
      if (wave) drawWave(g, pyramid(wave), 0, dur, 0, Math.round(r.width), waveH, {});
      for (const s of info.detail.sections) {
        g.fillStyle = SECTION_COLORS[s.label] ?? "#52525b";
        g.globalAlpha = 0.85;
        g.fillRect((s.start / dur) * r.width + 0.5, r.height - 4, Math.max(1, ((s.end - s.start) / dur) * r.width - 1), 4);
      }
      g.globalAlpha = 1;
      bg.current = off;
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(c);
    return () => ro.disconnect();
  }, [info, wave]);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      if (c && info) {
        const g = setupCanvas(c);
        const r = c.getBoundingClientRect();
        g.clearRect(0, 0, r.width, r.height);
        if (bg.current) g.drawImage(bg.current, 0, 0, r.width, r.height);
        const dur = info.detail.track.duration || 1;
        const pos = livePosition(deck);
        const x = (pos / dur) * r.width;
        g.fillStyle = "rgba(9,9,11,0.55)";
        g.fillRect(0, 0, x, r.height - 6);
        const t = useTelemetry.getState().t.decks[deck];
        if (t.looping.active || t.looping.end > t.looping.start) {
          g.fillStyle = t.looping.active ? "rgba(34,197,94,0.35)" : "rgba(161,161,170,0.2)";
          g.fillRect((t.looping.start / dur) * r.width, 0, Math.max(2, ((t.looping.end - t.looping.start) / dur) * r.width), r.height - 6);
        }
        for (const cu of info.detail.cues) {
          if (cu.role === "section" || cu.role === "load") continue;
          const cx = (cu.seconds / dur) * r.width;
          g.fillStyle = cu.role === "hot" ? hex(cu.color) : cu.role === "mixIn" ? "#1abc9c" : cu.role === "mixOut" ? "#e67e22" : "#fbbf24";
          g.fillRect(cx - 0.5, 0, 1.5, r.height - 6);
          if (cu.role === "hot") {
            g.beginPath();
            g.moveTo(cx - 3, 0);
            g.lineTo(cx + 3, 0);
            g.lineTo(cx, 5);
            g.fill();
          }
        }
        // Main cue.
        g.fillStyle = "#f59e0b";
        const cx = (t.cue / dur) * r.width;
        g.beginPath();
        g.moveTo(cx - 4, r.height - 6);
        g.lineTo(cx + 4, r.height - 6);
        g.lineTo(cx, r.height - 12);
        g.fill();
        g.fillStyle = "#fafafa";
        g.fillRect(x - 1, 0, 2, r.height);
        // End-of-track warning.
        if (t.playing && t.remaining > 0 && t.remaining < 30 && Math.floor(performance.now() / 400) % 2 === 0) {
          g.strokeStyle = "rgba(239,68,68,0.9)";
          g.lineWidth = 2;
          g.strokeRect(1, 1, r.width - 2, r.height - 2);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, info]);

  const seekAt = (e: React.PointerEvent) => {
    if (!info) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    backend().seek(deck, f * info.detail.track.duration);
  };

  return (
    <canvas
      ref={ref}
      className="w-full cursor-pointer rounded-md bg-black/40"
      style={{ height, touchAction: "none" }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && seekAt(e)}
    />
  );
}
