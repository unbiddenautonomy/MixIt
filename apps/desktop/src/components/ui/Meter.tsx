// A level meter drawn from telemetry on every animation frame, with peak hold.
import { useEffect, useRef } from "react";
import { useTelemetry } from "../../store/telemetry";
import type { Telemetry } from "../../backend/types";

const toDb = (x: number) => (x > 1e-5 ? 20 * Math.log10(x) : -100);
/** dB to 0..1 meter height (−48 dB … +3 dB, more resolution near the top). */
const scale = (db: number) => Math.max(0, Math.min(1, (db + 48) / 51)) ** 1.4;

export function Meter({ read, height = 120, width = 6, channels = 2 }: { read: (t: Telemetry) => [number, number]; height?: number; width?: number; channels?: 1 | 2 }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = channels * width + (channels - 1) * 2;
    c.width = w * dpr;
    c.height = height * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const hold = [0, 0];
    const holdAt = [0, 0];
    const smooth = [0, 0];
    let raf = 0;
    const grad = g.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, "#22c55e");
    grad.addColorStop(scale(-12), "#84cc16");
    grad.addColorStop(scale(-6), "#eab308");
    grad.addColorStop(scale(-1), "#f97316");
    grad.addColorStop(1, "#ef4444");
    const draw = () => {
      const v = read(useTelemetry.getState().t);
      const now = performance.now();
      g.clearRect(0, 0, w, height);
      for (let i = 0; i < channels; i++) {
        const lvl = scale(toDb(v[i]));
        smooth[i] = lvl > smooth[i] ? lvl : smooth[i] * 0.92 + lvl * 0.08;
        if (lvl >= hold[i] || now - holdAt[i] > 1200) {
          hold[i] = lvl;
          holdAt[i] = now;
        }
        const x = i * (width + 2);
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(x, 0, width, height);
        g.fillStyle = grad;
        const hh = smooth[i] * height;
        g.fillRect(x, height - hh, width, hh);
        // Segment gaps for an LED look.
        g.fillStyle = "rgba(9,9,11,0.55)";
        for (let y = 3; y < height; y += 4) g.fillRect(x, y, width, 1);
        if (hold[i] > 0.02) {
          g.fillStyle = hold[i] > scale(-0.5) ? "#ef4444" : "#e4e4e7";
          g.fillRect(x, height - hold[i] * height, width, 2);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [read, height, width, channels]);
  return <canvas ref={ref} style={{ width: channels * width + (channels - 1) * 2, height }} />;
}
