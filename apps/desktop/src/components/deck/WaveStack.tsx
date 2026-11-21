// Beat-aligned scrolling waveforms of every deck, stacked, with the play head in the
// middle: beat lines on one deck sit over the other's when they are in sync.
import { useEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import clsx from "clsx";
import { backend } from "../../backend";
import { useApp } from "../../store/app";
import { livePosition, useTelemetry } from "../../store/telemetry";
import { hex } from "../../lib/format";
import { beatsIn, drawWave, pyramid, setupCanvas } from "../../lib/waveform";
import { DECK_COLORS } from "./useWaveform";
import { useWaveform } from "./useWaveform";

const ZOOMS = [2, 3, 4, 6, 8, 12, 16, 24, 32];

function Lane({ deck, seconds, height }: { deck: number; seconds: number; height: number }) {
  const info = useApp((s) => s.decks[deck]);
  const wave = useWaveform(info?.detail.track.id);
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; pos: number; wasPlaying: boolean } | null>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      if (c) {
        const g = setupCanvas(c);
        const r = c.getBoundingClientRect();
        const W = r.width;
        const H = r.height;
        g.clearRect(0, 0, W, H);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(0, 0, W, H);
        if (info) {
          const t = useTelemetry.getState().t.decks[deck];
          const pos = drag.current ? drag.current.pos : livePosition(deck);
          // Seconds of track shown: the window scales with the playback rate so beat
          // spacing on screen matches between synced decks.
          const span = seconds * (t.rate || 1);
          const t0 = pos - span / 2;
          const t1 = pos + span / 2;
          const px = (s: number) => ((s - t0) / (t1 - t0)) * W;
          // Loop region.
          if (t.looping.end > t.looping.start) {
            g.fillStyle = t.looping.active ? "rgba(34,197,94,0.18)" : "rgba(161,161,170,0.10)";
            g.fillRect(px(t.looping.start), 0, px(t.looping.end) - px(t.looping.start), H);
          }
          if (wave) drawWave(g, pyramid(wave), t0, t1, 0, Math.round(W), H, { playhead: pos, dimPlayed: false });
          // Beat grid: bars brighter, phrases marked.
          const d = info.detail;
          for (const [bt, k] of beatsIn(d, t0, t1)) {
            const x = Math.round(px(bt)) + 0.5;
            const bar = ((k % d.beatsPerBar) + d.beatsPerBar) % d.beatsPerBar === 0;
            const phrase = ((k % (d.beatsPerBar * 8)) + d.beatsPerBar * 8) % (d.beatsPerBar * 8) === 0;
            g.fillStyle = phrase ? "rgba(244,63,94,0.95)" : bar ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.22)";
            g.fillRect(x - (phrase ? 1 : 0.5), 0, phrase ? 2 : 1, bar ? H : H * 0.18);
            if (!bar) g.fillRect(x - 0.5, H * 0.82, 1, H * 0.18);
            if (phrase) {
              g.font = "600 9px ui-sans-serif, system-ui";
              g.fillText(`${Math.floor(k / d.beatsPerBar) + 1}`, x + 3, 10);
            }
          }
          // Cues.
          for (const cu of d.cues) {
            if (cu.seconds < t0 || cu.seconds > t1) continue;
            const x = px(cu.seconds);
            if (cu.role === "hot") {
              g.fillStyle = hex(cu.color);
              g.fillRect(x - 1, 0, 2, H);
              g.beginPath();
              g.roundRect(x, 0, 14, 13, 3);
              g.fill();
              g.fillStyle = "#09090b";
              g.font = "700 10px ui-sans-serif, system-ui";
              g.fillText(String((cu.slot ?? 0) + 1), x + 4, 10);
            } else if (cu.role === "mixIn" || cu.role === "mixOut") {
              g.fillStyle = cu.role === "mixIn" ? "#1abc9c" : "#e67e22";
              g.fillRect(x - 1, 0, 2, H);
              g.font = "600 9px ui-sans-serif, system-ui";
              g.fillText(cu.role === "mixIn" ? "MIX IN" : "MIX OUT", x + 4, H - 4);
            }
          }
          if (t.cue >= t0 && t.cue <= t1) {
            const x = px(t.cue);
            g.fillStyle = "#f59e0b";
            g.beginPath();
            g.moveTo(x - 5, H);
            g.lineTo(x + 5, H);
            g.lineTo(x, H - 7);
            g.fill();
          }
        } else {
          g.fillStyle = "rgba(161,161,170,0.6)";
          g.font = "500 11px ui-sans-serif, system-ui";
          g.fillText(`Deck ${String.fromCharCode(65 + deck)} is empty`, 12, H / 2 + 4);
        }
        // Play head.
        g.fillStyle = DECK_COLORS[deck];
        g.fillRect(W / 2 - 1, 0, 2, H);
        g.fillStyle = "rgba(250,250,250,0.9)";
        g.fillRect(W / 2 - 0.5, 0, 1, H);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, info, wave, seconds]);

  return (
    <canvas
      ref={ref}
      className="block w-full cursor-grab active:cursor-grabbing"
      style={{ height, touchAction: "none" }}
      onPointerDown={(e) => {
        if (!info) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const t = useTelemetry.getState().t.decks[deck];
        drag.current = { x: e.clientX, pos: livePosition(deck), wasPlaying: t.playing };
        backend().scratch(deck, "start", 0);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const W = (e.currentTarget as HTMLElement).getBoundingClientRect().width;
        const dx = e.clientX - d.x;
        d.x = e.clientX;
        const ds = -(dx / W) * seconds;
        d.pos = Math.max(0, d.pos + ds);
        backend().scratch(deck, "move", ds / 0.016);
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        backend().scratch(deck, "end", 0);
        if (d && !d.wasPlaying) backend().seek(deck, d.pos);
      }}
    />
  );
}

export function WaveStack({ decks }: { decks: number[] }) {
  const [zoom, setZoom] = useState(3);
  const seconds = ZOOMS[zoom];
  const h = decks.length > 2 ? 44 : 76;
  return (
    <div className="screen relative shrink-0 overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-950">
      {decks.map((d, i) => (
        <div key={d} className={clsx("relative", i > 0 && "border-t border-white/[0.06]")}>
          <div className="pointer-events-none absolute left-2 top-1.5 z-10 rounded px-1.5 text-[10px] font-bold text-zinc-950" style={{ background: DECK_COLORS[d] }}>
            {String.fromCharCode(65 + d)}
          </div>
          <Lane deck={d} seconds={seconds} height={h} />
        </div>
      ))}
      <div className="absolute right-2 top-1.5 z-10 flex items-center gap-0.5 rounded-md bg-black/60 p-0.5 text-zinc-300 backdrop-blur">
        <button className="rounded p-0.5 hover:bg-white/10" onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} title="Zoom out">
          <Minus size={12} />
        </button>
        <span className="w-7 text-center font-mono text-[10px]">{seconds}s</span>
        <button className="rounded p-0.5 hover:bg-white/10" onClick={() => setZoom((z) => Math.max(0, z - 1))} title="Zoom in">
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}
