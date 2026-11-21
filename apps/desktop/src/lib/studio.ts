// Studio strips on the UI side: defaults and one-knob mappings that match the engine
// (mixit-dsp `CompressorSettings::punch` / `::glue`), the EQ curve for drawing, and
// presets in plain words.
import type { BandDto, BandShape, CompDto, StudioDto } from "../backend/types";

export const MAX_BANDS = 8;
/** Range of the EQ display and spectrum (Hz). */
export const EQ_RANGE: [number, number] = [20, 20_000];
/** Saturation drive at warmth 1 (dB), and ducking depth at amount 1 (dB). */
export const WARMTH_MAX_DB = 24;
export const DUCK_MAX_DB = 24;

export const defaultBand = (): BandDto => ({ enabled: false, shape: "bell", freq: 1000, q: Math.SQRT1_2, gainDb: 0, slopeDb: 12 });

export function punchComp(amount: number): CompDto {
  const a = Math.max(0, Math.min(1, amount));
  return { thresholdDb: -6 - 24 * a, ratio: 1.5 + 4.5 * a, kneeDb: 6, attackMs: 15, releaseMs: 120, makeupDb: 0, autoMakeup: true, sidechainHpfHz: 60, mix: 1 };
}

export function glueComp(amount: number): CompDto {
  const a = Math.max(0, Math.min(1, amount));
  return { thresholdDb: -4 - 16 * a, ratio: 2, kneeDb: 6, attackMs: 30, releaseMs: 200, makeupDb: 0, autoMakeup: true, sidechainHpfHz: 90, mix: 1 };
}

export function defaultStudio(): StudioDto {
  return {
    gateOn: false,
    gate: { thresholdDb: -40, hysteresisDb: 4, attackMs: 1, holdMs: 30, releaseMs: 100, rangeDb: -80 },
    eqOn: true,
    bands: Array.from({ length: MAX_BANDS }, defaultBand),
    compOn: false,
    comp: punchComp(0.5),
    satOn: false,
    driveDb: 6,
    width: 1,
    outputDb: 0,
  };
}

/** Where a new band goes, so the eight bands start spread over the range. */
export const BAND_SLOTS: { shape: BandShape; freq: number }[] = [
  { shape: "lowCut", freq: 30 },
  { shape: "lowShelf", freq: 100 },
  { shape: "bell", freq: 250 },
  { shape: "bell", freq: 800 },
  { shape: "bell", freq: 2500 },
  { shape: "bell", freq: 6000 },
  { shape: "highShelf", freq: 10_000 },
  { shape: "highCut", freq: 18_000 },
];

// ------------------------------------------------------------------ EQ curve

/** RBJ cookbook biquad magnitude (dB) at `f`, the same designs the engine draws with. */
function biquadDb(shape: BandShape, f0: number, q: number, gainDb: number, f: number, sr: number): number {
  const w0 = (2 * Math.PI * Math.min(f0, sr * 0.49)) / sr;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sw / (2 * Math.max(0.05, q));
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (shape) {
    case "lowCut":
      [b0, b1, b2, a0, a1, a2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case "highCut":
      [b0, b1, b2, a0, a1, a2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case "notch":
      [b0, b1, b2, a0, a1, a2] = [1, -2 * cw, 1, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case "bandPass":
      [b0, b1, b2, a0, a1, a2] = [alpha, 0, -alpha, 1 + alpha, -2 * cw, 1 - alpha];
      break;
    case "lowShelf": {
      const k = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2] = [A * (A + 1 - (A - 1) * cw + k), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - k)];
      [a0, a1, a2] = [A + 1 + (A - 1) * cw + k, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - k];
      break;
    }
    case "highShelf": {
      const k = 2 * Math.sqrt(A) * alpha;
      [b0, b1, b2] = [A * (A + 1 + (A - 1) * cw + k), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - k)];
      [a0, a1, a2] = [A + 1 - (A - 1) * cw + k, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - k];
      break;
    }
    default:
      [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw, 1 - alpha / A];
  }
  const w = (2 * Math.PI * f) / sr;
  const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  const mag2 = (nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di);
  return 10 * Math.log10(Math.max(1e-30, mag2));
}

const sections = (b: BandDto) => (b.shape === "lowCut" || b.shape === "highCut" ? Math.max(1, Math.min(4, Math.round(b.slopeDb / 12))) : 1);

/** Response of one band (dB) at `f`. */
export function bandDb(b: BandDto, f: number, sr = 48_000): number {
  if (!b.enabled) return 0;
  return biquadDb(b.shape, b.freq, b.q, b.gainDb, f, sr) * sections(b);
}

/** Response of the whole EQ (dB) at `f`. */
export function eqDb(s: StudioDto, f: number, sr = 48_000): number {
  if (!s.eqOn) return 0;
  return s.bands.reduce((a, b) => a + bandDb(b, f, sr), 0);
}

/** Whether a shape has a gain (cuts, notches and band-passes do not). */
export const hasGain = (shape: BandShape) => shape === "bell" || shape === "lowShelf" || shape === "highShelf";

/** Log position (0..1) of a frequency on the display, and back. */
export const freqToX = (f: number) => Math.log(f / EQ_RANGE[0]) / Math.log(EQ_RANGE[1] / EQ_RANGE[0]);
export const xToFreq = (x: number) => EQ_RANGE[0] * Math.pow(EQ_RANGE[1] / EQ_RANGE[0], Math.max(0, Math.min(1, x)));

export function fmtHz(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(f >= 10_000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`;
}

// ------------------------------------------------------------------ presets

export interface StudioPreset {
  id: string;
  name: string;
  /** What it does, in plain words. */
  hint: string;
  /** Applies to a channel, the master, or both. */
  for: "channel" | "master" | "both";
  apply: (s: StudioDto) => StudioDto;
}

const withBands = (s: StudioDto, bands: Partial<BandDto>[]): StudioDto => {
  const out = { ...s, eqOn: true, bands: s.bands.map((b) => ({ ...b })) };
  for (const nb of bands) {
    // Reuse a free band.
    const i = out.bands.findIndex((b) => !b.enabled);
    if (i < 0) break;
    out.bands[i] = { ...defaultBand(), ...nb, enabled: true };
  }
  return out;
};

export const STUDIO_PRESETS: StudioPreset[] = [
  {
    id: "clean",
    name: "Start clean",
    hint: "Turns everything in this strip off.",
    for: "both",
    apply: () => defaultStudio(),
  },
  {
    id: "fuller-bass",
    name: "Fuller bass",
    hint: "A warm lift under 100 Hz, and rumble below 30 Hz removed so the lift stays tight.",
    for: "channel",
    apply: (s) => withBands(s, [{ shape: "lowCut", freq: 28, slopeDb: 24, q: Math.SQRT1_2 }, { shape: "lowShelf", freq: 90, gainDb: 3, q: 0.7 }]),
  },
  {
    id: "make-room",
    name: "Make room for the other deck",
    hint: "Thins this track's bass and low mids so another track's bass can sit underneath. Use it on the track that is fading out.",
    for: "channel",
    apply: (s) => withBands(s, [{ shape: "lowCut", freq: 120, slopeDb: 12, q: Math.SQRT1_2 }, { shape: "bell", freq: 300, gainDb: -3, q: 1 }]),
  },
  {
    id: "clearer-vocals",
    name: "Clearer vocals",
    hint: "Less boxiness around 350 Hz and a little more presence around 3 kHz, where words are understood.",
    for: "channel",
    apply: (s) => withBands(s, [{ shape: "bell", freq: 350, gainDb: -3, q: 1.2 }, { shape: "bell", freq: 3200, gainDb: 2.5, q: 0.9 }]),
  },
  {
    id: "tame-harsh",
    name: "Tame harshness",
    hint: "Softens a piercing 2 to 5 kHz region and the very top, for bright or loud masters.",
    for: "both",
    apply: (s) => withBands(s, [{ shape: "bell", freq: 3500, gainDb: -2.5, q: 1.4 }, { shape: "highShelf", freq: 12_000, gainDb: -2, q: 0.7 }]),
  },
  {
    id: "warm-round",
    name: "Warm and round",
    hint: "Tape warmth and a gentle top roll-off, for thin or digital-sounding tracks.",
    for: "both",
    apply: (s) => ({ ...withBands(s, [{ shape: "highShelf", freq: 9000, gainDb: -1.5, q: 0.7 }]), satOn: true, driveDb: 9 }),
  },
  {
    id: "punchy-drums",
    name: "Punchy drums",
    hint: "A compressor that lets the drum hits through, then holds the body up.",
    for: "channel",
    apply: (s) => ({ ...s, compOn: true, comp: { ...punchComp(0.6), attackMs: 25, releaseMs: 90 } }),
  },
  {
    id: "radio-voice",
    name: "Radio voice",
    hint: "For a mic or a talk track: no rumble, steady level, a little presence.",
    for: "channel",
    apply: (s) => ({
      ...withBands(s, [{ shape: "lowCut", freq: 90, slopeDb: 24, q: Math.SQRT1_2 }, { shape: "bell", freq: 4000, gainDb: 3, q: 0.8 }]),
      compOn: true,
      comp: { ...punchComp(0.8), attackMs: 5, releaseMs: 150 },
    }),
  },
  {
    id: "mono-bass",
    name: "Narrow",
    hint: "Makes the track narrower, leaving the sides of the stereo picture for other tracks.",
    for: "channel",
    apply: (s) => ({ ...s, width: 0.6 }),
  },
  {
    id: "master-glue",
    name: "Glue the mix",
    hint: "A gentle 2:1 compressor over everything, so separate tracks sound like one mix.",
    for: "master",
    apply: (s) => ({ ...s, compOn: true, comp: glueComp(0.5) }),
  },
  {
    id: "master-polish",
    name: "Polish",
    hint: "Glue, a little air on top, and no sub-rumble: a safe start for a recorded mix.",
    for: "master",
    apply: (s) => ({
      ...withBands(s, [{ shape: "lowCut", freq: 25, slopeDb: 24, q: Math.SQRT1_2 }, { shape: "highShelf", freq: 12_000, gainDb: 1.5, q: 0.7 }]),
      compOn: true,
      comp: glueComp(0.4),
    }),
  },
];

/** Loudness targets for the master (integrated LUFS). */
export const LOUDNESS_TARGETS: { id: string; name: string; lufs: number; hint: string }[] = [
  { id: "streaming", name: "Streaming", lufs: -14, hint: "Spotify, YouTube, SoundCloud and Tidal turn louder mixes down to about −14, so going louder only loses punch." },
  { id: "apple", name: "Apple Music", lufs: -16, hint: "Apple Music plays at about −16." },
  { id: "club", name: "Club", lufs: -9, hint: "Loud and dense, for playing through a club system. Uploads will be turned down." },
  { id: "podcast", name: "Podcast / radio", lufs: -16, hint: "Speech-friendly level, the usual target for podcasts." },
];
