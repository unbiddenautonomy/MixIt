// The studio EQ drawn over the live spectrum. Drag a dot to move a band (sideways for
// the pitch, up and down for boost or cut), scroll on it for a narrower or wider band,
// double-click empty space to add one, and double-click a dot to switch it off.
import { useEffect, useRef, useState } from "react";
import type { BandDto, StudioDto } from "../../backend/types";
import { BAND_SLOTS, EQ_RANGE, bandDb, eqDb, fmtHz, freqToX, hasGain, xToFreq } from "../../lib/studio";
import { useTelemetry } from "../../store/telemetry";
import { useDevicePixelRatio } from "../../lib/dpr";

/** Display range of the curve (dB). */
const DB = 18;
const BAND_COLORS = ["#f472b6", "#fb923c", "#facc15", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#e879f9"];

export interface EqGraphProps {
  settings: StudioDto;
  onChange: (bands: BandDto[]) => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
  height?: number;
  color?: string;
}

const yOf = (db: number, h: number) => h / 2 - (db / DB) * (h / 2 - 8);
const dbOf = (y: number, h: number) => ((h / 2 - y) / (h / 2 - 8)) * DB;

/** Where a band's dot sits: its gain for bells and shelves, the 0 dB line for the rest. */
function dotDb(b: BandDto): number {
  return hasGain(b.shape) ? b.gainDb : 0;
}

export function EqGraph({ settings, onChange, selected, onSelect, height = 220, color = "#38bdf8" }: EqGraphProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ratio = useDevicePixelRatio();
  const [width, setWidth] = useState(600);
  const live = useRef(settings);
  live.current = settings;
  const sel = useRef(selected);
  sel.current = selected;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Spectrum and curve, redrawn every frame.
  useEffect(() => {
    const c = canvas.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const smooth = new Float32Array(96).fill(-120);
    let raf = 0;
    const draw = () => {
      const s = live.current;
      const w = width;
      const h = height;
      g.clearRect(0, 0, w, h);
      // Grid: octaves and 6 dB steps.
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.lineWidth = 1;
      g.font = "10px ui-sans-serif, system-ui";
      g.fillStyle = "rgba(255,255,255,0.3)";
      for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10_000]) {
        const x = freqToX(f) * w;
        g.beginPath();
        g.moveTo(x + 0.5, 0);
        g.lineTo(x + 0.5, h);
        g.stroke();
        g.fillText(fmtHz(f).replace(" ", ""), x + 3, h - 4);
      }
      for (let db = -DB + 6; db < DB; db += 6) {
        const y = yOf(db, h);
        g.strokeStyle = db === 0 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
        g.beginPath();
        g.moveTo(0, y + 0.5);
        g.lineTo(w, y + 0.5);
        g.stroke();
        if (db !== 0) g.fillText(`${db > 0 ? "+" : ""}${db}`, 3, y - 2);
      }
      // Spectrum: fast up, slow down.
      const sp = useTelemetry.getState().t.spectrum;
      if (sp && sp.length) {
        for (let k = 0; k < smooth.length; k++) {
          const v = sp[k] ?? -120;
          smooth[k] = v > smooth[k] ? v : smooth[k] * 0.85 + v * 0.15;
        }
        // −80 … 0 dB of spectrum fills the graph from the bottom.
        g.beginPath();
        g.moveTo(0, h);
        for (let k = 0; k < smooth.length; k++) {
          const x = ((k + 0.5) / smooth.length) * w;
          const y = h - Math.max(0, Math.min(1, (smooth[k] + 80) / 80)) * (h - 10);
          g.lineTo(x, y);
        }
        g.lineTo(w, h);
        g.closePath();
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "rgba(148,163,184,0.35)");
        grad.addColorStop(1, "rgba(148,163,184,0.05)");
        g.fillStyle = grad;
        g.fill();
      }
      // Each band's own shape, faintly, then the total.
      const steps = Math.max(120, Math.floor(w / 2));
      s.bands.forEach((b, i) => {
        if (!b.enabled || !s.eqOn) return;
        g.beginPath();
        for (let k = 0; k <= steps; k++) {
          const x = (k / steps) * w;
          const y = yOf(Math.max(-DB - 6, Math.min(DB + 6, bandDb(b, xToFreq(k / steps)))), h);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokeStyle = BAND_COLORS[i] + (sel.current === i ? "cc" : "55");
        g.lineWidth = sel.current === i ? 1.5 : 1;
        g.stroke();
      });
      g.beginPath();
      for (let k = 0; k <= steps; k++) {
        const x = (k / steps) * w;
        const y = yOf(Math.max(-DB - 6, Math.min(DB + 6, eqDb(s, xToFreq(k / steps)))), h);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = s.eqOn ? color : "rgba(255,255,255,0.25)";
      g.lineWidth = 2;
      g.stroke();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [width, height, color, ratio]);

  const drag = useRef<{ i: number; id: number } | null>(null);

  const pointAt = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: e.clientY - r.top, h: r.height };
  };

  const setBand = (i: number, p: Partial<BandDto>) => {
    const bands = live.current.bands.map((b, j) => (j === i ? { ...b, ...p } : b));
    onChange(bands);
  };

  const hit = (x: number, y: number, h: number): number | null => {
    let best: number | null = null;
    let bestD = 14;
    live.current.bands.forEach((b, i) => {
      if (!b.enabled) return;
      const dx = (freqToX(b.freq) - x) * width;
      const dy = yOf(dotDb(b), h) - y;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const add = (x: number, y: number, h: number) => {
    const bands = live.current.bands;
    const free = bands.findIndex((b) => !b.enabled);
    if (free < 0) return;
    const f = xToFreq(x);
    const shape = f < 40 ? "lowCut" : f > 16_000 ? "highCut" : "bell";
    const nb: BandDto = { enabled: true, shape, freq: Math.round(f), q: shape === "bell" ? 1 : Math.SQRT1_2, gainDb: shape === "bell" ? Math.round(dbOf(y, h) * 2) / 2 : 0, slopeDb: 12 };
    onChange(bands.map((b, j) => (j === free ? nb : b)));
    onSelect(free);
  };

  return (
    <div ref={wrap} className="relative w-full select-none">
      <canvas
        ref={canvas}
        className="block w-full cursor-crosshair rounded-lg bg-black/40"
        style={{ height }}
        aria-label="EQ curve"
        onPointerDown={(e) => {
          const p = pointAt(e);
          const i = hit(p.x, p.y, p.h);
          onSelect(i);
          if (i === null) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { i, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const p = pointAt(e);
          const b = live.current.bands[d.i];
          const fine = e.shiftKey ? 0.25 : 1;
          const freq = Math.round(Math.max(EQ_RANGE[0], Math.min(EQ_RANGE[1], xToFreq(p.x))));
          const gain = hasGain(b.shape) ? Math.max(-DB, Math.min(DB, Math.round(dbOf(p.y, p.h) * 2 * fine) / (2 * fine))) : b.gainDb;
          setBand(d.i, { freq, gainDb: gain });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const p = pointAt(e);
          const i = hit(p.x, p.y, p.h);
          if (i !== null) {
            setBand(i, { enabled: false });
            onSelect(null);
          } else add(p.x, p.y, p.h);
        }}
        onWheel={(e) => {
          const p = pointAt(e);
          const i = hit(p.x, p.y, p.h) ?? selected;
          if (i === null) return;
          const b = live.current.bands[i];
          if (!b.enabled) return;
          const q = Math.max(0.1, Math.min(18, b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
          setBand(i, { q: Math.round(q * 100) / 100 });
        }}
      />
      {/* Dots, as buttons so they can be reached and read without a mouse. */}
      {settings.bands.map((b, i) =>
        b.enabled ? (
          <button
            key={i}
            type="button"
            aria-label={`Band ${i + 1}: ${b.shape}, ${fmtHz(b.freq)}${hasGain(b.shape) ? `, ${b.gainDb > 0 ? "+" : ""}${b.gainDb} dB` : ""}`}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => {
              const k = e.key;
              const step = e.shiftKey ? 0.1 : 0.5;
              if (k === "ArrowLeft" || k === "ArrowRight") setBand(i, { freq: Math.round(Math.max(20, Math.min(20_000, b.freq * Math.pow(2, (k === "ArrowRight" ? 1 : -1) / 12)))) });
              else if ((k === "ArrowUp" || k === "ArrowDown") && hasGain(b.shape)) setBand(i, { gainDb: Math.max(-DB, Math.min(DB, b.gainDb + (k === "ArrowUp" ? step : -step))) });
              else if (k === "Delete" || k === "Backspace") setBand(i, { enabled: false });
              else return;
              e.preventDefault();
            }}
            className="pointer-events-none absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-[9px] font-bold text-zinc-950 focus-visible:pointer-events-auto"
            style={{
              left: `${freqToX(b.freq) * 100}%`,
              top: yOf(dotDb(b), height),
              background: BAND_COLORS[i],
              borderColor: selected === i ? "white" : "rgba(0,0,0,0.4)",
              opacity: settings.eqOn ? 1 : 0.4,
            }}
          >
            {i + 1}
          </button>
        ) : null,
      )}
      {settings.bands.every((b) => !b.enabled) && (
        <div className="pointer-events-none absolute inset-x-0 top-6 flex justify-center"><span className="rounded-full bg-zinc-900/90 px-3 py-1 text-xs text-zinc-400">Double-click to add a band, or pick a preset.</span></div>
      )}
    </div>
  );
}

export { BAND_COLORS, BAND_SLOTS };
