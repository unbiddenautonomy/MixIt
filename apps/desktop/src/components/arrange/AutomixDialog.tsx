// Automix: turn a list of tracks into a finished mix project, with MixIt choosing the
// order, the transition points (phrase-aligned mix-in and mix-out), tempo and keys.
import * as Dialog from "@radix-ui/react-dialog";
import { Sparkles, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { backend } from "../../backend";
import type { AutomixRequest, TrackRow } from "../../backend/types";
import { bpm as fmtBpm, clock } from "../../lib/format";
import { keyLabel } from "../../lib/keys";
import { useApp, useNotation } from "../../store/app";
import { useLibrary } from "../../store/library";
import { Btn, Segmented } from "../ui/Button";
import { rowsById } from "../library/data";
import { beatToSeconds, confirmDiscard, projectBeats, setProject } from "./projectIo";

export function AutomixDialog() {
  const open = useApp((s) => s.automixOpen);
  const transitions = useApp((s) => s.transitions);
  const notation = useNotation();
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [o, setO] = useState<AutomixRequest>({ transition: "bassSwap", tempo: "follow", overlap: 32, harmonic: true, reorder: true, energy: "up", name: "My mix" });
  const [fixedBpm, setFixedBpm] = useState("124");

  // Tracks come from a "mixit:automix" event (playlist or selection), else the selection,
  // else the list on screen.
  useEffect(() => {
    const onEvt = (e: Event) => {
      const ids = (e as CustomEvent<number[]>).detail;
      rowsById(ids).then(setTracks);
    };
    window.addEventListener("mixit:automix", onEvt);
    return () => window.removeEventListener("mixit:automix", onEvt);
  }, []);
  useEffect(() => {
    if (!open || tracks.length > 0) return;
    const { selected, rows } = useLibrary.getState();
    if (selected.length > 1) rowsById(selected).then(setTracks);
    else setTracks(rows.slice(0, 12));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    useApp.getState().set({ automixOpen: false });
    setTracks([]);
  };

  const analysed = tracks.filter((t) => t.analysis === "done");
  const go = async () => {
    if (analysed.length < 2) {
      toast.error("Automix needs at least two analysed tracks.");
      return;
    }
    if (!(await confirmDiscard("make a new mix"))) return;
    setBusy(true);
    try {
      const req = { ...o, tempo: o.tempo === "fixed" ? fixedBpm : o.tempo };
      const p = await backend().automix(
        analysed.map((t) => t.id),
        req,
      );
      setProject(p, null);
      const secs = beatToSeconds(p, projectBeats(p));
      toast.success(`Made “${p.name}”`, { description: `${p.clips.length} tracks, ${clock(secs)}. Listen, tweak, then render it.` });
      useApp.getState().set({ workspace: "arrange" });
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tr = transitions.find((t) => t.id === o.transition);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? useApp.getState().set({ automixOpen: true }) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(760px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-4">
            <Wand2 size={18} className="text-sky-300" />
            <Dialog.Title className="text-base font-semibold text-zinc-50">Automix</Dialog.Title>
            <Dialog.Description className="ml-2 text-xs text-zinc-400">MixIt plans a whole mix: order, transitions on phrase boundaries, tempo and keys.</Dialog.Description>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[1fr_280px] overflow-hidden">
            <div className="min-h-0 overflow-y-auto border-r border-white/[0.06] p-3">
              <div className="mb-2 flex items-center justify-between text-[11px] text-zinc-400">
                <span>
                  {analysed.length} of {tracks.length} tracks ready
                </span>
                {tracks.length !== analysed.length && <span className="text-amber-300">Tracks that are not analysed yet are skipped</span>}
              </div>
              {tracks.length === 0 && <p className="p-6 text-center text-sm text-zinc-500">Select tracks in the library (or right-click a playlist) and open Automix again.</p>}
              {tracks.map((t, i) => (
                <div key={t.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-white/[0.04]">
                  <span className="w-5 text-right font-mono text-[10px] text-zinc-600">{i + 1}</span>
                  <span className={`min-w-0 flex-1 truncate ${t.analysis === "done" ? "text-zinc-200" : "text-zinc-600"}`}>
                    {t.title} <span className="text-zinc-500">· {t.artist}</span>
                  </span>
                  <span className="font-mono text-[11px] text-zinc-400">{fmtBpm(t.bpm)}</span>
                  <span className="w-8 font-mono text-[11px] text-zinc-400">{keyLabel(t.key, notation)}</span>
                  <button type="button" className="text-zinc-600 hover:text-zinc-200" onClick={() => setTracks(tracks.filter((x) => x.id !== t.id))} aria-label="Remove">
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-3 overflow-y-auto p-4 text-xs">
              <Label text="Name">
                <input className="input h-8 w-full" value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} />
              </Label>
              <Label text="Transitions" hint={tr?.explain}>
                <select className="input h-8 w-full" value={o.transition} onChange={(e) => setO({ ...o, transition: e.target.value })}>
                  {transitions.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Label>
              <Label text="Overlap" hint="How long two tracks play together in each transition.">
                <Segmented value={o.overlap} onChange={(v) => setO({ ...o, overlap: v })} options={[8, 16, 32, 64].map((b) => ({ value: b, label: `${b} beats` }))} />
              </Label>
              <Label text="Tempo" hint={o.tempo === "follow" ? "The mix glides from each track's tempo to the next." : o.tempo === "first" ? "Everything plays at the first track's tempo." : "Everything plays at one tempo."}>
                <div className="flex items-center gap-2">
                  <Segmented
                    value={o.tempo}
                    onChange={(v) => setO({ ...o, tempo: v })}
                    options={[
                      { value: "follow", label: "Follow" },
                      { value: "first", label: "First track" },
                      { value: "fixed", label: "Fixed" },
                    ]}
                  />
                  {o.tempo === "fixed" && <input className="input h-7 w-16 font-mono" value={fixedBpm} onChange={(e) => setFixedBpm(e.target.value)} />}
                </div>
              </Label>
              <Label text="Order">
                <label className="flex items-center gap-2 text-zinc-300">
                  <input type="checkbox" checked={o.reorder} onChange={(e) => setO({ ...o, reorder: e.target.checked })} />
                  Reorder for smooth keys and tempo
                </label>
                {o.reorder && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-zinc-500">Energy</span>
                    <Segmented
                      value={o.energy}
                      onChange={(v) => setO({ ...o, energy: v })}
                      options={[
                        { value: "up", label: "Build up" },
                        { value: "steady", label: "Steady" },
                        { value: "down", label: "Wind down" },
                      ]}
                    />
                  </div>
                )}
              </Label>
              <label className="flex items-center gap-2 text-zinc-300">
                <input type="checkbox" checked={o.harmonic} onChange={(e) => setO({ ...o, harmonic: e.target.checked })} />
                Shift keys so every transition is in key
              </label>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
            <Btn tone="ghost" onClick={close}>
              Cancel
            </Btn>
            <Btn tone="accent" style={{ ["--accent" as string]: "#38bdf8" }} disabled={busy || analysed.length < 2} onClick={go}>
              <Sparkles size={13} /> {busy ? "Planning…" : "Make the mix"}
            </Btn>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Label({ text, hint, children }: { text: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{text}</div>
      {children}
      {hint && <div className="text-[11px] leading-snug text-zinc-500">{hint}</div>}
    </div>
  );
}
