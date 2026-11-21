// The bar across the top: workspaces, the master clock and level, recording, engine
// health, and the Easy/Pro, explain, coach, palette and settings switches.
import clsx from "clsx";
import { AlertTriangle, Circle, Command, Grid2x2, GraduationCap, HelpCircle, Settings as Gear, Square } from "lucide-react";
import { toggleRecording, updateSettings } from "../../lib/appCommands";
import { isMac } from "../../lib/actions";
import { clock } from "../../lib/format";
import { useApp, type Workspace } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Meter } from "../ui/Meter";

export function TopBar() {
  const workspace = useApp((s) => s.workspace);
  const settings = useApp((s) => s.settings);
  const explain = useApp((s) => s.explain);
  const samplerOpen = useApp((s) => s.samplerOpen);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-zinc-950/80 px-3 backdrop-blur" data-tauri-drag-region>
      <div className="flex items-center gap-2 pr-1">
        <Logo />
        <span className="text-sm font-bold tracking-tight text-zinc-100">MixIt</span>
      </div>
      <Segmented<Workspace>
        value={workspace}
        onChange={(w) => useApp.getState().set({ workspace: w })}
        options={[
          { value: "mix", label: "Mix", title: `Decks and mixer (${isMac ? "⌘" : "Ctrl+"}2)` },
          { value: "library", label: "Library", title: `Your music (${isMac ? "⌘" : "Ctrl+"}1)` },
          { value: "arrange", label: "Arrange", title: `Build a mix on a timeline (${isMac ? "⌘" : "Ctrl+"}3)` },
        ]}
      />
      <MasterClock />
      <div className="ml-auto flex items-center gap-2">
        <Health />
        <Record />
        <div className="h-5 w-px bg-white/10" />
        <Ctl id="app.view_mode" side="bottom">
          <Segmented
            value={settings?.viewMode ?? "easy"}
            onChange={(v) => updateSettings({ viewMode: v })}
            options={[
              { value: "easy", label: "Easy" },
              { value: "pro", label: "Pro" },
            ]}
          />
        </Ctl>
        <Ctl id="app.sampler" side="bottom">
          <Btn
            size="sm"
            tone="ghost"
            active={samplerOpen && workspace === "mix"}
            onClick={() => useApp.getState().set(workspace === "mix" ? { samplerOpen: !samplerOpen } : { workspace: "mix", samplerOpen: true })}
            aria-label="Sampler and master FX"
          >
            <Grid2x2 size={14} />
          </Btn>
        </Ctl>
        <Ctl id="app.explain" side="bottom" label="Explain mode" explain="Shows what every control does. Hover anything. Hold ? for a quick look.">
          <Btn size="sm" tone="ghost" active={explain} onClick={() => useApp.getState().set({ explain: !explain })} aria-label="Explain mode">
            <HelpCircle size={14} />
          </Btn>
        </Ctl>
        <Ctl id="app.coach" side="bottom">
          <Btn size="sm" tone="ghost" active={settings?.coach} onClick={() => updateSettings({ coach: !settings?.coach })} aria-label="Coach">
            <GraduationCap size={14} />
          </Btn>
        </Ctl>
        <Ctl id="app.palette" side="bottom">
          <Btn size="sm" tone="ghost" onClick={() => useApp.getState().set({ paletteOpen: true })} aria-label="Command palette">
            <Command size={14} />
          </Btn>
        </Ctl>
        <Ctl id="app.settings" side="bottom">
          <Btn size="sm" tone="ghost" onClick={() => useApp.getState().set({ settingsOpen: true })} aria-label="Settings">
            <Gear size={14} />
          </Btn>
        </Ctl>
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="mx-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="url(#mx-logo)" strokeWidth="2.2" />
      <path d="M6.5 15.5 9.5 8.5 12 13l2.5-4.5 3 7" fill="none" stroke="#f4f4f5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MasterClock() {
  const bpm = useTelemetry((s) => Math.round(s.t.clockBpm * 10) / 10);
  const master = useTelemetry((s) => s.t.masterDeck);
  const beat = useTelemetry((s) => {
    const m = s.t.masterDeck;
    const d = m != null ? s.t.decks[m] : null;
    if (!d || !d.playing) return -1;
    return Math.floor(d.beat) % (d.beatsPerBar || 4);
  });
  return (
    <Ctl label="Master tempo" explain="The tempo everything synced follows. It comes from the master deck.">
      <div className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/30 px-2 py-1">
        <span className="font-mono text-sm font-semibold tabular-nums text-zinc-100">{bpm.toFixed(1)}</span>
        <span className="text-[9px] font-semibold uppercase text-zinc-500">BPM</span>
        <div className="flex gap-0.5">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={clsx("size-1.5 rounded-full", beat === i ? (i === 0 ? "bg-amber-400" : "bg-zinc-200") : "bg-white/10")} />
          ))}
        </div>
        {master != null && <span className="text-[10px] font-bold text-zinc-400">{String.fromCharCode(65 + master)}</span>}
        <div className="ml-1 h-4">
          <Meter read={(t) => t.master.peak} height={16} width={3} />
        </div>
      </div>
    </Ctl>
  );
}

function Health() {
  const audio = useApp((s) => s.audio);
  const load = useTelemetry((s) => Math.round(s.t.load * 100));
  const overruns = useTelemetry((s) => s.t.overruns);
  if (!audio) return null;
  const warn = audio.isVirtual || !!audio.warning;
  return (
    <Ctl
      label={audio.device}
      explain={
        audio.warning
          ? `${audio.warning}. MixIt is running on a silent virtual output so you can still prepare. Pick a device in Settings.`
          : `${audio.sampleRate / 1000} kHz, ${audio.bufferFrames ?? "?"} frames, ${audio.latencyMs.toFixed(1)} ms latency. Audio engine load ${load}%${overruns ? `, ${overruns} dropouts` : ""}.`
      }
      side="bottom"
    >
      <button
        type="button"
        onClick={() => useApp.getState().set({ settingsOpen: true })}
        className={clsx("flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]", warn ? "bg-amber-500/10 text-amber-300" : "text-zinc-400 hover:bg-white/[0.05]")}
      >
        {warn && <AlertTriangle size={12} />}
        <span className="max-w-36 truncate">{audio.isVirtual ? "No audio device" : audio.device}</span>
        <span className={clsx("font-mono", load > 80 ? "text-red-400" : load > 55 ? "text-amber-300" : "text-zinc-500")}>{load}%</span>
        {overruns > 0 && <span className="font-mono text-red-400">{overruns}!</span>}
      </button>
    </Ctl>
  );
}

function Record() {
  const rec = useTelemetry((s) => s.t.recording);
  const secs = useTelemetry((s) => Math.floor(s.t.recordedSeconds));
  return (
    <Ctl id="global.record" side="bottom">
      <Btn size="sm" tone={rec ? "danger" : "ghost"} onClick={toggleRecording} aria-label={rec ? "Stop recording" : "Record"}>
        {rec ? <Square size={11} fill="currentColor" /> : <Circle size={11} className="text-red-400" fill="currentColor" />}
        {rec ? <span className="font-mono tabular-nums">{clock(secs)}</span> : "Rec"}
      </Btn>
    </Ctl>
  );
}
