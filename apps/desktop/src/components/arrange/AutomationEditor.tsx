// Drawing automation on a clip: click to add a point, drag to move it, double-click (or
// right-click) to delete it. Points snap to beats; hold Shift for quarter beats.
import { useRef, useState } from "react";
import { create } from "zustand";
import type { AutomationLane, AutomationPoint, Clip, CurveShape, ProjectParam } from "../../backend/types";
import { useApp } from "../../store/app";
import { updateClip } from "./projectIo";

export const PARAM_COLORS: Record<ProjectParam, string> = { Volume: "#f4f4f5", EqLow: "#405cff", EqMid: "#ffa630", EqHigh: "#ecf6ff", Filter: "#e879f9", FxMix: "#34d399", Pan: "#fde047", Space: "#a78bfa", Echo: "#22d3ee" };
export const PARAM_RANGE: Record<ProjectParam, [number, number]> = { Volume: [0, 1], EqLow: [-26, 6], EqMid: [-26, 6], EqHigh: [-26, 6], Filter: [-1, 1], FxMix: [0, 1], Pan: [-1, 1], Space: [0, 1], Echo: [0, 1] };
export const PARAM_LABEL: Record<ProjectParam, string> = { Volume: "Volume", EqLow: "Low EQ", EqMid: "Mid EQ", EqHigh: "High EQ", Filter: "Filter", FxMix: "FX amount", Pan: "Pan", Space: "Reverb send", Echo: "Echo send" };
/** Value a new lane starts at (the control's resting position). */
export const PARAM_DEFAULT: Record<ProjectParam, number> = { Volume: 1, EqLow: 0, EqMid: 0, EqHigh: 0, Filter: 0, FxMix: 0, Pan: 0, Space: 0, Echo: 0 };

/** Which lane of the selected clip is being edited. */
export const useAutoEdit = create<{ param: ProjectParam | null }>(() => ({ param: null }));

export function formatParam(param: ProjectParam, v: number): string {
  if (param === "Volume" || param === "FxMix") return `${Math.round(v * 100)}%`;
  if (param === "Filter") return Math.abs(v) < 0.02 ? "off" : v < 0 ? `low-pass ${Math.round(-v * 100)}%` : `high-pass ${Math.round(v * 100)}%`;
  return v <= -25.5 ? "cut" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
}

/** Inserts or moves a point, keeping the lane sorted and one point per beat position. */
export function withPoint(points: AutomationPoint[], p: AutomationPoint, replace?: number): AutomationPoint[] {
  const rest = points.filter((x, i) => i !== replace && Math.abs(x.beat - p.beat) > 1e-6);
  return [...rest, p].sort((a, b) => a.beat - b.beat);
}

export function setLane(clip: Clip, param: ProjectParam, points: AutomationPoint[]) {
  const others = clip.lanes.filter((l) => l.param !== param);
  updateClip(clip.id, { lanes: [...others, { param, points }] });
}

export function setLaneCurve(clip: Clip, param: ProjectParam, curve: CurveShape) {
  const lane = clip.lanes.find((l) => l.param === param);
  if (lane) setLane(clip, param, lane.points.map((p) => ({ ...p, curve })));
}

export function AutomationEditor({ clip, ppb, height, param }: { clip: Clip; ppb: number; height: number; param: ProjectParam }) {
  const lane: AutomationLane = clip.lanes.find((l) => l.param === param) ?? { param, points: [] };
  const [lo, hi] = PARAM_RANGE[param];
  const w = clip.length * ppb;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const yOf = (v: number) => height - 4 - ((v - lo) / (hi - lo)) * (height - 8);
  const xOf = (beat: number) => (beat - clip.start) * ppb;
  const fromEvent = (e: React.PointerEvent | React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const snap = e.shiftKey ? 0.25 : 1;
    const beat = clip.start + Math.max(0, Math.min(clip.length, Math.round((e.clientX - r.left) / ppb / snap) * snap));
    const frac = 1 - (e.clientY - r.top - 4) / (height - 8);
    let value = lo + Math.max(0, Math.min(1, frac)) * (hi - lo);
    // Snap to the resting value and the ends so "off" and "full" are easy to hit.
    for (const s of [lo, hi, PARAM_DEFAULT[param]]) if (Math.abs(value - s) < (hi - lo) * 0.03) value = s;
    return { beat, value, x: (beat - clip.start) * ppb, y: yOf(value) };
  };
  const curve = lane.points[0]?.curve ?? "Linear";
  const pts = lane.points.map((p) => `${xOf(p.beat).toFixed(1)},${yOf(p.value).toFixed(1)}`);
  if (lane.points.length) {
    pts.unshift(`0,${yOf(lane.points[0].value).toFixed(1)}`);
    pts.push(`${w.toFixed(1)},${yOf(lane.points[lane.points.length - 1].value).toFixed(1)}`);
  }
  const color = PARAM_COLORS[param];
  return (
    <svg
      ref={svg}
      className="absolute inset-0 z-10 cursor-crosshair"
      width={w}
      height={height}
      role="application"
      aria-label={`${PARAM_LABEL[param]} automation. Click to add a point, drag to move, double-click to delete.`}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const p = fromEvent(e);
        const points = withPoint(lane.points, { beat: p.beat, value: p.value, curve });
        setLane(clip, param, points);
        drag.current = { index: points.findIndex((x) => x.beat === p.beat), moved: false };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const p = fromEvent(e);
        setHover({ x: p.x, y: p.y, text: `${formatParam(param, p.value)} · beat ${(p.beat - clip.start + 1).toFixed(e.shiftKey ? 2 : 0)}` });
        const d = drag.current;
        if (!d) return;
        e.stopPropagation();
        const cur = (latestLane(clip.id, param) ?? lane).points;
        const points = withPoint(cur, { beat: p.beat, value: p.value, curve }, d.index);
        d.index = points.findIndex((x) => x.beat === p.beat);
        d.moved = true;
        setLane(clip, param, points);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => setHover(null)}
    >
      <rect width={w} height={height} fill="rgba(0,0,0,0.35)" />
      <line x1={0} x2={w} y1={yOf(PARAM_DEFAULT[param])} y2={yOf(PARAM_DEFAULT[param])} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
      {lane.points.length > 0 && <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} />}
      {lane.points.map((p, i) => (
        <circle
          key={`${p.beat}`}
          cx={xOf(p.beat)}
          cy={yOf(p.value)}
          r={5}
          fill={color}
          stroke="#09090b"
          strokeWidth={1.5}
          className="cursor-grab"
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.button !== 0) return;
            drag.current = { index: i, moved: false };
            (svg.current as Element).setPointerCapture(e.pointerId);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setLane(clip, param, lane.points.filter((_, j) => j !== i));
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setLane(clip, param, lane.points.filter((_, j) => j !== i));
          }}
        />
      ))}
      {hover && !drag.current && <circle cx={hover.x} cy={hover.y} r={3} fill="none" stroke={color} />}
      {hover && (
        <text x={Math.min(w - 4, Math.max(4, hover.x + 8))} y={Math.max(12, hover.y - 8)} fill="#f4f4f5" fontSize={10} textAnchor={hover.x > w - 120 ? "end" : "start"} style={{ paintOrder: "stroke", stroke: "#09090b", strokeWidth: 3 }}>
          {hover.text}
        </text>
      )}
    </svg>
  );
}

/** The latest version of a clip's lane, read from the store so a drag sees its own edits. */
function latestLane(clipId: number, param: ProjectParam): AutomationLane | undefined {
  return useApp.getState().project?.clips.find((c) => c.id === clipId)?.lanes.find((l) => l.param === param);
}
