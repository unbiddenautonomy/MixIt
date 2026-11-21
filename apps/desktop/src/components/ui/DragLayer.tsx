// What follows the pointer while tracks are dragged, and the hint while files from outside
// hover the window: what is being dragged and what dropping it here will do.
import { FileAudio, Music2 } from "lucide-react";
import { useEffect } from "react";
import { installFileDrop, labelFor, useDrag } from "../../lib/dnd";

export function DragLayer() {
  const kind = useDrag((s) => s.kind);
  const x = useDrag((s) => s.x);
  const y = useDrag((s) => s.y);
  const text = useDrag((s) => s.text);
  const over = useDrag((s) => s.over);
  useEffect(() => installFileDrop(), []);
  if (!kind) return null;
  // Near the right or bottom edge the hint goes to the other side of the pointer.
  const pos = {
    ...(x > window.innerWidth - 310 ? { right: window.innerWidth - x + 14 } : { left: x + 14 }),
    ...(y > window.innerHeight - 70 ? { bottom: window.innerHeight - y + 14 } : { top: y + 14 }),
  };
  const action = over ? labelFor(over) : kind === "files" ? "Drop anywhere to add to your library" : null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[80]" aria-hidden>
      {kind === "files" && <div className="absolute inset-2 rounded-2xl border-2 border-dashed border-sky-400/40 bg-sky-400/[0.03]" />}
      <div className="absolute flex max-w-72 items-center gap-2 rounded-lg border border-white/15 bg-zinc-900/95 px-2.5 py-1.5 text-xs shadow-2xl" style={pos}>
        {kind === "files" ? <FileAudio size={13} className="shrink-0 text-sky-300" /> : <Music2 size={13} className="shrink-0 text-sky-300" />}
        <div className="min-w-0">
          {text && <div className="truncate text-zinc-100">{text}</div>}
          <div className={action ? "text-sky-300" : "text-zinc-500"}>{action ?? "Drop on a deck, a pad, a playlist or the timeline"}</div>
        </div>
      </div>
    </div>
  );
}
