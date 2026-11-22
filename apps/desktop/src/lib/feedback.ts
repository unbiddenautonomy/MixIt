// A plain-language report on a recorded mix: what went well, what to work on, and each
// transition checked for tempo, beats, phrases, basslines and keys. It reads the frames
// that lib/capture.ts records while Rec is on, so it judges exactly what was heard.
import { CAPTURE_RATE, type Capture, type CaptureFrame, type DeckFrame } from "./capture";
import { compatible, keyDto, transpose, type Key } from "./keys";

/** A deck counts as heard above this channel level (a fader well up). */
const HEARD = 0.15;
/** Both basslines count as playing above this low EQ (dB). */
const BASS_ON = -10;
const PHRASE = 32;
/** A voice counts as up front above this mid EQ (dB). */
const VOICE_ON = -6;

export type Severity = "good" | "tip" | "problem";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Seconds into the recording, when it happened at one spot. */
  at?: number;
  /** A practice lab and a guide topic that help. */
  lab?: string;
  concept?: string;
}

export interface TransitionCheck {
  /** Seconds into the recording where both tracks were first heard together. */
  at: number;
  seconds: number;
  beats: number;
  from: string;
  to: string;
  /** Tempo difference in percent while both played (null: different tempo families). */
  tempoPct: number | null;
  /** Average beat offset in milliseconds (null when the tempos did not match). */
  offsetMs: number | null;
  /** Whole beats between the two tracks' bar and phrase grids. */
  barOffset: number | null;
  phraseOffset: number | null;
  /** Seconds with both basslines up. */
  bassClash: number;
  /** Seconds with both tracks singing, loud and with their mids up. */
  vocalClash: number;
  keysFit: boolean | null;
  fromKey: string | null;
  toKey: string | null;
  /** The new track's bass came in with an EQ move (a bass swap). */
  usedEq: boolean;
}

export interface MixReport {
  name: string;
  seconds: number;
  tracks: number;
  transitions: TransitionCheck[];
  findings: Finding[];
  /** 0–100, a rough overall mark. */
  score: number;
}

const heard = (d: DeckFrame | null | undefined): d is DeckFrame => !!d && d.playing && d.volume >= HEARD;

/** Beat difference folded into −0.5…0.5. */
const phaseDiff = (a: number, b: number) => ((((a - b) % 1) + 1.5) % 1) - 0.5;
const mod = (x: number, m: number) => ((x % m) + m) % m;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The key a deck is heard in: the track's key, its key shift, and pitch from tempo without key lock. */
function heardKey(cap: Capture, d: DeckFrame): Key | null {
  const ref = cap.tracks[d.token];
  const k = ref?.key as { tonic?: number; mode?: string } | null | undefined;
  if (!k || typeof k.tonic !== "number") return null;
  let shift = d.keyShift;
  if (!d.keylock && ref.bpm > 0) shift += 12 * Math.log2(d.bpm / ref.bpm);
  return transpose({ tonic: k.tonic, minor: k.mode === "Minor" }, Math.round(shift));
}

const title = (cap: Capture, token: number) => cap.tracks[token]?.title || "a track";

export function clock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

interface Overlap {
  a: number;
  b: number;
  from: number;
  to: number;
}

/** Stretches where two decks were heard together (the first two, when three are). */
function overlaps(frames: CaptureFrame[]): Overlap[] {
  const out: Overlap[] = [];
  let cur: Overlap | null = null;
  frames.forEach((f, i) => {
    const on = f.decks.map((d, k) => (heard(d) ? k : -1)).filter((k) => k >= 0);
    const pair = on.length >= 2 ? [on[0], on[1]] : null;
    if (pair && cur && cur.a === pair[0] && cur.b === pair[1] && f.decks[pair[0]]!.token === frames[cur.from].decks[pair[0]]?.token && f.decks[pair[1]]!.token === frames[cur.from].decks[pair[1]]?.token) cur.to = i;
    else {
      if (cur) out.push(cur);
      cur = pair ? { a: pair[0], b: pair[1], from: i, to: i } : null;
    }
  });
  if (cur) out.push(cur);
  return out;
}

function checkTransition(cap: Capture, o: Overlap): TransitionCheck | null {
  const fr = cap.frames.slice(o.from, o.to + 1);
  const t0 = fr[0].t;
  const seconds = fr[fr.length - 1].t - t0;
  if (seconds < 1) return null;
  // The outgoing track is the one heard first.
  const before = cap.frames.slice(Math.max(0, o.from - 40), o.from);
  const aFirst = before.filter((f) => heard(f.decks[o.a])).length >= before.filter((f) => heard(f.decks[o.b])).length;
  const [out, inn] = aFirst ? [o.a, o.b] : [o.b, o.a];
  const dOut = fr[0].decks[out]!;
  const dIn = fr[0].decks[inn]!;
  const ratio = median(fr.map((f) => f.decks[inn]!.bpm / Math.max(1, f.decks[out]!.bpm)));
  const sameFamily = ratio > 0.9 && ratio < 1.1;
  const tempoPct = sameFamily ? (ratio - 1) * 100 : null;
  let offsetMs: number | null = null;
  let barOffset: number | null = null;
  let phraseOffset: number | null = null;
  if (sameFamily && Math.abs(tempoPct!) < 0.5) {
    offsetMs = median(fr.map((f) => Math.abs(phaseDiff(f.decks[inn]!.beat, f.decks[out]!.beat)) * (60_000 / f.decks[out]!.bpm)));
    const whole = Math.round(median(fr.map((f) => f.decks[inn]!.beat - f.decks[out]!.beat)));
    barOffset = mod(whole, 4);
    phraseOffset = mod(whole, PHRASE);
  }
  let bassClash = 0;
  let vocalClash = 0;
  let usedEq = false;
  for (let i = 1; i < fr.length; i++) {
    const f = fr[i];
    const a = f.decks[out]!;
    const b = f.decks[inn]!;
    if (a.low > BASS_ON && b.low > BASS_ON && a.volume > 0.5 && b.volume > 0.5) bassClash += f.t - fr[i - 1].t;
    if (a.singing && b.singing && a.mid > VOICE_ON && b.mid > VOICE_ON && a.volume > 0.5 && b.volume > 0.5) vocalClash += f.t - fr[i - 1].t;
    if (Math.abs(b.low - fr[i - 1].decks[inn]!.low) > 3 || Math.abs(a.low - fr[i - 1].decks[out]!.low) > 3) usedEq = true;
  }
  const kOut = heardKey(cap, dOut);
  const kIn = heardKey(cap, dIn);
  const bps = dOut.bpm / 60;
  return {
    at: t0,
    seconds,
    beats: Math.round(seconds * bps),
    from: title(cap, dOut.token),
    to: title(cap, dIn.token),
    tempoPct,
    offsetMs,
    barOffset,
    phraseOffset,
    bassClash,
    vocalClash,
    keysFit: kOut && kIn ? compatible(kOut, kIn) : null,
    fromKey: kOut ? keyDto(kOut).camelot : null,
    toKey: kIn ? keyDto(kIn).camelot : null,
    usedEq,
  };
}

/** Builds the report. Null when too little was heard to say anything useful. */
export function mixReport(cap: Capture): MixReport | null {
  const f = cap.frames;
  const heardFrames = f.filter((x) => x.decks.some(heard));
  if (heardFrames.length < 20) return null;
  const first = heardFrames[0].t;
  const last = heardFrames[heardFrames.length - 1].t;
  const seconds = last - first;
  const tokens = new Set<number>();
  for (const x of f) for (const d of x.decks) if (heard(d)) tokens.add(d.token);
  const transitions = overlaps(f)
    .map((o) => checkTransition(cap, o))
    .filter((t): t is TransitionCheck => !!t);

  const findings: Finding[] = [];
  let score = 100;
  const add = (x: Finding, cost: number) => {
    findings.push(x);
    if (x.severity !== "good") score -= cost;
  };

  // Silence between tracks.
  let gap = 0;
  let gapAt = 0;
  let worst = 0;
  let worstAt = 0;
  for (let i = 1; i < f.length; i++) {
    if (f[i].t <= first || f[i].t >= last) continue;
    if (!f[i].decks.some(heard)) {
      if (gap === 0) gapAt = f[i].t;
      gap += f[i].t - f[i - 1].t;
      if (gap > worst) (worst = gap), (worstAt = gapAt);
    } else gap = 0;
  }
  if (worst >= 1) {
    add({ id: "silence", severity: "problem", title: `${worst.toFixed(1)} seconds of silence`, detail: "The music stopped between tracks. Start the next track before the last one ends, and bring its fader up as the old one goes down.", at: worstAt, lab: "phrase-drop", concept: "phrase" }, 15);
  }

  // Tempo and beat matching.
  const unmatched = transitions.filter((t) => t.tempoPct !== null && Math.abs(t.tempoPct) >= 0.5);
  const flams = transitions.filter((t) => t.offsetMs !== null && t.offsetMs > 25);
  if (unmatched.length) {
    const t = unmatched[0];
    add({ id: "tempo", severity: "problem", title: `Tempos did not match in ${unmatched.length} transition${unmatched.length > 1 ? "s" : ""}`, detail: `“${t.to}” played ${Math.abs(t.tempoPct!).toFixed(1)}% ${t.tempoPct! > 0 ? "faster" : "slower"} than “${t.from}”, so the kicks drifted apart. Press Sync, or match the tempo before you bring the fader up.`, at: t.at, lab: "phrase-drop", concept: "sync" }, 10 * unmatched.length);
  }
  if (flams.length) {
    const t = flams.reduce((a, b) => (b.offsetMs! > a.offsetMs! ? b : a));
    add({ id: "phase", severity: "problem", title: `Beats were off in ${flams.length} transition${flams.length > 1 ? "s" : ""}`, detail: `The kicks landed about ${Math.round(t.offsetMs!)} ms apart when “${t.to}” came in, which sounds like a gallop. Sync both decks, or nudge the new one until the kicks hit together.`, at: t.at, lab: "beatgrid", concept: "beatmatch" }, 8 * flams.length);
  }
  const bars = transitions.filter((t) => t.barOffset !== null && t.barOffset !== 0);
  const phrases = transitions.filter((t) => t.barOffset === 0 && t.phraseOffset !== null && t.phraseOffset !== 0);
  if (bars.length) {
    const t = bars[0];
    add({ id: "downbeat", severity: "problem", title: "A new track came in off the bar", detail: `“${t.to}” started ${t.barOffset} beat${t.barOffset === 1 ? "" : "s"} away from the first beat of a bar of “${t.from}”, so its “one” landed in the wrong place. Start new tracks from a hot cue on a downbeat.`, at: t.at, lab: "phrase-drop", concept: "phrase" }, 6 * bars.length);
  }
  if (phrases.length) {
    const t = phrases[0];
    add({ id: "phrase", severity: "tip", title: "Phrases did not line up", detail: `“${t.to}” came in ${Math.min(t.phraseOffset!, PHRASE - t.phraseOffset!) / 4} bar${Math.min(t.phraseOffset!, PHRASE - t.phraseOffset!) === 4 ? "" : "s"} away from the start of a phrase of “${t.from}”. When you start a track at the top of an 8-bar phrase, the build-ups and drops of both tracks happen together.`, at: t.at, lab: "phrase-drop", concept: "phrase" }, 3 * phrases.length);
  }

  // Basslines and keys.
  const muddy = transitions.filter((t) => t.bassClash >= 2);
  if (muddy.length) {
    const t = muddy.reduce((a, b) => (b.bassClash > a.bassClash ? b : a));
    add({ id: "bass", severity: "problem", title: `Two basslines at once for ${Math.round(t.bassClash)} seconds`, detail: `When “${t.to}” came in, both tracks had their bass up, which makes the mix muddy and loud. Turn the new track's Low EQ down, then swap the basses on a downbeat.`, at: t.at, lab: "bass-swap", concept: "bass-swap" }, 7 * muddy.length);
  }
  const voices = transitions.filter((t) => t.vocalClash >= 3);
  if (voices.length) {
    const t = voices.reduce((a, b) => (b.vocalClash > a.vocalClash ? b : a));
    add({ id: "vocals", severity: "tip", title: `Two singers at once for ${Math.round(t.vocalClash)} seconds`, detail: `“${t.from}” and “${t.to}” were both singing, loud and with their mids up. Two voices blur together even when the keys fit. Bring the new track in during an instrumental part, or turn one track's Mid down until the other's vocal ends.`, at: t.at, lab: "vocals", concept: "vocals" }, 4 * voices.length);
  }
  const clashes = transitions.filter((t) => t.keysFit === false);
  if (clashes.length) {
    const t = clashes[0];
    add({ id: "key", severity: "tip", title: `Keys clashed in ${clashes.length} transition${clashes.length > 1 ? "s" : ""}`, detail: `“${t.from}” (${t.fromKey}) and “${t.to}” (${t.toKey}) do not sit well together. Keep the overlap short, or shift one track's key a step with key lock on.`, at: t.at, lab: "key-lock", concept: "key" }, 4 * clashes.length);
  }

  // Level.
  const loud = f.filter((x) => x.master && (x.master.clipped || Math.abs(x.master.limiterDb) > 3));
  const loudSec = loud.length / CAPTURE_RATE;
  if (loudSec >= 1) {
    add({ id: "level", severity: "problem", title: `Too loud for ${Math.round(loudSec)} seconds`, detail: "The master hit the red, so the limiter squashed the sound. Keep each channel's meter out of the red with Gain, and bring faders down a little while two tracks play.", at: loud[0].t, concept: "clipping" }, Math.min(15, 3 + loudSec));
  }

  // What went well.
  const clean = transitions.filter((t) => (t.offsetMs ?? 99) <= 25 && t.barOffset === 0 && t.bassClash < 2 && t.keysFit !== false);
  if (transitions.length && clean.length === transitions.length) add({ id: "clean", severity: "good", title: transitions.length === 1 ? "The transition was beatmatched" : "Every transition was beatmatched", detail: "Tempos matched, kicks lined up on the bar, and the basslines never fought." }, 0);
  else if (clean.length) add({ id: "clean", severity: "good", title: `${clean.length} of ${transitions.length} transitions beatmatched`, detail: "Tempos matched, kicks lined up on the bar, and the basslines never fought." }, 0);
  if (transitions.some((t) => t.usedEq && t.bassClash < 2)) add({ id: "eq", severity: "good", title: "You mixed with the EQ", detail: "Swapping the bass with the Low EQ is what keeps a blend clean. Nice." }, 0);
  if (worst < 1 && tokens.size >= 2) add({ id: "flow", severity: "good", title: "No gaps", detail: "The music kept going from one track to the next." }, 0);
  if (loudSec < 1 && f.some((x) => x.master)) add({ id: "levels", severity: "good", title: "Levels stayed out of the red", detail: "The master never clipped." }, 0);
  if (!transitions.length && tokens.size < 2) add({ id: "one", severity: "tip", title: "Only one track was heard", detail: "Mix a second track in to get feedback on your transitions.", lab: "phrase-drop" }, 0);

  const order: Record<Severity, number> = { problem: 0, tip: 1, good: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { name: cap.name, seconds, tracks: tokens.size, transitions, findings, score: Math.max(0, Math.min(100, Math.round(score))) };
}
