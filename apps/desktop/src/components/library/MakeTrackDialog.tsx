// Make a track: a helper on this computer (ACE-Step) makes a new track from a
// description, and it lands in the library like any other. It is set up once, on
// request, because it is big (Python, its libraries and several GB of models).
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { backend } from "../../backend";
import type { MakeRequest, MakeStatus } from "../../backend/types";
import { useApp } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { Btn, Segmented } from "../ui/Button";
import { loadOnDeck } from "../deck/Deck";

const useMake = create<{ open: boolean; message: string; working: boolean }>(() => ({ open: false, message: "", working: false }));

export const openMakeTrack = () => useMake.setState({ open: true });

/** The browser build has no track maker, and the setting can turn it off. */
export function makeAvailable(): boolean {
  return backend().kind !== "web" && useApp.getState().settings?.makeTrack !== false;
}

const KEYS = ["", "C major", "G major", "D major", "A major", "E major", "F major", "B♭ major", "E♭ major", "A minor", "E minor", "B minor", "D minor", "G minor", "C minor", "F minor", "F♯ minor"];
const LENGTHS: { value: number; label: string }[] = [
  { value: 60, label: "1 min" },
  { value: 120, label: "2 min" },
  { value: 180, label: "3 min" },
  { value: 240, label: "4 min" },
];

/** The job's last message is JSON {trackId, path} when a track was made. */
export function madeTrack(message: string): { trackId: number; path: string } | null {
  try {
    const v = JSON.parse(message) as { trackId?: unknown; path?: unknown };
    return typeof v.trackId === "number" && typeof v.path === "string" ? { trackId: v.trackId, path: v.path } : null;
  } catch {
    return null;
  }
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  backend().onJob((j) => {
    if (j.kind !== "make") return;
    if (!j.finished) return useMake.setState({ working: true, message: j.message });
    useMake.setState({ working: false, message: "" });
    if (j.error) {
      if (j.error !== "Stopped") toast.error("The track maker stopped", { description: j.error });
      return;
    }
    const made = madeTrack(j.message);
    if (made) {
      const name = made.path.split(/[\\/]/).pop()?.replace(/\.wav$/i, "") ?? "The new track";
      toast.success(`“${name}” is in your library`, { description: "It is analysed when you first load it.", action: { label: "Load on deck A", onClick: () => void loadOnDeck(0, made.trackId) } });
    } else if (j.message) {
      toast.success(j.message);
    }
    void refreshStatus();
  });
}

const useStatus = create<{ status: MakeStatus | null }>(() => ({ status: null }));
async function refreshStatus() {
  try {
    useStatus.setState({ status: await backend().makeStatus() });
  } catch {
    /* shown as not set up */
  }
}

export function MakeTrackHost() {
  const open = useMake((s) => s.open);
  useEffect(() => {
    if (open) {
      listen();
      void refreshStatus();
    }
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => useMake.setState({ open: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
          aria-describedby={undefined}
          data-testid="make-track"
        >
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-[var(--accent)]" />
            <Dialog.Title className="text-base font-semibold text-zinc-50">Make a track</Dialog.Title>
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

function Working() {
  const message = useMake((s) => s.message);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs text-zinc-300">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
      <span className="min-w-0 flex-1 truncate">{message || "Working…"}</span>
      <Btn size="sm" tone="ghost" onClick={() => void backend().makeCancel()}>
        Stop
      </Btn>
    </div>
  );
}

function Body() {
  const status = useStatus((s) => s.status);
  const working = useMake((s) => s.working);
  if (!status) return <p className="text-sm text-zinc-400">Checking the track maker…</p>;
  if (!status.enabled) return <p className="text-sm text-zinc-400">Make a track is off. Turn it on in Settings, on the Mixing page.</p>;
  if (!status.installed) return <SetUp status={status} working={working} />;
  return <Form working={working} />;
}

function SetUp({ status, working }: { status: MakeStatus; working: boolean }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status.uvInstall);
      toast.success("Copied: paste it into Terminal");
    } catch {
      toast.error("Could not copy. Select the line and copy it instead.");
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-[13px] leading-snug text-zinc-400">
        Describe a track and MixIt makes it on this computer, with ACE-Step (free and open). It is a big helper, so it is set up only when you ask: about 5 GB for the program, then several GB of models the first time you make a track. It runs best on a Mac with Apple silicon or a computer with a graphics card.
      </p>
      {!status.uv && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs text-zinc-300">
          <span>First install uv, the small tool that sets up the helper's Python. Paste this into Terminal, then come back:</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all truncate rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-zinc-200">{status.uvInstall}</code>
            <Btn size="sm" onClick={() => void copy()}>
              <Copy size={12} /> Copy
            </Btn>
          </div>
        </div>
      )}
      {working ? (
        <Working />
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title={status.folder}>
            Into {status.folder}
          </span>
          <Btn tone="accent" onClick={() => void backend().makeInstall().catch((e) => toast.error(String(e)))}>
            Set it up
          </Btn>
        </div>
      )}
    </div>
  );
}

function Form({ working }: { working: boolean }) {
  const clock = useTelemetry.getState().t.clockBpm;
  const [r, setR] = useState<MakeRequest>({ description: "", lyrics: "", bpm: clock > 0 ? Math.round(clock) : 124, key: null, seconds: 180, name: "" });
  const [singing, setSinging] = useState(false);
  const set = (p: Partial<MakeRequest>) => setR((x) => ({ ...x, ...p }));
  const make = () =>
    void backend()
      .makeTrack({ ...r, lyrics: singing ? r.lyrics : "" })
      .catch((e) => toast.error(String(e)));
  const field = "rounded-md border border-white/10 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500";
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        What should it sound like?
        <textarea aria-label="What the track should sound like" rows={3} className={field} placeholder="Warm deep house with a rolling bassline, soft pads and a shuffling hi-hat" value={r.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="w-20 shrink-0">Voice</span>
        <Segmented
          value={singing ? "sing" : "inst"}
          onChange={(v) => setSinging(v === "sing")}
          options={[
            { value: "inst", label: "Instrumental", title: "No singing" },
            { value: "sing", label: "Singing", title: "Sung words you write" },
          ]}
        />
      </div>
      {singing && (
        <textarea aria-label="Words to sing" rows={4} className={field} placeholder={"[Verse]\nWords for the verse…\n\n[Chorus]\nWords for the chorus…"} value={r.lyrics} onChange={(e) => set({ lyrics: e.target.value })} />
      )}
      <div className="grid grid-cols-[5rem_1fr] items-center gap-x-2 gap-y-2 text-xs text-zinc-400">
        <span>Tempo</span>
        <div className="flex items-center gap-2">
          <input aria-label="Tempo in BPM" type="number" min={60} max={200} className={`${field} w-20`} value={r.bpm ?? ""} onChange={(e) => set({ bpm: e.target.value ? Number(e.target.value) : null })} />
          <span>BPM</span>
        </div>
        <span>Key</span>
        <select aria-label="Key" className={`${field} w-40`} value={r.key ?? ""} onChange={(e) => set({ key: e.target.value || null })}>
          {KEYS.map((k) => (
            <option key={k} value={k}>
              {k || "Let it choose"}
            </option>
          ))}
        </select>
        <span>Length</span>
        <Segmented value={r.seconds} onChange={(seconds) => set({ seconds })} options={LENGTHS} />
        <span>Name</span>
        <input aria-label="Track name" className={field} placeholder="From the description" value={r.name} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <p className="text-[11px] leading-snug text-zinc-500">The track is saved in your music folder under “Made” and added to the library. Before you play it in public, check it doesn't sound too close to someone else's song.</p>
      {working ? (
        <Working />
      ) : (
        <div className="flex justify-end">
          <Btn tone="accent" disabled={!r.description.trim()} onClick={make}>
            <Sparkles size={13} /> Make it
          </Btn>
        </div>
      )}
    </div>
  );
}
