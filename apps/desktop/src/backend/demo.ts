// An in-browser stand-in for the Rust backend: a generated library, simulated decks
// (tempo, sync, loops, cues, meters) and jobs. It lets the UI run in any browser for
// development and tests, and is the starting point of the web version.

import type { Backend, Unlisten } from "./index";
import type * as T from "./types";
import { bestShift, compatibility, keyDto, keyFromIndex, transpose } from "../lib/keys";

const SR = 48_000;
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

interface DemoTrack {
  row: T.TrackRow;
  sections: T.SectionDto[];
  firstBeat: number;
  period: number;
  wave: Uint8Array;
  cues: T.CueDto[];
}

function makeTrack(id: number): DemoTrack {
  const r = rng(id * 7919);
  const [genre, lo, hi] = GENRES[Math.floor(r() * GENRES.length)];
  const bpm = Math.round((lo + r() * (hi - lo)) * 2) / 2;
  const key = keyFromIndex(Math.floor(r() * 24));
  const bars = [16, 16, 32, 16, 32, 16].map((b) => (r() < 0.3 ? b / 2 : b));
  const labels = ["Intro", "Build", "Drop", "Breakdown", "Drop", "Outro"];
  const period = 60 / bpm;
  const firstBeat = r() < 0.4 ? 0.05 + r() * 0.4 : 0.02;
  const sections: T.SectionDto[] = [];
  let t = firstBeat;
  const energies = [0.35, 0.6, 1, 0.3, 1, 0.4];
  bars.forEach((b, i) => {
    const len = b * 4 * period;
    sections.push({ start: t, end: t + len, bars: b, label: labels[i], energy: energies[i] });
    t += len;
  });
  const duration = t + 2;
  const title = `${WORDS[Math.floor(r() * WORDS.length)]}${r() < 0.3 ? ` (${["Extended Mix", "Club Mix", "Dub", "Original Mix"][Math.floor(r() * 4)]})` : ""}`;
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
  return {
    row: {
      id,
      path: `/Music/${genre}/${title}.flac`,
      title,
      artist: ARTISTS[Math.floor(r() * ARTISTS.length)],
      album: "",
      genre,
      label: ["Night Shift", "Lumen", "Coastline", "Free Form"][Math.floor(r() * 4)],
      year: 2018 + Math.floor(r() * 8),
      duration,
      bpm,
      key: keyDto(key),
      energy,
      lufs: -9 - r() * 4,
      rating: r() < 0.3 ? 4 + Math.round(r()) : Math.floor(r() * 4),
      color: null,
      playCount: Math.floor(r() * 12),
      lastPlayed: null,
      addedAt: 1_700_000_000 + id * 86_400,
      missing: false,
      analysis: "done",
      comment: "",
    },
    sections,
    firstBeat,
    period,
    wave,
    cues,
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
    loopSize: 4,
    jump: 4,
    hot: Array(16).fill(null),
    nudge: 0,
    fader: 1,
    eq: [0, 0, 0],
    filter: 0,
    trim: 0,
    slip: false,
  };
}

type Listener<P> = (p: P) => void;

const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const JUMP_SIZES = [1, 2, 4, 8, 16, 32];
const RANGES = [0.06, 0.08, 0.1, 0.16, 0.5, 1];

export class DemoBackend implements Backend {
  readonly kind = "demo" as const;
  private tracks: DemoTrack[] = [];
  private decks: SimDeck[] = Array.from({ length: DECKS }, deckState);
  private master: number | null = null;
  private crossfader = 0;
  private masterDb = 0;
  private recording = false;
  private recorded = 0;
  private pads: T.PadInfo[] = defaultPads();
  /** Pad index to performance.now() when it stops (Infinity while looping or held). */
  private padEnds = new Map<number, number>();
  private listeners = new Map<string, Set<Listener<unknown>>>();
  private settings: T.Settings = {
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
  };
  private playlistsData: (T.PlaylistDto & { tracks: number[] })[] = [];
  private historyData: T.HistoryEntry[] = [];
  private token = 1;
  private frame = 0;
  private last = performance.now();
  private registry: T.ActionSpec[] = [];

  constructor() {
    for (let i = 1; i <= 120; i++) this.tracks.push(makeTrack(i));
    const pick = (n: number, off: number) => this.tracks.slice(off, off + n).map((t) => t.row.id);
    this.playlistsData = [
      { id: 1, parent: null, name: "Warm-up", kind: "list", query: null, count: 0, duration: 0, tracks: pick(12, 0) },
      { id: 2, parent: null, name: "Peak time", kind: "list", query: null, count: 0, duration: 0, tracks: pick(15, 20) },
      { id: 3, parent: null, name: "Fresh & unplayed", kind: "smart", query: "played:never energy:>5", count: 0, duration: 0, tracks: [] },
      { id: 4, parent: null, name: "Around 124", kind: "smart", query: "bpm:~124", count: 0, duration: 0, tracks: [] },
    ];
    setInterval(() => this.tick(), 16);
  }

  private emit<P>(event: string, payload: P) {
    this.listeners.get(event)?.forEach((cb) => cb(payload));
  }

  private on<P>(event: string, cb: Listener<P>): Unlisten {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb as Listener<unknown>);
    return () => this.listeners.get(event)?.delete(cb as Listener<unknown>);
  }

  private find(id: number): DemoTrack {
    const t = this.tracks.find((x) => x.row.id === id);
    if (!t) throw new Error(`no track ${id}`);
    return t;
  }

  private baseBpm(d: SimDeck) {
    return d.track?.row.bpm ?? 120;
  }

  private rate(i: number): number {
    const d = this.decks[i];
    const m = this.master;
    if (d.sync && m !== null && m !== i && this.decks[m].track) {
      const md = this.decks[m];
      const target = this.baseBpm(md) * (1 + md.tempo * md.range);
      return target / this.baseBpm(d) + d.nudge * 0.04;
    }
    return 1 + d.tempo * d.range + d.nudge * 0.04;
  }

  private beatAt(d: SimDeck, pos: number) {
    if (!d.track) return 0;
    return (pos - d.track.firstBeat) / d.track.period;
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frame += Math.round(dt * SR);
    if (this.recording) this.recorded += dt;
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
      };
    });
    const mix = tele.reduce((a, d, i) => {
      const x = this.crossfader;
      const side = i % 2 === 0 ? Math.min(1, 1 - x) : Math.min(1, 1 + x);
      return a + d.peak[0] * this.decks[i].fader * this.decks[i].fader * side;
    }, 0);
    const m = Math.min(1.2, mix) * Math.pow(10, this.masterDb / 20);
    const limited = Math.min(m, 0.98);
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
        cuePeak: [0, 0],
        clipped: false,
      },
      clockBpm: this.master !== null ? tele[this.master].bpm : 124,
      masterDeck: this.master,
      recording: this.recording,
      recordedSeconds: this.recorded,
      load: 0.08 + Math.random() * 0.02,
      overruns: 0,
      samplerPlaying: this.samplerMask(),
    });
  }

  private detail(t: DemoTrack): T.TrackDetail {
    return {
      track: t.row,
      analysed: true,
      bpm: t.row.bpm,
      bpmCandidates: [t.row.bpm!, t.row.bpm! / 2],
      tempoConfidence: 0.92,
      driftMs: 0.8,
      constantGrid: true,
      beatsPerBar: 4,
      firstBeat: t.firstBeat,
      beatPeriod: t.period,
      beats: [],
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
    };
  }

  private saved = new Map<number, T.CueDto[]>();
  private savedCues(t: DemoTrack): T.CueDto[] {
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
      } else if (p[1] === "crossfader") this.crossfader = value;
      else if (p[1] === "master") this.masterDb = value;
    } else if (id === "global.record" && press) {
      this.recording = !this.recording;
    }
  }

  private snap(d: SimDeck, pos: number) {
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

  async setHotCue(deck: number, slot: number, seconds: number, loopSeconds?: number | null, color?: number) {
    const d = this.decks[deck];
    if (!d.track) return;
    const palette = [0xef4444, 0xf97316, 0xeab308, 0x22c55e, 0x06b6d4, 0x3b82f6, 0x8b5cf6, 0xec4899];
    const cue: T.CueDto = { role: "hot", slot, seconds, loopSeconds: loopSeconds ?? null, label: "", color: color ?? palette[slot % 8] };
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
    return demoSearch(this.tracks.map((t) => t.row), query).slice(0, limit);
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

  async suggestNext(trackId: number, energy: "steady" | "up" | "down", limit = 30): Promise<T.SuggestionRow[]> {
    const cur = this.find(trackId).row;
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
      out.push({ track: c, score: Math.min(1, score), tempoChangePct: best.pct, keyShift: shift, reasons, tags });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
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
  async deletePlaylist(id: number) {
    this.playlistsData = this.playlistsData.filter((p) => p.id !== id);
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
  async orderPlaylist(id: number) {
    const p = this.playlistsData.find((x) => x.id === id);
    if (!p) return;
    p.tracks.sort((a, b) => (this.find(a).row.key?.index ?? 0) - (this.find(b).row.key?.index ?? 0));
  }
  async history() {
    return this.historyData;
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
  async recordStart() {
    this.recording = true;
    this.recorded = 0;
    return "~/Music/MixIt/Recordings/demo.wav";
  }
  async recordStop() {
    this.recording = false;
    return "~/Music/MixIt/Recordings/demo.wav";
  }

  async automix(tracks: number[], options: T.AutomixRequest): Promise<T.MixProject> {
    const rows = tracks.map((i) => this.find(i));
    const bpm = rows[0].row.bpm ?? 124;
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
        track: { hash: null, path: t.row.path, title: t.row.title, artist: t.row.artist, bpm: t.row.bpm ?? 0, key: null, duration: t.row.duration },
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
  async saveProject() {}
  async openProject(): Promise<T.MixProject> {
    throw new Error("Opening files needs the desktop app.");
  }
  async checkProject() {
    return [];
  }
  async renderProject() {
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
      for (const c of project.clips) {
        if (beat < c.start || beat >= c.start + c.length) continue;
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

  private samplerMask(): number {
    const now = performance.now();
    let m = 0;
    for (const [pad, end] of this.padEnds) {
      if (end > now) m |= 1 << pad;
      else this.padEnds.delete(pad);
    }
    return m;
  }

  private samplerAction(p: string[], input: T.ActionInput) {
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
      const name = source.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Sound";
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

  async importRekordbox() {}
  async exportRekordbox() {}
  async exportPlaylist() {}
  async importM3u() {
    return 0;
  }

  async pickFolders() {
    return ["~/Music/New"];
  }
  async pickFiles() {
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

/** A subset of the library search language, enough for the demo. */
export function demoSearch(rows: T.TrackRow[], query: string): T.TrackRow[] {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  let out = rows;
  let sort: ((a: T.TrackRow, b: T.TrackRow) => number) | null = null;
  for (const raw of terms) {
    const neg = raw.startsWith("-");
    const term = neg ? raw.slice(1) : raw;
    const [field, val] = term.includes(":") ? term.split(/:(.*)/s) : [null, term];
    let f: (t: T.TrackRow) => boolean;
    const num = (v: number | null, spec: string) => {
      if (v == null) return false;
      if (spec.startsWith("~")) return Math.abs(v / Number(spec.slice(1)) - 1) <= 0.06 || Math.abs(v / 2 / Number(spec.slice(1)) - 1) <= 0.06 || Math.abs((v * 2) / Number(spec.slice(1)) - 1) <= 0.06;
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
      case "played":
        f = (t) => (val === "never" ? t.playCount === 0 : t.playCount > 0);
        break;
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
  return out;
}

/** The registry as the Rust side builds it, for the demo (decks A–D, common controls). */
const DEMO_KIT: T.KitSound[] = [
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
];
const KIT_SECONDS: Record<string, number> = { kick: 0.5, clap: 0.38, air_horn: 1.35, siren: 2.4, riser: 3.87, impact: 2.8, laser: 0.46, drum_loop: 1.94, snare_build: 3.87, scratch: 0.6, hat_loop: 1.94, sub_drop: 2 };

function emptyPad(pad: number): T.PadInfo {
  return { pad, name: "", source: { type: "empty" }, seconds: 0, bpm: null, mode: 0, gainDb: 0, pan: 0, sync: true, quantized: false, color: 0x52525b, error: null };
}

function kitPad(pad: number, id: string): T.PadInfo {
  const k = DEMO_KIT.find((x) => x.id === id) ?? DEMO_KIT[0];
  return { ...emptyPad(pad), name: k.name, source: { type: "kit", id: k.id }, seconds: KIT_SECONDS[k.id] ?? 1, bpm: k.bpm, mode: k.mode, color: k.color };
}

function defaultPads(): T.PadInfo[] {
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
    add(`deck.${l}.sync`, "Sync", g, { type: "toggle" }, "Matches this deck's tempo and beat phase to the master deck.", k[2] ?? null);
    add(`deck.${l}.keylock`, "Key lock", g, { type: "toggle" }, "Keeps the pitch steady when you change the tempo.");
    add(`deck.${l}.tempo`, "Tempo", g, cont(-1, 1, 0), "Speeds the track up or down within the tempo range.");
    add(`deck.${l}.key_sync`, "Match key", g, { type: "trigger" }, "Shifts this deck's key to fit the other deck.");
    add(`deck.${l}.loop.auto`, "Loop", g, { type: "toggle" }, "Loops the selected number of beats from here, on the beat.", k[7] ?? null);
    add(`deck.${l}.loop.halve`, "Halve loop", g, { type: "trigger" }, "Halves the loop length.", k[8] ?? null);
    add(`deck.${l}.loop.double`, "Double loop", g, { type: "trigger" }, "Doubles the loop length.", k[9] ?? null);
    add(`deck.${l}.beatjump.back`, "Beat jump back", g, { type: "trigger" }, "Jumps back by the selected number of beats, staying in time.", k[10] ?? null);
    add(`deck.${l}.beatjump.fwd`, "Beat jump forward", g, { type: "trigger" }, "Jumps forward by the selected number of beats.", k[11] ?? null);
    for (let h = 1; h <= 8; h++) add(`deck.${l}.hotcue.${h}`, `Hot cue ${h}`, g, { type: "momentary" }, "Empty: saves this spot. Set: jumps there instantly.", h <= 4 ? k[2 + h] ?? null : null);
    add(`deck.${l}.eject`, "Eject", g, { type: "trigger" }, "Unloads the track (only when paused).");
    const m = `Mixer ${l}`;
    add(`mixer.${l}.fader`, "Volume", m, cont(0, 1, 1), "The channel's volume fader.");
    add(`mixer.${l}.eq.high`, "High EQ", m, cont(-26, 6, 0), "Hi-hats and air.");
    add(`mixer.${l}.eq.mid`, "Mid EQ", m, cont(-26, 6, 0), "Vocals, synths and snares.");
    add(`mixer.${l}.eq.low`, "Low EQ", m, cont(-26, 6, 0), "Kick and bass. Cut it on the incoming track so two basslines never clash.");
    add(`mixer.${l}.filter`, "Filter", m, cont(-1, 1, 0), "Left: low-pass (muffled). Right: high-pass (thin). Centre: off.");
    add(`mixer.${l}.trim`, "Gain", m, cont(-12, 12, 0), "Input level, to match loudness between tracks.");
    add(`mixer.${l}.cue`, "Headphone cue", m, { type: "toggle" }, "Sends this channel to your headphones so you can prepare the next track.");
  });
  add("mixer.crossfader", "Crossfader", "Mixer", cont(-1, 1, 0), "Blends between the left and right decks.");
  add("mixer.master", "Master volume", "Mixer", cont(-120, 6, 0), "The level of the whole mix.");
  for (let n = 1; n <= 8; n++) add(`sampler.pad.${n}`, `Pad ${n}`, "Sampler", { type: "momentary" }, "Plays this pad's sound: air horns, risers, drum hits or loops on top of your mix.", `Shift+${n}`);
  add("sampler.volume", "Sampler volume", "Sampler", cont(0, 1, 0.8), "Volume of all pads.");
  add("sampler.stop_all", "Stop all pads", "Sampler", { type: "trigger" }, "Stops every pad that is playing, including loops.", null, false);
  add("app.sampler", "Sampler and master FX", "App", { type: "toggle" }, "Shows or hides the sampler pads and the effects on the whole mix.", "Mod+P");
  add("global.record", "Record", "Global", { type: "toggle" }, "Records your mix to a WAV file.", "Mod+R");
  add("app.palette", "Command palette", "App", { type: "trigger" }, "Search every action.", "Mod+K");
  add("app.undo", "Undo", "App", { type: "trigger" }, "Undoes the last change.", "Mod+Z");
  add("app.redo", "Redo", "App", { type: "trigger" }, "Redoes the last undone change.", "Mod+Shift+Z");
  add("app.view_mode", "Easy / Pro view", "App", { type: "toggle" }, "Switches between the simple and the full interface.", "Mod+E");
  add("app.explain", "Explain mode", "App", { type: "momentary" }, "Shows what every control does.", "F1");
  add("app.settings", "Settings", "App", { type: "trigger" }, "Audio device, keys and preferences.", "Mod+,");
  add("app.coach", "Coach", "App", { type: "toggle" }, "Tips while you mix.");
  return out;
}
