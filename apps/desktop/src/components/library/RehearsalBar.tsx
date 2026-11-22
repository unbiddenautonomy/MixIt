// The mix being heard first (from the Auto DJ queue or a suggestion): play and pause,
// where it is with the transition marked, jump to the mix, close. Sits under the
// library like the preview player, which plays it.
import { Headphones, Loader2, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { setupCanvas } from "../../lib/waveform";
import { changeAt, nextChange, seekMix, stopMix, toggleMix, useRehearse } from "../../store/rehearse";
import { useTelemetry } from "../../store/telemetry";
import { Btn } from "../ui/Button";
import { previewPosition } from "./PreviewBar";

/** The mix being heard: play and pause, where it is (the transition marked), jump to the mix. */
export function RehearsalBar() {
  const key = useRehearse((s) => s.key);
  const status = useRehearse((s) => s.status);
  const title = useRehearse((s) => s.title);
  const summary = useRehearse((s) => s.summary);
  const mixAt = useRehearse((s) => s.mixAt);
  const many = useRehearse((s) => s.changes.length > 1);
  const playing = useTelemetry((s) => !!s.t.preview?.playing);
  if (key === null) return null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-white/[0.06] bg-sky-400/[0.06] px-3 py-2" data-testid="rehearsal-bar">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggleMix}
          disabled={status !== "ready"}
          aria-label={playing ? "Pause the mix" : "Play the mix"}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-400 text-zinc-950 hover:brightness-110 disabled:opacity-60"
        >
          {status === "loading" ? <Loader2 size={14} className="animate-spin" /> : playing ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
        </button>
        <Headphones size={14} className="shrink-0 text-sky-300" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-zinc-100">{title}</div>
          <div className="truncate text-[11px] text-zinc-400">{status === "loading" ? (many ? "Preparing every change… a long set takes a little while" : "Preparing the mix…") : many ? <NowHearing /> : `${summary}, the way Auto DJ mixes it`}</div>
        </div>
        {many ? (
          <Btn size="sm" tone="ghost" disabled={status !== "ready"} onClick={() => nextChange(previewPosition())} title="Jump to a few seconds before the next change" data-testid="next-change">
            Next change
          </Btn>
        ) : (
          <Btn size="sm" tone="ghost" disabled={status !== "ready"} onClick={() => seekMix(Math.max(0, mixAt - 4))} title="Jump to a few seconds before the transition starts">
            Jump to the mix
          </Btn>
        )}
        <button type="button" onClick={stopMix} aria-label="Stop hearing the mix" title="Stop and close" className="flex size-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-100">
          <X size={14} />
        </button>
      </div>
      <MixStrip />
    </div>
  );
}

/** Which change of the set is playing, updated as it plays. */
function NowHearing() {
  const changes = useRehearse((s) => s.changes);
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setI(changeAt(previewPosition())), 250);
    return () => window.clearInterval(id);
  }, []);
  const c = changes[i];
  return <span data-testid="now-hearing">{c ? `Change ${i + 1} of ${changes.length}: ${c.label}` : ""}</span>;
}

function MixStrip() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = ref.current;
      const s = useRehearse.getState();
      if (c) {
        const g = setupCanvas(c);
        const r = c.getBoundingClientRect();
        const dur = s.duration || Math.max(1, s.mixEnd + 8);
        g.clearRect(0, 0, r.width, r.height);
        g.fillStyle = "rgba(255,255,255,0.06)";
        g.fillRect(0, r.height / 2 - 1, r.width, 2);
        // The transition: where both tracks play.
        g.fillStyle = "rgba(56,189,248,0.35)";
        for (const m of s.changes.length ? s.changes : [{ at: s.mixAt, end: s.mixEnd }]) g.fillRect((m.at / dur) * r.width, 2, Math.max(2, ((m.end - m.at) / dur) * r.width), r.height - 4);
        if (s.status === "ready") {
          const x = (previewPosition() / dur) * r.width;
          g.fillStyle = "#fafafa";
          g.fillRect(x - 0.75, 0, 1.5, r.height);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  const seekAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekMix(((e.clientX - r.left) / r.width) * useRehearse.getState().duration);
  };
  return (
    <canvas
      ref={ref}
      className="h-5 w-full cursor-pointer rounded"
      aria-label="Where the mix is: the blue part is the transition. Click to jump."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekAt(e);
      }}
      data-testid="rehearsal-strip"
    />
  );
}

