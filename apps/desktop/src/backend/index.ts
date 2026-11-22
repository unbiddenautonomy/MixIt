// The one way the UI talks to the engine and library. In the desktop app this is the
// Tauri bridge; in a plain browser (development, screenshots, the future web app) it is
// the in-browser demo backend.

import type {
  ActionInput,
  AppInfo,
  AudioStatus,
  AutomixRequest,
  DeckInfo,
  DeviceInfo,
  GridEdit,
  HistoryEntry,
  JobProgress,
  LibraryStats,
  MicState,
  MicTake,
  MixProject,
  PadInfo,
  ScopeSource,
  StudioDto,
  PadPatch,
  PadSource,
  EditOp,
  SoundOpened,
  SoundView,
  PlaylistDto,
  Settings,
  SequencerDto,
  SuggestionRow,
  Telemetry,
  TrackDetail,
  TrackEdit,
  TrackRow,
  WaveformData,
} from "./types";

export type Unlisten = () => void;

export interface Backend {
  /** "web" is the real engine running in the browser; "demo" simulates it. */
  readonly kind: "tauri" | "demo" | "web";
  appInfo(): Promise<AppInfo>;
  action(id: string, input: ActionInput): Promise<void>;

  loadTrack(deck: number, trackId: number): Promise<DeckInfo>;
  seek(deck: number, seconds: number): Promise<void>;
  scratch(deck: number, phase: "start" | "move" | "end", velocity: number): Promise<void>;
  setHotCue(deck: number, slot: number, seconds: number, loopSeconds?: number | null, color?: number, label?: string): Promise<void>;
  /** Adds or replaces a named marker (not on a pad) at `seconds`. */
  setMemoryCue(deck: number, seconds: number, label: string, color?: number | null): Promise<void>;
  deleteMemoryCue(deck: number, seconds: number): Promise<void>;
  /** Edits the beat grid of the deck's track and saves it (the deck is reloaded in place). */
  setGrid(deck: number, edit: GridEdit): Promise<void>;
  deleteHotCue(deck: number, slot: number): Promise<void>;
  setMainCue(deck: number, seconds: number): Promise<void>;
  setLoop(deck: number, start: number, end: number, active: boolean): Promise<void>;
  waveform(trackId: number): Promise<WaveformData>;

  search(query: string, limit?: number): Promise<TrackRow[]>;
  stats(): Promise<LibraryStats>;
  folders(): Promise<string[]>;
  removeFolder(path: string): Promise<void>;
  addToLibrary(paths: string[]): Promise<void>;
  /** Adds one audio file to the library now (it is analysed when first loaded) and returns it. */
  importTrack(path: string): Promise<TrackRow>;
  /**
   * Keeps files dropped from outside the browser under paths the other calls accept.
   * The desktop app gets real paths from the system instead and returns none.
   */
  registerFiles(files: File[]): string[];
  rescan(): Promise<void>;
  analyzePending(): Promise<void>;
  cancelJob(): Promise<void>;
  trackDetail(id: number): Promise<TrackDetail>;
  editTrack(id: number, edit: TrackEdit): Promise<TrackRow>;
  removeTracks(ids: number[]): Promise<void>;
  /** Tracks whose files cannot be found. */
  missingTracks(): Promise<TrackRow[]>;
  /** Looks through a folder for missing tracks' files (same name, or same audio). Returns how many were found. */
  findMissing(folder: string): Promise<number>;
  /** Points a track at a file the user picked. */
  relocateTrack(id: number, path: string): Promise<TrackRow>;
  /** Groups of tracks with the same audio. */
  duplicates(): Promise<TrackRow[][]>;
  /** Folds duplicates into the one to keep: playlists, tags, history and cues move over. */
  mergeTracks(keep: number, others: number[]): Promise<void>;
  suggestNext(trackId: number, energy: "steady" | "up" | "down", limit?: number): Promise<SuggestionRow[]>;

  playlists(): Promise<PlaylistDto[]>;
  playlistTracks(id: number): Promise<TrackRow[]>;
  createPlaylist(name: string, kind: "folder" | "list" | "smart", opts?: { parent?: number | null; query?: string | null; tracks?: number[] }): Promise<number>;
  renamePlaylist(id: number, name: string): Promise<void>;
  setPlaylistQuery(id: number, query: string): Promise<void>;
  deletePlaylist(id: number): Promise<void>;
  addToPlaylist(id: number, tracks: number[]): Promise<void>;
  removeFromPlaylist(id: number, indices: number[]): Promise<void>;
  reorderPlaylist(id: number, from: number[], to: number): Promise<void>;
  orderPlaylist(id: number, energy: "steady" | "up" | "down"): Promise<void>;
  history(): Promise<HistoryEntry[]>;
  tracklist(): Promise<string>;

  devices(): Promise<DeviceInfo[]>;
  audioStatus(): Promise<AudioStatus>;
  saveSettings(s: Settings): Promise<Settings>;
  recordStart(): Promise<string>;
  recordStop(): Promise<string>;

  /** Microphones and line inputs. The mic itself opens and closes with the settings. */
  inputDevices(): Promise<DeviceInfo[]>;
  /** A channel's (0..3) or, with null, the master's studio strip. */
  studioGet(channel: number | null): Promise<StudioDto>;
  studioSet(channel: number | null, settings: StudioDto): Promise<void>;
  /** Turns the spectrum analyser on for the master or a channel, or off. */
  setScope(source: ScopeSource): Promise<void>;
  micState(): Promise<MicState>;
  /** Starts recording the mic channel. */
  micRecordStart(): Promise<void>;
  /** Stops it and returns the file (`trim` cuts the silence around it, for a pad). */
  micRecordStop(trim: boolean): Promise<MicTake>;

  automix(tracks: number[], options: AutomixRequest): Promise<MixProject>;
  saveProject(path: string, project: MixProject): Promise<void>;
  openProject(path: string): Promise<MixProject>;
  checkProject(project: MixProject): Promise<string[]>;
  /** Bounces the mix to a file; with `targetLufs` it is turned to that loudness. */
  renderProject(project: MixProject, path: string, format?: string, targetLufs?: number | null): Promise<void>;
  /** Bounces each lane to its own file in `folder`, all the same length. */
  renderStems(project: MixProject, folder: string, format?: string): Promise<void>;
  /** Beats [fromBeat, toBeat) of the project as a WAV file, for listening in Arrange. */
  previewProject(project: MixProject, fromBeat: number, toBeat: number): Promise<ArrayBuffer>;

  /** Opens a sound for the editor (a pad source: kit sound, file, library track or a
   * slice of one). The original is never changed. */
  soundOpen(source: PadSource, bins: number): Promise<SoundOpened>;
  /** The sound after the edits, for drawing. */
  soundRender(id: number, ops: EditOp[], bins: number): Promise<SoundView>;
  /** The sound after the edits as a WAV file, for listening. */
  soundAudio(id: number, ops: EditOp[]): Promise<ArrayBuffer>;
  /** Saves the edited sound as a new file and returns its path (for a pad or the library). */
  soundSave(id: number, ops: EditOp[], name: string): Promise<string>;
  soundClose(id: number): Promise<void>;

  samplerLoad(pad: number, source: PadSource): Promise<PadInfo>;
  samplerClear(pad: number): Promise<PadInfo>;
  samplerSet(pad: number, patch: PadPatch): Promise<PadInfo>;
  /** Puts the built-in kit back on every pad. */
  samplerReset(): Promise<PadInfo[]>;
  samplerStopAll(): Promise<void>;
  /** Puts the step sequencer's patterns and settings on the engine. */
  samplerSequence(sequencer: SequencerDto): Promise<void>;

  /** Generates the practice tracks for the guide's labs and adds them to the library. */
  addPracticeTracks(): Promise<void>;

  importRekordbox(path: string): Promise<void>;
  exportRekordbox(path: string, playlist?: number | null): Promise<void>;
  exportPlaylist(playlist: number, path: string): Promise<void>;
  importM3u(path: string): Promise<number>;

  pickFolders(): Promise<string[] | null>;
  pickFiles(extensions: string[], title: string): Promise<string[] | null>;
  pickSave(defaultName: string, extensions: string[]): Promise<string | null>;

  onTelemetry(cb: (t: Telemetry) => void): Unlisten;
  onDeckLoaded(cb: (d: DeckInfo) => void): Unlisten;
  onDeckEnded(cb: (deck: number) => void): Unlisten;
  onJob(cb: (j: JobProgress) => void): Unlisten;
  onLibraryChanged(cb: () => void): Unlisten;
  onHistoryChanged(cb: () => void): Unlisten;
  onAudioStatus(cb: (s: AudioStatus) => void): Unlisten;
  onError(cb: (message: string) => void): Unlisten;
}

let instance: Backend | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let creating: Promise<Backend> | null = null;

/**
 * The backend for this environment, created once. Concurrent callers (React's strict mode
 * runs start-up twice) share one instance, so events and the demo engine are never doubled.
 */
export function getBackend(): Promise<Backend> {
  if (instance) return Promise.resolve(instance);
  creating ??= (async () => {
    const b: Backend = isTauri() ? new (await import("./tauri")).TauriBackend() : await browserBackend();
    instance ??= b;
    return instance;
  })();
  return creating;
}

/**
 * In a browser: the real engine in WebAssembly when it is built and the browser supports
 * it, otherwise the silent simulation. `?demo` in the address forces the simulation.
 */
async function browserBackend(): Promise<Backend> {
  const forceDemo = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
  if (!forceDemo) {
    const engine = await (await import("../web/engine")).WebEngine.start();
    if (engine) {
      try {
        return await (await import("./web")).WebAudioBackend.create(engine);
      } catch (e) {
        console.warn("MixIt web engine failed to start, using the simulated demo:", e);
      }
    }
  }
  return new (await import("./demo")).DemoBackend();
}

/** Synchronous access after start-up. */
export function backend(): Backend {
  if (!instance) throw new Error("backend not initialised");
  return instance;
}

export function setBackendForTests(b: Backend) {
  instance = b;
  creating = null;
}

/** Decodes the binary waveform from the `waveform` command. */
export function decodeWaveform(buf: ArrayBuffer): WaveformData {
  const v = new DataView(buf);
  return { sampleRate: v.getUint32(0, true), framesPerColumn: v.getUint32(4, true), columns: new Uint8Array(buf, 8) };
}
