// Sound to notes: the note listener hears the notes a pad plays (a riff, a bassline, a
// hummed tune) and the sequencer plays them back on any pad, each square at its pitch.
import * as Dialog from "@radix-ui/react-dialog";
import { Music, X } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import { backend } from "../../backend";
import type { PadNotes } from "../../backend/types";
import { useApp } from "../../store/app";
import { MAX_PITCH, noteName, notesToPattern, setRow, useSequencer } from "../../store/sequencer";
import { useTelemetry } from "../../store/telemetry";
import { Btn } from "../ui/Button";
import { toast } from "sonner";

const usePadNotes = create<{ open: boolean }>(() => ({ open: false }));

export const openPadNotes = () => usePadNotes.setState({ open: true });

/** The browser build has no note listener, and the setting can turn it off. */
export function notesAvailable(): boolean {
  return backend().kind !== "web" && useApp.getState().settings?.soundToNotes !== false;
}

export function PadNotesDialog() {
  const open = usePadNotes((s) => s.open);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => usePadNotes.setState({ open: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex w-[min(460px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
          aria-describedby={undefined}
          data-testid="pad-notes"
        >
          <div className="flex items-center gap-2">
            <Music size={16} className="text-[var(--accent)]" />
            <Dialog.Title className="text-base font-semibold text-zinc-50">Turn a pad's notes into a pattern</Dialog.Title>
            <Dialog.Close className="ml-auto rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
              <X size={15} />
            </Dialog.Close>
          </div>
          {open && <Body />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const selectClass = "h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-zinc-800 px-1.5 text-xs text-zinc-200";

function Body() {
  const pads = useApp((s) => s.pads);
  const stepBeats = useSequencer((s) => s.stepBeats);
  const filled = pads.filter((p) => p.source.type !== "empty");
  const [from, setFrom] = useState(filled[0]?.pad ?? 0);
  const [to, setTo] = useState(filled.find((p) => p.pad !== filled[0]?.pad)?.pad ?? filled[0]?.pad ?? 0);
  const [heard, setHeard] = useState<PadNotes | null>(null);
  const [root, setRoot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (filled.length === 0) return <p className="text-sm text-zinc-400">Put a sound on a pad first: a riff, a bassline or a tune you recorded with the mic.</p>;

  const bpm = heard?.bpm ?? (useTelemetry.getState().t.clockBpm || 120);
  const pattern = heard && heard.notes.length > 0 ? notesToPattern(heard.notes, bpm, stepBeats, root ?? undefined) : null;
  const pitches = heard?.notes.map((n) => n.pitch) ?? [];
  const low = Math.min(...pitches);
  const high = Math.max(...pitches);

  const listen = async () => {
    setBusy(true);
    setError(null);
    try {
      const h = await backend().padNotes(from);
      setHeard(h);
      setRoot(null);
      if (h.notes.length === 0) setError("No clear notes in that sound. Notes work best from one instrument or voice at a time.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const place = () => {
    if (!pattern) return;
    setRow(to, pattern.row, pattern.pitches, pattern.steps);
    usePadNotes.setState({ open: false });
    const name = pads[to]?.name ?? `Pad ${to + 1}`;
    toast.success(`${pattern.placed} notes are on ${name}'s row`, {
      description: pattern.dropped ? `${pattern.dropped} left out: only one note fits on a square, and the pattern holds 64 squares.` : "Press Play in the sequencer to hear them.",
    });
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-[13px] leading-snug text-zinc-400">MixIt listens to a pad's sound, writes down the notes it plays, and lays them on the sequencer's squares, each at its own pitch, so another pad can play the same tune.</p>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <span className="w-24 shrink-0">Listen to</span>
        <select aria-label="Pad to listen to" className={selectClass} value={from} onChange={(e) => (setFrom(Number(e.target.value)), setHeard(null))}>
          {filled.map((p) => (
            <option key={p.pad} value={p.pad}>
              Pad {p.pad + 1}: {p.name}
            </option>
          ))}
        </select>
        <Btn size="sm" tone="accent" disabled={busy} onClick={() => void listen()}>
          {busy ? "Listening…" : "Listen"}
        </Btn>
      </label>
      {error && <p className="text-xs text-amber-300">{error}</p>}
      {pattern && heard && (
        <>
          <p className="text-xs text-zinc-300" data-testid="pad-notes-heard">
            Heard {heard.notes.length} notes, from {noteName(low)} to {noteName(high)}, laid on {pattern.steps} squares at {Math.round(bpm)} BPM.
          </p>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <span className="w-24 shrink-0">Play them on</span>
            <select aria-label="Pad to play the notes" className={selectClass} value={to} onChange={(e) => setTo(Number(e.target.value))}>
              {filled.map((p) => (
                <option key={p.pad} value={p.pad}>
                  Pad {p.pad + 1}: {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300" title="The note the pad's sound already plays. That note plays it as recorded; the others play it higher or lower.">
            <span className="w-24 shrink-0">Its sound is</span>
            <select aria-label="Note the pad's sound plays" className={selectClass} value={pattern.root} onChange={(e) => setRoot(Number(e.target.value))}>
              {Array.from({ length: high - low + 1 + 2 * 12 }, (_, i) => low - 12 + i).map((m) => (
                <option key={m} value={m}>
                  {noteName(m)}
                </option>
              ))}
            </select>
          </label>
          {Math.max(high - pattern.root, pattern.root - low) > MAX_PITCH && <p className="text-[11px] text-zinc-500">Notes more than two octaves away move by an octave to stay in range.</p>}
          <div className="flex justify-end gap-2">
            <Btn size="sm" onClick={() => usePadNotes.setState({ open: false })}>
              Cancel
            </Btn>
            <Btn size="sm" tone="accent" onClick={place}>
              Put them on the squares
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}
