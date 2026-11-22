// Settings: audio device and latency, mixing behaviour, display, recording, library
// folders and the keyboard shortcut list.
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import clsx from "clsx";
import { FolderPlus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { backend } from "../../backend";
import type { DeviceInfo, Settings } from "../../backend/types";
import { shortcutLabel } from "../../lib/actions";
import { keyName } from "../../lib/keyboard";
import { bindable, defaultShortcut, holderOf, reservedKey, resetAllShortcuts, resetShortcut, setShortcut, useShortcuts } from "../../lib/shortcuts";
import { ask } from "./Dialogs";
import { Backups } from "./Backups";
import { updateSettings } from "../../lib/appCommands";
import { useApp } from "../../store/app";
import { Segmented } from "../ui/Button";
import { addMusicFolder } from "../library/Library";
import { TEMPO_RANGES, TEMPO_RANGE_LABELS } from "../deck/Deck";

const BUFFERS = [64, 128, 256, 512, 1024, 2048];

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen);
  const s = useApp((st) => st.settings);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => useApp.getState().set({ settingsOpen: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[min(600px,88vh)] w-[min(780px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl" aria-describedby={undefined}>
          <div className="flex items-center border-b border-white/[0.06] px-5 py-3">
            <Dialog.Title className="text-base font-semibold text-zinc-50">Settings</Dialog.Title>
            <Dialog.Close className="ml-auto rounded p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>
          {s && (
            <Tabs.Root defaultValue="audio" orientation="vertical" className="flex min-h-0 flex-1">
              <Tabs.List className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-white/[0.06] p-2">
                {[
                  ["audio", "Audio"],
                  ["mixing", "Mixing"],
                  ["display", "Display"],
                  ["library", "Library"],
                  ["keys", "Shortcuts"],
                  ["about", "About"],
                ].map(([v, l]) => (
                  <Tabs.Trigger key={v} value={v} className="rounded-md px-3 py-1.5 text-left text-[13px] text-zinc-400 hover:text-zinc-100 data-[state=active]:bg-white/10 data-[state=active]:text-zinc-50">
                    {l}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              <div className="min-h-0 flex-1 overflow-y-auto p-5 text-[13px]">
                <Tabs.Content value="audio">
                  <Audio s={s} />
                </Tabs.Content>
                <Tabs.Content value="mixing">
                  <Mixing s={s} />
                </Tabs.Content>
                <Tabs.Content value="display">
                  <Display s={s} />
                </Tabs.Content>
                <Tabs.Content value="library">
                  <LibrarySettings />
                </Tabs.Content>
                <Tabs.Content value="keys">
                  <Shortcuts />
                </Tabs.Content>
                <Tabs.Content value="about">
                  <About />
                </Tabs.Content>
              </div>
            </Tabs.Root>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-start gap-3 border-b border-white/[0.04] py-3 last:border-0">
      <div className="pt-1 text-zinc-300">{label}</div>
      <div className="flex flex-col gap-1">
        {children}
        {hint && <div className="text-[11px] leading-snug text-zinc-500">{hint}</div>}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
      <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-sky-500" : "bg-white/15"}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
      {label}
    </label>
  );
}

function Audio({ s }: { s: Settings }) {
  const audio = useApp((st) => st.audio);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  useEffect(() => {
    backend().devices().then(setDevices).catch(() => setDevices([]));
  }, []);
  const dev = devices.find((d) => d.id === s.device) ?? devices.find((d) => d.is_default);
  return (
    <div>
      {audio && (
        <div className={`mb-3 rounded-lg px-3 py-2 text-xs ${audio.warning ? "bg-amber-500/10 text-amber-200" : "bg-white/[0.04] text-zinc-300"}`}>
          {audio.warning ? `${audio.warning}. Running on the silent virtual output.` : `Playing through ${audio.device}: ${audio.sampleRate / 1000} kHz, ${audio.bufferFrames ?? "?"} frames, ${audio.latencyMs.toFixed(1)} ms.`}
        </div>
      )}
      <Field label="Output device" hint="Changing the device restarts audio. Loaded tracks stay loaded.">
        <select className="input h-8" value={s.device ?? ""} onChange={(e) => updateSettings({ device: e.target.value || null })}>
          <option value="">System default</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.host}, {d.max_channels} ch)
            </option>
          ))}
          <option value="virtual">Virtual output (silent)</option>
        </select>
      </Field>
      <Field label="Buffer size" hint="Smaller is more responsive; raise it if you hear clicks or dropouts.">
        <Segmented value={s.bufferFrames} onChange={(v) => updateSettings({ bufferFrames: v })} options={BUFFERS.filter((b) => !dev?.buffer_range || (b >= dev.buffer_range[0] && b <= dev.buffer_range[1])).map((b) => ({ value: b, label: String(b) }))} />
        <div className="font-mono text-[11px] text-zinc-500">≈ {((s.bufferFrames / (s.sampleRate ?? audio?.sampleRate ?? 48000)) * 1000).toFixed(1)} ms per buffer</div>
      </Field>
      <Field label="Sample rate">
        <select className="input h-8" value={s.sampleRate ?? ""} onChange={(e) => updateSettings({ sampleRate: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Device default</option>
          {(dev?.sample_rates ?? [44100, 48000, 96000]).map((r) => (
            <option key={r} value={r}>
              {r / 1000} kHz
            </option>
          ))}
        </select>
      </Field>
      <Field label="Headphones" hint="With a 4-channel interface, send the headphone cue to channels 3–4 and keep 1–2 for the speakers.">
        <select className="input h-8" value={s.cueChannel ?? ""} onChange={(e) => updateSettings({ cueChannel: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Off (one stereo output)</option>
          {Array.from({ length: Math.max(0, Math.floor(((dev?.max_channels ?? 2) - 2) / 2)) }, (_, i) => 2 + i * 2).map((c) => (
            <option key={c} value={c}>
              Channels {c + 1}–{c + 2}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function Mixing({ s }: { s: Settings }) {
  return (
    <div>
      <Field label="Decks">
        <Segmented value={s.decks} onChange={(v) => updateSettings({ decks: v })} options={[{ value: 2 as const, label: "2 decks" }, { value: 4 as const, label: "4 decks" }]} />
      </Field>
      <Field label="Auto-gain" hint="Sets each track's gain from its measured loudness so every track starts equally loud.">
        <Toggle on={s.autoGain} onChange={(v) => updateSettings({ autoGain: v })} label="Match loudness on load" />
      </Field>
      <Field label="Master limiter" hint="A transparent look-ahead limiter on the master that stops clipping. Leave it on.">
        <Toggle on={s.limiter} onChange={(v) => updateSettings({ limiter: v })} label="Protect the output" />
      </Field>
      <Field label="Tempo range" hint="How far the tempo slider goes. ±8% is the club standard; wider ranges are for mixing different genres.">
        <Segmented value={s.tempoRange} onChange={(v) => updateSettings({ tempoRange: v })} options={TEMPO_RANGES.map((r, i) => ({ value: r, label: TEMPO_RANGE_LABELS[i] }))} />
      </Field>
      <Field label="Recording" hint="Recordings go to your Music folder as WAV.">
        <Toggle on={s.recordFloat} onChange={(v) => updateSettings({ recordFloat: v })} label="32-bit float (no clipping, larger files)" />
      </Field>
      <Field label="Coach">
        <Toggle on={s.coach} onChange={(v) => updateSettings({ coach: v })} label="Show tips while I mix" />
      </Field>
    </div>
  );
}

function Display({ s }: { s: Settings }) {
  return (
    <div>
      <Field label="Interface" hint="Easy shows the essentials. Pro shows every control. Nothing is locked either way.">
        <Segmented value={s.viewMode} onChange={(v) => updateSettings({ viewMode: v })} options={[{ value: "easy" as const, label: "Easy" }, { value: "pro" as const, label: "Pro" }]} />
      </Field>
      <Field label="Theme" hint="Dark is easier on the eyes in a dim room. Light suits daylight. Waveforms always stay on a dark display.">
        <Segmented
          value={s.theme}
          onChange={(v) => updateSettings({ theme: v })}
          options={[
            { value: "dark" as const, label: "Dark" },
            { value: "light" as const, label: "Light" },
            { value: "system" as const, label: "Match system" },
          ]}
        />
      </Field>
      <Field label="Key notation" hint="Camelot (8A) makes harmonic mixing easy: neighbouring numbers and the same number with A/B mix well.">
        <Segmented
          value={s.keyNotation}
          onChange={(v) => updateSettings({ keyNotation: v })}
          options={[
            { value: "camelot" as const, label: "Camelot 8A" },
            { value: "openKey" as const, label: "Open Key 1m" },
            { value: "standard" as const, label: "Musical Am" },
          ]}
        />
      </Field>
      <Field label="Explain mode">
        <Toggle on={s.explain} onChange={(v) => updateSettings({ explain: v })} label="Show explanations in every tooltip" />
      </Field>
    </div>
  );
}

function LibrarySettings() {
  const info = useApp((st) => st.info);
  const [folders, setFolders] = useState<string[]>([]);
  const load = () => backend().folders().then(setFolders).catch(() => {});
  useEffect(() => {
    load();
  }, []);
  return (
    <div>
      <Field label="Music folders" hint="MixIt watches these folders and adds new tracks when you rescan.">
        {folders.length === 0 && <div className="text-zinc-500">None yet.</div>}
        {folders.map((f) => (
          <div key={f} className="flex items-center gap-2 rounded-md bg-white/[0.04] px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{f}</span>
            <button
              type="button"
              className="text-zinc-500 hover:text-red-300"
              onClick={async () => {
                await backend().removeFolder(f);
                load();
              }}
              aria-label="Remove folder"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="mt-1 flex w-fit items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 text-xs text-zinc-200 hover:bg-white/10" onClick={() => addMusicFolder().then(load)}>
          <FolderPlus size={12} /> Add folder
        </button>
      </Field>
      <Field label="Backups" hint="Once a day MixIt copies your library (tracks, analysis, cues, beat grids, playlists, tags and history) and keeps the last 10. Your music files are not copied: back those up separately.">
        <Backups />
      </Field>
      {info && (
        <>
          <Field label="Library file">
            <span className="break-all font-mono text-[11px] text-zinc-400">{info.dbPath}</span>
          </Field>
          <Field label="Recordings">
            <span className="break-all font-mono text-[11px] text-zinc-400">{info.recordingsDir}</span>
          </Field>
          <Field label="Mix projects">
            <span className="break-all font-mono text-[11px] text-zinc-400">{info.projectsDir}</span>
          </Field>
        </>
      )}
    </div>
  );
}

function Shortcuts() {
  const registry = useApp((st) => st.registry);
  const overrides = useShortcuts((st) => st.overrides);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const changed = Object.keys(overrides).length;

  // While a row listens, the next key goes to it instead of the decks.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const name = keyName(e);
      if (name === "Escape") {
        setRecording(null);
        return;
      }
      const why = reservedKey(name);
      if (why === "") return; // a modifier on its own: wait for the key
      if (why) {
        setNote(`${shortcutLabel(name)}: ${why}`);
        return;
      }
      const other = holderOf(name, recording);
      setShortcut(recording, name);
      setNote(other ? `${shortcutLabel(name)} now plays “${registry.find((a) => a.id === recording)?.label}” instead of “${other.label}”.` : null);
      setRecording(null);
    };
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", swallow, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", swallow, true);
    };
  }, [recording, registry]);

  const q = query.trim().toLowerCase();
  const rows = registry.filter((a) => bindable(a) && (q ? `${a.label} ${a.group} ${a.id} ${a.shortcut ?? ""}`.toLowerCase().includes(q) : all || a.shortcut || a.id in overrides));
  const groups = [...new Set(rows.map((a) => a.group))];

  return (
    <div className="flex flex-col gap-3" data-testid="shortcut-editor">
      <div className="flex items-center gap-2">
        <input className="input h-8 flex-1" placeholder="Find an action or a key…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a shortcut" />
        <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-zinc-400">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show actions without a key
        </label>
      </div>
      <p className="text-[11px] text-zinc-500">Click a key to change it, then press the new key (Esc cancels). Giving a key to one action takes it off the one that had it. Keys that hold (cue, hot cues, nudge) act while the key is down.</p>
      {note && <div className="rounded-md bg-sky-400/10 px-2 py-1 text-[12px] text-sky-200">{note}</div>}
      {groups.map((g) => (
        <div key={g}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{g}</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
            {rows
              .filter((a) => a.group === g)
              .map((a) => {
                const custom = a.id in overrides;
                const def = defaultShortcut(a.id);
                const listening = recording === a.id;
                return (
                  <div key={a.id} className="group flex items-center justify-between gap-2" data-action={a.id}>
                    <span className={clsx("truncate", custom ? "text-sky-200" : "text-zinc-300")} title={a.explain}>
                      {a.label}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {custom && (
                        <button type="button" onClick={() => resetShortcut(a.id)} title={def ? `Back to ${shortcutLabel(def)}` : "Back to no key"} aria-label={`Reset ${a.label}`} className="text-zinc-500 opacity-0 hover:text-zinc-100 group-hover:opacity-100">
                          <RotateCcw size={11} />
                        </button>
                      )}
                      {a.shortcut && !listening && (
                        <button type="button" onClick={() => setShortcut(a.id, null)} title="Take the key off" aria-label={`Remove the key of ${a.label}`} className="text-zinc-500 opacity-0 hover:text-zinc-100 group-hover:opacity-100">
                          <X size={11} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setNote(null);
                          setRecording(listening ? null : a.id);
                        }}
                        className={clsx("min-w-12 rounded border px-1.5 font-mono text-[11px]", listening ? "animate-pulse border-sky-400 bg-sky-400/15 text-sky-200" : a.shortcut ? "border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/30" : "border-dashed border-white/10 text-zinc-600 hover:text-zinc-300")}
                        data-testid="shortcut-key"
                      >
                        {listening ? "Press a key" : a.shortcut ? shortcutLabel(a.shortcut) : "Add"}
                      </button>
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-zinc-500">No action matches.</p>}
      <div className="flex items-center gap-2 border-t border-white/[0.06] pt-3">
        <span className="text-[11px] text-zinc-500">{changed ? `${changed} changed from the defaults` : "All keys are the defaults."}</span>
        {changed > 0 && (
          <button
            type="button"
            className="ml-auto rounded-md border border-white/10 px-2 py-1 text-[12px] text-zinc-300 hover:bg-white/[0.06]"
            onClick={async () => {
              if (await ask({ title: "Reset all shortcuts?", body: "Every key goes back to how MixIt came.", confirm: "Reset all" })) resetAllShortcuts();
            }}
          >
            Reset all
          </button>
        )}
      </div>
    </div>
  );
}

function About() {
  const info = useApp((st) => st.info);
  return (
    <div className="flex flex-col gap-2 text-zinc-300">
      <div className="text-lg font-semibold text-zinc-50">MixIt {info?.version}</div>
      <p className="text-zinc-400">A DJ app for people who have never mixed and for people who mix every night. Real-time engine with Signalsmith time-stretching, beat-accurate sync, analysis of tempo, key, structure and loudness, and harmonic suggestions.</p>
    </div>
  );
}
