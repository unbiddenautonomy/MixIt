// The real MixIt engine in the browser: the Rust engine compiled to WebAssembly runs in an
// AudioWorklet (public/mixit-worklet.js); a Web Worker (public/mixit-worker.js) generates
// and analyses tracks. This file is the page's side of both.
import type { Telemetry } from "../backend/types";

/** A beat grid as TrackDetail describes it, plus the grid itself (after a grid edit). */
export interface GridView {
  bpm: number;
  constantGrid: boolean;
  gridLocked: boolean;
  beatsPerBar: number;
  firstBeat: number;
  beatPeriod: number;
  beats: number[];
  /** The beat grid as the engine stores it (opaque to the UI). */
  grid: unknown;
}

/** What analysis returns: the analysed fields of TrackDetail plus the grid to load with. */
export interface AnalysisView extends GridView {
  duration: number;
  bpmCandidates: number[];
  tempoConfidence: number;
  driftMs: number;
  key: { index: number; camelot: string; openKey: string; name: string } | null;
  keyConfidence: number;
  keySecond: { index: number; camelot: string; openKey: string; name: string } | null;
  tuningCents: number;
  lufs: number;
  truePeak: number;
  autoGainDb: number;
  energy: number;
  energyCurve: number[];
  energyCurveStart: number;
  sections: { start: number; end: number; bars: number; label: string; energy: number }[];
  cues: { role: string; slot: number | null; seconds: number; loopSeconds: number | null; label: string; color: number | null }[];
  audible: [number, number];
}

export interface GenerateRequest {
  practice?: string;
  style?: string;
  bpm?: number;
  endBpm?: number | null;
  camelot?: string;
  seed?: number;
  sampleRate: number;
  short?: boolean;
  leadIn?: number;
  swing?: number;
}

export interface Prepared {
  /** Interleaved stereo at the engine's sample rate. */
  audio: Float32Array;
  view: AnalysisView;
  /** Waveform in the desktop's binary layout. */
  wave: Uint8Array;
}

type Reply = { ok: boolean; body?: string; error?: string; [k: string]: unknown };

/** Where the built module is served from (see `npm run wasm`). */
const WASM_URL = "/mixit.wasm";

export class WebEngine {
  readonly ctx: AudioContext;
  readonly node: AudioWorkletNode;
  /** Taps the master output for recording. */
  readonly tap: MediaStreamAudioDestinationNode;
  private worker: Worker;
  private nextId = 1;
  private nextJob = 1;
  private pending = new Map<number, (r: Reply) => void>();
  private pollListeners = new Set<(t: Telemetry, ended: number[]) => void>();
  private recChunks: Float32Array[] | null = null;
  private recDone: (() => void) | null = null;

  private constructor(ctx: AudioContext, node: AudioWorkletNode, worker: Worker) {
    this.ctx = ctx;
    this.node = node;
    this.worker = worker;
    this.tap = ctx.createMediaStreamDestination();
    node.connect(ctx.destination);
    node.connect(this.tap);
    node.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "poll") {
        const p = JSON.parse(m.body) as { t: Telemetry; ended: number[] };
        this.pollListeners.forEach((cb) => cb(p.t, p.ended));
      } else if (m.type === "reply") {
        this.settle(m.id, m);
      } else if (m.type === "rec") {
        this.recChunks?.push(m.data as Float32Array);
      } else if (m.type === "recDone") {
        this.recDone?.();
      }
    };
    worker.onmessage = (ev) => {
      if (ev.data.type === "reply") this.settle(ev.data.id, ev.data);
    };
  }

  /**
   * Starts the engine, or returns null when the module is not built or the browser lacks
   * AudioWorklet (the app then falls back to the simulated demo).
   */
  static async start(): Promise<WebEngine | null> {
    if (typeof window === "undefined" || typeof AudioWorkletNode === "undefined" || typeof WebAssembly === "undefined") return null;
    try {
      const res = await fetch(WASM_URL);
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("wasm")) return null;
      const module = await WebAssembly.compile(await res.arrayBuffer());
      const ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.audioWorklet.addModule("/mixit-worklet.js");
      const node = new AudioWorkletNode(ctx, "mixit", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module } });
      const worker = new Worker("/mixit-worker.js");
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (ev) => (ev.data.type === "ready" ? resolve() : undefined);
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage({ type: "init", module });
      });
      const engine = new WebEngine(ctx, node, worker);
      engine.resumeOnGesture();
      return engine;
    } catch (e) {
      console.warn("MixIt web engine unavailable, using the simulated demo:", e);
      return null;
    }
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Browsers start audio suspended until the person interacts with the page. */
  private resumeOnGesture() {
    const resume = () => {
      if (this.ctx.state !== "running") void this.ctx.resume();
      if (this.ctx.state === "running") {
        window.removeEventListener("pointerdown", resume, true);
        window.removeEventListener("keydown", resume, true);
      }
    };
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("keydown", resume, true);
    resume();
  }

  private settle(id: number, r: Reply) {
    const f = this.pending.get(id);
    if (f) {
      this.pending.delete(id);
      f(r);
    }
  }

  private ask<R extends Reply>(target: MessagePort | Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, (r) => (r.ok ? resolve(r as R) : reject(new Error(r.error ?? r.body ?? "failed"))));
      target.postMessage({ ...msg, id }, transfer);
    });
  }

  onPoll(cb: (t: Telemetry, ended: number[]) => void): () => void {
    this.pollListeners.add(cb);
    return () => this.pollListeners.delete(cb);
  }

  /** A JSON call to the engine host; resolves with its parsed reply. */
  async call(msg: Record<string, unknown>): Promise<unknown> {
    const r = await this.ask(this.node.port, { type: "call", json: JSON.stringify(msg) });
    return r.body ? JSON.parse(r.body) : null;
  }

  /** Fire-and-forget call, for controls moved many times a second. */
  send(msg: Record<string, unknown>) {
    this.node.port.postMessage({ type: "call", json: JSON.stringify(msg) });
  }

  /** Loads audio onto a deck (the buffer is transferred). Resolves with the token. */
  async load(deck: number, audio: Float32Array, opts: Record<string, unknown>): Promise<number> {
    const r = await this.ask(this.node.port, { type: "load", deck, audio, json: JSON.stringify(opts) }, [audio.buffer]);
    return (JSON.parse(r.body!) as { token: number }).token;
  }

  async loadPad(pad: number, audio: Float32Array, bpm: number | null, settings: { mode: number; gainDb: number; pan: number; sync: boolean; quantized: boolean }) {
    await this.ask(this.node.port, { type: "loadPad", pad, audio, json: JSON.stringify({ bpm, settings }) }, [audio.buffer]);
  }

  /**
   * Renders an Arrange project (or the beats `from..to` of it) in the worker, about a
   * second at a time. `need` supplies each track when its first clip is about to play
   * (null when it cannot be found); `chunk` receives the interleaved stereo as it comes.
   */
  async renderProject(
    request: { project: unknown; from?: number; to?: number; tail?: number; limiter?: boolean; autoGain?: boolean },
    need: (n: RenderNeed) => Promise<RenderTrack | null>,
    chunk: (audio: Float32Array, position: number, total: number) => void,
    cancelled: () => boolean = () => false,
  ): Promise<void> {
    const job = this.nextJob++;
    await this.ask(this.worker, { type: "renderStart", job, request, sampleRate: this.sampleRate });
    try {
      for (;;) {
        if (cancelled()) throw new RenderCancelled();
        const r = await this.ask<Reply & { progress: RenderProgress; audio: Float32Array }>(this.worker, { type: "renderNext", job, frames: this.sampleRate });
        if (r.audio.length) chunk(r.audio, r.progress.position, r.progress.total);
        const n = r.progress.need;
        if (n) {
          const t = await need(n);
          if (t) await this.ask(this.worker, { type: "renderTrack", job, path: n.path, audio: t.audio, options: { grid: t.grid, autoGainDb: t.autoGainDb } }, [t.audio.buffer]);
          else await this.ask(this.worker, { type: "renderMissing", job, path: n.path });
        }
        if (r.progress.done) return;
      }
    } finally {
      await this.ask(this.worker, { type: "renderFree", job }).catch(() => undefined);
    }
  }

  /** The action registry and FX names, as the desktop app reports them. */
  async registry(): Promise<{ registry: unknown[]; fxTypes: string[] }> {
    const r = await this.ask<Reply & { info: { registry: unknown[]; fxTypes: string[] } }>(this.worker, { type: "registry" });
    return r.info;
  }

  /** Generates a track (no analysis) in the worker. */
  async generate(request: GenerateRequest): Promise<Float32Array> {
    const r = await this.ask<Reply & { audio: Float32Array }>(this.worker, { type: "generate", request });
    return r.audio;
  }

  /** Starts copying the master output for a recording. */
  recordStart() {
    this.recChunks = [];
    this.node.port.postMessage({ type: "record", on: true });
  }

  /** Stops recording; resolves with every chunk (interleaved stereo at the engine rate). */
  recordStop(): Promise<Float32Array[]> {
    return new Promise((resolve) => {
      this.recDone = () => {
        const c = this.recChunks ?? [];
        this.recChunks = null;
        this.recDone = null;
        resolve(c);
      };
      this.node.port.postMessage({ type: "record", on: false });
    });
  }

  /** Generates and analyses a track in the worker. */
  async prepare(request: GenerateRequest): Promise<Prepared> {
    const r = await this.ask<Reply & Prepared>(this.worker, { type: "prepare", request });
    return { audio: r.audio, view: r.view, wave: r.wave };
  }

  /** Analyses audio the page already has (a copy goes to the worker). */
  async analyse(audio: Float32Array): Promise<{ view: AnalysisView; wave: Uint8Array }> {
    const r = await this.ask<Reply & { view: AnalysisView; wave: Uint8Array }>(this.worker, { type: "analyse", audio, sampleRate: this.sampleRate });
    return { view: r.view, wave: r.wave };
  }

  async kit(sound: string): Promise<{ audio: Float32Array; bpm: number | null; mode: number }> {
    const r = await this.ask<Reply & { audio: Float32Array; bpm: number | null; mode: number }>(this.worker, { type: "kit", sound, sampleRate: this.sampleRate });
    return { audio: r.audio, bpm: r.bpm, mode: r.mode };
  }

  /** Decodes an audio file to interleaved stereo at the engine rate. */
  async decode(data: ArrayBuffer): Promise<Float32Array> {
    const b = await this.ctx.decodeAudioData(data);
    const l = b.getChannelData(0);
    const r = b.numberOfChannels > 1 ? b.getChannelData(1) : l;
    const out = new Float32Array(b.length * 2);
    for (let i = 0; i < b.length; i++) {
      out[i * 2] = l[i];
      out[i * 2 + 1] = r[i];
    }
    return out;
  }
}

/** Encodes interleaved stereo chunks as a WAV file (16-bit PCM, or 32-bit float). */
export interface RenderNeed {
  clip: number;
  path: string;
  title: string;
}

export interface RenderTrack {
  audio: Float32Array;
  grid: unknown;
  autoGainDb: number;
}

interface RenderProgress {
  frames: number;
  position: number;
  total: number;
  need: RenderNeed | null;
  done: boolean;
}

export class RenderCancelled extends Error {
  constructor() {
    super("Render stopped");
  }
}

/** A 44-byte WAV header for interleaved stereo. */
export function wavHeader(samples: number, sampleRate: number, float = false): ArrayBuffer {
  const bytes = float ? 4 : 2;
  const header = new ArrayBuffer(44);
  const h = new DataView(header);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => h.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  h.setUint32(4, 36 + samples * bytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, float ? 3 : 1, true);
  h.setUint16(22, 2, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * 2 * bytes, true);
  h.setUint16(32, 2 * bytes, true);
  h.setUint16(34, bytes * 8, true);
  str(36, "data");
  h.setUint32(40, samples * bytes, true);
  return header;
}

/** Floats to 16-bit samples. */
export function toPcm16(c: Float32Array): Int16Array<ArrayBuffer> {
  const pcm = new Int16Array(c.length);
  for (let i = 0; i < c.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
  return pcm;
}

export function encodeWav(chunks: Float32Array[], sampleRate: number, float = false): Blob {
  const samples = chunks.reduce((a, c) => a + c.length, 0);
  const parts: BlobPart[] = [wavHeader(samples, sampleRate, float)];
  for (const c of chunks) parts.push(float ? new Float32Array(c) : toPcm16(c));
  return new Blob(parts, { type: "audio/wav" });
}

/** Parses the desktop's waveform layout: [u32 sample rate][u32 frames per column] then columns. */
export function parseWave(bytes: Uint8Array): { sampleRate: number; framesPerColumn: number; columns: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { sampleRate: dv.getUint32(0, true), framesPerColumn: dv.getUint32(4, true), columns: bytes.subarray(8) };
}
