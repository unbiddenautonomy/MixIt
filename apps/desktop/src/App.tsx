// The app shell: connects to the backend, wires its events into the stores, installs the
// keyboard map, and lays out the three workspaces.
import { installRegistry } from "./lib/shortcuts";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, type PointerEvent } from "react";
import { toast, Toaster } from "sonner";
import { getBackend } from "./backend";
import { Arrange } from "./components/arrange/Arrange";
import { AutomixDialog } from "./components/arrange/AutomixDialog";
import { Deck } from "./components/deck/Deck";
import { WaveStack } from "./components/deck/WaveStack";
import { refreshCare, refreshRows, refreshStats } from "./components/library/data";
import { Library } from "./components/library/Library";
import { GuidePanel } from "./components/guide/GuidePanel";
import { Mixer } from "./components/mixer/Mixer";
import { SamplerPanel } from "./components/sampler/SamplerPanel";
import { StudioPanel } from "./components/studio/StudioPanel";
import { Coach } from "./components/shell/Coach";
import { CommandPalette } from "./components/shell/CommandPalette";
import { DialogHost } from "./components/shell/Dialogs";
import { SettingsDialog } from "./components/shell/SettingsDialog";
import { TrackEditor } from "./components/editor/TrackEditor";
import { SoundEditor } from "./components/editor/SoundEditor";
import { MixReportDialog } from "./components/feedback/MixReport";
import { Tour } from "./components/guide/Tour";
import { maybeWelcome } from "./guide/tour";
import { DragLayer } from "./components/ui/DragLayer";
import { refreshMic, syncMic } from "./store/mic";
import { TopBar } from "./components/shell/TopBar";
import { handleShortcut, openCapturedMix } from "./lib/appCommands";
import { pushEngineState } from "./lib/engineSync";
import { installKeyboard } from "./lib/keyboard";
import { useTheme } from "./lib/theme";
import { useApp } from "./store/app";
import { useLibrary } from "./store/library";
import { useTelemetry } from "./store/telemetry";

export function App() {
  const ready = useApp((s) => s.ready);
  const error = useApp((s) => s.error);
  const workspace = useApp((s) => s.workspace);
  const guideOpen = useApp((s) => s.guideOpen);
  const theme = useTheme();

  useEffect(() => {
    let off: (() => void)[] = [];
    let cancelled = false;
    (async () => {
      try {
        const b = await getBackend();
        const info = await b.appInfo();
        if (cancelled) return;
        installRegistry(info.registry);
        useApp.getState().set({
          info,
          transitions: info.transitions,
          fxTypes: info.fxTypes,
          settings: info.settings,
          audio: info.audio,
          decks: [0, 1, 2, 3].map((i) => info.decks[i] ?? null),
          explain: info.settings.explain,
          kit: info.kit,
          pads: info.pads,
          ready: true,
        });
        pushEngineState();
        void refreshMic()
          .then((m) => (m.status ? syncMic() : undefined))
          .catch(() => undefined);
        maybeWelcome();
        let libTimer = 0;
        off = [
          b.onTelemetry((t) => useTelemetry.getState().set(t)),
          b.onDeckLoaded((d) => useApp.getState().setDeck(d)),
          b.onDeckEnded((deck) => toast.message(`Deck ${String.fromCharCode(65 + deck)} reached the end`)),
          b.onJob((j) => {
            useApp.getState().setJob(j);
            if (j.finished) {
              if (j.error) toast.error(j.error);
              else if (j.kind === "render") toast.success("Mix rendered", { description: j.message });
              else if (j.kind === "analyze" && j.total) toast.success(`Analysed ${j.total} tracks`);
              refreshStats();
              refreshRows();
            }
          }),
          b.onLibraryChanged(() => {
            // Scans send many of these; refresh at most a few times a second.
            window.clearTimeout(libTimer);
            libTimer = window.setTimeout(() => {
              refreshStats();
              void refreshCare();
              const src = useLibrary.getState().source.type;
              if (src !== "suggest") refreshRows();
            }, 300);
          }),
          b.onHistoryChanged(() => {
            if (useLibrary.getState().source.type === "history") refreshRows();
          }),
          b.onAudioStatus((a) => {
            useApp.getState().set({ audio: a });
            // A new device restarts the engine with default mixer and FX values.
            pushEngineState();
            void refreshMic()
              .then((m) => (m.status ? syncMic() : undefined))
              .catch(() => undefined);
            if (a.warning) toast.warning(a.warning);
          }),
          b.onError((m) => toast.error(m)),
          installKeyboard(handleShortcut),
        ];
      } catch (e) {
        useApp.getState().set({ error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      off.forEach((f) => f());
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-red-400/30 bg-red-500/10 p-6 text-sm text-red-100">
          <div className="mb-2 text-base font-semibold">MixIt could not start</div>
          <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
        </div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
        <Loader2 size={16} className="animate-spin" /> Starting the audio engine…
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={600} skipDelayDuration={150}>
      <div className="flex h-full flex-col bg-zinc-950 text-zinc-200">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
            {workspace === "mix" && <MixView />}
            {workspace === "library" && <Library full />}
            {workspace === "arrange" && <Arrange />}
          </main>
          {guideOpen && <GuidePanel />}
        </div>
      </div>
      <CommandPalette />
      <SettingsDialog />
      <TrackEditor />
      <SoundEditor />
      <MixReportDialog onEdit={(p) => void openCapturedMix(p)} />
      <Tour />
      <DragLayer />
      <AutomixDialog />
      <StudioPanel />
      <DialogHost />
      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </Tooltip.Provider>
  );
}

function MixView() {
  const count = useApp((s) => s.settings?.decks ?? 2);
  const libraryHeight = useApp((s) => s.libraryHeight);
  const samplerOpen = useApp((s) => s.samplerOpen);
  const loaded = useApp((s) => s.decks.map((d) => (d ? 1 : 0)).join(""));
  const four = count > 2;
  // Empty C and D lanes would only take space from the library.
  const decks = four ? [0, 1, 2, 3].filter((d) => d < 2 || loaded[d] === "1") : [0, 1];
  return (
    <>
      <WaveStack decks={decks} />
      <div className="flex min-h-0 shrink-0 gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Deck deck={0} compact={four} />
          {four && <Deck deck={2} compact />}
        </div>
        <Mixer count={count} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Deck deck={1} compact={four} />
          {four && <Deck deck={3} compact />}
        </div>
      </div>
      <Coach />
      <Splitter />
      <div className="flex min-h-[140px] gap-2" style={{ height: libraryHeight, flex: "1 1 auto" }}>
        <div className="flex min-w-0 flex-1 flex-col">
          <Library />
        </div>
        {samplerOpen && <SamplerPanel />}
      </div>
    </>
  );
}

/** Drag to resize the library under the decks. */
function Splitter() {
  const start = useRef<{ y: number; h: number } | null>(null);
  const down = (e: PointerEvent) => {
    start.current = { y: e.clientY, h: useApp.getState().libraryHeight };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!start.current) return;
    const h = Math.max(140, Math.min(window.innerHeight - 200, start.current.h - (e.clientY - start.current.y)));
    useApp.getState().set({ libraryHeight: h });
  };
  return (
    <div className="group -my-1 flex h-2 shrink-0 cursor-row-resize items-center justify-center" onPointerDown={down} onPointerMove={move} onPointerUp={() => (start.current = null)}>
      <div className="h-0.5 w-12 rounded-full bg-white/10 group-hover:bg-white/30" />
    </div>
  );
}
