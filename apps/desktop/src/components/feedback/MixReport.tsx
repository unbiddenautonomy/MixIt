// The report after a recorded mix: an overall mark, what went well, what to work on
// (each with a practice lab and a guide topic), and every transition checked.
import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { AlertTriangle, BookOpen, Check, FlaskConical, Lightbulb, Pencil, X } from "lucide-react";
import { create } from "zustand";
import type { MixProject } from "../../backend/types";
import { clock, type Finding, type MixReport, type TransitionCheck } from "../../lib/feedback";
import { useGuide } from "../../guide/model";
import { labById } from "../../guide/labs";
import { conceptById } from "../../guide/concepts";
import { useApp } from "../../store/app";
import { Btn } from "../ui/Button";
import { backend } from "../../backend";
import { cueSheet, stemOf, timestamp, tracklistText, type TracklistEntry } from "../../lib/tracklist";
import { toast } from "sonner";

export interface ReportTracklist {
  entries: TracklistEntry[];
  /** The mix's name, for the CUE sheet's title. */
  name: string;
  /** Already written beside the recording. */
  saved: boolean;
}

interface ReportState {
  report: MixReport | null;
  project: MixProject | null;
  path: string | null;
  tracklist: ReportTracklist | null;
  open: boolean;
}

export const useReport = create<ReportState>(() => ({ report: null, project: null, path: null, tracklist: null, open: false }));

export function showReport(report: MixReport, project: MixProject | null, path: string | null, tracklist: ReportTracklist | null = null) {
  useReport.setState({ report, project, path, tracklist, open: true });
}

function openLab(id: string) {
  useReport.setState({ open: false });
  useApp.getState().set({ guideOpen: true, workspace: "mix" });
  useGuide.getState().set({ tab: "labs", lab: id });
}

function openConcept(id: string) {
  useReport.setState({ open: false });
  useApp.getState().set({ guideOpen: true });
  useGuide.getState().set({ tab: "learn", topic: id });
}

export function MixReportDialog({ onEdit }: { onEdit: (p: MixProject) => void }) {
  const { report, project, open } = useReport();
  return (
    <Dialog.Root open={open && !!report} onOpenChange={(o) => useReport.setState({ open: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(760px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl"
          aria-describedby={undefined}
        >
          {report && <Body report={report} project={project} onEdit={onEdit} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Score({ value }: { value: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const color = value >= 85 ? "#34d399" : value >= 60 ? "#fbbf24" : "#f87171";
  return (
    <svg width={64} height={64} viewBox="0 0 64 64" aria-label={`Score ${value} out of 100`}>
      <circle cx={32} cy={32} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={6} />
      <circle cx={32} cy={32} r={r} fill="none" stroke={color} strokeWidth={6} strokeDasharray={`${(value / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 32 32)" />
      <text x={32} y={37} textAnchor="middle" fontSize={16} fontWeight={700} fill="currentColor" className="text-zinc-50">
        {value}
      </text>
    </svg>
  );
}

function verdict(score: number): string {
  if (score >= 90) return "A clean mix. Keep going like this.";
  if (score >= 75) return "A good mix with a couple of things to tidy up.";
  if (score >= 55) return "Getting there. Work on the points below one at a time.";
  return "A rough one, and that is how everyone starts. Pick one thing below and practise it.";
}

function Body({ report, project, onEdit }: { report: MixReport; project: MixProject | null; onEdit: (p: MixProject) => void }) {
  const work = report.findings.filter((f) => f.severity !== "good");
  const good = report.findings.filter((f) => f.severity === "good");
  return (
    <>
      <div className="flex items-center gap-4 border-b border-white/[0.06] px-5 py-4">
        <Score value={report.score} />
        <div className="min-w-0 flex-1">
          <Dialog.Title className="text-base font-semibold text-zinc-50">How your mix went</Dialog.Title>
          <p className="text-xs text-zinc-400">
            {clock(report.seconds)} long · {report.tracks} track{report.tracks === 1 ? "" : "s"} · {report.transitions.length} transition{report.transitions.length === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-sm text-zinc-300">{verdict(report.score)}</p>
        </div>
        <Dialog.Close className="rounded-md p-1.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-100" aria-label="Close">
          <X size={15} />
        </Dialog.Close>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 text-sm">
        {work.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What to work on</h3>
            {work.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </section>
        )}
        {good.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What went well</h3>
            {good.map((f) => (
              <FindingRow key={f.id} f={f} />
            ))}
          </section>
        )}
        {report.transitions.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Each transition</h3>
            <div className="overflow-x-auto rounded-lg border border-white/[0.06]">
              <table className="w-full text-left text-xs">
                <thead className="bg-white/[0.03] text-[10px] uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">At</th>
                    <th className="px-2 py-1.5 font-medium">From → to</th>
                    <th className="px-2 py-1.5 font-medium">Length</th>
                    <th className="px-2 py-1.5 text-center font-medium" title="The tempos matched">Tempo</th>
                    <th className="px-2 py-1.5 text-center font-medium" title="The kicks hit together">Beats</th>
                    <th className="px-2 py-1.5 text-center font-medium" title="Bars and 8-bar phrases lined up">Phrase</th>
                    <th className="px-2 py-1.5 text-center font-medium" title="Only one bassline at a time">Bass</th>
                    <th className="px-2 py-1.5 text-center font-medium" title="The keys fit together">Key</th>
                  </tr>
                </thead>
                <tbody>
                  {report.transitions.map((t, i) => (
                    <TransitionRow key={i} t={t} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
        <Tracklist />
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-5 py-3">
        <p className="flex-1 text-xs text-zinc-500">{project ? "Every move you made was captured, so you can fix a transition in Arrange instead of mixing again." : "Record a longer mix to get it as an editable project too."}</p>
        {project && (
          <Btn
            tone="accent"
            onClick={() => {
              useReport.setState({ open: false });
              onEdit(project);
            }}
          >
            <Pencil size={13} /> Fix it in Arrange
          </Btn>
        )}
      </div>
    </>
  );
}

function FindingRow({ f }: { f: Finding }) {
  const Icon = f.severity === "good" ? Check : f.severity === "problem" ? AlertTriangle : Lightbulb;
  const lab = f.lab ? labById(f.lab) : undefined;
  const concept = f.concept ? conceptById(f.concept) : undefined;
  return (
    <div className={clsx("flex gap-3 rounded-xl border p-3", f.severity === "good" ? "border-emerald-400/15 bg-emerald-400/[0.04]" : f.severity === "problem" ? "border-amber-400/20 bg-amber-400/[0.05]" : "border-sky-400/15 bg-sky-400/[0.04]")}>
      <Icon size={16} className={clsx("mt-0.5 shrink-0", f.severity === "good" ? "text-emerald-300" : f.severity === "problem" ? "text-amber-300" : "text-sky-300")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-zinc-100">{f.title}</span>
          {f.at !== undefined && <span className="font-mono text-[11px] text-zinc-500">at {clock(f.at)}</span>}
        </div>
        <p className="mt-0.5 text-[13px] leading-snug text-zinc-400">{f.detail}</p>
        {(lab || concept) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {lab && (
              <Btn size="sm" onClick={() => openLab(lab.id)}>
                <FlaskConical size={12} /> Practise: {lab.title}
              </Btn>
            )}
            {concept && (
              <Btn size="sm" tone="ghost" onClick={() => openConcept(concept.id)}>
                <BookOpen size={12} /> {concept.title}
              </Btn>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Mark({ ok, title }: { ok: boolean | null; title: string }) {
  if (ok === null) return <span className="text-zinc-600" title={title}>–</span>;
  return ok ? <Check size={13} className="mx-auto text-emerald-300" aria-label={`${title}: fine`} /> : <X size={13} className="mx-auto text-amber-300" aria-label={`${title}: needs work`} />;
}

function TransitionRow({ t }: { t: TransitionCheck }) {
  const tempo = t.tempoPct === null ? null : Math.abs(t.tempoPct) < 0.5;
  const beats = t.offsetMs === null ? null : t.offsetMs <= 25;
  const phrase = t.barOffset === null ? null : t.barOffset === 0 && t.phraseOffset === 0;
  return (
    <tr className="border-t border-white/[0.04] text-zinc-300">
      <td className="px-2 py-1.5 font-mono text-zinc-500">{clock(t.at)}</td>
      <td className="max-w-64 truncate px-2 py-1.5">
        {t.from} → {t.to}
      </td>
      <td className="px-2 py-1.5 font-mono text-zinc-400">{t.beats >= 4 ? `${Math.round(t.beats / 4)} bars` : `${t.beats} beats`}</td>
      <td className="px-2 py-1.5 text-center">
        <Mark ok={tempo} title={t.tempoPct === null ? "Different tempos" : `${t.tempoPct.toFixed(1)}% apart`} />
      </td>
      <td className="px-2 py-1.5 text-center">
        <Mark ok={beats} title={t.offsetMs === null ? "Tempos did not match" : `${Math.round(t.offsetMs)} ms apart`} />
      </td>
      <td className="px-2 py-1.5 text-center">
        <Mark ok={phrase} title="Bars and phrases" />
      </td>
      <td className="px-2 py-1.5 text-center">
        <Mark ok={t.bassClash < 2} title={`${t.bassClash.toFixed(1)} s with two basslines`} />
      </td>
      <td className="px-2 py-1.5 text-center">
        <Mark ok={t.keysFit} title={t.fromKey && t.toKey ? `${t.fromKey} → ${t.toKey}` : "Key unknown"} />
      </td>
    </tr>
  );
}

/** The tracks heard in the recording and when, ready to paste into a mix site or save as a CUE sheet. */
function Tracklist() {
  const tl = useReport((s) => s.tracklist);
  const path = useReport((s) => s.path);
  if (!tl || tl.entries.length === 0) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tracklistText(tl.entries));
      toast.success("Tracklist copied");
    } catch {
      toast.error("Could not copy. Select the list and copy it instead.");
    }
  };
  const save = async () => {
    const b = backend();
    // In a browser the recording went to the downloads under this name.
    const file = path?.replace(/, in your downloads$/, "") || `${tl.name}.wav`;
    const base = stemOf(file);
    try {
      await b.saveText(`${base}.cue`, cueSheet(tl.entries, file, tl.name));
      useReport.setState({ tracklist: { ...tl, saved: true } });
      toast.success("CUE sheet saved", { description: b.kind === "tauri" ? `${base}.cue` : "In your downloads, next to the recording." });
    } catch (e) {
      toast.error(String(e));
    }
  };
  return (
    <section className="flex flex-col gap-1.5" data-testid="report-tracklist">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Tracklist</h3>
        <span className="text-[11px] text-zinc-500">{tl.saved ? "Saved beside the recording as a CUE sheet and a text file." : "Players and mix sites use a CUE sheet to show and skip between the tracks."}</span>
        <div className="ml-auto flex gap-1">
          <Btn size="sm" onClick={() => void copy()}>
            Copy
          </Btn>
          {!tl.saved && (
            <Btn size="sm" onClick={() => void save()}>
              Save CUE sheet
            </Btn>
          )}
        </div>
      </div>
      <ol className="rounded-lg border border-white/[0.06] text-xs">
        {tl.entries.map((e, i) => (
          <li key={i} className="flex gap-3 px-2 py-1 odd:bg-white/[0.02]">
            <span className="w-14 shrink-0 font-mono text-zinc-500">{timestamp(e.at)}</span>
            <span className="min-w-0 truncate text-zinc-200">
              {e.title}
              {e.artist && <span className="text-zinc-500"> · {e.artist}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
