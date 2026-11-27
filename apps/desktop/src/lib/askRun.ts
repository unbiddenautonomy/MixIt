// Does what Ask MixIt understood (src/lib/ask.ts), and builds what it needs to know
// about the app from the stores.
import { toast } from "sonner";
import { openBuildSet } from "../components/library/BuildSetDialog";
import { refreshRows, refreshSuggestions, showDescribed } from "../components/library/data";
import { setAssistantOpen } from "../components/feedback/MixAssistant";
import { deckCount, openTool, setTools, useApp } from "../store/app";
import { useAutoDj } from "../store/autodj";
import { useLibrary } from "../store/library";
import { useTelemetry } from "../store/telemetry";
import { act, choose, setOn, setValue, tap } from "./actions";
import { runCommand, toggleRecording, updateSettings } from "./appCommands";
import type { AskContext, AskStep, Understood } from "./ask";
import { bringHome, builtInLayout, editLayout, foldPart, openInNewWindow, sendToOtherScreen, setController } from "./layoutCommands";
import type { BuiltIn } from "./layout/presets";
import type { UnitId } from "./layout/model";
import { UNITS } from "./layout/units";

/** What Ask MixIt knows about the app right now. */
export function askContext(): AskContext {
  const s = useApp.getState();
  const lib = useLibrary.getState();
  const t = useTelemetry.getState().t;
  const n = deckCount();
  const selected = lib.rows.find((r) => r.id === lib.selected[0]) ?? null;
  return {
    registry: s.registry,
    decks: Array.from({ length: n }, (_, i) => {
      const d = t.decks[i];
      const info = s.decks[i];
      return {
        loaded: !!d?.loaded,
        playing: !!d?.playing,
        baseBpm: d?.baseBpm ?? 0,
        tempo: d?.tempo ?? 0,
        tempoRange: d?.tempoRange || 0.08,
        keyShift: d?.keyShift ?? 0,
        track: info ? { id: info.detail.track.id, title: info.detail.track.title, key: info.detail.track.key?.camelot ?? null } : null,
      };
    }),
    masterDeck: t.masterDeck,
    mixer: { channels: s.mixer.channels, master: s.mixer.master, fx: s.mixer.fx.map((u) => u.map((f) => ({ type: f.type, on: f.on }))) },
    playlists: lib.playlists.filter((p) => p.kind !== "folder").map((p) => ({ id: p.id, name: p.name })),
    genres: [...new Set(lib.rows.map((r) => r.genre).filter(Boolean))],
    selected: selected ? { id: selected.id, title: selected.title } : null,
    soundSearch: s.settings?.soundSearch !== false,
  };
}

/** App commands Ask MixIt can turn on or off (`id:on`, `id:off`), not just flip. */
function runAppStep(id: string) {
  const [base, want] = id.split(":") as [string, "on" | "off" | undefined];
  const s = useApp.getState();
  const on = want !== "off";
  const preset = /^layout\.preset\.(standard|controller|prepare|arrange)$/.exec(base);
  if (preset) return builtInLayout(preset[1] as BuiltIn);
  const part = /^layout\.(screen|window|home|fold)\.(.+)$/.exec(base);
  if (part) {
    const unit = part[2] as UnitId;
    if (!(unit in UNITS)) return;
    if (part[1] === "screen") sendToOtherScreen(unit);
    else if (part[1] === "window") openInNewWindow(unit);
    else if (part[1] === "home") bringHome(unit);
    else foldPart(unit, on);
    return;
  }
  switch (base) {
    case "app.layout_edit":
      editLayout(want ? on : undefined);
      return;
    case "app.controller":
      setController(want ? on : undefined);
      return;
    case "app.view.pro":
    case "app.view.easy":
      void updateSettings({ viewMode: base === "app.view.pro" ? "pro" : "easy" });
      return;
    case "app.guide":
      s.set({ guideOpen: want ? on : !s.guideOpen });
      return;
    case "app.coach":
      void updateSettings({ coach: want ? on : !s.settings?.coach });
      return;
    case "app.assistant":
      setAssistantOpen(on);
      return;
    case "app.sampler":
    case "app.sequencer":
    case "app.tools":
      if (on) openTool(base === "app.sampler" ? "pads" : base === "app.sequencer" ? "steps" : s.toolTab);
      else setTools({ toolSize: "closed" });
      return;
    case "app.autodj": {
      const running = useAutoDj.getState().phase !== "off";
      if (!want || running !== on) runCommand("app.autodj");
      return;
    }
  }
  runCommand(base);
}

async function runStep(step: AskStep) {
  switch (step.do) {
    case "press":
      return act(step.id, { type: "press" });
    case "tap":
      return tap(step.id);
    case "set":
      if (step.id === "global.record") {
        if (useTelemetry.getState().t.recording !== step.on) await toggleRecording();
        return;
      }
      return setOn(step.id, step.on);
    case "value":
      return setValue(step.id, step.value);
    case "choose":
      return choose(step.id, step.index);
    case "app":
      return runAppStep(step.id);
  }
}

/** Does what was understood. `extra` runs one of the command palette's own commands. */
export async function runAsk(u: Understood, extra: (id: string) => void = () => {}) {
  const a = u.ask;
  const lib = useLibrary.getState();
  switch (a.kind) {
    case "control":
      if (!a.steps.length) {
        toast.message(u.say);
        return;
      }
      for (const s of a.steps) await runStep(s);
      return;
    case "find":
      useApp.getState().set({ workspace: "library" });
      lib.set({ source: a.playlist != null ? { type: "playlist", id: a.playlist } : { type: "all" }, query: a.query, selected: [], anchor: null });
      await refreshRows();
      return;
    case "describe":
      useApp.getState().set({ workspace: "library" });
      await showDescribed(a.text);
      return;
    case "similar":
      useApp.getState().set({ workspace: "library" });
      lib.set({ source: { type: "similar", id: a.id, title: a.title }, sort: null, matches: {} });
      await refreshRows();
      return;
    case "next":
      lib.set({ source: { type: "suggest" }, suggestFor: null, energy: a.energy });
      await refreshSuggestions();
      await refreshRows();
      return;
    case "buildSet":
      useApp.getState().set({ workspace: "library" });
      openBuildSet({ plan: a.plan });
      return;
    case "explain": {
      const spec = useApp.getState().registry.find((x) => x.id === a.id);
      if (spec) toast.message(spec.label, { description: spec.explain, duration: 12_000 });
      return;
    }
    case "extra":
      extra(a.id);
      return;
  }
}
