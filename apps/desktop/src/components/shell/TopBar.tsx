// The bar across the top: workspaces, the master clock and level, recording, engine
// health, and the Easy/Pro, explain, coach, palette and settings switches.
import clsx from "clsx";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { AlarmClock, AlertTriangle, BookOpen, Check, Circle, Command, Compass, Grid2x2, GraduationCap, HelpCircle, Settings as Gear, Square } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toggleRecording, updateSettings } from "../../lib/appCommands";
import { setOn, shortcutLabel, findAction } from "../../lib/actions";
import { startTour } from "../../guide/tour";
import { clock } from "../../lib/format";
import { endAt, setLeftLabel, setSecondsLeft, setSetEnd, useSetClock } from "../../lib/setClock";
import { useApp, type Workspace } from "../../store/app";
import { useTelemetry } from "../../store/telemetry";
import { AssistantButton } from "../feedback/MixAssistant";
import { MicButton } from "../mic/MicPanel";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Meter } from "../ui/Meter";

export function TopBar() {
  const workspace = useApp((s) => s.workspace);
  const settings = useApp((s) => s.settings);
  const explain = useApp((s) => s.explain);
  const samplerOpen = useApp((s) => s.samplerOpen);
  const guideOpen = useApp((s) => s.guideOpen);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-zinc-950/80 px-3 backdrop-blur" data-tauri-drag-region>
      <div className="flex items-center gap-2 pr-1">
        <Logo />
        <span className="wordmark text-sm font-bold tracking-tight text-zinc-100">MixIt</span>
      </div>
      <Segmented<Workspace>
        value={workspace}
        onChange={(w) => useApp.getState().set({ workspace: w })}
        options={[
          { value: "mix", label: "Mix", title: `Decks and mixer (${shortcutLabel("Mod+2")})` },
          { value: "library", label: "Library", title: `Your music (${shortcutLabel("Mod+1")})` },
          { value: "arrange", label: "Arrange", title: `Build a mix on a timeline (${shortcutLabel("Mod+3")})` },
        ]}
      />
      <MasterClock />
      <SetClock />
      <div className="ml-auto flex items-center gap-2">
        <AbBypass />
        <Health />
        <MicButton />
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
            <span className="hidden xl:inline">Pads</span>
          </Btn>
        </Ctl>
        <AssistantButton />
        <Ctl id="app.guide" side="bottom">
          <Btn size="sm" tone="ghost" active={guideOpen} onClick={() => useApp.getState().set({ guideOpen: !guideOpen })} aria-label="Guide and practice labs">
            <BookOpen size={14} />
            <span className="hidden lg:inline">Guide</span>
          </Btn>
        </Ctl>
        <HelpMenu explain={explain} coach={!!settings?.coach} />
        <Ctl id="app.settings" side="bottom">
          <Btn size="sm" tone="ghost" onClick={() => useApp.getState().set({ settingsOpen: true })} aria-label="Settings">
            <Gear size={14} />
          </Btn>
        </Ctl>
      </div>
    </header>
  );
}

/**
 * A/B: hear the music plain (no EQ, filters, effects or studio) and back, to learn what
 * your changes do. It stays lit while on, so the mix is never left plain by accident.
 */
function AbBypass() {
  const on = useApp((s) => s.mixer.bypass);
  return (
    <Ctl id="mixer.bypass" side="bottom">
      <Btn size="sm" tone="ghost" active={on} onClick={() => setOn("mixer.bypass", !on)} aria-pressed={on} data-testid="ab-bypass" className={on ? "!text-amber-300" : undefined}>
        <span className="font-mono text-[11px] font-semibold">A/B</span>
        {on && <span className="text-[11px]">Plain</span>}
      </Btn>
    </Ctl>
  );
}

/**
 * One menu for the ways MixIt helps you learn: explain mode, coach tips, the tour and
 * the command palette. They used to be four unlabelled icons in the bar.
 */
function HelpMenu({ explain, coach }: { explain: boolean; coach: boolean }) {
  const key = (id: string) => shortcutLabel(findAction(id)?.shortcut);
  const item = (icon: ReactNode, label: string, hint: string, onSelect: () => void, on?: boolean, shortcut?: string) => (
    <DropdownMenu.Item className="menu-item items-start" onSelect={onSelect}>
      <span className="mt-0.5 w-4 shrink-0 text-zinc-400">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-zinc-100">
          {label}
          {on && <Check size={12} className="text-[var(--accent-ink)]" />}
        </span>
        <span className="text-[11px] leading-snug text-zinc-400">{hint}</span>
      </span>
      {shortcut && <kbd className="mt-0.5 rounded border border-white/15 bg-white/5 px-1.5 py-px font-mono text-[10px] text-zinc-300">{shortcut}</kbd>}
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Btn size="sm" tone="ghost" active={explain} aria-label="Help" data-testid="help-menu">
          <HelpCircle size={14} />
          <span className="hidden lg:inline">Help</span>
        </Btn>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="menu w-72">
          {item(<HelpCircle size={13} />, "Explain mode", "Hover any control to see what it does.", () => useApp.getState().set({ explain: !explain }), explain, key("app.explain"))}
          {item(<GraduationCap size={13} />, "Coach tips", "Tips while you mix, like keys that clash.", () => updateSettings({ coach: !coach }), coach, key("app.coach"))}
          <DropdownMenu.Separator className="menu-sep" />
          {item(<Compass size={13} />, "Take the tour", "A short walk round the screen.", () => startTour())}
          {item(<Command size={13} />, "Find any action", "Search every command by name.", () => useApp.getState().set({ paletteOpen: true }), undefined, key("app.palette"))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Logo() {
  // The same artwork as the app icon (src-tauri/icons), so the top bar matches the Dock and Start menu.
  return <img src="/logo.png" width={22} height={22} alt="" aria-hidden draggable={false} className="rounded-[5px]" />;
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
    <Ctl label="Master tempo" explain="The tempo every deck with Sync on follows. It comes from the leading deck.">
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

const SET_LENGTHS: [number, string][] = [
  [30, "30 min"],
  [60, "1 hour"],
  [90, "1½ hours"],
  [120, "2 hours"],
];

/** How long your set has left: choose a length or an end time, and the bar counts down. */
function SetClock() {
  const endsAt = useSetClock((s) => s.endsAt);
  const [now, setNow] = useState(() => Date.now());
  const [at, setAt] = useState("");
  useEffect(() => {
    setNow(Date.now());
    if (!endsAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);
  const left = setSecondsLeft(endsAt, now);
  const ends = endsAt ? new Date(endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const validAt = endAt(at) != null;
  return (
    <Popover.Root>
      <Ctl label="Set clock" explain="How long your set has left. Choose a length or the time you finish, and the coach tells you when a track would run past the end.">
        <Popover.Trigger asChild>
          <button
            type="button"
            className={clsx(
              "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs",
              left == null ? "border-transparent text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200" : left < 180 ? "border-red-500/40 bg-red-500/10 text-red-300" : left < 600 ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-white/[0.06] bg-black/30 text-zinc-200",
            )}
            aria-label="Set clock"
            data-testid="set-clock"
          >
            <AlarmClock size={13} />
            {left == null ? <span className="hidden lg:inline">Set length</span> : <span className="font-mono tabular-nums">{setLeftLabel(left)}</span>}
          </button>
        </Popover.Trigger>
      </Ctl>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={8} className="z-50 flex w-72 flex-col gap-3 rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur" data-testid="set-clock-panel">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">How long is your set?</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {SET_LENGTHS.map(([m, label]) => (
                <Btn key={m} size="sm" onClick={() => setSetEnd({ minutes: m })} data-testid={`set-length-${m}`}>
                  {label}
                </Btn>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Or it ends at</span>
            <span className="flex gap-1.5">
              <input className="input h-8 flex-1" placeholder="02:00" value={at} onChange={(e) => setAt(e.target.value)} onKeyDown={(e) => e.key === "Enter" && validAt && setSetEnd({ at })} aria-label="Time the set ends" />
              <Btn size="sm" disabled={!validAt} onClick={() => setSetEnd({ at })}>
                Set
              </Btn>
            </span>
          </label>
          {endsAt && (
            <div className="flex items-center gap-2 border-t border-white/[0.06] pt-2 text-zinc-400">
              <span>
                Ends at {ends}
                {left != null && `, ${setLeftLabel(left).toLowerCase()}`}
              </span>
              <button type="button" className="ml-auto rounded px-1.5 py-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" onClick={() => setSetEnd(null)}>
                Clear
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
