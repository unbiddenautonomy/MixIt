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
}

export interface MasterTele {
  peak: [number, number];
  truePeakDb: number;
  momentaryLufs: number;
  shortTermLufs: number;
  correlation: number;
  limiterGrDb: number;
  cuePeak: [number, number];
  clipped: boolean;
}

export interface Telemetry {
  frame: number;
  decks: DeckTele[];
  master: MasterTele;
  clockBpm: number;
  masterDeck: number | null;
  recording: boolean;
  recordedSeconds: number;
  load: number;
  overruns: number;
}

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
}

// --- Mix projects (crates/mixit-project, serialised as-is) ---

export type CurveShape = "Linear" | "Smooth" | "Power" | "Hold";
export type ProjectParam = "Volume" | "EqLow" | "EqMid" | "EqHigh" | "Filter" | "FxMix";

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
  next_id: number;
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
