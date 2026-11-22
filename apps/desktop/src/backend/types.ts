// Mirrors apps/desktop/src-tauri/src/dto.rs and the library/engine types it exposes.

export interface KeyDto {
  /** 0..23: C major = 0 … B major = 11, C minor = 12 … B minor = 23. */
  index: number;
  camelot: string;
  openKey: string;
  name: string;
}

export interface TrackRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  label: string;
  year: number | null;
  duration: number;
  bpm: number | null;
  key: KeyDto | null;
  energy: number | null;
  lufs: number | null;
  rating: number;
  color: number | null;
  playCount: number;
  lastPlayed: number | null;
  addedAt: number;
  missing: boolean;
  analysis: "pending" | "done" | "failed";
  comment: string;
}

/** One of your own tags ("vocal", "peak time"), with how many tracks carry it. */
export interface TagDto {
  id: number;
  name: string;
  /** A group for the tag ("Vibe", "Vocals"), empty for none. */
  category: string;
  color: number | null;
  count: number;
}

/** A copy of the library (tracks, analysis, cues, playlists, tags, history; not the music files). */
export interface BackupInfo {
  path: string;
  /** Made by hand, by the daily backup, or saved just before a restore. */
  kind: "manual" | "auto" | "beforeRestore";
  /** Unix seconds. */
  created: number;
  bytes: number;
  /** Tracks in it (null when the file could not be read). */
  tracks: number | null;
}

export interface SectionDto {
  start: number;
  end: number;
  bars: number;
  label: string;
  energy: number;
}

export type CueRole = "load" | "mixIn" | "mixOut" | "section" | "hot" | "memory" | "main";

export interface CueDto {
  role: CueRole;
  slot: number | null;
  seconds: number;
  loopSeconds: number | null;
  label: string;
  color: number | null;
}

export interface TrackDetail {
  track: TrackRow;
  analysed: boolean;
  bpm: number | null;
  bpmCandidates: number[];
  tempoConfidence: number;
  driftMs: number;
  constantGrid: boolean;
  /** A locked grid is kept by re-analysis and refuses edits until unlocked. */
  gridLocked: boolean;
  beatsPerBar: number;
  firstBeat: number;
  beatPeriod: number;
  beats: number[];
  key: KeyDto | null;
  keyConfidence: number;
  keySecond: KeyDto | null;
  tuningCents: number;
  lufs: number | null;
  truePeak: number | null;
  autoGainDb: number | null;
  energy: number | null;
  energyCurve: number[];
  energyCurveStart: number;
  sections: SectionDto[];
  cues: CueDto[];
  audible: [number, number];
}

export interface SuggestionRow {
  track: TrackRow;
  score: number;
  tempoChangePct: number | null;
  keyShift: number;
  reasons: string[];
  tags: string[];
}

/** A precise beat grid edit from the track editor. */
export interface GridEdit {
  /** A constant tempo. */
  bpm?: number;
  /** Seconds where a bar should start (the nearest beat moves there). */
  downbeatAt?: number;
  /** Moves the whole grid, in milliseconds (positive = later). */
  nudgeMs?: number;
  locked?: boolean;
}

export interface DeckInfo {
  deck: number;
  token: number;
  detail: TrackDetail;
  sampleRate: number;
}

export interface LoopDto {
  start: number;
  end: number;
  active: boolean;
  beats: number;
}

export interface DeckTele {
  loaded: boolean;
  token: number;
  playing: boolean;
  position: number;
  duration: number;
  remaining: number;
  bpm: number;
  baseBpm: number;
  rate: number;
  tempo: number;
  tempoRange: number;
  beat: number;
  beatsPerBar: number;
  keylock: boolean;
  keyShift: number;
  sync: boolean;
  master: boolean;
  phase: number;
  slip: boolean;
  slipPosition: number;
  reverse: boolean;
  cue: number;
  looping: LoopDto;
  peak: [number, number];
  rms: number;
  /** Bass below about 150 Hz after the fader (RMS), for spotting two basslines at once. */
  lowRms: number;
  /** Studio compressor gain reduction (dB, positive). */
  compGrDb: number;
  /** How far ducking turned the channel down (dB, positive). */
  duckDb: number;
  gateOpen: boolean;
}

export interface MasterTele {
  peak: [number, number];
  truePeakDb: number;
  momentaryLufs: number;
  shortTermLufs: number;
  correlation: number;
  limiterGrDb: number;
  /** Master glue compressor gain reduction (dB, positive). */
  glueGrDb: number;
  cuePeak: [number, number];
  clipped: boolean;
}

/** The library preview player. */
export interface PreviewTele {
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number;
  /** It played to the end since the previous snapshot. */
  ended: boolean;
  /** It plays in time with the decks (sync on and the track has a beat grid). */
  synced: boolean;
  /** Playback speed (1 = the track's own tempo). */
  rate: number;
}

export type PreviewRoute = "headphones" | "speakers";

export interface Telemetry {
  frame: number;
  decks: DeckTele[];
  master: MasterTele;
  mic: MicTele;
  preview: PreviewTele;
  clockBpm: number;
  masterDeck: number | null;
  recording: boolean;
  recordedSeconds: number;
  load: number;
  overruns: number;
  /** Bit n is set while sampler pad n plays. */
  samplerPlaying: number;
  /** Step the sampler's sequencer is on, or -1 while it is stopped. */
  sequencerStep: number;
  /** Spectrum-analyser bands (dB, 96 log-spaced bands from 20 Hz to 20 kHz) while one is open. */
  spectrum?: number[];
}

// ------------------------------------------------------------------ studio strips

export type BandShape = "bell" | "lowShelf" | "highShelf" | "lowCut" | "highCut" | "notch" | "bandPass";

export interface BandDto {
  enabled: boolean;
  shape: BandShape;
  freq: number;
  q: number;
  gainDb: number;
  /** Cuts only: 12, 24, 36 or 48 dB per octave. */
  slopeDb: number;
}

export interface CompDto {
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  autoMakeup: boolean;
  sidechainHpfHz: number;
  mix: number;
}

export interface GateDto {
  thresholdDb: number;
  hysteresisDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  rangeDb: number;
}

/** A channel's (or the master's) studio insert chain. */
export interface StudioDto {
  gateOn: boolean;
  gate: GateDto;
  eqOn: boolean;
  bands: BandDto[];
  compOn: boolean;
  comp: CompDto;
  satOn: boolean;
  driveDb: number;
  width: number;
  outputDb: number;
}

/** What the spectrum analyser shows: nothing, the master, or a channel (0..3). */
export type ScopeSource = "off" | "master" | number;

export interface AudioStatus {
  device: string;
  isVirtual: boolean;
  sampleRate: number;
  bufferFrames: number | null;
  latencyMs: number;
  warning: string | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  host: string;
  max_channels: number;
  sample_rates: number[];
  default_sample_rate: number;
  buffer_range: [number, number] | null;
  is_default: boolean;
}

export interface Settings {
  device: string | null;
  bufferFrames: number;
  sampleRate: number | null;
  cueChannel: number | null;
  keyNotation: "camelot" | "openKey" | "standard";
  viewMode: "easy" | "pro";
  theme: "dark" | "light" | "system";
  decks: 2 | 4;
  explain: boolean;
  coach: boolean;
  recordFloat: boolean;
  autoGain: boolean;
  limiter: boolean;
  tempoRange: number;
  /** Opens the input device for the mic channel. */
  micEnabled: boolean;
  /** Input device id (null = the system's default). */
  micDevice: string | null;
  /** First input channel (0-based); with micStereo, this one and the next. */
  micChannel: number;
  micStereo: boolean;
  /** Browser only: echo cancelling and noise reduction for a voice. */
  micVoice?: boolean;
}

/** The mic channel, as the engine reports it. */
export interface MicTele {
  connected: boolean;
  /** Audio is arriving. */
  live: boolean;
  onAir: boolean;
  /** After gain, low cut, gate and EQ, before the volume (linear). */
  peak: [number, number];
  rms: number;
  /** How far talk-over is turning the music down (dB, 0 or below). */
  duckDb: number;
  gateOpen: boolean;
  /** The delay the mic adds on top of the output's. */
  latencyMs: number;
  driftPpm: number;
  underruns: number;
  capturing: boolean;
  capturedSeconds: number;
}

/** The input device the mic channel is connected to. */
export interface MicStatus {
  device: string;
  sampleRate: number;
  channels: number;
  bufferFrames: number | null;
  channel: number;
  stereo: boolean;
}

export interface MicState {
  status: MicStatus | null;
  /** Why the mic could not be opened. */
  error: string | null;
  /** The device went away (unplugged). */
  lost: boolean;
}

/** A finished mic recording, ready for a pad or the library. */
export interface MicTake {
  path: string;
  seconds: number;
}

export interface ParamSpec {
  min: number;
  max: number;
  default: number;
  unit: "None" | "Decibels" | "Hertz" | "Percent" | "Milliseconds" | "Seconds" | "Beats" | "Semitones" | string;
  /** "Linear" | "Logarithmic" | "Centered" | "Fader" | { Power: n } */
  taper: string | { Power: number };
  smoothing_ms: number;
  step: number;
}

export type ActionKind =
  | { type: "trigger" }
  | { type: "momentary" }
  | { type: "toggle" }
  | { type: "continuous"; spec: ParamSpec }
  | { type: "choice"; options: string[]; default: number };

export interface ActionSpec {
  id: string;
  label: string;
  group: string;
  kind: ActionKind;
  explain: string;
  easy: boolean;
  shortcut: string | null;
  glossary: string | null;
}

export type ActionInput =
  | { type: "press" }
  | { type: "release" }
  | { type: "value"; value: number }
  | { type: "set"; value: boolean }
  | { type: "choice"; value: number };

export interface TransitionInfo {
  id: string;
  name: string;
  explain: string;
  beats: number;
}

export interface AppInfo {
  version: string;
  dbPath: string;
  recordingsDir: string;
  projectsDir: string;
  audio: AudioStatus;
  settings: Settings;
  registry: ActionSpec[];
  transitions: TransitionInfo[];
  fxTypes: string[];
  decks: (DeckInfo | null)[];
  kit: KitSound[];
  pads: PadInfo[];
}

/** A sound in the built-in sampler kit. */
export interface KitSound {
  id: string;
  name: string;
  bpm: number | null;
  mode: number;
  color: number;
}

export type PadSource =
  | { type: "empty" }
  | { type: "kit"; id: string }
  | { type: "file"; path: string }
  | { type: "track"; trackId: number; start: number | null; seconds: number | null };

export interface PadInfo {
  pad: number;
  name: string;
  source: PadSource;
  seconds: number;
  bpm: number | null;
  /** 0 one-shot, 1 gate (plays while held), 2 loop. */
  mode: number;
  gainDb: number;
  pan: number;
  sync: boolean;
  quantized: boolean;
  color: number;
  error: string | null;
}

/** The sampler's step sequencer: one row of steps per pad. */
export interface SequencerDto {
  on: boolean;
  /** Steps in the pattern (1 to 64). */
  steps: number;
  /** Length of one step in beats (0.25 = sixteenth notes). */
  stepBeats: number;
  /** 0 = straight, 0.5 = full triplet feel. */
  swing: number;
  /** pads[p][s]: whether pad p plays on step s. */
  pads: boolean[][];
}

export interface PadPatch {
  name?: string;
  mode?: number;
  gainDb?: number;
  pan?: number;
  sync?: boolean;
  quantized?: boolean;
  color?: number;
  /** 0 clears the tempo. */
  bpm?: number;
}

export interface LibraryStats {
  tracks: number;
  analysed: number;
  pending: number;
  failed: number;
  missing: number;
  playlists: number;
  total_seconds: number;
}

export interface PlaylistDto {
  id: number;
  parent: number | null;
  name: string;
  kind: "folder" | "list" | "smart";
  query: string | null;
  count: number;
  duration: number;
}

/** A past set: one session of the app that played at least one track. */
export interface SessionDto {
  id: number;
  name: string;
  startedAt: number;
  tracks: number;
  firstPlayed: number;
  lastPlayed: number;
}

export interface HistoryEntry {
  track_id: number | null;
  played_at: number;
  deck: number | null;
  title: string;
  artist: string;
}

export interface JobProgress {
  kind: "scan" | "analyze" | "render" | "import";
  done: number;
  total: number;
  message: string;
  finished: boolean;
  error: string | null;
}

export interface TrackEdit {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  label?: string;
  comment?: string;
  rating?: number;
  color?: number | null;
  bpm?: number | null;
  energy?: number | null;
  year?: number | null;
}

export interface WriteTagsResult {
  written: number;
  /** [track id, why] for files that could not be written. */
  failed: [number, string][];
}

// --- Mix projects (crates/mixit-project, serialised as-is) ---

export type CurveShape = "Linear" | "Smooth" | "Power" | "Hold";
export type ProjectParam = "Volume" | "EqLow" | "EqMid" | "EqHigh" | "Filter" | "FxMix" | "Pan" | "Space" | "Echo";

export interface AutomationPoint {
  beat: number;
  value: number;
  curve: CurveShape;
}

export interface AutomationLane {
  param: ProjectParam;
  points: AutomationPoint[];
}

export interface TrackRef {
  hash: string | null;
  path: string | null;
  title: string;
  artist: string;
  bpm: number;
  key: unknown;
  duration: number;
}

export interface Clip {
  id: number;
  track: TrackRef;
  lane: number;
  start: number;
  length: number;
  source_start: number;
  key_shift: number;
  keylock: boolean;
  gain_db: number;
  lanes: AutomationLane[];
  fx: { kind: number; beats: number } | null;
  name: string;
  /** Plays the clip's range of the track backwards. */
  reverse?: boolean;
}

export interface TempoSegment {
  start_beat: number;
  bpm: number;
  end_bpm: number;
}

export interface MixProject {
  version: number;
  name: string;
  tempo: { segments: TempoSegment[]; time_signatures: unknown[] };
  clips: Clip[];
  markers: { beat: number; label: string }[];
  master_gain_db: number;
  /** Studio strip per lane (deck); missing entries leave the sound unchanged. */
  strips?: StudioDto[];
  master_strip?: StudioDto | null;
  returns?: ProjectReturns;
  /** Mute and solo per lane (deck); missing entries are heard. */
  lane_states?: { muted: boolean; solo: boolean }[];
  next_id: number;
}

/** The shared reverb and echo a project's lanes send to. */
export interface ProjectReturns {
  space_level_db: number;
  space_size: number;
  echo_level_db: number;
  echo_feedback: number;
  echo_beats: number;
}

export interface AutomixRequest {
  transition: string;
  tempo: string;
  overlap: number;
  harmonic: boolean;
  reorder: boolean;
  energy: "steady" | "up" | "down";
  name: string;
}

export interface WaveformData {
  sampleRate: number;
  framesPerColumn: number;
  /** 5 bytes per column: peak, rms, low, mid, high. */
  columns: Uint8Array;
}

// ------------------------------------------------------------------ sound editor

/** One step of a non-destructive sound edit. Times are seconds in the sound as it is at
 * that step. */
export type EditOp =
  | { op: "trim"; start: number; end: number }
  | { op: "delete"; start: number; end: number }
  | { op: "copy"; start: number; end: number }
  | { op: "paste"; at: number }
  | { op: "silence"; start: number; end: number }
  | { op: "insertSilence"; at: number; seconds: number }
  | { op: "fade"; start: number; end: number; fadeIn: boolean; shape: FadeShape }
  | { op: "gain"; start: number; end: number; db: number }
  | { op: "normalize"; to: "peak" | "loudness"; level: number }
  | { op: "reverse"; start: number; end: number }
  | { op: "trimSilence"; thresholdDb: number }
  | { op: "removeDc" };

export type FadeShape = "linear" | "smooth" | "power" | "exponential";

/** An edited sound, summarised for drawing. */
export interface SoundView {
  seconds: number;
  sampleRate: number;
  /** [min, max] per bin over the whole sound. */
  peaks: [number, number][];
  /** Integrated loudness (LUFS; −99 when too short to measure) and peak (dBFS). */
  lufs: number;
  peakDb: number;
}

export interface SoundOpened {
  id: number;
  name: string;
  view: SoundView;
}
