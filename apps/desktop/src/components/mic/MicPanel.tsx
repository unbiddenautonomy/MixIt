// The mic: a button in the top bar that opens everything about it, and a narrow channel
// strip on the mixer while it is on. A mic can be talked over the music (with talk-over
// turning the music down while you speak), recorded onto a sampler pad, or recorded into
// the library as a track (a turntable, a phone or another mixer on a line input).
import clsx from "clsx";
import * as Popover from "@radix-ui/react-popover";
import { AlertTriangle, Circle, Headphones, Library as LibraryIcon, Mic, MicOff, Radio, Settings2, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { backend } from "../../backend";
import type { DeviceInfo } from "../../backend/types";
import { setOn, setValue } from "../../lib/actions";
import { clock } from "../../lib/format";
import { useApp, usePro } from "../../store/app";
import { refreshMic, setMicEnabled, toggleMicRecording, useMic, type TakeTarget } from "../../store/mic";
import { useTelemetry } from "../../store/telemetry";
import { Btn, Segmented } from "../ui/Button";
import { Ctl } from "../ui/Ctl";
import { Fader } from "../ui/Fader";
import { Knob } from "../ui/Knob";
import { Meter } from "../ui/Meter";

const MIC_COLOR = "#f472b6";

/** Opens the mic panel from anywhere (the strip, the guide, the palette). */
export const useMicPanel = (() => {
  let setter: ((v: boolean) => void) | null = null;
  return {
    open: () => setter?.(true),
    bind: (s: (v: boolean) => void) => {
      setter = s;
    },
  };
})();

export function MicButton() {
  const [open, setOpen] = useState(false);
  const enabled = useApp((s) => !!s.settings?.micEnabled);
  const onAir = useMic((s) => s.onAir);
  const recording = useMic((s) => s.recording);
  useMicPanel.bind(setOpen);
  useEffect(() => {
    if (open) void refreshMic().catch(() => undefined);
  }, [open]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Ctl label="Mic" explain="Talk to the crowd over the music, record your own sounds onto a pad, or bring in a turntable or phone." side="bottom">
        <Popover.Trigger asChild>
          <Btn size="sm" tone={enabled && onAir ? "danger" : "ghost"} active={open} aria-label="Mic">
            {enabled ? <Mic size={14} /> : <MicOff size={14} className="text-zinc-500" />}
            {enabled && onAir && <span className="text-[10px] font-bold uppercase tracking-wide">On air</span>}
            {recording && <Circle size={8} className="animate-pulse text-red-400" fill="currentColor" />}
          </Btn>
        </Popover.Trigger>
      </Ctl>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-[22rem] rounded-xl border border-white/10 bg-zinc-900/95 p-3 text-xs shadow-2xl backdrop-blur" style={{ ["--accent" as string]: MIC_COLOR }}>
          <MicPanel />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MicPanel() {
  const settings = useApp((s) => s.settings);
  const kind = backendKind();
  const enabled = !!settings?.micEnabled;
  const st = useMic((s) => s.state);
  const [busy, setBusy] = useState(false);
  const turn = async (on: boolean) => {
    setBusy(true);
    await setMicEnabled(on).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Mic size={15} style={{ color: MIC_COLOR }} />
        <div className="flex-1 text-sm font-semibold text-zinc-100">Mic</div>
        <Btn size="sm" tone={enabled ? "default" : "accent"} disabled={busy} onClick={() => turn(!enabled)}>
          {enabled ? "Turn off" : busy ? "Asking…" : "Turn on"}
        </Btn>
      </div>
      {!enabled ? (
        <div className="flex flex-col gap-2 leading-relaxed text-zinc-400">
          <p>Talk to the crowd over the music, record your own sounds onto a sampler pad, or bring in a turntable or a phone and record it into your library.</p>
          <p className="text-zinc-500">MixIt only listens while the mic is on. {kind === "web" ? "Your browser will ask first." : "Your system may ask the first time."}</p>
        </div>
      ) : (
        <>
          <DevicePicker />
          {st.error && (
            <div className="flex gap-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-red-200">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{st.error}</span>
            </div>
          )}
          {st.lost && <div className="rounded-lg bg-amber-500/10 px-2.5 py-2 text-amber-200">The mic was unplugged. Plug it back in and pick it again.</div>}
          <InputLevel />
          <OnAir />
          <MicRecorder />
        </>
      )}
    </div>
  );
}

function backendKind() {
  try {
    return backend().kind;
  } catch {
    return "demo";
  }
}

function DevicePicker() {
  const s = useApp((st) => st.settings)!;
  const status = useMic((m) => m.state.status);
  const pro = usePro();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const web = backendKind() === "web";
  useEffect(() => {
    backend()
      .inputDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [status?.device]);
  const dev = devices.find((d) => d.id === s.micDevice) ?? devices.find((d) => d.is_default);
  const channels = dev?.max_channels ?? 1;
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-zinc-500">Input</span>
        <select className="input h-7 min-w-0 flex-1" value={s.micDevice ?? ""} onChange={(e) => void setMicEnabled(true, { micDevice: e.target.value || null, micChannel: 0 })}>
          <option value="">System default{!s.micDevice && status ? ` (${status.device})` : ""}</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {!web && (channels > 1 || pro) && (
        <label className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-zinc-500">Channel</span>
          <select
            className="input h-7 min-w-0 flex-1"
            value={`${s.micChannel}:${s.micStereo ? 2 : 1}`}
            onChange={(e) => {
              const [c, n] = e.target.value.split(":").map(Number);
              void setMicEnabled(true, { micChannel: c, micStereo: n === 2 });
            }}
          >
            {Array.from({ length: Math.max(1, channels) }, (_, c) => (
              <option key={`m${c}`} value={`${c}:1`}>
                Input {c + 1} (a mic)
              </option>
            ))}
            {Array.from({ length: Math.max(0, Math.floor(channels / 2)) }, (_, k) => (
              <option key={`s${k}`} value={`${k * 2}:2`}>
                Inputs {k * 2 + 1}–{k * 2 + 2} (stereo: turntable, mixer, phone)
              </option>
            ))}
          </select>
        </label>
      )}
      {web && (
        <label className="flex items-center gap-2 text-zinc-300">
          <input type="checkbox" checked={s.micVoice ?? true} onChange={(e) => void setMicEnabled(true, { micVoice: e.target.checked })} />
          Clean up my voice (removes echo and background noise; turn off for music)
        </label>
      )}
      {status && (
        <div className="text-[11px] text-zinc-500">
          {status.device}, {status.sampleRate / 1000} kHz
          <MicLatency />
        </div>
      )}
    </div>
  );
}

function MicLatency() {
  const ms = useTelemetry((s) => Math.round(s.t.mic.latencyMs));
  const live = useTelemetry((s) => s.t.mic.live);
  if (!live) return <span className="text-amber-300">, waiting for sound…</span>;
  return <span>, {ms} ms delay</span>;
}

function InputLevel() {
  const gain = useMic((s) => s.gain);
  const peak = useTelemetry((s) => Math.max(s.t.mic.peak[0], s.t.mic.peak[1]));
  const hint = peak < 0.02 ? "Say something: the bar should move." : peak > 0.9 ? "Too loud: turn the gain down." : peak < 0.12 ? "A little quiet: turn the gain up." : "Good level.";
  return (
    <div className="flex items-center gap-3 rounded-lg bg-black/25 px-2.5 py-2">
      <Ctl id="mic.gain" side="left">
        <Knob value={gain} min={-20} max={30} def={0} size={30} color="var(--color-zinc-300)" onChange={(v) => setValue("mic.gain", v)} label="Gain" />
      </Ctl>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <LevelBar />
        <div className={clsx("text-[11px]", peak > 0.9 ? "text-red-300" : "text-zinc-400")}>{hint}</div>
      </div>
    </div>
  );
}

/** A horizontal meter of the mic (after gain and clean-up, before the volume). */
function LevelBar() {
  const peak = useTelemetry((s) => Math.min(1, Math.max(s.t.mic.peak[0], s.t.mic.peak[1])));
  const db = peak > 0 ? 20 * Math.log10(peak) : -60;
  const w = Math.max(0, Math.min(1, (db + 60) / 60));
  return (
    <div className="relative h-2.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-label="Mic level" aria-valuenow={Math.round(db)} aria-valuemin={-60} aria-valuemax={0}>
      <div className={clsx("h-full rounded-full transition-[width] duration-75", db > -1 ? "bg-red-500" : db > -9 ? "bg-amber-400" : "bg-emerald-400")} style={{ width: `${w * 100}%` }} />
      <div className="absolute inset-y-0 left-[70%] w-px bg-white/20" title="−18 dB: aim around here when you speak" />
    </div>
  );
}

function OnAir() {
  const m = useMic();
  const pro = usePro();
  const duck = useTelemetry((s) => Math.round(s.t.mic.duckDb));
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] p-2.5">
      <div className="flex items-center gap-2">
        <Ctl id="mic.on_air" side="left">
          <Btn tone={m.onAir ? "danger" : "default"} onClick={() => setOn("mic.on_air", !m.onAir)} aria-pressed={m.onAir}>
            <Radio size={13} /> {m.onAir ? "On air" : "Go on air"}
          </Btn>
        </Ctl>
        <Ctl id="mic.cue" side="top">
          <Btn size="sm" tone={m.cue ? "cue" : "ghost"} onClick={() => setOn("mic.cue", !m.cue)} aria-label="Mic in headphones" aria-pressed={m.cue}>
            <Headphones size={12} />
          </Btn>
        </Ctl>
        <div className="flex-1" />
        <Ctl id="mic.level" side="top">
          <Knob value={m.level} min={0} max={1} def={0.8} size={28} color={MIC_COLOR} onChange={(v) => setValue("mic.level", v)} label="Volume" />
        </Ctl>
      </div>
      {m.onAir && <div className="text-[11px] leading-snug text-amber-200/90">Wear headphones or keep the mic away from the speakers, or it will howl.</div>}
      <div className="flex items-center gap-2">
        <Ctl id="mic.talkover" side="left">
          <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
            <input type="checkbox" checked={m.talkover} onChange={(e) => setOn("mic.talkover", e.target.checked)} />
            Talk-over
          </label>
        </Ctl>
        <span className="flex-1 text-[11px] text-zinc-500">{m.talkover ? (duck < -1 ? `music down ${-duck} dB` : "music dips while you speak") : "music stays as it is"}</span>
        {m.talkover && (
          <Ctl id="mic.talkover_depth" side="top">
            <Knob value={m.depth} min={-30} max={0} def={-12} size={24} color="var(--color-zinc-300)" onChange={(v) => setValue("mic.talkover_depth", v)} label="Amount" />
          </Ctl>
        )}
      </div>
      {pro && (
        <div className="flex items-center gap-2 border-t border-white/[0.06] pt-2">
          {(["high", "mid", "low"] as const).map((b) => (
            <Ctl key={b} id={`mic.eq.${b}`} side="top">
              <Knob value={m[b]} min={-26} max={6} def={0} bipolar size={24} color={MIC_COLOR} onChange={(v) => setValue(`mic.eq.${b}`, v)} label={b[0].toUpperCase() + b.slice(1)} />
            </Ctl>
          ))}
          <div className="flex flex-1 flex-col gap-1 pl-1 text-zinc-300">
            {(
              [
                ["mic.low_cut", "Low cut", m.lowCut],
                ["mic.gate", "Cut background noise", m.gate],
                ["mic.mono", "Mono", m.mono],
              ] as const
            ).map(([id, label, on]) => (
              <Ctl key={id} id={id} side="left">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={on} onChange={(e) => setOn(id, e.target.checked)} />
                  {label}
                </label>
              </Ctl>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MicRecorder() {
  const recording = useMic((s) => s.recording);
  const target = useMic((s) => s.target);
  const pad = useMic((s) => s.pad);
  const last = useMic((s) => s.lastTake);
  const pads = useApp((s) => s.pads);
  const secs = useTelemetry((s) => Math.floor(s.t.mic.capturedSeconds));
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.06] p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-zinc-400">Record for</span>
        <Segmented<TakeTarget>
          value={target}
          onChange={(v) => useMic.getState().set({ target: v })}
          options={[
            { value: "pad", label: "A pad", title: "A short sound for the sampler: a shout, a tag, a hit. The silence around it is cut." },
            { value: "library", label: "My library", title: "A whole take, kept as a track: a turntable, a phone, a live set." },
          ]}
        />
        {target === "pad" && (
          <select className="input h-7 w-24" value={pad} onChange={(e) => useMic.getState().set({ pad: Number(e.target.value) })} aria-label="Pad for the recording" disabled={recording}>
            {pads.map((p) => (
              <option key={p.pad} value={p.pad}>
                Pad {p.pad + 1}
                {p.source.type !== "empty" ? ` (${p.name})` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      <Ctl id="mic.record" side="left">
        <Btn tone={recording ? "danger" : "default"} onClick={() => void toggleMicRecording()} className="w-full justify-center">
          {recording ? (
            <>
              <Square size={11} fill="currentColor" /> Stop <span className="font-mono tabular-nums">{clock(secs)}</span>
            </>
          ) : (
            <>
              <Circle size={11} className="text-red-400" fill="currentColor" /> Record {target === "pad" ? `onto pad ${pad + 1}` : "into the library"}
            </>
          )}
        </Btn>
      </Ctl>
      {last && !recording && (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          {last.target === "pad" ? <Settings2 size={11} /> : <LibraryIcon size={11} />}
          Last take: {last.seconds.toFixed(1)} s {last.target === "pad" ? `on pad ${last.pad + 1}` : "in the library"}
          <button
            type="button"
            className="ml-auto rounded px-1.5 py-0.5 text-sky-300 hover:bg-white/10"
            onClick={() => void import("../editor/SoundEditor").then((m) => m.openSoundEditor({ type: "file", path: last.path }, { pad: last.target === "pad" ? last.pad : null, name: "Mic take" }))}
            title="Trim, fade, normalise or clean up the take"
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

/** The mic's channel on the mixer, shown while the mic is on. */
export function MicStrip({ compact }: { compact: boolean }) {
  const enabled = useApp((s) => !!s.settings?.micEnabled);
  const m = useMic();
  const duck = useTelemetry((s) => Math.round(s.t.mic.duckDb));
  if (!enabled) return null;
  const len = compact ? 84 : 104;
  return (
    <div style={{ ["--accent" as string]: MIC_COLOR }} className="mr-1 flex w-[52px] flex-col items-center gap-1.5 rounded-xl bg-black/20 px-1 py-1.5">
      <button type="button" onClick={() => useMicPanel.open()} className="flex items-center gap-1 text-[10px] font-black uppercase" style={{ color: MIC_COLOR }} aria-label="Mic settings">
        <Mic size={11} /> Mic
      </button>
      <Ctl id="mic.on_air" side="right">
        <button
          type="button"
          onClick={() => setOn("mic.on_air", !m.onAir)}
          className={clsx("w-11 rounded-md border px-1 py-0.5 text-[9px] font-bold uppercase leading-tight", m.onAir ? "border-transparent bg-red-500 text-white shadow-[0_0_12px_-2px_#ef4444]" : "border-white/10 text-zinc-400 hover:text-zinc-100")}
          aria-pressed={m.onAir}
        >
          {m.onAir ? "On air" : "Off"}
        </button>
      </Ctl>
      <Ctl id="mic.talkover" side="right">
        <button
          type="button"
          onClick={() => setOn("mic.talkover", !m.talkover)}
          className={clsx("w-11 rounded-md border px-1 py-0.5 text-[9px] font-semibold leading-tight", m.talkover ? "border-white/20 text-zinc-200" : "border-white/10 text-zinc-500")}
          aria-pressed={m.talkover}
        >
          Talk-over
        </button>
      </Ctl>
      <div className={clsx("h-3 font-mono text-[9px]", duck < -1 ? "text-amber-300" : "text-transparent")}>{duck < -1 ? `${duck} dB` : "0"}</div>
      <div className="mt-auto flex items-end gap-1">
        <Meter read={(t) => t.mic.peak} height={len} width={3} />
        <Ctl id="mic.level" side="right">
          <Fader value={m.level} min={0} max={1} def={0.8} length={len} color={MIC_COLOR} onChange={(v) => setValue("mic.level", v)} label="Mic volume" />
        </Ctl>
      </div>
    </div>
  );
}
