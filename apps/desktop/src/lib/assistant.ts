// The mix assistant: listens to the mix for a while (telemetry, the master spectrum and
// the mixer settings) and reports problems in plain words, each with why it matters and,
// where there is one, a fix in one click.
//
// It measures over a rolling window rather than a single moment, so a bassline that
// overlaps for half a second or one loud hit does not raise an alarm.
import type { BandDto, StudioDto, Telemetry } from "../backend/types";
import { defaultBand } from "./studio";
import type { MixerState } from "../store/app";

/** Seconds of history the checks look at. */
export const WINDOW_S = 12;
/** Samples per second taken. */
export const RATE = 4;

export interface Sample {
  t: number;
  /** Per deck: playing and heard (fader up), bass RMS, compressor GR. */
  decks: { on: boolean; lowRms: number; compGrDb: number }[];
  lufs: number;
  truePeakDb: number;
  limiterGrDb: number;
  correlation: number;
  clipped: boolean;
  /** Master spectrum (dB per band, 96 bands, tilt-corrected) when the analyser is on. */
  spectrum: number[] | null;
}

export type Level = "problem" | "tip" | "good";

export type Fix =
  | { kind: "action"; id: string; value: number }
  | { kind: "master-db"; delta: number }
  | { kind: "match-loudness"; targetLufs: number }
  | { kind: "master-eq"; preset: "tame-harsh" | "clear-mud" | "add-air" | "tighten-bass" }
  | { kind: "duck"; deck: number; under: number };

export interface Finding {
  id: string;
  level: Level;
  title: string;
  /** Why it matters and what the fix does, in plain words. */
  why: string;
  fix?: { label: string; do: Fix };
  /** Guide topic that explains it. */
  concept?: string;
}

const L = (d: number) => String.fromCharCode(65 + d);
const dbOf = (rms: number) => (rms > 0 ? 20 * Math.log10(rms) : -120);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
/** Mean of loudness values in the energy domain. */
const meanLufs = (xs: number[]) => {
  const live = xs.filter((x) => x > -50);
  return live.length ? 10 * Math.log10(mean(live.map((x) => Math.pow(10, x / 10)))) : -99;
};

/** One sample of the mix from telemetry and the mixer. */
export function sample(t: Telemetry, mixer: MixerState, decks: number, now: number): Sample {
  return {
    t: now,
    decks: Array.from({ length: decks }, (_, i) => {
      const d = t.decks[i];
      const c = mixer.channels[i];
      return { on: !!d?.playing && (c?.fader ?? 0) > 0.2, lowRms: d?.lowRms ?? 0, compGrDb: d?.compGrDb ?? 0 };
    }),
    lufs: t.master.shortTermLufs,
    truePeakDb: t.master.truePeakDb,
    limiterGrDb: t.master.limiterGrDb,
    correlation: t.master.correlation,
    clipped: t.master.clipped,
    spectrum: t.spectrum && t.spectrum.length ? t.spectrum : null,
  };
}

/** Average spectrum level (dB) between two frequencies. 96 log bands span 20 Hz to 20 kHz. */
export function bandLevel(spec: number[], lo: number, hi: number): number {
  const n = spec.length;
  const idx = (f: number) => Math.round((Math.log(f / 20) / Math.log(1000)) * n - 0.5);
  const a = Math.max(0, idx(lo));
  const b = Math.min(n - 1, idx(hi));
  const xs = spec.slice(a, b + 1).map((x) => Math.pow(10, x / 10));
  return xs.length ? 10 * Math.log10(mean(xs)) : -120;
}

export interface Context {
  mixer: MixerState;
  /** Known master strip (for checking what is already on it). */
  master: StudioDto | null;
  targetLufs: number;
  targetName: string;
}

/**
 * The findings for the samples in the window, most important first. Returns an empty
 * list until enough music has played to judge.
 */
export function assess(samples: Sample[], ctx: Context): Finding[] {
  const live = samples.filter((s) => s.decks.some((d) => d.on) && s.lufs > -50);
  if (live.length < RATE * 3) return [];
  const out: Finding[] = [];
  const decks = live[0].decks.length;

  // Clipping and the limiter working hard.
  const clipped = live.some((s) => s.clipped);
  const gr = mean(live.map((s) => s.limiterGrDb));
  if (clipped || gr < -3) {
    const down = Math.min(12, Math.max(2, Math.round(-gr + (clipped ? 2 : 0))));
    out.push({
      id: "limiter",
      level: "problem",
      title: clipped ? "The mix is clipping" : `The limiter is squashing the mix (${gr.toFixed(1)} dB)`,
      why: "When the mix is louder than the output can take, MixIt's limiter flattens the peaks to stop distortion. A little is fine; this much takes the punch out of the drums. Turning the master down gives it room; turn your speakers up instead.",
      fix: { label: `Master down ${down} dB`, do: { kind: "master-db", delta: -down } },
    });
  }

  // Two basslines at once.
  for (let a = 0; a < decks; a++) {
    for (let b = a + 1; b < decks; b++) {
      const both = live.filter((s) => s.decks[a].on && s.decks[b].on && dbOf(s.decks[a].lowRms) > -30 && dbOf(s.decks[b].lowRms) > -30);
      if (both.length >= RATE * 2) {
        // Turn down the one with less bass (usually the one on its way out or in).
        const la = mean(both.map((s) => s.decks[a].lowRms));
        const lb = mean(both.map((s) => s.decks[b].lowRms));
        const quiet = la < lb ? a : b;
        const loud = quiet === a ? b : a;
        out.push({
          id: `bass-${a}${b}`,
          level: "problem",
          title: `Decks ${L(a)} and ${L(b)} both have bass`,
          why: `Two basslines at once add up to a muddy, boomy low end and push the level into the limiter. Cut the bass on deck ${L(quiet)} until it takes over, or let deck ${L(quiet)} duck under deck ${L(loud)} automatically.`,
          fix: { label: `Cut bass on ${L(quiet)}`, do: { kind: "action", id: `mixer.${L(quiet)}.eq.low`, value: -26 } },
        });
        out.push({
          id: `duck-${quiet}`,
          level: "tip",
          title: `Let deck ${L(quiet)} make room for deck ${L(loud)}`,
          why: `Ducking turns deck ${L(quiet)} down a little whenever deck ${L(loud)} is loud, so the new track comes through without riding the fader.`,
          fix: { label: `Duck ${L(quiet)} under ${L(loud)}`, do: { kind: "duck", deck: quiet, under: loud } },
        });
      }
    }
  }

  // Loudness against the target.
  const lufs = meanLufs(live.map((s) => s.lufs));
  if (lufs > -60) {
    const diff = lufs - ctx.targetLufs;
    if (diff < -3) {
      out.push({
        id: "quiet",
        level: "tip",
        title: `Quieter than ${ctx.targetName} (${lufs.toFixed(1)} LUFS)`,
        why: `Your mix sits about ${(-diff).toFixed(0)} dB under the ${ctx.targetLufs} LUFS target, so a recording will sound weak next to other music. Match sets the master output to reach the target.`,
        fix: { label: "Match the target", do: { kind: "match-loudness", targetLufs: ctx.targetLufs } },
      });
    } else if (diff > 2) {
      out.push({
        id: "loud",
        level: diff > 5 ? "problem" : "tip",
        title: `Louder than ${ctx.targetName} (${lufs.toFixed(1)} LUFS)`,
        why: `Streaming services turn loud mixes down anyway, so the extra ${diff.toFixed(0)} dB only costs punch and leaves less room before the limiter. Match brings it to the target.`,
        fix: { label: "Match the target", do: { kind: "match-loudness", targetLufs: ctx.targetLufs } },
      });
    } else {
      out.push({ id: "loud-ok", level: "good", title: `Loudness on target (${lufs.toFixed(1)} LUFS)`, why: `Within a couple of dB of ${ctx.targetName}.` });
    }
  }

  // True peak for files that will be uploaded.
  const tp = Math.max(...live.map((s) => s.truePeakDb));
  if (tp > -0.5 && !clipped) {
    out.push({
      id: "true-peak",
      level: "tip",
      title: `Peaks reach ${tp.toFixed(1)} dB`,
      why: "Files converted to MP3 or AAC for streaming can distort when the peaks are this close to the top. Leaving about 1 dB of room is safer.",
      fix: { label: "Master down 1 dB", do: { kind: "master-db", delta: -1 } },
    });
  }

  // Mono compatibility.
  const corr = mean(live.map((s) => s.correlation));
  const worst = Math.min(...live.map((s) => s.correlation));
  if (corr < 0.15 || worst < -0.3) {
    const wide = Array.from({ length: decks }, (_, i) => i).filter((i) => (ctx.mixer.channels[i]?.width ?? 1) > 1.05);
    out.push({
      id: "mono",
      level: "problem",
      title: "Parts of the mix cancel out in mono",
      why: "The left and right speakers are playing opposite sounds. On a phone, a mono club system or a radio, those parts disappear and the mix sounds hollow. It is usually a stereo-widened track.",
      fix: wide.length ? { label: `Narrow deck ${L(wide[0])}`, do: { kind: "action", id: `mixer.${L(wide[0])}.width`, value: 1 } } : undefined,
    });
  }

  // Over-compression on a channel.
  for (let d = 0; d < decks; d++) {
    const on = live.filter((s) => s.decks[d].on);
    if (on.length < RATE * 2) continue;
    const c = mean(on.map((s) => s.decks[d].compGrDb));
    const punch = ctx.mixer.channels[d]?.punch ?? 0;
    if (c > 10 && punch > 0.2) {
      out.push({
        id: `comp-${d}`,
        level: "tip",
        title: `Deck ${L(d)} is compressed hard (${c.toFixed(0)} dB)`,
        why: "Heavy compression flattens the drums and can make the track pump. A few dB of gain reduction is usually enough.",
        fix: { label: `Less punch on ${L(d)}`, do: { kind: "action", id: `mixer.${L(d)}.punch`, value: Math.round(punch * 50) / 100 } },
      });
    }
  }

  // Tonal balance from the master spectrum (tilted so typical music reads about flat).
  const specs = live.map((s) => s.spectrum).filter((s): s is number[] => !!s);
  if (specs.length >= RATE * 2) {
    const avg = specs[0].map((_, k) => 10 * Math.log10(mean(specs.map((s) => Math.pow(10, s[k] / 10)))));
    const mid = bandLevel(avg, 500, 2000);
    const sub = bandLevel(avg, 30, 120) - mid;
    const mud = bandLevel(avg, 200, 500) - mid;
    const harsh = bandLevel(avg, 2500, 5000) - mid;
    const air = bandLevel(avg, 8000, 16000) - mid;
    if (sub > 8)
      out.push({
        id: "boomy",
        level: "tip",
        title: "Heavy in the deep bass",
        why: "The sub-bass is well above the rest. It can sound great on headphones and boom on big speakers. A gentle low shelf on the master tightens it.",
        fix: { label: "Tighten the low end", do: { kind: "master-eq", preset: "tighten-bass" } },
      });
    if (mud > 5)
      out.push({
        id: "muddy",
        level: "tip",
        title: "Muddy low mids",
        why: "There is a lot around 200 to 500 Hz, where sounds blur together. A small cut there makes everything clearer.",
        fix: { label: "Clear the mud", do: { kind: "master-eq", preset: "clear-mud" } },
      });
    if (harsh > 4)
      out.push({
        id: "harsh",
        level: "tip",
        title: "Harsh upper mids",
        why: "The 2 to 5 kHz range, where ears are most sensitive, is strong. Turned up loud it tires people quickly. A gentle cut softens it.",
        fix: { label: "Tame harshness", do: { kind: "master-eq", preset: "tame-harsh" } },
      });
    if (air < -12)
      out.push({
        id: "dull",
        level: "tip",
        title: "Dull top end",
        why: "There is little above 8 kHz, so the mix can sound muffled. A little \"air\" on the master brings back the shine of the cymbals.",
        fix: { label: "Add air", do: { kind: "master-eq", preset: "add-air" } },
      });
  }

  const rank: Record<Level, number> = { problem: 0, tip: 1, good: 2 };
  return out.map((f) => ({ ...f, concept: f.concept ?? conceptFor(f.id) })).sort((a, b) => rank[a.level] - rank[b.level]);
}

function conceptFor(id: string): string | undefined {
  if (id === "limiter") return "clipping";
  if (id.startsWith("bass-")) return "mud";
  if (id.startsWith("duck-")) return "ducking";
  if (id === "quiet" || id === "loud" || id === "loud-ok" || id === "true-peak") return "loudness";
  if (id === "mono") return "stereo";
  if (id.startsWith("comp-")) return "compressor";
  if (id === "boomy" || id === "muddy" || id === "harsh" || id === "dull") return "studio";
  return undefined;
}

/** Loudness of the music in the window (LUFS), or -99 when nothing played. */
export function windowLufs(samples: Sample[]): number {
  return meanLufs(samples.filter((s) => s.decks.some((d) => d.on)).map((s) => s.lufs));
}

/** The master EQ bands each tonal fix adds. */
export const MASTER_EQ_FIXES: Record<"tame-harsh" | "clear-mud" | "add-air" | "tighten-bass", { shape: "bell" | "lowShelf" | "highShelf"; freq: number; gainDb: number; q: number }> = {
  "tame-harsh": { shape: "bell", freq: 3500, gainDb: -2, q: 1.2 },
  "clear-mud": { shape: "bell", freq: 320, gainDb: -2.5, q: 1 },
  "add-air": { shape: "highShelf", freq: 10_000, gainDb: 2, q: 0.7 },
  "tighten-bass": { shape: "lowShelf", freq: 80, gainDb: -2.5, q: 0.7 },
};

/**
 * The master strip with a tonal fix added. A band already near that frequency with the
 * same shape is moved by the fix instead of adding another, so pressing the same fix twice
 * deepens it (up to ±6 dB) rather than stacking bands.
 */
export function withMasterEq(s: StudioDto, preset: keyof typeof MASTER_EQ_FIXES): StudioDto {
  const fx = MASTER_EQ_FIXES[preset];
  const bands: BandDto[] = s.bands.map((b) => ({ ...b }));
  const near = bands.findIndex((b) => b.enabled && b.shape === fx.shape && Math.abs(Math.log2(b.freq / fx.freq)) < 0.5);
  if (near >= 0) {
    const b = bands[near];
    b.gainDb = Math.max(-6, Math.min(6, b.gainDb + fx.gainDb));
  } else {
    const free = bands.findIndex((b) => !b.enabled);
    if (free < 0) return s;
    bands[free] = { ...defaultBand(), shape: fx.shape, freq: fx.freq, gainDb: fx.gainDb, q: fx.q, enabled: true };
  }
  return { ...s, eqOn: true, bands };
}
