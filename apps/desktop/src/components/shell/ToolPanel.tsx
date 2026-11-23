// The tools panel under the decks. While you play, the waveforms, decks, mixer and library
// stay where they are; the things you set up and then leave running (sampler pads, the
// step sequencer, effects, the mic and line inputs, recording) share this one panel. It
// can be tucked away to a row of buttons, sit beside the library, or take the whole
// screen under the waveforms when you are working on one of them.
import clsx from "clsx";
import { Circle, Disc3, Grid2x2, ListMusic, Maximize2, Mic, Minimize2, PanelRightClose, Sparkles, Square } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { backend } from "../../backend";
import { runApp, toggleRecording, updateSettings } from "../../lib/appCommands";
import { shortcutLabel, findAction } from "../../lib/actions";
import { clock } from "../../lib/format";
import { MASTER_FX, openTool, setTools, useApp, type ToolTab } from "../../store/app";
import { useMic } from "../../store/mic";
import { useSequencer } from "../../store/sequencer";
import { useTelemetry } from "../../store/telemetry";
import { useReport } from "../feedback/MixReport";
import { MicPanel } from "../mic/MicPanel";
import { EffectsTab, SamplerTab } from "../sampler/SamplerPanel";
import { Btn } from "../ui/Button";

type TabSpec = { id: ToolTab; label: string; hint: string; icon: ComponentType<{ size?: number; className?: string }> };

export const TOOL_TAB_SPECS: TabSpec[] = [
  { id: "pads", label: "Pads", hint: "Sampler pads: sounds you play on top of your mix", icon: Grid2x2 },
  { id: "steps", label: "Steps", hint: "Step sequencer: plays the pads in a pattern on the beat", icon: ListMusic },
  { id: "effects", label: "Effects", hint: "Every effect in full: on the whole mix and on each deck", icon: Sparkles },
  { id: "inputs", label: "Mic", hint: "Mic and line inputs: talk over the music or bring in a turntable", icon: Mic },
  { id: "recording", label: "Record", hint: "Recording your mix: where it goes and what is saved with it", icon: Disc3 },
];

/** A small dot on a tab whose tool is doing something right now. */
function useBusy(tab: ToolTab): boolean {
  const seq = useSequencer((s) => s.on);
  const fx = useApp((s) => s.mixer.fx[MASTER_FX].some((f) => f.on && f.type !== 0));
  const onAir = useMic((s) => s.onAir);
  const micRec = useMic((s) => s.recording);
  const mic = useApp((s) => !!s.settings?.micEnabled);
  const rec = useTelemetry((s) => s.t.recording);
  const pads = useTelemetry((s) => (s.t.samplerPlaying ?? 0) !== 0);
  switch (tab) {
    case "pads":
      return pads;
    case "steps":
      return seq;
    case "effects":
      return fx;
    case "inputs":
      return (mic && onAir) || micRec;
    case "recording":
      return rec;
  }
}

function TabButton({ spec, vertical }: { spec: TabSpec; vertical?: boolean }) {
  const active = useApp((s) => s.toolTab === spec.id && s.toolSize !== "closed");
  const busy = useBusy(spec.id);
  const Icon = spec.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={spec.hint}
      data-testid={`tool-tab-${spec.id}`}
      onClick={() => openTool(spec.id)}
      className={clsx(
        "relative flex items-center gap-1.5 rounded-md text-[11px] font-medium transition-colors",
        vertical ? "size-8 justify-center" : "h-7 px-2",
        active ? "bg-[var(--accent)]/15 text-[var(--accent-ink,#fff)]" : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100",
      )}
    >
      <Icon size={vertical ? 15 : 13} />
      {!vertical && <span>{spec.label}</span>}
      {busy && <span className={clsx("size-1.5 rounded-full", spec.id === "recording" || spec.id === "inputs" ? "bg-red-400" : "bg-[var(--accent)]", vertical && "absolute right-1 top-1")} />}
    </button>
  );
}

/** The panel tucked away: just its tab buttons, in a narrow column beside the library. */
function ToolRail() {
  return (
    <nav role="tablist" aria-label="Tools" data-testid="tool-panel" data-size="closed" className="flex w-10 shrink-0 flex-col items-center gap-1 rounded-xl border border-white/[0.06] bg-zinc-900/60 py-1.5">
      {TOOL_TAB_SPECS.map((t) => (
        <TabButton key={t.id} spec={t} vertical />
      ))}
    </nav>
  );
}

function SizeButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
      {children}
    </button>
  );
}

export function ToolPanel() {
  const tab = useApp((s) => s.toolTab);
  const size = useApp((s) => s.toolSize);
  if (size === "closed") return <ToolRail />;
  const full = size === "full";
  const fullKey = findAction("app.tools_full")?.shortcut;
  return (
    <section
      aria-label="Tools"
      data-testid="tool-panel"
      data-size={size}
      className={clsx("flex min-h-0 flex-col gap-2 rounded-xl border border-white/[0.06] bg-zinc-900/60 p-2", full ? "min-w-0 flex-1" : "w-[320px] shrink-0")}
    >
      <div className="flex items-center gap-0.5" role="tablist" aria-label="Tools">
        <div className={clsx("flex min-w-0 items-center gap-0.5", !full && "overflow-x-auto")}>
          {TOOL_TAB_SPECS.map((t) => (
            <TabButton key={t.id} spec={t} vertical={!full && t.id !== tab} />
          ))}
        </div>
        <span className="ml-auto" />
        {full ? (
          <SizeButton label={`Back beside the library${fullKey ? ` (${shortcutLabel(fullKey)})` : ""}`} onClick={() => setTools({ toolSize: "docked" })}>
            <Minimize2 size={13} />
          </SizeButton>
        ) : (
          <SizeButton label={`Full screen under the waveforms${fullKey ? ` (${shortcutLabel(fullKey)})` : ""}`} onClick={() => setTools({ toolSize: "full" })}>
            <Maximize2 size={13} />
          </SizeButton>
        )}
        <SizeButton label="Tuck away (keep just the buttons)" onClick={() => setTools({ toolSize: "closed" })}>
          <PanelRightClose size={14} />
        </SizeButton>
      </div>
      <div className={clsx("flex min-h-0 flex-1 flex-col", full && "mx-auto w-full max-w-5xl")}>
        {tab === "pads" && <SamplerTab />}
        {tab === "steps" && <SamplerTab steps />}
        {tab === "effects" && <EffectsTab />}
        {tab === "inputs" && (
          <div className="min-h-0 flex-1 overflow-y-auto" style={{ ["--accent" as string]: "#f472b6" }}>
            <MicPanel />
          </div>
        )}
        {tab === "recording" && <RecordingTab />}
      </div>
    </section>
  );
}

/** Recording: start and stop (also in the top bar), where it goes, and what comes with it. */
export function RecordingTab() {
  const rec = useTelemetry((s) => s.t.recording);
  const secs = useTelemetry((s) => Math.floor(s.t.recordedSeconds));
  const float = useApp((s) => !!s.settings?.recordFloat);
  const dir = useApp((s) => s.info?.recordingsDir ?? "");
  const hasReport = useReport((s) => !!s.report);
  const desktop = backend().kind === "tauri";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto text-[11px] leading-snug text-zinc-400" aria-label="Recording">
      <div className="flex items-center gap-3">
        <Btn size="lg" tone={rec ? "danger" : "default"} onClick={toggleRecording} aria-label={rec ? "Stop recording" : "Start recording"}>
          {rec ? <Square size={13} fill="currentColor" /> : <Circle size={13} className="text-red-400" fill="currentColor" />}
          {rec ? "Stop" : "Record"}
        </Btn>
        <div className="flex flex-col">
          <span className="font-mono text-lg tabular-nums text-zinc-100">{clock(rec ? secs : 0)}</span>
          <span>{rec ? "Recording everything the audience hears" : "Saves everything the audience hears"}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Where it goes</div>
        {desktop ? <span className="break-all font-mono text-[11px] text-zinc-300">{dir || "Your Music folder"}</span> : <span>Your browser's downloads, as a WAV file.</span>}
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={float} onChange={(e) => updateSettings({ recordFloat: e.target.checked })} />
        <span>
          <span className="text-zinc-200">Never clip</span>: save in 32-bit float, so even a too-loud moment is kept whole. Files are larger.
        </span>
      </label>
      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">What comes with it</div>
        <span>The tracklist, saved beside the recording as a CUE sheet and a text list.</span>
        <span>Every move you make, so you can open the mix in Arrange and fix a transition.</span>
        <span>Feedback on how the mix went, once you stop.</span>
      </div>
      <div>
        <Btn size="sm" tone="ghost" disabled={!hasReport} onClick={() => runApp("app.feedback")}>
          Show feedback on your last mix
        </Btn>
      </div>
    </div>
  );
}
