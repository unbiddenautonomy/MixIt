// An in-browser stand-in for the Rust backend: a generated library, simulated decks
// (tempo, sync, loops, cues, meters) and jobs. It lets the UI run in any browser for
// development and tests, and is the starting point of the web version.

import type { Backend, Unlisten } from "./index";
import type * as T from "./types";
import { transition } from "../lib/setFlow";
import { shapeTarget } from "../lib/setShapes";
import { searchTerms } from "../lib/search";
export { searchTerms };
import { applyEdits, DEMO_SR, demoSound, viewOf } from "./demoSound";
import { bestShift, compatibility, fromCamelot, keyDto, keyFromIndex, transpose } from "../lib/keys";
import { toProjectKey } from "../lib/arrangeOps";
import { DUCK_MAX_DB, WARMTH_MAX_DB, defaultStudio, eqDb, glueComp, punchComp } from "../lib/studio";
import { fileName } from "../lib/platform";

export const SR = 48_000;
const DECKS = 4;

// ---------------------------------------------------------------- deterministic random

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const ARTISTS = ["Nova Drift", "Kaleo Moss", "Amber Field", "Polar Echo", "Mira Vale", "Low Tide Club", "Static Bloom", "Juno Reyes", "Oslo Lights", "Teo Marin", "Velvet Signal", "Deep Coast", "Rhea Stone", "Night Ferry", "Sunset Theory"];
const WORDS = ["Afterglow", "Running", "Neon", "Gravity", "Weightless", "Horizon", "Pulse", "Carousel", "Silk", "Daybreak", "Static", "Mirrors", "Paper Moons", "Overdrive", "Satellite", "Echoes", "Velvet", "Tides", "Glasshouse", "Fever", "Lanterns", "Undertow", "Feel It", "Higher", "Midnight", "Bloom", "Motion", "Signal", "Rush", "Haze"];
const GENRES: [string, number, number][] = [
  ["Deep House", 120, 124],
  ["House", 122, 126],
  ["Tech House", 124, 128],
  ["Techno", 128, 134],
  ["Melodic Techno", 120, 125],
  ["Drum & Bass", 172, 175],
  ["Hip Hop", 86, 96],
  ["Disco", 115, 122],
];

export interface DemoTrack {
  row: T.TrackRow;
  sections: T.SectionDto[];
  firstBeat: number;
  period: number;
  wave: Uint8Array;
  cues: T.CueDto[];
  /** Where the track has a voice: [start, end] seconds. */
  vocals: [number, number][];
  /** Pinned beats (warp markers), sorted, the first being the grid's start. */
  pins?: { beat: number; t: number }[];
}

interface TrackOverride {
  title: string;
  genre: string;
  bpm: number;
  key: [number, "A" | "B"];
  firstBeat: number;
  /** Has a singer (in the drops and breakdown, like the generated practice tracks). */
  vocals?: boolean;
}

/** The practice tracks the desktop app generates for the labs (see mixit-generator). */
export const DEMO_PRACTICE: TrackOverride[] = [
  { title: "Practice 1 - Warm House", genre: "House", bpm: 124, key: [8, "A"], firstBeat: 0.02 },
  { title: "Practice 2 - Deep House", genre: "House", bpm: 124, key: [9, "A"], firstBeat: 0.02 },
  { title: "Practice 3 - Night Techno", genre: "Techno", bpm: 128, key: [8, "A"], firstBeat: 0.02 },
  { title: "Practice 4 - Clashing Keys", genre: "House", bpm: 124, key: [3, "B"], firstBeat: 0.02 },
  { title: "Practice 5 - Melodic Trance", genre: "Trance", bpm: 132, key: [5, "A"], firstBeat: 0.02 },
  { title: "Practice 6 - Live Drummer", genre: "House", bpm: 120, key: [11, "B"], firstBeat: 0.42 },
  { title: "Practice 7 - Vocal House", genre: "House", bpm: 124, key: [8, "A"], firstBeat: 0.02, vocals: true },
  { title: "Practice 8 - Vocal Deep House", genre: "House", bpm: 124, key: [9, "A"], firstBeat: 0.02, vocals: true },
];

function makeTrack(id: number, o?: TrackOverride): DemoTrack {
  const r = rng(id * 7919);
  const [g0, lo, hi] = GENRES[Math.floor(r() * GENRES.length)];
  const genre = o?.genre ?? g0;
  const bpm0 = Math.round((lo + r() * (hi - lo)) * 2) / 2;
  const bpm = o?.bpm ?? bpm0;
  const k0 = keyFromIndex(Math.floor(r() * 24));
  const key = o ? fromCamelot(o.key[0], o.key[1]) : k0;
  const bars = [16, 16, 32, 16, 32, 16].map((b) => (r() < 0.3 ? b / 2 : b));
  const labels = ["Intro", "Build", "Drop", "Breakdown", "Drop", "Outro"];
  const period = 60 / bpm;
  const fb = r() < 0.4 ? 0.05 + r() * 0.4 : 0.02;
  const firstBeat = o?.firstBeat ?? fb;
  const sections: T.SectionDto[] = [];
  let t = firstBeat;
  const energies = [0.35, 0.6, 1, 0.3, 1, 0.4];
  bars.forEach((b, i) => {
    const len = b * 4 * period;
    sections.push({ start: t, end: t + len, bars: b, label: labels[i], energy: energies[i] });
    t += len;
  });
  const duration = t + 2;
  const t0 = `${WORDS[Math.floor(r() * WORDS.length)]}${r() < 0.3 ? ` (${["Extended Mix", "Club Mix", "Dub", "Original Mix"][Math.floor(r() * 4)]})` : ""}`;
  const title = o?.title ?? t0;
  // Waveform: 64-frame columns at 48 kHz, shaped by section energy and the beat.
  const fpc = 64;
  const cols = Math.ceil((duration * SR) / fpc);
  const wave = new Uint8Array(cols * 5);
  for (let c = 0; c < cols; c++) {
    const s = (c * fpc) / SR;
    const sec = sections.find((x) => s >= x.start && s < x.end);
    const e = sec ? sec.energy : 0.05;
    const ph = ((s - firstBeat) / period) % 1;
    const kick = sec && sec.label !== "Breakdown" ? Math.exp(-ph * 9) : 0.1;
    const noise = 0.75 + 0.25 * Math.sin(c * 0.37) * Math.sin(c * 0.011);
    const low = Math.min(255, 255 * kick * e * noise);
    const mid = Math.min(255, 255 * (0.18 + 0.32 * e) * noise * (0.6 + 0.4 * Math.sin(c * 0.05)));
    const high = Math.min(255, 255 * e * (0.3 + 0.5 * Math.exp(-((ph + 0.5) % 1) * 12)) * noise);
    const peak = Math.min(255, Math.max(low, mid, high) * 0.9 + 25 * e);
    wave.set([peak, peak * 0.62, low, mid, high], c * 5);
  }
  const mixOut = sections[sections.length - 1].start;
  const cues: T.CueDto[] = [
    { role: "load", slot: null, seconds: firstBeat, loopSeconds: null, label: "Start", color: 0x9ca3af },
    { role: "mixIn", slot: null, seconds: firstBeat, loopSeconds: 32 * period, label: "Mix in", color: 0x1abc9c },
    ...sections.slice(1).map((s) => ({ role: "section" as const, slot: null, seconds: s.start, loopSeconds: null, label: s.label, color: null })),
    { role: "mixOut", slot: null, seconds: mixOut, loopSeconds: 32 * period, label: "Mix out", color: 0xe67e22 },
  ];
  const energy = Math.round(3 + r() * 6);
  // Singing in the breakdown and the first half of each drop, on most tracks but few
  // techno ones (its own random stream, so the rest of the demo stays as it was).
  const vr = rng(id * 104_729 + 1);
  const sings = o ? !!o.vocals : vr() < (genre === "Techno" ? 0.2 : 0.65);
  const vocals: [number, number][] = sings
    ? sections.filter((s) => s.label === "Breakdown" || s.label === "Drop").map((s) => [s.start + 2 * period, s.label === "Drop" ? s.start + (s.end - s.start) / 2 : s.end - 2 * period] as [number, number])
    : [];
  const vocalPct = Math.round((100 * vocals.reduce((a, [s, e]) => a + e - s, 0)) / duration);
  return {
    row: {
      id,
      path: `/Music/${genre}/${title}.flac`,
      title,
      artist: o ? "MixIt" : ARTISTS[Math.floor(r() * ARTISTS.length)],
      album: "",
      genre,
      label: ["Night Shift", "Lumen", "Coastline", "Free Form"][Math.floor(r() * 4)],
      year: 2018 + Math.floor(r() * 8),
      duration,
      bpm,
      key: keyDto(key),
      energy,
      vocals: vocalPct,
      lufs: -9 - r() * 4,
      rating: r() < 0.3 ? 4 + Math.round(r()) : Math.floor(r() * 4),
      color: null,
      playCount: Math.floor(r() * 12),
      lastPlayed: null,
      addedAt: 1_700_000_000 + id * 86_400,
      missing: false,
      analysis: "done",
      comment: "",
      hasArt: !o && id % 3 !== 0,
    },
    sections,
    firstBeat,
    period,
    wave,
    cues,
    vocals,
  };
}

// ---------------------------------------------------------------- simulated decks

interface SimDeck {
  track: DemoTrack | null;
  token: number;
  playing: boolean;
  position: number;
  tempo: number;
  range: number;
  keylock: boolean;
  keyShift: number;
  sync: boolean;
  cue: number;
  cueHeld: boolean;
  loop: T.LoopDto;
  loopSize: number;
  jump: number;
  hot: (T.CueDto | null)[];
  nudge: number;
  fader: number;
  eq: [number, number, number];
  filter: number;
  trim: number;
  slip: boolean;
  /** Slicer pad or roll held: where the track would be, and when that was. */
  held: { pos: number; at: number; pad: string } | null;
  sliceBeats: number;
  keypadCue: number;
  keypadRange: number;
  /** The safety loop is holding the end of the track. */
  safety: boolean;
  /** The safety loop has been used on this pass through the track. */
  safetySpent: boolean;
}

function deckState(): SimDeck {
  return {
    track: null,
    token: 0,
    playing: false,
    position: 0,
    tempo: 0,
    range: 0.08,
    keylock: false,
    keyShift: 0,
    sync: false,
    cue: 0,
    cueHeld: false,
    loop: { start: 0, end: 0, active: false, beats: 0 },
    safety: false,
    safetySpent: false,
    loopSize: 4,
    jump: 4,
    hot: Array(16).fill(null),
    nudge: 0,
    fader: 1,
    eq: [0, 0, 0],
    filter: 0,
    trim: 0,
    slip: false,
    held: null,
    sliceBeats: 8,
    keypadCue: 0,
    keypadRange: 1,
  };
}

type Listener<P> = (p: P) => void;

const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const JUMP_SIZES = [1, 2, 4, 8, 16, 32];
const RANGES = [0.06, 0.08, 0.1, 0.16, 0.5, 1];

export class DemoBackend implements Backend {
  readonly kind: Backend["kind"] = "demo";
  protected tracks: DemoTrack[] = [];
  protected decks: SimDeck[] = Array.from({ length: DECKS }, deckState);
  protected master: number | null = null;
  protected crossfader = 0;
  protected masterDb = 0;
  protected recording = false;
  protected safetyLoop = false;
  protected recorded = 0;
  protected pads: T.PadInfo[] = defaultPads();
  /** Pad index to performance.now() when it stops (Infinity while looping or held). */
  protected padEnds = new Map<number, number>();
  protected listeners = new Map<string, Set<Listener<unknown>>>();
  protected settings: T.Settings = {
    device: null,
    bufferFrames: 256,
    sampleRate: null,
    cueChannel: null,
    keyNotation: "camelot",
    viewMode: "easy",
    theme: "dark",
    decks: 2,
    explain: false,
    coach: true,
    recordFloat: false,
    autoGain: true,
    limiter: true,
    tempoRange: 0.08,
    micEnabled: false,
    micDevice: null,
    micChannel: 0,
    micStereo: false,
    faderStart: false,
    knobDrag: "linear",
    layoutEngine: false,
    safetyLoop: true,
    nowPlayingFile: null,
    nowPlayingFormat: "{artist} - {title}",
    micVoice: true,
    micDenoise: "strong",
    soundSearch: true,
    ask: true,
    checkUpdates: true,
    trainedStems: true,
  };
  /** The simulated mic channel. */
  protected mic = { onAir: false, level: 0.8, gain: 0, talkover: true, depth: -12, recordingSince: null as number | null };
  /** Studio strips: decks 0..3, then the master. */
  protected studio: T.StudioDto[] = [0, 1, 2, 3, 4].map(() => defaultStudio());
  /** Ducking per channel: source deck (or null) and amount 0..1. */
  protected duck: { source: number | null; amount: number }[] = [0, 1, 2, 3].map(() => ({ source: null, amount: 0 }));
  protected scope: T.ScopeSource = "off";
  protected playlistsData: (T.PlaylistDto & { tracks: number[] })[] = [];
  protected historyData: T.HistoryEntry[] = [];
  protected token = 1;
  protected frame = 0;
  protected last = performance.now();
  protected registry: T.ActionSpec[] = [];

  constructor() {
    for (let i = 1; i <= 120; i++) this.tracks.push(makeTrack(i));
    const pick = (n: number, off: number) => this.tracks.slice(off, off + n).map((t) => t.row.id);
    this.playlistsData = [
      { id: 1, parent: null, name: "Warm-up", kind: "list", query: null, count: 0, duration: 0, tracks: pick(12, 0) },
      { id: 2, parent: null, name: "Peak time", kind: "list", query: null, count: 0, duration: 0, tracks: pick(15, 20) },
      { id: 3, parent: null, name: "Fresh & unplayed", kind: "smart", query: "played:never energy:>5", count: 0, duration: 0, tracks: [] },
      { id: 4, parent: null, name: "Around 124", kind: "smart", query: "bpm:~124", count: 0, duration: 0, tracks: [] },
    ];
    // A few tags so the tag features have something to show.
    const seed: [string, string, number[]][] = [
      ["Vocal", "Vocals", [2, 5, 9, 14, 21, 30]],
      ["Peak time", "Moment", [3, 22, 24, 27, 33]],
      ["Warm-up", "Moment", [1, 4, 6, 8]],
      ["Dark", "Vibe", [3, 11, 27, 40]],
    ];
    for (const [name, category, ids] of seed) this.tagIds(name, category, ids, true);
    setInterval(() => this.tick(), 16);
  }

  protected emit<P>(event: string, payload: P) {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  protected on<P>(event: string, cb: Listener<P>): Unlisten {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb as Listener<unknown>);
    return () => this.listeners.get(event)?.delete(cb as Listener<unknown>);
  }

  protected find(id: number): DemoTrack {
    const t = this.tracks.find((x) => x.row.id === id);
    if (!t) throw new Error(`no track ${id}`);
    return t;
  }

  protected baseBpm(d: SimDeck) {
    return d.track?.row.bpm ?? 120;
  }

  protected rate(i: number): number {
    const d = this.decks[i];
    const m = this.master;
    if (d.sync && m !== null && m !== i && this.decks[m].track) {
      const md = this.decks[m];
      const target = this.baseBpm(md) * (1 + md.tempo * md.range);
      return target / this.baseBpm(d) + d.nudge * 0.04;
    }
    return 1 + d.tempo * d.range + d.nudge * 0.04;
  }

  /** Slicer and roll pads: a loop while held, then back to where the track would be. */
  protected padHold(d: SimDeck, kind: string, n: number, press: boolean, release: boolean) {
    const t = d.track;
    if (!t) return;
    const key = `${kind}${n}`;
    const now = performance.now();
    const rate = this.rate(this.decks.indexOf(d));
    if (press) {
      const here = d.held ? d.held.pos + ((now - d.held.at) / 1000) * rate : d.position;
      const beat = this.beatAt(d, here);
      let start: number;
      let len: number;
      if (kind === "slice") {
        len = d.sliceBeats / 8;
        const domain = Math.floor(beat / d.sliceBeats) * d.sliceBeats;
        start = domain + n * len;
        d.position = t.firstBeat + (start + (((beat - domain) % len) + len) % len) * t.period;
      } else {
        len = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4][n];
        start = Math.floor(beat / Math.min(1, len)) * Math.min(1, len);
        d.position = t.firstBeat + start * t.period;
      }
      d.held = { pos: here, at: now, pad: key };
      d.loop = { start: t.firstBeat + start * t.period, end: t.firstBeat + (start + len) * t.period, active: true, beats: len };
    } else if (release && d.held?.pad === key) {
      d.position = d.held.pos + (d.playing ? ((now - d.held.at) / 1000) * rate : 0);
      d.held = null;
      d.loop = { ...d.loop, active: false };
    }
  }

  protected beatAt(d: SimDeck, pos: number) {
    if (!d.track) return 0;
    return (pos - d.track.firstBeat) / d.track.period;
  }

  /** The last 16 beats before the final bar line (the demo's tracks play at full level to the end). */
  protected safetyRegion(d: SimDeck): { start: number; end: number } | null {
    const t = d.track;
    if (!t) return null;
    const bar = 4 * t.period;
    const end = t.firstBeat + Math.floor((t.row.duration - t.firstBeat) / bar) * bar;
    const start = end - 16 * t.period;
    return start > t.firstBeat ? { start, end } : null;
  }

  /** Like the engine: loops the end of the only track heard so the music does not stop. */
  protected safetyCheck() {
    const heard = (d: SimDeck) => !!d.track && d.playing && d.fader > 0.05;
    this.decks.forEach((d, i) => {
      if (d.safety && !d.loop.active) d.safety = false;
      const r = this.safetyRegion(d);
      if (!r) return;
      if (d.safetySpent && !d.safety && d.position < r.start - 0.5) d.safetySpent = false;
      if (!this.safetyLoop || !heard(d) || d.loop.active || d.safetySpent) return;
      if (d.position < r.start || d.position >= r.end - 0.1) return;
      if (this.decks.some((o, j) => j !== i && heard(o))) return;
      d.loop = { start: r.start, end: r.end, active: true, beats: 16 };
      d.safety = true;
      d.safetySpent = true;
    });
  }

  protected tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frame += Math.round(dt * SR);
    if (this.recording) this.recorded += dt;
    this.safetyCheck();
    const tele: T.DeckTele[] = this.decks.map((d, i) => {
      const t = d.track;
      if (t && d.playing) {
        d.position += dt * this.rate(i);
        if (d.loop.active && d.position >= d.loop.end) d.position = d.loop.start + (d.position - d.loop.end);
        if (d.position >= t.row.duration) {
          d.position = t.row.duration;
          d.playing = false;
          this.emit("deck-ended", i);
        }
      }
      // Phase-lock synced decks gently.
      if (t && d.sync && this.master !== null && this.master !== i && d.playing) {
        const md = this.decks[this.master];
        if (md.track && md.playing) {
          const ph = (this.beatAt(md, md.position) % 1) - (this.beatAt(d, d.position) % 1);
          const err = ((ph + 1.5) % 1) - 0.5;
          d.position += err * t.period * 0.1;
        }
      }
      const col = t ? Math.floor((d.position * SR) / 64) : 0;
      const w = t ? t.wave : null;
      const level = w && d.playing && col * 5 < w.length ? w[col * 5] / 255 : 0;
      const eqGain = d.eq.reduce((a, g) => a + Math.max(-26, g), 0) / 3;
      const lvl = level * Math.pow(10, (d.trim + eqGain) / 20);
      const rate = this.rate(i);
      return {
        loaded: !!t,
        stems: !!t && this.split.has(t.row.id),
        token: d.token,
        playing: d.playing,
        position: d.position,
        duration: t?.row.duration ?? 0,
        remaining: t ? (t.row.duration - d.position) / rate : 0,
        bpm: t ? this.baseBpm(d) * rate : 0,
        baseBpm: this.baseBpm(d),
        rate,
        tempo: d.tempo,
        tempoRange: d.range,
        beat: this.beatAt(d, d.position),
        beatsPerBar: 4,
        keylock: d.keylock,
        keyShift: d.keyShift,
        sync: d.sync,
        master: this.master === i,
        phase: this.master !== null && this.master !== i && t ? (((this.beatAt(this.decks[this.master], this.decks[this.master].position) - this.beatAt(d, d.position)) % 1) + 1.5) % 1 - 0.5 : 0,
        slip: d.slip,
        slipPosition: d.position,
        reverse: false,
        cue: d.cue,
        looping: d.loop,
        peak: [lvl, lvl * 0.97],
        rms: lvl * 0.6,
        lowRms: lvl * 0.35 * d.fader * Math.pow(10, Math.max(-26, d.eq[0]) / 20),
        compGrDb: this.studio[i].compOn && lvl > 0.05 ? Math.max(0, 20 * Math.log10(lvl) - this.studio[i].comp.thresholdDb) * (1 - 1 / this.studio[i].comp.ratio) : 0,
        duckDb: 0,
        gateOpen: this.studio[i].gateOn && lvl > 0.01,
        safetyLoop: d.safety,
      };
    });
    tele.forEach((d, i) => {
      const src = this.duck[i].source;
      if (src !== null && tele[src]?.playing && tele[src].peak[0] > 0.05) d.duckDb = this.duck[i].amount * DUCK_MAX_DB;
    });
    const mix = tele.reduce((a, d, i) => {
      const x = this.crossfader;
      const side = i % 2 === 0 ? Math.min(1, 1 - x) : Math.min(1, 1 + x);
      return a + d.peak[0] * this.decks[i].fader * this.decks[i].fader * side;
    }, 0);
    // A simulated voice: phrases of a few seconds with pauses between them.
    const secs = performance.now() / 1000;
    const speaking = this.settings.micEnabled && Math.sin(secs * 0.9) > 0.1;
    const voice = speaking ? (0.18 + 0.12 * Math.abs(Math.sin(secs * 7.3)) * Math.abs(Math.sin(secs * 3.1))) * Math.pow(10, this.mic.gain / 20) : 0.004;
    const duckDb = this.mic.onAir && this.mic.talkover && speaking ? this.mic.depth : 0;
    const m = (Math.min(1.2, mix) * Math.pow(10, duckDb / 20) + (this.mic.onAir ? voice * this.mic.level : 0)) * Math.pow(10, (this.masterDb + this.studio[4].outputDb) / 20);
    const limited = Math.min(m, 0.98);
    this.sequencerTick(dt, this.master !== null ? tele[this.master].bpm || 124 : 124);
    const pv = this.previewState;
    let previewEnded = false;
    // In time with the decks: speed is the clock's tempo over the track's own (double or half time when closer).
    const own = pv && pv.trackId >= 0 ? this.find(pv.trackId).row.bpm : null;
    const clock = this.master !== null ? tele[this.master].bpm : (tele.find((d) => d.playing && d.bpm > 0)?.bpm ?? 124);
    const k = own ? [1, 2, 0.5].reduce((b, x) => (Math.abs(clock / (own * x) - 1) < Math.abs(clock / (own * b) - 1) ? x : b)) : 1;
    const step = own && clock > 0 ? clock / (own * k) : 1;
    // Like the engine: no further than a turntable's pitch range (16%).
    const synced = !!(pv && this.previewSynced && own && Math.abs(step - 1) <= 0.16);
    const previewRate = synced ? step : 1;
    if (pv && pv.playing) {
      pv.position += dt * previewRate;
      if (pv.position >= pv.duration) {
        pv.position = pv.duration;
        pv.playing = false;
        previewEnded = true;
      }
    }
    this.emit<T.Telemetry>("telemetry", {
      frame: this.frame,
      decks: tele,
      master: {
        peak: [limited, limited * 0.98],
        truePeakDb: 20 * Math.log10(Math.max(limited, 1e-5)),
        momentaryLufs: m > 0 ? -14 + 20 * Math.log10(m) : -70,
        shortTermLufs: m > 0 ? -14 + 20 * Math.log10(m) : -70,
        correlation: 0.9,
        limiterGrDb: m > 0.98 ? -20 * Math.log10(m / 0.98) : 0,
        glueGrDb: this.studio[4].compOn && m > 0.1 ? Math.max(0, 20 * Math.log10(m) - this.studio[4].comp.thresholdDb) * 0.5 : 0,
        cuePeak: [0, 0],
        clipped: false,
      },
      preview: pv
        ? { loaded: true, playing: pv.playing, position: pv.position, duration: pv.duration, ended: previewEnded, synced, rate: previewRate }
        : { loaded: false, playing: false, position: 0, duration: 0, ended: false, synced: false, rate: 1 },
      mic: {
        connected: this.settings.micEnabled,
        live: this.settings.micEnabled,
        onAir: this.mic.onAir,
        peak: this.settings.micEnabled ? [voice, voice] : [0, 0],
        rms: this.settings.micEnabled ? voice * 0.5 : 0,
        duckDb,
        gateOpen: speaking,
        latencyMs: 12,
        driftPpm: 0,
        underruns: 0,
        capturing: this.mic.recordingSince !== null,
        capturedSeconds: this.mic.recordingSince !== null ? secs - this.mic.recordingSince : 0,
      },
      clockBpm: this.master !== null ? tele[this.master].bpm : 124,
      masterDeck: this.master,
      recording: this.recording,
      recordedSeconds: this.recorded,
      load: 0.08 + Math.random() * 0.02,
      overruns: 0,
      samplerPlaying: this.samplerMask(),
      sequencerStep: this.seqStep,
      spectrum:
        this.scope === "off"
          ? undefined
          : this.scope === "master"
            ? this.fakeSpectrum(limited, this.studio[4])
            : this.fakeSpectrum(tele[this.scope]?.peak[0] ?? 0, this.studio[this.scope]),
    });
  }

  protected detail(t: DemoTrack): T.TrackDetail {
    return {
      track: t.row,
      analysed: true,
      bpm: t.row.bpm,
      bpmCandidates: [t.row.bpm!, t.row.bpm! / 2],
      tempoConfidence: 0.92,
      driftMs: 0.8,
      constantGrid: !t.pins,
      gridLocked: this.locked.has(t.row.id),
      beatsPerBar: 4,
      firstBeat: t.firstBeat,
      beatPeriod: t.period,
      beats: t.pins ? demoBeatList(t) : [],
      warps: t.pins?.map((p) => p.t) ?? [],
      key: t.row.key,
      keyConfidence: 0.81,
      keySecond: t.row.key ? keyDto(transpose(keyFromIndex(t.row.key.index), 7)) : null,
      tuningCents: 0,
      lufs: t.row.lufs,
      truePeak: -0.4,
      autoGainDb: -12 - (t.row.lufs ?? -12),
      energy: t.row.energy,
      energyCurve: t.sections.flatMap((s) => Array(s.bars).fill(s.energy)),
      energyCurveStart: t.firstBeat,
      sections: t.sections,
      cues: [...t.cues, ...this.savedCues(t)],
      audible: [0, t.row.duration - 1],
      vocals: t.vocals,
    };
  }

  protected saved = new Map<number, T.CueDto[]>();
  /** Tracks whose grid the person locked. */
  protected locked = new Set<number>();
  protected savedCues(t: DemoTrack): T.CueDto[] {
    return this.saved.get(t.row.id) ?? [];
  }

  // ---------------------------------------------------------------- Backend

  async appInfo(): Promise<T.AppInfo> {
    if (this.registry.length === 0) this.registry = demoRegistry();
    return {
      version: "0.1.0-demo",
      dbPath: "(in memory)",
      recordingsDir: "~/Music/MixIt/Recordings",
      projectsDir: "~/Music/MixIt/Mixes",
      audio: await this.audioStatus(),
      settings: this.settings,
      registry: this.registry,
      transitions: [
        { id: "blend", name: "Blend", explain: "Fades one track out while the other fades in. Smooth and safe for most music.", beats: 32 },
        { id: "bassSwap", name: "Bass swap", explain: "Brings the new track in without its bass, then swaps the basslines on a downbeat so they never clash.", beats: 32 },
        { id: "filterFade", name: "Filter fade", explain: "Thins the old track out with a filter while the new one opens up.", beats: 32 },
        { id: "echoOut", name: "Echo out", explain: "The old track ends in an echo that rings over the start of the new one.", beats: 8 },
        { id: "cut", name: "Cut", explain: "Switches instantly on a downbeat. Punchy, great into a drop.", beats: 0 },
        { id: "brake", name: "Brake", explain: "Stops the old track like a turntable, then the new one slams in.", beats: 4 },
      ],
      fxTypes: ["None", "Echo", "Ping-pong delay", "Reverb", "Filter LFO", "Flanger", "Phaser", "Chorus", "Gater", "Slicer", "Beat repeat", "Bitcrusher", "Distortion", "Tape stop", "Pitch delay", "Ring modulator", "Noise riser", "Dub echo"],
      decks: this.decks.map((d, i) => (d.track ? { deck: i, token: d.token, detail: this.detail(d.track), sampleRate: SR } : null)),
      kit: DEMO_KIT,
      pads: this.pads.map((p) => ({ ...p })),
    };
  }

  async action(id: string, input: T.ActionInput): Promise<void> {
    const p = id.split(".");
    const press = input.type === "press";
    const release = input.type === "release";
    const value = input.type === "value" ? input.value : input.type === "set" ? (input.value ? 1 : 0) : input.type === "choice" ? input.value : NaN;
    const toggle = (cur: boolean) => (input.type === "set" ? input.value : input.type === "value" ? input.value > 0.5 : press ? !cur : cur);
    if (p[0] === "deck") {
      const i = p[1].charCodeAt(0) - 65;
      const d = this.decks[i];
      if (!d) return;
      const t = d.track;
      const beat = t?.period ?? 0.5;
      if (p[2] === "keypad") {
        if (p[3] === "cue" && !Number.isNaN(value)) d.keypadCue = value;
        else if (p[3] === "range" && !Number.isNaN(value)) d.keypadRange = value;
        else if (t && press && /^[1-8]$/.test(p[3] ?? "")) {
          d.keylock = true;
          d.keyShift = [-7, -3, 0][d.keypadRange] + Number(p[3]) - 1;
          const h = d.hot[d.keypadCue];
          if (h) {
            d.position = h.seconds;
            d.playing = true;
          } else await this.setHotCue(i, d.keypadCue, this.snap(d, d.position));
        }
        return;
      }
      if (p[2] === "hotcue" && press && p.length === 4) d.keypadCue = Number(p[3]) - 1;
      if (t && (p[2] === "slice" || p[2] === "roll") && /^[1-8]$/.test(p[3] ?? "")) {
        this.padHold(d, p[2], Number(p[3]) - 1, press, release);
        return;
      }
      switch (p.slice(2).join(".")) {
        case "play":
          if (press && t) {
            d.playing = !d.playing;
            if (d.playing && this.master === null) this.master = i;
          }
          break;
        case "cue":
          if (press && t) {
            if (d.playing) {
              d.playing = false;
              d.position = d.cue;
            } else if (Math.abs(d.position - d.cue) < 0.01) {
              d.cueHeld = true;
              d.playing = true;
            } else {
              d.cue = this.snap(d, d.position);
              d.position = d.cue;
            }
          } else if (release && d.cueHeld) {
            d.cueHeld = false;
            d.playing = false;
            d.position = d.cue;
          }
          break;
        case "sync":
          d.sync = toggle(d.sync);
          if (d.sync && (this.master === null || this.master === i)) {
            const other = this.decks.findIndex((x, j) => j !== i && x.track && x.playing);
            if (other >= 0) this.master = other;
          }
          if (d.sync && this.master !== null && this.master !== i && t) {
            const md = this.decks[this.master];
            d.tempo = (this.baseBpm(md) * (1 + md.tempo * md.range) / this.baseBpm(d) - 1) / d.range;
          }
          break;
        case "master":
          // Taking the lead keeps the tempo it was following (as the engine does).
          if (press && d.sync && this.master !== i) d.tempo = (this.rate(i) - 1) / d.range;
          if (press) this.master = i;
          break;
        case "keylock":
          d.keylock = toggle(d.keylock);
          break;
        case "tempo":
          if (!Number.isNaN(value)) d.tempo = Math.max(-1, Math.min(1, value));
          break;
        case "tempo_range":
          if (!Number.isNaN(value)) d.range = RANGES[value] ?? d.range;
          break;
        case "tempo_reset":
          if (press) d.tempo = 0;
          break;
        case "nudge_down":
          d.nudge = press ? -0.5 : 0;
          break;
        case "nudge_up":
          d.nudge = press ? 0.5 : 0;
          break;
        case "key_shift":
          if (!Number.isNaN(value)) d.keyShift = Math.round(value * 100) / 100;
          break;
        case "key_sync":
          if (press && t?.row.key && this.master !== null && this.master !== i) {
            const mk = this.decks[this.master].track?.row.key;
            if (mk) {
              d.keylock = true;
              d.keyShift = bestShift(keyFromIndex(t.row.key.index), transpose(keyFromIndex(mk.index), this.decks[this.master].keyShift), 6) ?? 0;
            }
          }
          break;
        case "loop.auto":
          if (t) {
            const on = toggle(d.loop.active);
            if (on) {
              const start = this.snap(d, d.position);
              d.loop = { start, end: start + d.loopSize * beat, active: true, beats: d.loopSize };
            } else d.loop = { ...d.loop, active: false };
          }
          break;
        case "slice.size":
          if (!Number.isNaN(value)) d.sliceBeats = [4, 8, 16][value] ?? 8;
          break;
        case "loop.size":
          if (!Number.isNaN(value)) {
            d.loopSize = LOOP_SIZES[value] ?? d.loopSize;
            if (d.loop.active) d.loop = { ...d.loop, end: d.loop.start + d.loopSize * beat, beats: d.loopSize };
          }
          break;
        case "loop.halve":
          if (press) {
            d.loopSize = Math.max(1 / 32, d.loopSize / 2);
            if (d.loop.active) d.loop = { ...d.loop, end: d.loop.start + d.loopSize * beat, beats: d.loopSize };
          }
          break;
        case "loop.double":
          if (press) {
            d.loopSize = Math.min(32, d.loopSize * 2);
            if (d.loop.active) d.loop = { ...d.loop, end: d.loop.start + d.loopSize * beat, beats: d.loopSize };
          }
          break;
        case "let_end":
          if (press) d.loop = { ...d.loop, active: false };
          break;
        case "loop.reloop":
          if (press && d.loop.end > d.loop.start) d.loop = { ...d.loop, active: !d.loop.active };
          break;
        case "beatjump.back":
          if (press) d.position = Math.max(0, d.position - d.jump * beat);
          break;
        case "beatjump.fwd":
          if (press) d.position += d.jump * beat;
          break;
        case "beatjump.size":
          if (!Number.isNaN(value)) d.jump = JUMP_SIZES[value] ?? d.jump;
          break;
        case "slip":
          d.slip = toggle(d.slip);
          break;
        case "eject":
          if (press && !d.playing) this.decks[i] = deckState();
          break;
        case "grid.set_downbeat":
        case "grid.halve":
        case "grid.double":
        case "grid.nudge_back":
        case "grid.nudge_fwd":
        case "grid.warp":
        case "grid.unwarp":
          if (press && t) {
            const at = d.position;
            const op = p.slice(3).join(".");
            const edit: T.GridEdit =
              op === "set_downbeat" ? { downbeatAt: at }
              : op === "halve" ? { bpm: 30 / t.period }
              : op === "double" ? { bpm: 120 / t.period }
              : op === "nudge_back" ? { nudgeMs: -5 }
              : op === "nudge_fwd" ? { nudgeMs: 5 }
              : op === "warp" ? { warpAt: at }
              : { unwarpAt: at };
            try {
              applyDemoGrid(t, edit, this.locked);
            } catch (err) {
              this.emit("error", (err as Error).message);
              break;
            }
            this.deckLoaded(i);
            this.emit("library-changed", null);
          }
          break;
        default:
          if (p[2] === "hotcue" && t) {
            const n = Number(p[3]) - 1;
            if (p[4] === "delete") {
              if (press) await this.deleteHotCue(i, n);
            } else if (press) {
              const h = d.hot[n];
              if (h) {
                d.position = h.seconds;
                if (!d.playing) d.playing = true;
              } else await this.setHotCue(i, n, this.snap(d, d.position));
            }
          }
      }
    } else if (p[0] === "sampler") {
      this.samplerAction(p, input);
    } else if (p[0] === "mixer") {
      const i = p[1].length === 1 ? p[1].charCodeAt(0) - 65 : -1;
      const d = this.decks[i];
      if (d) {
        const c = p.slice(2).join(".");
        if (c === "fader") d.fader = value;
        else if (c === "trim") d.trim = value;
        else if (c === "filter") d.filter = value;
        else if (c === "eq.low") d.eq[0] = value;
        else if (c === "eq.mid") d.eq[1] = value;
        else if (c === "eq.high") d.eq[2] = value;
        else if (c === "punch") this.studio[i] = { ...this.studio[i], compOn: value > 0.001, comp: punchComp(value) };
        else if (c === "warmth") this.studio[i] = { ...this.studio[i], satOn: value > 0.001, driveDb: WARMTH_MAX_DB * value };
        else if (c === "width") this.studio[i] = { ...this.studio[i], width: value };
        else if (c === "gate") this.studio[i] = { ...this.studio[i], gateOn: toggle(this.studio[i].gateOn) };
        else if (c === "duck_source") this.duck[i].source = value >= 1 && value - 1 !== i ? value - 1 : null;
        else if (c === "duck") this.duck[i].amount = value;
      } else if (p[1] === "glue") {
        this.studio[4] = { ...this.studio[4], compOn: value > 0.001, comp: glueComp(value) };
      } else if (p[1] === "crossfader") this.crossfader = value;
      else if (p[1] === "master") this.masterDb = value;
    } else if (p[0] === "mic") {
      const c = p.slice(1).join(".");
      if (c === "on_air") this.mic.onAir = toggle(this.mic.onAir);
      else if (c === "talkover") this.mic.talkover = toggle(this.mic.talkover);
      else if (c === "level" && !Number.isNaN(value)) this.mic.level = value;
      else if (c === "gain" && !Number.isNaN(value)) this.mic.gain = value;
      else if (c === "talkover_depth" && !Number.isNaN(value)) this.mic.depth = value;
    } else if (id === "global.safety_loop") {
      this.safetyLoop = toggle(this.safetyLoop);
    } else if (id === "global.record" && press) {
      this.recording = !this.recording;
    }
  }

  protected snap(d: SimDeck, pos: number) {
    if (!d.track) return pos;
    const b = Math.round((pos - d.track.firstBeat) / d.track.period);
    return d.track.firstBeat + b * d.track.period;
  }

  async loadTrack(deck: number, trackId: number): Promise<T.DeckInfo> {
    const t = this.find(trackId);
    const d = this.decks[deck];
    if (d.playing) throw new Error("This deck is playing. Pause it first, or load onto the other deck.");
    Object.assign(d, deckState(), { fader: d.fader, eq: d.eq, range: d.range });
    d.track = t;
    d.token = ++this.token;
    d.cue = t.firstBeat;
    d.position = t.firstBeat;
    for (const c of this.savedCues(t)) if (c.role === "hot" && c.slot != null) d.hot[c.slot] = c;
    const info = { deck, token: d.token, detail: this.detail(t), sampleRate: SR };
    this.emit("deck-loaded", info);
    this.historyData.push({ track_id: t.row.id, played_at: Math.floor(Date.now() / 1000), deck, title: t.row.title, artist: t.row.artist });
    return info;
  }

  async seek(deck: number, seconds: number) {
    const d = this.decks[deck];
    if (d.track) d.position = Math.max(0, Math.min(d.track.row.duration, seconds));
  }

  async scratch(deck: number, phase: "start" | "move" | "end", velocity: number) {
    const d = this.decks[deck];
    if (phase === "move" && d.track) d.position = Math.max(0, d.position + velocity * 0.016);
  }

  async setHotCue(deck: number, slot: number, seconds: number, loopSeconds?: number | null, color?: number, label?: string) {
    const d = this.decks[deck];
    if (!d.track) return;
    const palette = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899];
    const cue: T.CueDto = { role: "hot", slot, seconds, loopSeconds: loopSeconds ?? null, label: label ?? "", color: color ?? palette[slot % 8] };
    d.hot[slot] = cue;
    const list = (this.saved.get(d.track.row.id) ?? []).filter((c) => c.slot !== slot);
    list.push(cue);
    this.saved.set(d.track.row.id, list);
    this.emit("deck-loaded", { deck, token: d.token, detail: this.detail(d.track), sampleRate: SR });
  }

  async deleteHotCue(deck: number, slot: number) {
    const d = this.decks[deck];
    if (!d.track) return;
    d.hot[slot] = null;
    this.saved.set(d.track.row.id, (this.saved.get(d.track.row.id) ?? []).filter((c) => c.slot !== slot));
    this.emit("deck-loaded", { deck, token: d.token, detail: this.detail(d.track), sampleRate: SR });
  }

  /** The track on a deck, for editing (the demo's simulated decks). */
  protected deckTrack(deck: number): DemoTrack | null {
    return this.decks[deck]?.track ?? null;
  }

  protected deckLoaded(deck: number) {
    const d = this.decks[deck];
    if (d.track) this.emit("deck-loaded", { deck, token: d.token, detail: this.detail(d.track), sampleRate: SR });
  }

  async setMemoryCue(deck: number, seconds: number, label: string, color?: number | null) {
    const t = this.deckTrack(deck);
    if (!t) return;
    const list = (this.saved.get(t.row.id) ?? []).filter((c) => !(c.role === "memory" && Math.abs(c.seconds - seconds) < 0.01));
    list.push({ role: "memory", slot: null, seconds, loopSeconds: null, label, color: color ?? null });
    this.saved.set(t.row.id, list);
    this.deckLoaded(deck);
  }

  async deleteMemoryCue(deck: number, seconds: number) {
    const t = this.deckTrack(deck);
    if (!t) return;
    this.saved.set(t.row.id, (this.saved.get(t.row.id) ?? []).filter((c) => !(c.role === "memory" && Math.abs(c.seconds - seconds) < 0.01)));
    this.deckLoaded(deck);
  }

  async setGrid(deck: number, edit: T.GridEdit) {
    const t = this.deckTrack(deck);
    if (!t) throw new Error("no track on this deck");
    applyDemoGrid(t, edit, this.locked);
    this.deckLoaded(deck);
    this.emit("library-changed", null);
  }

  async setMainCue(deck: number, seconds: number) {
    this.decks[deck].cue = seconds;
  }

  async setLoop(deck: number, start: number, end: number, active: boolean) {
    const d = this.decks[deck];
    d.loop = { start, end, active, beats: d.track ? (end - start) / d.track.period : 0 };
  }

  async waveform(trackId: number): Promise<T.WaveformData> {
    const t = this.find(trackId);
    return { sampleRate: SR, framesPerColumn: 64, columns: t.wave };
  }

  async search(query: string, limit = 5000): Promise<T.TrackRow[]> {
    const alikeOf = (id: number) => {
      const me = this.tracks.find((t) => t.row.id === id)?.row;
      const m = new Map<number, number>();
      if (me) for (const t of this.tracks) if (t.row.id !== id && t.row.analysis === "done") m.set(t.row.id, this.alike(me, t.row));
      return m;
    };
    return demoSearch(
      this.tracks.map((t) => t.row),
      query,
      (id) => this.tagNames(id),
      alikeOf,
    ).slice(0, limit);
  }

  async stats(): Promise<T.LibraryStats> {
    return {
      tracks: this.tracks.length,
      analysed: this.tracks.length,
      pending: 0,
      failed: 0,
      missing: 0,
      playlists: this.playlistsData.length,
      total_seconds: this.tracks.reduce((a, t) => a + t.row.duration, 0),
    };
  }

  async folders() {
    return ["~/Music"];
  }
  async removeFolder() {}

  async importTrack(path: string): Promise<T.TrackRow> {
    const base = this.tracks[this.tracks.length % Math.max(1, this.tracks.length) || 0] ?? this.tracks[0];
    if (!base) throw new Error("The demo library is not ready yet.");
    const existing = this.tracks.find((t) => t.row.path === path);
    if (existing) return existing.row;
    const id = Math.max(...this.tracks.map((t) => t.row.id)) + 1;
    const title = fileName(path).replace(/\.[^.]+$/, "") || "Dropped track";
    const t: DemoTrack = { ...base, row: { ...base.row, id, path, title, artist: "", album: "", playCount: 0, lastPlayed: null, addedAt: Math.floor(Date.now() / 1000), rating: 0, color: null, comment: "" } };
    this.tracks.push(t);
    this.emit("library-changed", null);
    return t.row;
  }

  registerFiles(files: File[]): string[] {
    return files.map((f) => `demo-drop:/${f.webkitRelativePath || f.name}`);
  }

  async addToLibrary(paths: string[]) {
    let done = 0;
    const total = 20;
    const timer = setInterval(() => {
      done += 2;
      this.emit<T.JobProgress>("job", { kind: "analyze", done, total, message: `Analysing ${done} of ${total}`, finished: false, error: null });
      if (done >= total) {
        clearInterval(timer);
        this.emit<T.JobProgress>("job", { kind: "analyze", done, total, message: `Added ${paths.length} folder(s)`, finished: true, error: null });
        this.emit("library-changed", null);
      }
    }, 200);
  }
  async rescan() {
    await this.addToLibrary([]);
  }
  async analyzePending() {}

  /** Track ids "split into stems" (the demo plays no audio, so only the controls change). */
  protected split = new Set<number>();
  private splitting: number | null = null;
  async splitStems(trackId: number) {
    if (this.splitting !== null) throw new Error("Already splitting a track. Wait for it to finish.");
    const t = this.find(trackId);
    this.splitting = window.setInterval(() => undefined, 1_000_000);
    const message = `Splitting “${t.row.title}” into stems`;
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 150));
      if (this.splitting === null) {
        this.emit("job", { kind: "stems", done: 0, total: 0, message: "", finished: true, error: "Stopped splitting" });
        return;
      }
      this.emit("job", { kind: "stems", done: i * 200, total: 1000, message, finished: false, error: null });
    }
    window.clearInterval(this.splitting);
    this.splitting = null;
    this.split.add(trackId);
    this.emit("job", { kind: "stems", done: 1000, total: 1000, message: `“${t.row.title}” is split: turn its vocals, drums, bass and melody up and down on the deck.`, finished: true, error: null });
  }
  async cancelStems() {
    if (this.splitting !== null) window.clearInterval(this.splitting);
    this.splitting = null;
  }
  async cancelJob() {}

  async trackDetail(id: number) {
    return this.detail(this.find(id));
  }

  async editTrack(id: number, edit: T.TrackEdit) {
    const t = this.find(id);
    Object.assign(t.row, Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)));
    this.emit("library-changed", null);
    return t.row;
  }

  async removeTracks(ids: number[]) {
    this.tracks = this.tracks.filter((t) => !ids.includes(t.row.id));
    this.emit("library-changed", null);
  }

  async editTracks(ids: number[], edit: T.TrackEdit) {
    const patch = Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined));
    for (const id of ids) Object.assign(this.find(id).row, patch);
    this.emit("library-changed", null);
  }

  /** The demo has no files to write: it reports them written, and missing ones as failed. */
  async writeSerato(ids: number[]): Promise<T.WriteTagsResult> {
    return this.writeTags(ids);
  }

  async writeTags(ids: number[]): Promise<T.WriteTagsResult> {
    const failed: [number, string][] = [];
    for (const id of ids) {
      const t = this.find(id);
      if (t.row.missing) failed.push([id, `file not found: ${t.row.path}`]);
    }
    return { written: ids.length - failed.length, failed };
  }

  // ---------------------------------------------------------------- preview player

  /** The simulated preview player: only a position that moves. */
  protected previewState: { trackId: number; playing: boolean; position: number; duration: number } | null = null;

  async previewLoad(trackId: number, seconds: number): Promise<number> {
    const t = this.find(trackId);
    if (t.row.missing) throw new Error(`file not found: ${t.row.path}`);
    this.previewState = { trackId, playing: true, position: Math.max(0, Math.min(seconds, t.row.duration)), duration: t.row.duration };
    return t.row.duration;
  }

  async previewPlay(on: boolean): Promise<void> {
    const p = this.previewState;
    if (!p) return;
    if (on && p.position >= p.duration) p.position = 0;
    p.playing = on;
  }

  async previewSeek(seconds: number): Promise<void> {
    if (this.previewState) this.previewState.position = Math.max(0, Math.min(seconds, this.previewState.duration));
  }

  async previewSettings(_gain: number, _route: T.PreviewRoute): Promise<void> {}

  protected previewSynced = false;

  async previewSync(on: boolean): Promise<void> {
    this.previewSynced = on;
  }

  async previewClose(): Promise<void> {
    this.previewState = null;
  }

  // ---------------------------------------------------------------- backups

  /** Simulated backups: snapshots of the library in memory. */
  private snapshots: { info: T.BackupInfo; rows: Map<number, T.TrackRow>; playlists: (T.PlaylistDto & { tracks: number[] })[]; tags: { id: number; name: string; category: string; color: number | null }[]; trackTags: [number, number[]][] }[] = [];

  private snapshot(kind: T.BackupInfo["kind"], path?: string | null): string {
    const created = Math.floor(Date.now() / 1000) + this.snapshots.length * 0.001;
    const d = new Date(created * 1000);
    const stamp = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const p = path ?? `~/MixIt/Backups/${kind === "auto" ? "auto" : kind === "beforeRestore" ? "before-restore" : "library"}-${stamp}${this.snapshots.length ? `-${this.snapshots.length + 1}` : ""}.mixitlib`;
    this.snapshots.unshift({
      info: { path: p, kind, created: Math.floor(created), bytes: 180_000 + this.tracks.length * 9_000, tracks: this.tracks.length },
      rows: new Map(this.tracks.map((t) => [t.row.id, { ...t.row }])),
      playlists: this.playlistsData.map((pl) => ({ ...pl, tracks: [...pl.tracks] })),
      tags: this.tagsData.map((t) => ({ ...t })),
      trackTags: [...this.trackTagIds].map(([id, s]) => [id, [...s]]),
    });
    return p;
  }

  async backups(): Promise<T.BackupInfo[]> {
    return this.snapshots.map((s) => s.info);
  }

  async backupLibrary(path?: string | null): Promise<string> {
    return this.snapshot("manual", path);
  }

  async restoreLibrary(path: string): Promise<string> {
    const s = this.snapshots.find((x) => x.info.path === path);
    if (!s) throw new Error("this file is not a MixIt library backup");
    const safety = this.snapshot("beforeRestore");
    this.tracks = this.tracks.filter((t) => s.rows.has(t.row.id));
    for (const t of this.tracks) t.row = { ...s.rows.get(t.row.id)! };
    this.playlistsData = s.playlists.map((pl) => ({ ...pl, tracks: [...pl.tracks] }));
    this.tagsData = s.tags.map((t) => ({ ...t }));
    this.trackTagIds = new Map(s.trackTags.map(([id, ids]) => [id, new Set(ids)]));
    this.emit("library-changed", null);
    return safety;
  }

  // ---------------------------------------------------------------- your own tags

  protected tagsData: { id: number; name: string; category: string; color: number | null }[] = [];
  protected trackTagIds = new Map<number, Set<number>>();
  private nextTagId = 1;

  private tagNamed(name: string) {
    return this.tagsData.find((t) => t.name.toLowerCase() === name.toLowerCase());
  }

  /** The tag names of a track, ordered as the library orders them (category, then name). */
  protected tagNames(trackId: number): string[] {
    const ids = this.trackTagIds.get(trackId);
    if (!ids?.size) return [];
    return this.tagsData
      .filter((t) => ids.has(t.id))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .map((t) => t.name);
  }

  private tagIds(name: string, category: string, ids: number[], on: boolean) {
    const n = name.trim();
    if (!n) throw new Error("A tag needs a name.");
    let tag = this.tagNamed(n);
    if (!tag) {
      tag = { id: this.nextTagId++, name: n, category, color: null };
      this.tagsData.push(tag);
    }
    for (const id of ids) {
      const set = this.trackTagIds.get(id) ?? new Set<number>();
      if (on) set.add(tag.id);
      else set.delete(tag.id);
      this.trackTagIds.set(id, set);
    }
    return tag.id;
  }

  async listTags(): Promise<T.TagDto[]> {
    return this.tagsData
      .map((t) => ({ ...t, count: [...this.trackTagIds.values()].filter((s) => s.has(t.id)).length }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async tagsOf(ids: number[]): Promise<[number, string[]][]> {
    return ids.map((id) => [id, this.tagNames(id)] as [number, string[]]).filter(([, n]) => n.length > 0);
  }

  async setTag(ids: number[], name: string, on: boolean, category = ""): Promise<void> {
    this.tagIds(name, category, ids, on);
    this.emit("library-changed", null);
  }

  async renameTag(id: number, name: string): Promise<number> {
    const n = name.trim();
    if (!n) throw new Error("A tag needs a name.");
    const tag = this.tagsData.find((t) => t.id === id);
    if (!tag) throw new Error("No such tag.");
    const other = this.tagNamed(n);
    let kept = id;
    if (other && other.id !== id) {
      for (const s of this.trackTagIds.values()) if (s.delete(id)) s.add(other.id);
      this.tagsData = this.tagsData.filter((t) => t.id !== id);
      kept = other.id;
    } else tag.name = n;
    this.emit("library-changed", null);
    return kept;
  }

  async tagInfo(id: number, category: string, color: number | null): Promise<void> {
    const tag = this.tagsData.find((t) => t.id === id);
    if (tag) Object.assign(tag, { category: category.trim(), color });
    this.emit("library-changed", null);
  }

  async deleteTag(id: number): Promise<void> {
    this.tagsData = this.tagsData.filter((t) => t.id !== id);
    for (const s of this.trackTagIds.values()) s.delete(id);
    this.emit("library-changed", null);
  }

  async missingTracks(): Promise<T.TrackRow[]> {
    return this.tracks.filter((t) => t.row.missing).map((t) => ({ ...t.row }));
  }

  /** The demo has no files: a missing track is "found" when the folder path holds its file name. */
  async findMissing(folder: string): Promise<number> {
    let n = 0;
    for (const t of this.tracks.filter((x) => x.row.missing)) {
      const name = fileName(t.row.path);
      if (folder && name) {
        t.row = { ...t.row, path: `${folder.replace(/[\\/]$/, "")}/${name}`, missing: false };
        n++;
      }
    }
    if (n) this.emit("library-changed", null);
    return n;
  }

  async relocateTrack(id: number, path: string): Promise<T.TrackRow> {
    const t = this.find(id);
    t.row = { ...t.row, path, missing: false };
    this.emit("library-changed", null);
    return { ...t.row };
  }

  /** Same audio, as the demo knows it: the same title, artist and length. */
  async duplicates(): Promise<T.TrackRow[][]> {
    const groups = new Map<string, T.TrackRow[]>();
    for (const t of this.tracks) {
      const k = `${t.row.title}\u0000${t.row.artist}\u0000${Math.round(t.row.duration)}`;
      groups.set(k, [...(groups.get(k) ?? []), { ...t.row }]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  async mergeTracks(keep: number, others: number[]): Promise<void> {
    const k = this.find(keep);
    const olds = this.tracks.filter((t) => others.includes(t.row.id) && t.row.id !== keep);
    for (const o of olds) {
      for (const pl of this.playlistsData) pl.tracks = pl.tracks.map((id) => (id === o.row.id ? keep : id));
      if (!k.cues.some((c) => c.role === "hot") && o.cues.some((c) => c.role === "hot")) k.cues = o.cues.map((c) => ({ ...c }));
    }
    k.row = {
      ...k.row,
      rating: Math.max(k.row.rating, ...olds.map((o) => o.row.rating)),
      playCount: k.row.playCount + olds.reduce((a, o) => a + o.row.playCount, 0),
      comment: k.row.comment || olds.find((o) => o.row.comment)?.row.comment || "",
    };
    this.tracks = this.tracks.filter((t) => !olds.includes(t));
    this.emit("library-changed", null);
  }

  /** How many times each track was played right after `trackId` in past sets. */
  protected playedAfter(trackId: number): Map<number, number> {
    const out = new Map<number, number>();
    for (const set of [...this.demoSets().map((s) => s.entries), this.historyData]) {
      for (let i = 1; i < set.length; i++) {
        const next = set[i].track_id;
        if (set[i - 1].track_id === trackId && next != null && next !== trackId) out.set(next, (out.get(next) ?? 0) + 1);
      }
    }
    return out;
  }

  async suggestNext(trackId: number, energy: "steady" | "up" | "down", limit = 30): Promise<T.SuggestionRow[]> {
    const cur = this.find(trackId).row;
    const after = this.playedAfter(trackId);
    const onDecks = this.decks.map((d) => d.track?.row.id);
    const out: T.SuggestionRow[] = [];
    for (const t of this.tracks) {
      const c = t.row;
      if (c.id === cur.id || onDecks.includes(c.id) || !c.bpm || !cur.bpm) continue;
      const mults = [1, 0.5, 2];
      let best = { pct: Infinity, m: 1 };
      for (const m of mults) {
        const pct = (cur.bpm / (c.bpm / m) - 1) * 100;
        if (Math.abs(pct) < Math.abs(best.pct)) best = { pct, m };
      }
      if (Math.abs(best.pct) > 6) continue;
      const reasons: string[] = [];
      const tags: string[] = [];
      if (best.m !== 1) {
        reasons.push(best.m < 1 ? "Plays at half your tempo: it will feel half-time." : "Plays at double your tempo.");
        tags.push(best.m < 1 ? "half" : "double");
      }
      reasons.push(Math.abs(best.pct) < 0.05 ? "Same tempo." : `Needs a ${best.pct > 0 ? "+" : ""}${best.pct.toFixed(1)} % tempo change.`);
      tags.push("tempo");
      let keyScore = 0.4;
      let shift = 0;
      if (cur.key && c.key) {
        const a = keyFromIndex(cur.key.index);
        const b = keyFromIndex(c.key.index);
        const comp = compatibility(a, b);
        if (comp === "same") {
          keyScore = 1;
          reasons.push("Same key: the harmonies will blend perfectly.");
          tags.push("key");
        } else if (comp === "match") {
          keyScore = 0.9;
          reasons.push("Neighbouring key on the Camelot wheel: blends smoothly.");
          tags.push("key");
        } else if (comp === "shift") {
          shift = bestShift(b, a, 2) ?? 0;
          keyScore = 0.75 - 0.05 * (Math.abs(shift) - 1);
          reasons.push(`Shift its key by ${shift > 0 ? "+" : ""}${shift} semitone(s) with keylock to make it fit.`);
          tags.push("keyShift");
        } else if (comp === "boost") {
          keyScore = 0.5;
          reasons.push("Two steps up the wheel: an energy boost that works if you mix quickly.");
          tags.push("key");
        } else {
          keyScore = 0.1;
          reasons.push("Keys clash: mix with bass and melody of one track cut, or mix fast.");
          tags.push("clash");
        }
      }
      const de = (c.energy ?? 5) - (cur.energy ?? 5);
      const target = energy === "up" ? 1.5 : energy === "down" ? -1.5 : 0.5;
      const energyScore = Math.max(0, 1 - Math.abs(de - target) / 4);
      reasons.push(de === 0 ? "Keeps the energy level." : de > 0 ? `Lifts the energy by ${de}.` : `Brings the energy down by ${-de}.`);
      tags.push("energy");
      const tempoScore = (1 - Math.pow(Math.abs(best.pct) / 6, 1.5)) * (best.m === 1 ? 1 : 0.8);
      let score = 0.4 * tempoScore + 0.35 * keyScore + 0.2 * energyScore;
      if (c.genre === cur.genre) {
        score += 0.04;
        reasons.push("Same genre.");
        tags.push("genre");
      }
      const times = after.get(c.id) ?? 0;
      if (times) {
        score += 0.03 * Math.min(3, times);
        reasons.push(times === 1 ? "You played it after this track in a past set." : `You played it after this track ${times} times before.`);
        tags.push("history");
      }
      if ((cur.vocals ?? 0) >= 10 && c.vocals != null && c.vocals < 5) {
        score += 0.02;
        reasons.push("An instrumental: no second voice to clash with this track's singing.");
        tags.push("instrumental");
      }
      const alike = this.alike(cur, c);
      score += 0.08 * (alike - 0.5);
      if (alike >= 0.7) {
        reasons.push(`Sounds alike (${Math.round(alike * 100)} % match): similar instruments and groove.`);
        tags.push("sound");
      }
      out.push({ track: c, score: Math.min(1, score), tempoChangePct: best.pct, keyShift: shift, reasons, tags });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** A greedy version of the desktop's set builder (setbuild.rs): every change mixable, the energy on the shape. */
  async buildSet(req: T.BuildSetRequest): Promise<T.TrackRow[]> {
    let pool = (await this.search(req.query)).filter((r) => r.bpm && !r.missing && r.duration > 0);
    // Instrumentals only: every track known to have a voice stays out (the chosen opener still plays).
    if (req.vocals === "instrumental") pool = pool.filter((r) => r.vocals == null || r.vocals < 5 || r.id === req.seed);
    const sings = (r: T.TrackRow) => (r.vocals ?? 0) >= 10;
    if (req.playlist != null) {
      const keep = new Set((await this.playlistTracks(req.playlist)).map((r) => r.id));
      pool = pool.filter((r) => keep.has(r.id));
    }
    const seed = req.seed != null ? this.tracks.find((t) => t.row.id === req.seed)?.row : undefined;
    if (seed && !pool.some((r) => r.id === seed.id)) pool = [seed, ...pool];
    if (!pool.length) return [];
    const goal = Math.max(60, req.minutes * 60);
    const shake = (id: number) => (req.variety ? ((((id + 1) * 2654435761 * (req.variety + 7)) >>> 0) % 1000) / 1000 - 0.5 : 0) * 0.1;
    const energies = pool.filter((r) => r.energy != null).map((r) => r.energy!);
    const steady = seed?.energy ?? (energies.length ? energies.reduce((a, b) => a + b, 0) / energies.length : 6);
    const fit = (r: T.TrackRow, target: number) => (r.energy == null ? 0.4 : Math.max(0, 1 - Math.abs(r.energy - target) / 4));
    const bpms = pool.map((r) => r.bpm!).sort((a, b) => a - b);
    const usual = bpms[Math.floor(bpms.length / 2)];
    const first =
      seed ??
      pool.slice().sort((a, b) => {
        const s = (r: T.TrackRow) => fit(r, shapeTarget(req.shape, 0, steady)) + 0.5 * Math.max(0, 1 - Math.abs(r.bpm! / usual - 1) * 10) + 0.02 * r.rating + 3 * shake(r.id);
        return s(b) - s(a) || a.id - b.id;
      })[0];
    const set = [first];
    let heard = first.duration * 0.8;
    while (heard < goal) {
      const last = set[set.length - 1];
      const target = shapeTarget(req.shape, heard / goal, steady);
      let best: { r: T.TrackRow; v: number } | null = null;
      for (const r of pool) {
        if (set.includes(r)) continue;
        // Room for the voices: no third singer in a row.
        if (req.vocals === "breathe" && sings(r) && set.length >= 2 && set.slice(-2).every(sings)) continue;
        const tr = transition(last, r);
        const tempo = Math.abs(r.bpm! / last.bpm! - 1);
        if (tempo > 0.06 && Math.abs(r.bpm! / (last.bpm! * 2) - 1) > 0.06 && Math.abs(r.bpm! / (last.bpm! / 2) - 1) > 0.06) continue;
        const smooth = tr.grade === "smooth" ? 1 : tr.grade === "ok" ? 0.6 : 0.15;
        let v = 0.6 * smooth + 0.4 * fit(r, target) + shake(r.id);
        if (r.artist && r.artist === last.artist) v -= 0.1;
        if (!best || v > best.v) best = { r, v };
      }
      if (!best) break;
      set.push(best.r);
      heard += best.r.duration * 0.8;
    }
    return set;
  }

  /** How alike two demo tracks sound: mostly their genre, then energy and tempo, with a little of their own. */
  private alike(a: T.TrackRow, b: T.TrackRow): number {
    const jitter = (((a.id * 7919 + b.id * 104729) % 97) / 97 - 0.5) * 0.08;
    const sameGenre = a.genre && a.genre === b.genre ? 0.38 : 0;
    const energy = 0.17 * (1 - Math.min(9, Math.abs((a.energy ?? 5) - (b.energy ?? 5))) / 9);
    const tempo = a.bpm && b.bpm ? 0.12 * (1 - Math.min(1, Math.abs(a.bpm - b.bpm) / 60)) : 0.04;
    return Math.max(0, Math.min(1, 0.25 + sameGenre + energy + tempo + jitter));
  }

  async soundsLike(trackId: number, limit = 50): Promise<T.SoundMatch[]> {
    const me = this.find(trackId).row;
    if (me.analysis !== "done") return [];
    return this.tracks
      .map((t) => t.row)
      .filter((r) => r.id !== me.id && r.analysis === "done" && !r.missing)
      .map((r) => ({ track: r, score: this.alike(me, r) }))
      .sort((x, y) => y.score - x.score || x.track.id - y.track.id)
      .slice(0, limit);
  }

  /** The demo has no listener: it matches a description's words to each track's genre, title, energy and voice. */
  async soundSearch(text: string, limit = 60): Promise<T.SoundMatch[]> {
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    const calm = ["calm", "chill", "soft", "gentle", "mellow", "deep", "warm", "slow", "ambient"];
    const loud = ["hard", "energetic", "peak", "banger", "heavy", "loud", "driving", "pumping", "big"];
    return this.tracks
      .map((t) => t.row)
      .filter((r) => r.analysis === "done" && !r.missing)
      .map((r) => {
        const about = `${r.genre} ${r.title} ${r.artist}`.toLowerCase();
        let score = 0.15 + words.filter((w) => about.includes(w)).length * 0.25;
        const e = r.energy ?? 5;
        if (words.some((w) => calm.includes(w))) score += 0.2 * (1 - e / 10);
        if (words.some((w) => loud.includes(w))) score += 0.2 * (e / 10);
        if (words.some((w) => ["vocal", "vocals", "voice", "singing", "singer"].includes(w))) score += 0.2 * ((r.vocals ?? 0) / 100);
        if (words.includes("instrumental")) score += 0.2 * (1 - (r.vocals ?? 0) / 100);
        score += (((r.id * 7919) % 97) / 97 - 0.5) * 0.04;
        return { track: r, score: Math.max(0, Math.min(1, score)) };
      })
      .sort((x, y) => y.score - x.score || x.track.id - y.track.id)
      .slice(0, limit);
  }
  async soundSearchStatus(): Promise<T.SoundSearchStatus> {
    const rows = this.tracks.map((t) => t.row).filter((r) => !r.missing);
    return { available: this.settings.soundSearch !== false, heard: rows.filter((r) => r.analysis === "done").length, total: rows.length };
  }
  async soundListen(): Promise<void> {}
  async updateCheck(): Promise<T.UpdateStatus> {
    return { canInstall: false, problem: "The demo in the browser doesn't update itself: reload the page for the newest version.", source: "", branch: "", current: "", latest: "", changes: [], waiting: 0, running: false };
  }
  async updateInstall(): Promise<void> {
    throw new Error("The demo in the browser doesn't update itself.");
  }
  async updateCancel(): Promise<void> {}
  async updateRestart(): Promise<void> {
    location.reload();
  }

  async playlists(): Promise<T.PlaylistDto[]> {
    const rows = await Promise.all(
      this.playlistsData.map(async (p) => {
        const tracks = await this.playlistTracks(p.id);
        return { id: p.id, parent: p.parent, name: p.name, kind: p.kind, query: p.query, count: tracks.length, duration: tracks.reduce((a, t) => a + t.duration, 0) };
      }),
    );
    return rows;
  }

  async playlistTracks(id: number): Promise<T.TrackRow[]> {
    const p = this.playlistsData.find((x) => x.id === id);
    if (!p) return [];
    if (p.kind === "smart") return this.search(p.query ?? "");
    return p.tracks.map((i) => this.tracks.find((t) => t.row.id === i)?.row).filter((x): x is T.TrackRow => !!x);
  }

  async createPlaylist(name: string, kind: "folder" | "list" | "smart", opts: { parent?: number | null; query?: string | null; tracks?: number[] } = {}) {
    const id = Math.max(0, ...this.playlistsData.map((p) => p.id)) + 1;
    this.playlistsData.push({ id, parent: opts.parent ?? null, name, kind, query: opts.query ?? null, count: 0, duration: 0, tracks: opts.tracks ?? [] });
    return id;
  }
  async renamePlaylist(id: number, name: string) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (p) p.name = name;
  }
  async setPlaylistQuery(id: number, query: string) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (p) p.query = query;
  }
  /** Like the library, a folder takes everything inside it along. */
  async deletePlaylist(id: number) {
    const gone = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of this.playlistsData) if (p.parent != null && gone.has(p.parent) && !gone.has(p.id)) (gone.add(p.id), (grew = true));
    }
    this.playlistsData = this.playlistsData.filter((p) => !gone.has(p.id));
  }
  async addToPlaylist(id: number, tracks: number[]) {
    this.playlistsData.find((x) => x.id === id)?.tracks.push(...tracks);
  }
  async removeFromPlaylist(id: number, indices: number[]) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (p) p.tracks = p.tracks.filter((_, i) => !indices.includes(i));
  }
  async reorderPlaylist(id: number, from: number[], to: number) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (!p) return;
    const moving = from.map((i) => p.tracks[i]);
    const rest = p.tracks.filter((_, i) => !from.includes(i));
    const at = Math.min(to - from.filter((i) => i < to).length, rest.length);
    rest.splice(at, 0, ...moving);
    p.tracks = rest;
  }
  async movePlaylist(id: number, parent: number | null, position: number) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (!p) return;
    if (parent != null) {
      const target = this.playlistsData.find((x) => x.id === parent);
      if (!target || target.kind !== "folder") throw new Error("playlists go into folders, not into other playlists");
      for (let at: number | null = parent; at != null; at = this.playlistsData.find((x) => x.id === at)?.parent ?? null) {
        if (at === id) throw new Error("a folder cannot go inside itself");
      }
    }
    // Position among the new siblings, kept by order in the list.
    this.playlistsData = this.playlistsData.filter((x) => x !== p);
    p.parent = parent;
    const siblings = this.playlistsData.filter((x) => x.parent === parent);
    const before = siblings[Math.max(0, position)];
    const at = before ? this.playlistsData.indexOf(before) : this.playlistsData.length;
    this.playlistsData.splice(at, 0, p);
  }
  async setPlaylistTracks(id: number, tracks: number[]) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (p) p.tracks = [...tracks];
  }
  /** The demo has no files: it reports the copy as a job, like the desktop app. */
  async copyFiles(ids: number[], dest: string, name: string) {
    const missing = ids.filter((id) => this.find(id).row.missing).length;
    this.emit<T.JobProgress>("job", { kind: "copy", done: 0, total: ids.length, message: "Copying", finished: false, error: null });
    setTimeout(() => this.emit<T.JobProgress>("job", { kind: "copy", done: 0, total: 0, message: `Copied ${ids.length - missing} of ${ids.length} tracks to ${dest}/${name}`, finished: true, error: null }), 400);
  }
  /** A greedy path: each next track is the easiest to mix into, rising in energy for "up". */
  async orderPlaylist(id: number, energy: "steady" | "up" | "down" = "steady") {
    const p = this.playlistsData.find((x) => x.id === id);
    if (!p || p.tracks.length < 3) return;
    const rows = p.tracks.map((t) => this.find(t).row);
    const rank = { smooth: 0, ok: 1, rough: 3 };
    const cost = (a: T.TrackRow, b: T.TrackRow) => {
      const t = transition(a, b);
      let c = rank[t.grade] + Math.abs(t.tempoPct ?? 0) / 6;
      const de = (b.energy ?? 5) - (a.energy ?? 5);
      if (energy === "up") c += de < 0 ? -de : de > 2 ? (de - 2) / 2 : 0;
      if (energy === "down") c += de > 0 ? de : de < -2 ? (-de - 2) / 2 : 0;
      return c;
    };
    const left = [...rows];
    const pick = energy === "up" ? left.reduce((m, r) => ((r.energy ?? 5) < (m.energy ?? 5) ? r : m)) : energy === "down" ? left.reduce((m, r) => ((r.energy ?? 5) > (m.energy ?? 5) ? r : m)) : left[0];
    const out = [pick];
    left.splice(left.indexOf(pick), 1);
    while (left.length) {
      const cur = out[out.length - 1];
      let best = 0;
      for (let i = 1; i < left.length; i++) if (cost(cur, left[i]) < cost(cur, left[best])) best = i;
      out.push(left.splice(best, 1)[0]);
    }
    p.tracks = out.map((r) => r.id);
  }
  async history() {
    return this.historyData;
  }

  /** The current session's id; past demo sets are 1, 2 and 3. */
  private static CURRENT = 100;
  private pastSets: { id: number; name: string; startedAt: number; entries: T.HistoryEntry[] }[] | null = null;

  /** A few made-up past sets so History has something to show. */
  private demoSets() {
    if (this.pastSets) return this.pastSets;
    const day = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const plan: [number, string, number, number][] = [
      [2, "", 22, 16],
      [6, "Friday at the bar", 30, 12],
      [13, "", 50, 18],
    ];
    this.pastSets = plan.map(([ago, name, from, n], i) => {
      const start = Math.floor((now - ago * day) / day) * day + 21 * 3600;
      let at = start;
      const entries = this.tracks.slice(from, from + n).map((t) => {
        const e: T.HistoryEntry = { track_id: t.row.id, played_at: at, deck: (at / 60) % 2 ? 1 : 0, title: t.row.title, artist: t.row.artist };
        at += Math.round(t.row.duration * 0.7);
        return e;
      });
      return { id: i + 1, name, startedAt: start - 300, entries };
    });
    return this.pastSets;
  }

  async historySessions(): Promise<{ current: number | null; sessions: T.SessionDto[] }> {
    const info = (id: number, name: string, startedAt: number, e: T.HistoryEntry[]): T.SessionDto => ({ id, name, startedAt, tracks: e.length, firstPlayed: e[0].played_at, lastPlayed: e[e.length - 1].played_at });
    const sessions = this.demoSets().map((s) => info(s.id, s.name, s.startedAt, s.entries));
    if (this.historyData.length) sessions.unshift(info(DemoBackend.CURRENT, "", this.historyData[0].played_at, this.historyData));
    return { current: DemoBackend.CURRENT, sessions };
  }

  async sessionHistory(session: number): Promise<T.HistoryEntry[]> {
    if (session === DemoBackend.CURRENT) return this.historyData;
    return this.demoSets().find((s) => s.id === session)?.entries ?? [];
  }

  async renameSession(session: number, name: string): Promise<void> {
    const s = this.demoSets().find((x) => x.id === session);
    if (s) s.name = name.trim();
  }

  async deleteSession(session: number): Promise<void> {
    if (session === DemoBackend.CURRENT) this.historyData = [];
    else this.pastSets = this.demoSets().filter((s) => s.id !== session);
    this.emit("history-changed", null);
  }
  async tracklist() {
    return this.historyData.map((h, i) => `${i + 1}. ${h.artist} – ${h.title}`).join("\n");
  }

  async devices(): Promise<T.DeviceInfo[]> {
    return [{ id: "demo:default", name: "Browser (no audio in demo)", host: "Demo", max_channels: 2, sample_rates: [48000], default_sample_rate: 48000, buffer_range: [64, 2048], is_default: true }];
  }
  async audioStatus(): Promise<T.AudioStatus> {
    return { device: "Demo engine (silent)", isVirtual: true, sampleRate: SR, bufferFrames: 256, latencyMs: 5.3, warning: null };
  }
  async saveSettings(s: T.Settings) {
    this.settings = s;
    return s;
  }
  async inputDevices(): Promise<T.DeviceInfo[]> {
    return [
      { id: "demo:mic", name: "Built-in microphone (simulated)", host: "Demo", max_channels: 2, sample_rates: [48000], default_sample_rate: 48000, buffer_range: null, is_default: true },
      { id: "demo:line", name: "USB audio interface, line in (simulated)", host: "Demo", max_channels: 4, sample_rates: [44100, 48000], default_sample_rate: 48000, buffer_range: [64, 1024], is_default: false },
    ];
  }
  async studioGet(channel: number | null): Promise<T.StudioDto> {
    return structuredClone(this.studio[channel ?? 4]);
  }

  async studioSet(channel: number | null, settings: T.StudioDto): Promise<void> {
    this.studio[channel ?? 4] = structuredClone(settings);
  }

  async setScope(source: T.ScopeSource): Promise<void> {
    this.scope = source;
  }

  /** A believable spectrum: pink-ish music shaped by the strip's EQ, moving with the level. */
  protected fakeSpectrum(level: number, s: T.StudioDto): number[] {
    const t = performance.now() / 1000;
    return Array.from({ length: 96 }, (_, k) => {
      const f = 20 * Math.pow(1000, (k + 0.5) / 96);
      // Music falls about 4.5 dB per octave; the display tilts it back to roughly flat.
      const base = -30 + 20 * Math.log10(Math.max(level, 1e-4)) - 6 * Math.max(0, Math.log2(f / 8000)) - 8 * Math.max(0, Math.log2(60 / f));
      const wobble = 3 * Math.sin(t * 5 + k * 0.7) * Math.sin(t * 1.3 + k * 0.31);
      return Math.max(-110, base + eqDb(s, f) + wobble);
    });
  }

  async micState(): Promise<T.MicState> {
    if (!this.settings.micEnabled) return { status: null, error: null, lost: false };
    const d = (await this.inputDevices()).find((x) => x.id === this.settings.micDevice) ?? (await this.inputDevices())[0];
    return { status: { device: d.name, sampleRate: 48000, channels: d.max_channels, bufferFrames: 256, channel: this.settings.micChannel, stereo: this.settings.micStereo, ...this.demoCleaning() }, error: null, lost: false };
  }
  /** What the desktop's mic cleaner would report for the current settings. */
  private demoCleaning(): Pick<T.MicStatus, "cleaning" | "cleanDelayMs"> {
    const s = this.settings;
    if (s.micStereo || s.micVoice === false) return { cleaning: null, cleanDelayMs: 0 };
    const d = s.micDenoise ?? "strong";
    const what = d === "off" ? "echo cancelled" : `echo cancelled, noise removed (${d === "light" ? "RNNoise" : "DeepFilterNet3"})`;
    return { cleaning: what, cleanDelayMs: d === "strong" ? 30 : d === "light" ? 10 : 0 };
  }
  async micRecordStart() {
    if (!this.settings.micEnabled) throw new Error("Turn the mic on first.");
    this.mic.recordingSince = performance.now() / 1000;
  }
  async micRecordStop(_trim: boolean): Promise<T.MicTake> {
    const since = this.mic.recordingSince;
    if (since === null) throw new Error("Not recording the mic.");
    this.mic.recordingSince = null;
    const d = new Date();
    return { path: `~/Music/MixIt/Recordings/Mic/Mic ${d.getHours()}.${String(d.getMinutes()).padStart(2, "0")}.wav`, seconds: Math.max(0.5, performance.now() / 1000 - since) };
  }
  async recordStart() {
    this.recording = true;
    this.recorded = 0;
    return "~/Music/MixIt/Recordings/demo.wav";
  }
  async recordStop() {
    this.recording = false;
    return "~/Music/MixIt/Recordings/demo.wav";
  }

  /** Files the demo "wrote", for tests. */
  readonly savedTexts = new Map<string, string>();

  async saveText(path: string, text: string) {
    this.savedTexts.set(path, text);
  }

  async automix(tracks: number[], options: T.AutomixRequest): Promise<T.MixProject> {
    const rows = tracks.map((i) => this.find(i));
    // The median tempo keeps most tracks close to their own speed.
    const tempos = rows.map((r) => r.row.bpm ?? 124).sort((a, b) => a - b);
    const bpm = tempos[Math.floor(tempos.length / 2)];
    const clips: T.Clip[] = [];
    let start = 0;
    rows.forEach((t, i) => {
      const len = t.sections.reduce((a, s) => a + s.bars * 4, 0);
      const outroBeats = t.sections[t.sections.length - 1].bars * 4;
      const ov = Math.min(options.overlap, outroBeats);
      const first = i === 0;
      const last = i === rows.length - 1;
      const vol: T.AutomationPoint[] = [];
      const low: T.AutomationPoint[] = [];
      if (!first) {
        vol.push({ beat: start, value: 0, curve: "Smooth" }, { beat: start + ov / 2, value: 1, curve: "Linear" });
        low.push({ beat: start, value: -26, curve: "Hold" }, { beat: start + ov / 2, value: 0, curve: "Hold" });
      }
      if (!last) {
        vol.push({ beat: start + len - ov / 2, value: 1, curve: "Smooth" }, { beat: start + len, value: 0, curve: "Linear" });
        low.push({ beat: start + len - ov / 2, value: 0, curve: "Hold" }, { beat: start + len - ov / 2 + 1, value: -26, curve: "Hold" });
      }
      clips.push({
        id: i + 1,
        track: { hash: null, path: t.row.path, title: t.row.title, artist: t.row.artist, bpm: t.row.bpm ?? 0, key: toProjectKey(t.row.key), duration: t.row.duration },
        lane: i % 2,
        start,
        length: len,
        source_start: 0,
        key_shift: 0,
        keylock: true,
        gain_db: 0,
        lanes: [
          { param: "Volume", points: vol },
          { param: "EqLow", points: low },
        ],
        fx: null,
        name: t.row.title,
      });
      start += len - ov;
    });
    return {
      version: 1,
      name: options.name,
      tempo: { segments: [{ start_beat: 0, bpm, end_bpm: bpm }], time_signatures: [{ start_beat: 0, numerator: 4, denominator: 4 }] },
      clips,
      markers: [],
      master_gain_db: 0,
      next_id: clips.length + 1,
    };
  }
  async saveProject(_path: string, _project: T.MixProject) {}
  async openProject(_path: string): Promise<T.MixProject> {
    throw new Error("Opening files needs the desktop app.");
  }
  async checkProject() {
    return [];
  }
  // ---------------------------------------------------------------- sound editor (simulated)

  private demoSounds = new Map<number, { audio: Float32Array; name: string }>();
  private nextDemoSound = 1;

  async soundOpen(source: T.PadSource, bins: number): Promise<T.SoundOpened> {
    if (source.type === "empty") throw new Error("The pad is empty.");
    const name = source.type === "kit" ? (DEMO_KIT.find((k) => k.id === source.id)?.name ?? "Sound") : source.type === "track" ? this.find(source.trackId).row.title : "Recording";
    const audio = demoSound(source.type === "track" ? 8 : 4);
    const id = this.nextDemoSound++;
    this.demoSounds.set(id, { audio, name });
    return { id, name, view: viewOf(audio, bins) };
  }
  private demoEdited(id: number, ops: T.EditOp[]) {
    const s = this.demoSounds.get(id);
    if (!s) throw new Error("That sound is no longer open.");
    return applyEdits(s.audio, ops);
  }
  async soundRender(id: number, ops: T.EditOp[], bins: number): Promise<T.SoundView> {
    return viewOf(this.demoEdited(id, ops), bins);
  }
  async soundAudio(id: number, ops: T.EditOp[]): Promise<ArrayBuffer> {
    const a = this.demoEdited(id, ops);
    const pcm = new Int16Array(a.length);
    for (let i = 0; i < a.length; i++) pcm[i] = Math.max(-1, Math.min(1, a[i])) * 32767;
    const h = new DataView(new ArrayBuffer(44));
    const w = (o: number, t: string) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF");
    h.setUint32(4, 36 + pcm.byteLength, true);
    w(8, "WAVEfmt ");
    h.setUint32(16, 16, true);
    h.setUint16(20, 1, true);
    h.setUint16(22, 2, true);
    h.setUint32(24, DEMO_SR, true);
    h.setUint32(28, DEMO_SR * 4, true);
    h.setUint16(32, 4, true);
    h.setUint16(34, 16, true);
    w(36, "data");
    h.setUint32(40, pcm.byteLength, true);
    return new Blob([h.buffer, pcm.buffer]).arrayBuffer();
  }
  async soundSave(id: number, ops: T.EditOp[], name: string): Promise<string> {
    this.demoEdited(id, ops);
    return `/Music/MixIt/Recordings/Edits/${name || "Edited sound"}.wav`;
  }
  async soundClose(id: number) {
    this.demoSounds.delete(id);
  }

  async renderStems(project: T.MixProject, _folder: string, format?: string) {
    return this.renderProject(project, `stems.${format ?? "flac"}`);
  }
  async renderProject(_project: T.MixProject, _path: string, _format?: string, _targetLufs?: number | null) {
    let done = 0;
    const timer = setInterval(() => {
      done += 50;
      const finished = done >= 1000;
      this.emit<T.JobProgress>("job", { kind: "render", done, total: 1000, message: finished ? "Saved (demo)" : `Rendering ${done / 10} %`, finished, error: null });
      if (finished) clearInterval(timer);
    }, 100);
  }

  /** A drum-machine sketch of the passage: kick on every beat, hats off-beat and a tone
   * per playing clip, at the project's tempo. */
  /** Plays the passage in the simulated preview player (as a track that is no library track). */
  async previewMix(project: T.MixProject, fromBeat: number, toBeat: number): Promise<number> {
    if (!project.clips.length) throw new Error("The mix has no clips.");
    for (const c of project.clips) if (!this.tracks.some((t) => t.row.path === c.track.path)) throw new Error(`file not found: ${c.track.path}`);
    // Seconds of the passage under the project's tempo map (steps; ramps taken at their start).
    const segs = project.tempo.segments.length ? project.tempo.segments : [{ start_beat: 0, bpm: 124, end_bpm: 124 }];
    let duration = 0.5;
    segs.forEach((sg, i) => {
      const a = Math.max(fromBeat, sg.start_beat);
      const b = Math.min(toBeat, segs[i + 1]?.start_beat ?? toBeat);
      if (b > a) duration += ((b - a) * 60) / sg.bpm;
    });
    this.previewState = { trackId: -1, playing: true, position: 0, duration };
    return duration;
  }

  async previewProject(project: T.MixProject, fromBeat: number, toBeat: number): Promise<ArrayBuffer> {
    const sr = 22050;
    const bpm = project.tempo.segments[0]?.bpm ?? 124;
    const spb = 60 / bpm;
    const beats = Math.max(1, toBeat - fromBeat);
    const n = Math.round(beats * spb * sr);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const beat = fromBeat + t / spb;
      const ph = (t / spb) % 1;
      let v = Math.sin(2 * Math.PI * 55 * Math.exp(-ph * 6) * ph * spb) * Math.exp(-ph * 10) * 0.6;
      const off = (ph + 0.5) % 1;
      v += (Math.random() * 2 - 1) * Math.exp(-off * 40) * 0.12;
      const st = project.lane_states ?? [];
      const anySolo = st.some((s) => s?.solo);
      for (const c of project.clips) {
        if (beat < c.start || beat >= c.start + c.length) continue;
        if (st[c.lane]?.muted || (anySolo && !st[c.lane]?.solo)) continue;
        const f = 220 * Math.pow(2, ((c.id * 5) % 12) / 12);
        const vol = c.lanes.find((l) => l.param === "Volume");
        let g = 1;
        if (vol && vol.points.length) {
          const pts = vol.points;
          if (beat <= pts[0].beat) g = pts[0].value;
          else if (beat >= pts[pts.length - 1].beat) g = pts[pts.length - 1].value;
          else {
            const k = pts.findIndex((p) => p.beat > beat);
            const a = pts[k - 1];
            const b = pts[k];
            g = a.value + ((b.value - a.value) * (beat - a.beat)) / Math.max(1e-9, b.beat - a.beat);
          }
        }
        v += Math.sin(2 * Math.PI * f * t) * 0.08 * g;
      }
      pcm[i] = Math.max(-1, Math.min(1, v)) * 32000;
    }
    const buf = new ArrayBuffer(44 + n * 2);
    const d = new DataView(buf);
    const str = (o: number, x: string) => [...x].forEach((ch, j) => d.setUint8(o + j, ch.charCodeAt(0)));
    str(0, "RIFF");
    d.setUint32(4, 36 + n * 2, true);
    str(8, "WAVEfmt ");
    d.setUint32(16, 16, true);
    d.setUint16(20, 1, true);
    d.setUint16(22, 1, true);
    d.setUint32(24, sr, true);
    d.setUint32(28, sr * 2, true);
    d.setUint16(32, 2, true);
    d.setUint16(34, 16, true);
    str(36, "data");
    d.setUint32(40, n * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }

  // ---------------------------------------------------------------- sampler

  protected seq: T.SequencerDto = { on: false, steps: 16, stepBeats: 0.25, swing: 0, pads: [] };
  protected seqStep = -1;
  protected seqBeat = 0;

  /** Steps the simulated sequencer on the clock and triggers the pads of each new step. */
  protected sequencerTick(dt: number, bpm: number) {
    if (!this.seq.on) {
      this.seqStep = -1;
      return;
    }
    const md = this.master !== null ? this.decks[this.master] : null;
    this.seqBeat = md?.track && md.playing ? this.beatAt(md, md.position) : this.seqBeat + (dt * bpm) / 60;
    const n = Math.max(1, this.seq.steps);
    const step = ((Math.floor(this.seqBeat / this.seq.stepBeats) % n) + n) % n;
    if (step === this.seqStep) return;
    this.seqStep = step;
    this.seq.pads.forEach((row, pad) => {
      const p = this.pads[pad];
      if (row[step] && p && p.source.type !== "empty") this.padEnds.set(pad, performance.now() + Math.min(p.seconds, 0.3) * 1000);
    });
  }

  async samplerSequence(sequencer: T.SequencerDto) {
    if (sequencer.on && !this.seq.on) this.seqStep = -1;
    this.seq = { ...sequencer, pads: sequencer.pads.map((r) => [...r]) };
  }

  protected samplerMask(): number {
    const now = performance.now();
    let m = 0;
    for (const [pad, end] of this.padEnds) {
      if (end > now) m |= 1 << pad;
      else this.padEnds.delete(pad);
    }
    return m;
  }

  protected samplerAction(p: string[], input: T.ActionInput) {
    if (p[1] === "stop_all") {
      if (input.type === "press") this.padEnds.clear();
      return;
    }
    if (p[1] !== "pad") return;
    const pad = this.pads[Number(p[2]) - 1];
    if (!pad || pad.source.type === "empty") return;
    if (p[3] === "mode") {
      if (input.type === "choice") pad.mode = input.value;
      return;
    }
    const playing = (this.padEnds.get(pad.pad) ?? 0) > performance.now();
    if (input.type === "press") {
      if (pad.mode === 2 && playing) this.padEnds.delete(pad.pad);
      else this.padEnds.set(pad.pad, pad.mode === 0 ? performance.now() + pad.seconds * 1000 : Infinity);
    } else if (input.type === "release" && pad.mode === 1) {
      this.padEnds.delete(pad.pad);
    }
  }

  async samplerLoad(pad: number, source: T.PadSource): Promise<T.PadInfo> {
    const cur = this.pads[pad];
    if (!cur) throw new Error(`no pad ${pad + 1}`);
    await new Promise((r) => setTimeout(r, 150));
    let next: T.PadInfo;
    if (source.type === "kit") {
      next = kitPad(pad, source.id);
    } else if (source.type === "file") {
      const name = fileName(source.path).replace(/\.[^.]+$/, "") || "Sound";
      next = { ...emptyPad(pad), name, source, seconds: 1.8, color: cur.color };
    } else if (source.type === "track") {
      const t = this.find(source.trackId);
      next = { ...emptyPad(pad), name: source.start != null ? `${t.row.title} (loop)` : t.row.title, source, seconds: source.seconds ?? t.row.duration, bpm: t.row.bpm, mode: source.start != null ? 2 : 0, color: cur.color };
    } else {
      return this.samplerClear(pad);
    }
    next.gainDb = cur.gainDb;
    this.pads[pad] = next;
    this.padEnds.delete(pad);
    return { ...next };
  }

  async samplerClear(pad: number): Promise<T.PadInfo> {
    this.pads[pad] = emptyPad(pad);
    this.padEnds.delete(pad);
    return { ...this.pads[pad] };
  }

  async samplerSet(pad: number, patch: T.PadPatch): Promise<T.PadInfo> {
    const p = this.pads[pad];
    if (!p) throw new Error(`no pad ${pad + 1}`);
    Object.assign(p, { ...patch, bpm: patch.bpm === undefined ? p.bpm : patch.bpm || null });
    return { ...p };
  }

  async samplerReset(): Promise<T.PadInfo[]> {
    this.pads = defaultPads();
    this.padEnds.clear();
    return this.pads.map((p) => ({ ...p }));
  }

  async samplerStopAll() {
    this.padEnds.clear();
  }

  async addPracticeTracks() {
    const have = new Set(this.tracks.map((t) => t.row.title));
    DEMO_PRACTICE.forEach((o, i) => {
      if (!have.has(o.title)) this.tracks.push(makeTrack(1001 + i, o));
    });
    this.emit("library-changed", null);
    this.emit<T.JobProgress>("job", { kind: "scan", done: 0, total: 0, message: `Added ${DEMO_PRACTICE.length} practice tracks.`, finished: true, error: null });
  }

  /** Demo covers: an abstract design drawn from the title, so every track looks its own. */
  async artwork(trackId: number): Promise<Blob | null> {
    const t = this.tracks.find((x) => x.row.id === trackId);
    if (!t?.row.hasArt) return null;
    return new Blob([demoCover(t.row.title, t.row.artist)], { type: "image/svg+xml" });
  }
  async importRekordbox() {}
  async importTraktor() {}
  async importSerato() {}
  async importVirtualDj() {}
  async exportRekordbox() {}
  async exportTraktor() {}
  async exportPlaylist() {}
  async importM3u() {
    return 0;
  }

  async pickFolders(): Promise<string[] | null> {
    return ["~/Music/New"];
  }
  async pickFiles(_extensions: string[], _title: string): Promise<string[] | null> {
    return null;
  }
  async pickSave(defaultName: string) {
    return defaultName;
  }

  onTelemetry(cb: (t: T.Telemetry) => void) { return this.on("telemetry", cb); }
  onDeckLoaded(cb: (d: T.DeckInfo) => void) { return this.on("deck-loaded", cb); }
  onDeckEnded(cb: (deck: number) => void) { return this.on("deck-ended", cb); }
  onJob(cb: (j: T.JobProgress) => void) { return this.on("job", cb); }
  onLibraryChanged(cb: () => void) { return this.on("library-changed", cb); }
  onHistoryChanged(cb: () => void) { return this.on("history-changed", cb); }
  onAudioStatus(cb: (s: T.AudioStatus) => void) { return this.on("audio-status", cb); }
  onError(cb: (m: string) => void) { return this.on("error", cb); }
}

/** The demo's version of the engine's grid edit (mixit_core::Beatgrid::apply_edit). */
export function applyDemoGrid(t: DemoTrack, e: T.GridEdit, locked: Set<number>) {
  const changes = e.bpm !== undefined || e.downbeatAt !== undefined || e.nudgeMs !== undefined || e.warpAt !== undefined || e.unwarpAt !== undefined || !!e.straighten;
  if (locked.has(t.row.id) && changes && e.locked !== false) throw new Error("The beat grid is locked. Unlock it first.");
  if (e.bpm !== undefined) {
    if (!(e.bpm >= 20 && e.bpm <= 400)) throw new Error("That tempo is outside the 20 to 400 BPM MixIt supports.");
    t.period = 60 / e.bpm;
    t.row.bpm = Math.round(e.bpm * 100) / 100;
    t.pins = undefined;
  }
  if (e.downbeatAt !== undefined) {
    // The spot becomes the start of a bar; beat 0 is the earliest bar start in the track.
    t.firstBeat = e.downbeatAt - Math.floor(e.downbeatAt / (4 * t.period)) * 4 * t.period;
    t.pins = undefined;
  }
  if (e.nudgeMs !== undefined) {
    t.firstBeat += e.nudgeMs / 1000;
    t.pins = t.pins?.map((p) => ({ ...p, t: p.t + e.nudgeMs! / 1000 }));
  }
  if (e.straighten && t.pins && t.pins.length > 1) {
    const [a, b] = [t.pins[0], t.pins[t.pins.length - 1]];
    t.period = (b.t - a.t) / (b.beat - a.beat);
    t.pins = undefined;
  }
  if (e.unwarpAt !== undefined && t.pins && t.pins.length > 1) {
    let best = 0;
    t.pins.forEach((p, i) => {
      if (Math.abs(p.t - e.unwarpAt!) < Math.abs(t.pins![best].t - e.unwarpAt!)) best = i;
    });
    t.pins = t.pins.filter((_, i) => i !== best);
    if (t.pins.length < 2) t.pins = undefined;
  }
  if (e.warpAt !== undefined) {
    const beat = Math.round(demoBeatAt(t, e.warpAt));
    const pins = (t.pins ?? [{ beat: 0, t: t.firstBeat }]).filter((p) => p.beat !== beat);
    pins.push({ beat, t: e.warpAt });
    pins.sort((a, b) => a.beat - b.beat);
    if (pins.some((p, i) => i > 0 && !(p.t > pins[i - 1].t))) throw new Error("A marker there would put beats out of order. Pin a beat closer to the play head.");
    t.pins = pins;
  }
  if (t.pins) {
    t.firstBeat = demoTimeAt(t, 0);
    t.period = demoTimeAt(t, 1) - t.firstBeat;
  }
  if (e.locked !== undefined) {
    if (e.locked) locked.add(t.row.id);
    else locked.delete(t.row.id);
  }
}

/** Every beat of a warped demo track, in seconds. */
function demoBeatList(t: DemoTrack): number[] {
  const out: number[] = [];
  for (let b = Math.ceil(demoBeatAt(t, 0)); ; b++) {
    const s = demoTimeAt(t, b);
    if (s > t.row.duration) break;
    out.push(s);
  }
  return out;
}

/** Segment of a pinned grid holding `x` (clamped to the first and last segments). */
function pinSegment(pins: { beat: number; t: number }[], x: number, key: "beat" | "t") {
  let i = 0;
  while (i < pins.length - 2 && pins[i + 1][key] <= x) i++;
  return [pins[i], pins[i + 1]] as const;
}

/** Seconds of a (fractional) beat on a demo track's grid. */
export function demoTimeAt(t: DemoTrack, beat: number): number {
  const p = t.pins;
  if (!p || p.length < 2) return t.firstBeat + beat * t.period;
  const [a, b] = pinSegment(p, beat, "beat");
  return a.t + ((beat - a.beat) * (b.t - a.t)) / (b.beat - a.beat);
}

/** The (fractional) beat at some seconds on a demo track's grid. */
export function demoBeatAt(t: DemoTrack, sec: number): number {
  const p = t.pins;
  if (!p || p.length < 2) return (sec - t.firstBeat) / t.period;
  const [a, b] = pinSegment(p, sec, "t");
  return a.beat + ((sec - a.t) * (b.beat - a.beat)) / (b.t - a.t);
}

/** A subset of the library search language, enough for the demo. */
export function demoSearch(rows: T.TrackRow[], query: string, tagsOf: (id: number) => string[] = () => [], alikeOf: (id: number) => Map<number, number> = () => new Map()): T.TrackRow[] {
  const terms = searchTerms(query.trim());
  let out = rows;
  let sort: ((a: T.TrackRow, b: T.TrackRow) => number) | null = null;
  let likeSort: ((a: T.TrackRow, b: T.TrackRow) => number) | null = null;
  for (const raw of terms) {
    const neg = raw.startsWith("-");
    const term = neg ? raw.slice(1) : raw;
    const [field, quotedVal] = term.includes(":") ? term.split(/:(.*)/s) : [null, term];
    const val = quotedVal.replace(/^"|"$/g, "");
    let f: (t: T.TrackRow) => boolean;
    const num = (v: number | null, spec: string) => {
      if (v == null) return false;
      if (spec.startsWith("~")) return Math.abs(v / Number(spec.slice(1)) - 1) <= 0.06 || Math.abs(v / 2 / Number(spec.slice(1)) - 1) <= 0.06 || Math.abs((v * 2) / Number(spec.slice(1)) - 1) <= 0.06;
      if (spec.endsWith("+")) return v >= Number(spec.slice(0, -1));
      if (spec.startsWith(">=")) return v >= Number(spec.slice(2));
      if (spec.startsWith("<=")) return v <= Number(spec.slice(2));
      if (spec.startsWith(">")) return v > Number(spec.slice(1));
      if (spec.startsWith("<")) return v < Number(spec.slice(1));
      if (spec.includes("-")) {
        const [a, b] = spec.split("-").map(Number);
        return v >= a && v <= b;
      }
      return Math.round(v) === Math.round(Number(spec));
    };
    switch (field?.toLowerCase()) {
      case "bpm":
        f = (t) => num(t.bpm, val);
        break;
      case "energy":
        f = (t) => num(t.energy, val);
        break;
      case "vocals":
      case "vocal":
      case "voice": {
        const v = val.toLowerCase();
        f = ["yes", "y", "some"].includes(v) ? (t) => (t.vocals ?? -1) >= 10 : ["no", "n", "none", "instrumental"].includes(v) ? (t) => t.vocals != null && t.vocals < 5 : (t) => num(t.vocals ?? null, val);
        break;
      }
      case "rating":
        f = (t) => num(t.rating, val);
        break;
      case "year":
        f = (t) => num(t.year, val);
        break;
      case "key": {
        const compat = val.startsWith("~");
        const k = compat ? val.slice(1) : val;
        f = (t) => {
          if (!t.key) return false;
          if (!compat) return t.key.camelot.toLowerCase() === k.toLowerCase() || t.key.name.toLowerCase() === k.toLowerCase();
          const m = k.match(/^(\d+)([ab])$/i);
          if (!m) return false;
          const n = Number(m[1]);
          const l = m[2].toUpperCase();
          const c = t.key.camelot;
          const cn = Number(c.slice(0, -1));
          const cl = c.slice(-1);
          return (cl === l && (Math.abs(cn - n) <= 1 || Math.abs(cn - n) === 11)) || cn === n;
        };
        break;
      }
      case "tag":
      case "#":
        f = (t) => tagsOf(t.id).some((n) => n.toLowerCase() === val.toLowerCase());
        break;
      case "like":
      case "sounds": {
        // Tracks that sound like track N (60 % match or more), best first.
        const m = alikeOf(Number(val.replace(/^#/, "")));
        f = (t) => (m.get(t.id) ?? 0) >= 0.6;
        if (!neg && !likeSort) likeSort = (a, b) => (m.get(b.id) ?? 0) - (m.get(a.id) ?? 0);
        break;
      }
      case "played":
      case "added": {
        // never, <Nd (within N days), >Nd (not within N days, never included for played).
        const m = val.match(/^([<>])(\d+)([hdwmy]?)$/);
        const unit: Record<string, number> = { h: 3600, "": 86400, d: 86400, w: 604800, m: 2592000, y: 31536000 };
        const at = (t: T.TrackRow) => (field === "played" ? t.lastPlayed : t.addedAt);
        if (val === "never") f = (t) => (field === "played" ? t.playCount === 0 : false);
        else if (m) {
          const since = Date.now() / 1000 - Number(m[2]) * unit[m[3]];
          f = m[1] === "<" ? (t) => (at(t) ?? 0) >= since && at(t) != null : (t) => at(t) == null || at(t)! < since;
        } else f = (t) => (field === "played" ? t.playCount > 0 : true);
        break;
      }
      case "sort": {
        const k = val.replace(/^-/, "") as keyof T.TrackRow;
        const dir = val.startsWith("-") ? -1 : 1;
        sort = (a, b) => {
          const x = k === "key" ? a.key?.index ?? 99 : (a[k] as number | string);
          const y = k === "key" ? b.key?.index ?? 99 : (b[k] as number | string);
          return (x > y ? 1 : x < y ? -1 : 0) * dir;
        };
        f = () => true;
        break;
      }
      case "artist":
      case "title":
      case "genre":
      case "label":
      case "album":
      case "comment":
        f = (t) => String(t[field as "artist"]).toLowerCase().includes(val.toLowerCase());
        break;
      default: {
        const v = term.toLowerCase().replace(/"/g, "");
        f = (t) => `${t.title} ${t.artist} ${t.genre} ${t.label} ${t.album}`.toLowerCase().includes(v);
      }
    }
    out = out.filter((t) => (neg ? !f(t) : f(t)));
  }
  if (sort) out = [...out].sort(sort);
  else if (likeSort) out = [...out].sort(likeSort);
  return out;
}

/** The registry as the Rust side builds it, for the demo (decks A–D, common controls). */
export const DEMO_KIT: T.KitSound[] = [
  { id: "kick", name: "Kick", bpm: null, mode: 0, color: 0xef4444 },
  { id: "clap", name: "Clap", bpm: null, mode: 0, color: 0xf97316 },
  { id: "air_horn", name: "Air horn", bpm: null, mode: 0, color: 0xeab308 },
  { id: "siren", name: "Siren", bpm: null, mode: 1, color: 0x22c55e },
  { id: "riser", name: "Riser", bpm: 124, mode: 0, color: 0x06b6d4 },
  { id: "impact", name: "Impact", bpm: null, mode: 0, color: 0x3b82f6 },
  { id: "laser", name: "Laser", bpm: null, mode: 0, color: 0xa855f7 },
  { id: "drum_loop", name: "Drum loop", bpm: 124, mode: 2, color: 0xec4899 },
  { id: "snare_build", name: "Snare build", bpm: 124, mode: 0, color: 0x14b8a6 },
  { id: "scratch", name: "Scratch", bpm: null, mode: 0, color: 0x84cc16 },
  { id: "hat_loop", name: "Hi-hat loop", bpm: 124, mode: 2, color: 0x8b5cf6 },
  { id: "sub_drop", name: "Sub drop", bpm: null, mode: 0, color: 0x64748b },
  { id: "snare", name: "Snare", bpm: null, mode: 0, color: 0xf59e0b },
  { id: "hat", name: "Hi-hat", bpm: null, mode: 0, color: 0x8b5cf6 },
  { id: "open_hat", name: "Open hi-hat", bpm: null, mode: 0, color: 0x6366f1 },
  { id: "rim", name: "Rim", bpm: null, mode: 0, color: 0x10b981 },
  { id: "tom", name: "Tom", bpm: null, mode: 0, color: 0xdc2626 },
  { id: "shaker", name: "Shaker", bpm: null, mode: 0, color: 0x0ea5e9 },
];
const KIT_SECONDS: Record<string, number> = { kick: 0.5, clap: 0.38, air_horn: 1.35, siren: 2.4, riser: 3.87, impact: 2.8, laser: 0.46, drum_loop: 1.94, snare_build: 3.87, scratch: 0.6, hat_loop: 1.94, sub_drop: 2, snare: 0.25, hat: 0.06, open_hat: 0.35, rim: 0.08, tom: 0.45, shaker: 0.12 };

export function emptyPad(pad: number): T.PadInfo {
  return { pad, name: "", source: { type: "empty" }, seconds: 0, bpm: null, mode: 0, gainDb: 0, pan: 0, sync: true, quantized: false, color: 0x52525b, error: null };
}

export function kitPad(pad: number, id: string): T.PadInfo {
  const k = DEMO_KIT.find((x) => x.id === id) ?? DEMO_KIT[0];
  return { ...emptyPad(pad), name: k.name, source: { type: "kit", id: k.id }, seconds: KIT_SECONDS[k.id] ?? 1, bpm: k.bpm, mode: k.mode, color: k.color };
}

export function defaultPads(): T.PadInfo[] {
  return ["air_horn", "siren", "riser", "impact", "kick", "clap", "laser", "drum_loop"].map((id, i) => kitPad(i, id));
}

function demoRegistry(): T.ActionSpec[] {
  const out: T.ActionSpec[] = [];
  const add = (id: string, label: string, group: string, kind: T.ActionKind, explain: string, shortcut: string | null = null, easy = true) =>
    out.push({ id, label, group, kind, explain, easy, shortcut, glossary: null });
  const cont = (min: number, max: number, def: number): T.ActionKind => ({ type: "continuous", spec: { min, max, default: def, unit: "None", taper: "Linear", smoothing_ms: 10, step: 0 } });
  const keys = [
    ["Z", "X", "C", "1", "2", "3", "4", "Q", "W", "E", "A", "S"],
    ["M", ",", ".", "7", "8", "9", "0", "U", "I", "O", "J", "K"],
  ];
  ["A", "B", "C", "D"].forEach((l, i) => {
    const g = `Deck ${l}`;
    const k = keys[i] ?? [];
    add(`deck.${l}.play`, "Play / pause", g, { type: "trigger" }, "Starts or pauses the track.", k[0] ?? null);
    add(`deck.${l}.cue`, "Cue", g, { type: "momentary" }, "Paused: sets the cue point here. Playing: jumps back to it and stops. Hold to preview.", k[1] ?? null);
    add(`deck.${l}.sync`, "Sync", g, { type: "toggle" }, "Makes this deck play at the same speed as the leading deck, with the beats lined up, and keeps it that way.", k[2] ?? null);
    add(`deck.${l}.keylock`, "Key lock", g, { type: "toggle" }, "Keeps the pitch steady when you change the tempo.");
    add(`deck.${l}.tempo`, "Tempo", g, cont(-1, 1, 0), "Speeds the track up or down within the tempo range.");
    add(`deck.${l}.key_sync`, "Match key", g, { type: "trigger" }, "Moves this track's key the smallest step that sounds good with the leading deck's key.");
    add(`deck.${l}.grid.set_downbeat`, "Set downbeat", g, { type: "trigger" }, "Tells MixIt a bar starts here: the beat you are on becomes the first beat of a bar.", null, false);
    add(`deck.${l}.grid.halve`, "Halve BPM", g, { type: "trigger" }, "Halves the tempo, for when MixIt counted twice as many beats as the music has.", null, false);
    add(`deck.${l}.grid.double`, "Double BPM", g, { type: "trigger" }, "Doubles the tempo, for when MixIt counted only every other beat.", null, false);
    add(`deck.${l}.grid.nudge_back`, "Shift grid earlier", g, { type: "trigger" }, "Moves the beat lines a tiny bit earlier, so they sit exactly on the kicks.", null, false);
    add(`deck.${l}.grid.nudge_fwd`, "Shift grid later", g, { type: "trigger" }, "Moves the beat lines a tiny bit later, so they sit exactly on the kicks.", null, false);
    add(`deck.${l}.grid.warp`, "Pin beat here", g, { type: "trigger" }, "Pins the nearest beat line to the play head. Use it where the lines drift off the kicks on a track whose tempo wanders.", null, false);
    add(`deck.${l}.grid.unwarp`, "Remove pin", g, { type: "trigger" }, "Takes away the pinned beat nearest the play head, so the beat lines around it go back to an even spacing.", null, false);
    add(`deck.${l}.loop.auto`, "Loop", g, { type: "toggle" }, "Loops the selected number of beats from here, on the beat.", k[7] ?? null);
    add(`deck.${l}.let_end`, "Let it end", g, { type: "trigger" }, "Leaves the safety loop (or any loop) so the track plays out to its end.");
    add(`deck.${l}.loop.halve`, "Halve loop", g, { type: "trigger" }, "Halves the loop length.", k[8] ?? null);
    add(`deck.${l}.loop.double`, "Double loop", g, { type: "trigger" }, "Doubles the loop length.", k[9] ?? null);
    add(`deck.${l}.beatjump.back`, "Beat jump back", g, { type: "trigger" }, "Jumps back by the selected number of beats, staying in time.", k[10] ?? null);
    add(`deck.${l}.beatjump.fwd`, "Beat jump forward", g, { type: "trigger" }, "Jumps forward by the selected number of beats.", k[11] ?? null);
    for (let h = 1; h <= 8; h++) add(`deck.${l}.hotcue.${h}`, `Hot cue ${h}`, g, { type: "momentary" }, "Empty: saves this spot. Set: jumps there instantly.", h <= 4 ? k[2 + h] ?? null : null);
    for (let h = 1; h <= 8; h++) {
      add(`deck.${l}.slice.${h}`, `Slicer pad ${h}`, g, { type: "momentary" }, "Cuts the bar the track is in into 8 slices and plays this one while held, in time. Let go and the track carries on where it would have been.", null, false);
      add(`deck.${l}.roll.${h}`, `Roll ${["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4"][h - 1]}`, g, { type: "momentary" }, "Repeats a short slice while held (a stutter); on release the track carries on as if it never stopped.", null, false);
    }
    for (let h = 1; h <= 8; h++) add(`deck.${l}.keypad.${h}`, `Key pad ${h}`, g, { type: "momentary" }, "Plays from the chosen hot cue in another key, one semitone per pad, so you can play a melody with it.", null, false);
    add(`deck.${l}.keypad.cue`, "Key pad cue", g, { type: "choice", options: ["1", "2", "3", "4", "5", "6", "7", "8"], default: 0 }, "The hot cue the key pads play from. Pressing a hot cue also picks it.", null, false);
    add(`deck.${l}.keypad.range`, "Key pad range", g, { type: "choice", options: ["Low", "Middle", "High"], default: 1 }, "Which keys the 8 pads cover: lower, around the track's own key, or higher.", null, false);
    add(`deck.${l}.slice.size`, "Slicer length", g, { type: "choice", options: ["1 bar", "2 bars", "4 bars"], default: 1 }, "How much music the 8 slicer pads cover: 1, 2 or 4 bars.", null, false);
    for (const [stem, name, what] of [["vocals", "Vocals", "the singing and rapping"], ["drums", "Drums", "the drums and percussion"], ["bass", "Bass", "the bassline"], ["melody", "Melody", "everything else: synths, guitars, pianos, pads"]]) {
      add(`deck.${l}.stem.${stem}`, `${name} level`, g, cont(0, 1, 1), `Turns ${what} of this track up or down. Works once the track is split into stems.`, null, false);
      add(`deck.${l}.stem.${stem}.mute`, `Mute ${name.toLowerCase()}`, g, { type: "toggle" }, `Silences ${what} of this track, and brings them back. Works once the track is split into stems.`);
    }
    add(`deck.${l}.eject`, "Eject", g, { type: "trigger" }, "Unloads the track (only when paused).");
    const m = `Mixer ${l}`;
    add(`mixer.${l}.fader`, "Volume", m, cont(0, 1, 1), "How loud this deck is in the mix.");
    add(`mixer.${l}.eq.high`, "High EQ", m, cont(-26, 6, 0), "Hi-hats and air.");
    add(`mixer.${l}.eq.mid`, "Mid EQ", m, cont(-26, 6, 0), "Vocals, synths and snares.");
    add(`mixer.${l}.eq.low`, "Low EQ", m, cont(-26, 6, 0), "Kick and bass. Cut it on the incoming track so two basslines never clash.");
    add(`mixer.${l}.filter`, "Filter", m, cont(-1, 1, 0), "Left removes highs (muffled, far away); right removes lows (thin, airy). Centre is off.");
    add(`mixer.${l}.trim`, "Gain", m, cont(-12, 12, 0), "Input level, to match loudness between tracks.");
    add(`mixer.${l}.cue`, "Headphone cue", m, { type: "toggle" }, "Sends this channel to your headphones so you can prepare the next track.");
    add(`mixer.${l}.pan`, "Pan", m, cont(-1, 1, 0), "Places this channel left or right in the stereo picture. Centre is straight ahead.", null, false);
    add(`mixer.${l}.punch`, "Punch", m, cont(0, 1, 0), "Evens out loud and quiet moments so the track hits harder and sits steadier in the mix (a compressor). A little goes a long way.", null, false);
    add(`mixer.${l}.warmth`, "Warmth", m, cont(0, 1, 0), "Adds the gentle grit of tape: fuller, denser and rounder peaks, without simply getting louder.", null, false);
    add(`mixer.${l}.width`, "Stereo width", m, cont(0, 2, 1), "Left makes the track narrower (fully left is mono), right makes it wider. Narrow tracks leave room for others.", null, false);
    add(`mixer.${l}.space`, "Space (reverb send)", m, cont(0, 1, 0), "Sends some of this channel into the shared reverb, as if it were played in a bigger room.", null, false);
    add(`mixer.${l}.echo`, "Echo send", m, cont(0, 1, 0), "Sends some of this channel into the shared echo, which repeats in time with the beat.", null, false);
    add(`mixer.${l}.duck_source`, "Duck under", m, { type: "choice", options: ["Off", "Deck A", "Deck B", "Deck C", "Deck D"], default: 0 }, "Which deck this channel gets quieter for. Pick the other deck so its kick and bass come through cleanly.", null, false);
    add(`mixer.${l}.duck`, "Ducking amount", m, cont(0, 1, 0), "How far this channel dips while the deck it ducks under plays.", null, false);
    add(`mixer.${l}.gate`, "Noise gate", m, { type: "toggle" }, "Silences the channel between sounds, removing hiss and hum in the quiet parts.", null, false);
  });
  add("mixer.glue", "Glue", "Mixer", cont(0, 1, 0), "Gently compresses the whole mix so the tracks sound like they belong together, as mastering engineers do.", null, false);
  add("mixer.space.level", "Reverb return", "Mixer", cont(-60, 6, -3), "How loud the shared reverb is in the mix.", null, false);
  add("mixer.space.size", "Reverb size", "Mixer", cont(0, 1, 0.5), "From a small room (left) to a huge hall (right).", null, false);
  add("mixer.echo.level", "Echo return", "Mixer", cont(-60, 6, -3), "How loud the shared echo is in the mix.", null, false);
  add("mixer.echo.feedback", "Echo repeats", "Mixer", cont(0, 1, 0.5), "How many times the echo repeats before it fades away.", null, false);
  add("mixer.echo.time", "Echo time", "Mixer", { type: "choice", options: ["1/4 beat", "1/2 beat", "3/4 beat", "1 beat", "2 beats", "4 beats"], default: 2 }, "How far apart the echoes are, in beats.", null, false);
  add("mixer.crossfader", "Crossfader", "Mixer", cont(-1, 1, 0), "Blends between the left and right decks.");
  add("mixer.master", "Master volume", "Mixer", cont(-120, 6, 0), "The level of the whole mix.");
  add("mixer.bypass", "Hear it plain (A/B)", "Mixer", { type: "toggle" }, "Turns all EQ, filters and effects off at once so you hear the plain music. Turn it off again to hear what your changes did.", "Mod+Shift+B");
  for (let n = 1; n <= 8; n++) add(`sampler.pad.${n}`, `Pad ${n}`, "Sampler", { type: "momentary" }, "Plays this pad's sound: air horns, risers, drum hits or loops on top of your mix.", `Shift+${n}`);
  add("sampler.volume", "Sampler volume", "Sampler", cont(0, 1, 0.8), "Volume of all pads.");
  add("mic.on_air", "Mic on", "Mic", { type: "toggle" }, "Lets the audience hear your mic. Wear headphones: speakers near the mic make it howl.", "Mod+Shift+M");
  add("mic.level", "Mic volume", "Mic", cont(0, 1, 0.8), "How loud your mic is in the mix.");
  add("mic.gain", "Mic gain", "Mic", cont(-20, 30, 0), "Boosts a quiet mic. Set it so your voice moves the meter well into the green when you talk.", null, false);
  add("mic.cue", "Mic in headphones", "Mic", { type: "toggle" }, "Lets you hear your mic in your headphones, to check it before going on.", null, false);
  add("mic.talkover", "Talk-over", "Mic", { type: "toggle" }, "Turns the music down by itself while you speak, and back up when you stop.");
  add("mic.talkover_depth", "Talk-over amount", "Mic", cont(-30, 0, -12), "How far the music goes down while you speak.", null, false);
  add("mic.eq.high", "Mic high EQ", "Mic", cont(-26, 6, 0), "Adds or removes brightness and hiss.", null, false);
  add("mic.eq.mid", "Mic mid EQ", "Mic", cont(-26, 6, 0), "Adds or removes the body of your voice. Turn it up to cut through loud music.", null, false);
  add("mic.eq.low", "Mic low EQ", "Mic", cont(-26, 6, 0), "Adds or removes boom. Turn it down if you sound muffled.", null, false);
  add("mic.low_cut", "Low cut", "Mic", { type: "toggle" }, "Removes rumble, wind and thumps from touching the mic. Leave it on for voice; off for a turntable.", null, false);
  add("mic.gate", "Cut background noise", "Mic", { type: "toggle" }, "Keeps the mic quiet between words, so fans and room noise stay out of the mix.", null, false);
  add("mic.mono", "Mono", "Mic", { type: "toggle" }, "Uses one voice on both speakers. Leave it on for a mic; turn it off for a stereo source like a turntable.", null, false);
  add("mic.record", "Record the mic", "Mic", { type: "toggle" }, "Records what comes in on the mic, to put on a sampler pad or keep in your library as a track.");
  add("sampler.stop_all", "Stop all pads", "Sampler", { type: "trigger" }, "Stops every pad that is playing, including loops.", null, false);
  add("app.save", "Save mix project", "App", { type: "trigger" }, "Saves the mix project you are arranging.", "Mod+S");
  add("app.save_as", "Save mix project as", "App", { type: "trigger" }, "Saves the mix project under a new name.", "Mod+Shift+S", false);
  add("app.open", "Open mix project", "App", { type: "trigger" }, "Opens a saved mix project in Arrange.", "Mod+O");
  add("app.sampler", "Sampler pads", "App", { type: "toggle" }, "Shows or hides the sampler pads in the tools panel under the decks.", "Mod+P");
  add("app.tools", "Tools panel", "App", { type: "toggle" }, "Shows or tucks away the tools panel under the decks: pads, step sequencer, effects, mic and recording.", "Mod+Shift+T");
  add("app.tools_full", "Tools full screen", "App", { type: "toggle" }, "Gives the tools panel the whole screen under the waveforms, or puts it back beside the library.", "Mod+Shift+F");
  add("app.guide", "Guide and practice labs", "App", { type: "toggle" }, "Opens the built-in guide: what each part of DJing means, step-by-step practice labs, and fixes for common problems.", "Mod+G");
  add("app.sequencer", "Step sequencer", "App", { type: "toggle" }, "Plays the sampler pads in a looping pattern that follows the beat. Opens the sequencer and starts or stops it.", null);
  add("app.autodj", "Auto DJ", "App", { type: "toggle" }, "Mixes a queue of tracks for you, choosing where and how to mix each one, and explains every choice.", null);
  add("app.mix_it", "Mix it", "App", { type: "trigger" }, "Runs a whole transition into the other deck on the beat, picking the transition, length and key shift the way Auto DJ does.", "T");
  add("app.hear_mix", "Hear the mix first", "App", { type: "trigger" }, "Plays the coming mix in your headphones before the audience hears it: Auto DJ's next mix, or what Mix it would do now.", "H");
  add("app.mix_now", "Mix now", "App", { type: "trigger" }, "Starts Auto DJ's next mix right away instead of waiting for the planned point.", null);
  add("app.rehearse_set", "Rehearse the set", "App", { type: "trigger" }, "Plays every change in the Auto DJ queue one after another in your headphones, a few bars either side of each.", null);
  add("app.make_mix", "Make a mix from the queue", "App", { type: "trigger" }, "Turns the Auto DJ queue into a finished mix in Arrange, every change as Auto DJ would do it, ready to render.", null);
  add("app.best_order", "Best order for the queue", "App", { type: "trigger" }, "Reorders the Auto DJ queue so every change is as easy to mix as it can be, with the energy going your way.", null);
  add("app.save_queue", "Save the queue as a playlist", "App", { type: "trigger" }, "Keeps the Auto DJ queue as a playlist in its order, to play again or share.", null);
  add("app.assistant", "Mix assistant", "App", { type: "toggle" }, "Listens to your mix and tells you what to fix (clashing bass, clipping, loudness, harsh or muddy tone), with a button that fixes it.", null);
  add("app.tour", "Take the 2-minute tour", "App", { type: "trigger" }, "Walks you through your first mix: play two tracks in time and blend from one into the other.", null);
  add("app.feedback", "Mix feedback", "App", { type: "trigger" }, "Shows how your last recorded mix went: what went well, what to work on, and every transition checked.", null);
  add("app.edit_track", "Edit track", "App", { type: "trigger" }, "Opens the track editor for the selected deck: fix the beat grid, name and colour cues, choose where the track starts, and turn a passage into a loop or a sampler pad.", "Mod+Shift+E");
  add("global.record", "Record", "Global", { type: "toggle" }, "Records your mix to a WAV file.", "Mod+R");
  add("global.safety_loop", "Safety loop", "Global", { type: "toggle" }, "When the only track playing is about to end and nothing is mixed in, its last bars loop on the beat so the music never stops.");
  add("app.palette", "Command palette", "App", { type: "trigger" }, "Search every action.", "Mod+K");
  add("app.clip_copy", "Copy clips", "App", { type: "trigger" }, "Copies the selected clips in Arrange, to paste somewhere else in the mix.", "Mod+C");
  add("app.clip_cut", "Cut clips", "App", { type: "trigger" }, "Removes the selected clips in Arrange and keeps them to paste.", "Mod+X");
  add("app.clip_paste", "Paste clips", "App", { type: "trigger" }, "Pastes copied clips in Arrange at the play marker, keeping their spacing and moves.", "Mod+V");
  add("app.clip_duplicate", "Duplicate clips", "App", { type: "trigger" }, "Copies the selected clips in Arrange to just after themselves, to repeat a section.", "Mod+D");
  add("app.clip_delete", "Delete clips", "App", { type: "trigger" }, "Removes the selected clips from the mix in Arrange.", "Delete");
  add("app.clip_split", "Cut clip in two", "App", { type: "trigger" }, "Cuts the selected clips (or every clip under the play marker) in two at the marker.", "Mod+B");
  add("app.select_all", "Select all clips", "App", { type: "trigger" }, "Selects every clip in Arrange.", "Mod+A");
  add("app.marker_add", "Add marker", "App", { type: "trigger" }, "Adds a named marker on the Arrange ruler at the play marker, like Drop or Outro.", null);
  add("app.marker_next", "Next marker", "App", { type: "trigger" }, "Moves the play marker to the next marker on the Arrange ruler.", null);
  add("app.marker_prev", "Previous marker", "App", { type: "trigger" }, "Moves the play marker to the previous marker on the Arrange ruler.", null);
  add("app.preview", "Preview track", "App", { type: "trigger" }, "Plays the selected library track in your headphones without loading it on a deck, so you can check it while the music plays. Press again to stop.", "P");
  add("app.arrange_loop", "Loop playback", "App", { type: "trigger" }, "Repeats a stretch of the mix in Arrange while you adjust it.", "L");
  add("app.arrange_play", "Play or stop the mix", "App", { type: "trigger" }, "Plays the Arrange timeline from the play marker, or stops it.", "Space");
  add("app.undo", "Undo", "App", { type: "trigger" }, "Undoes the last change.", "Mod+Z");
  add("app.redo", "Redo", "App", { type: "trigger" }, "Redoes the last undone change.", "Mod+Shift+Z");
  add("app.view_mode", "Easy / Pro view", "App", { type: "toggle" }, "Switches between the simple and the full interface.", "Mod+E");
  add("app.explain", "Explain mode", "App", { type: "momentary" }, "Shows what every control does.", "F1");
  add("app.settings", "Settings", "App", { type: "trigger" }, "Audio device, keys and preferences.", "Mod+,");
  add("app.coach", "Coach", "App", { type: "toggle" }, "Tips while you mix.");
  return out;
}

/** An abstract cover for a demo track: two colours and rings, picked from the title. */
export function demoCover(title: string, artist: string): string {
  let h = 2166136261;
  for (const c of `${title}|${artist}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const hue = h % 360;
  const hue2 = (hue + 40 + ((h >> 9) % 120)) % 360;
  const rings = 3 + ((h >> 3) % 4);
  const cx = 30 + ((h >> 5) % 40);
  const cy = 30 + ((h >> 11) % 40);
  const circles = Array.from({ length: rings }, (_, i) => `<circle cx="${cx}" cy="${cy}" r="${12 + i * 14}" fill="none" stroke="white" stroke-opacity="${0.35 - i * 0.05}" stroke-width="${2 + (i % 2) * 3}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue2} 75% 22%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>${circles}</svg>`;
}
