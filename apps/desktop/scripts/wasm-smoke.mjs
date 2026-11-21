// Smoke test of the browser engine module (public/mixit.wasm, from `npm run wasm`): it must
// have no imports (it is instantiated inside an AudioWorklet), generate and analyse a track,
// play it through the engine host with key lock on, and render an Arrange project.
//
//   node scripts/wasm-smoke.mjs [path/to/mixit.wasm]

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? new URL("../public/mixit.wasm", import.meta.url);
const module = await WebAssembly.compile(readFileSync(path));
const fail = (msg) => {
  console.error(`wasm smoke test failed: ${msg}`);
  process.exit(1);
};

const imports = WebAssembly.Module.imports(module);
if (imports.length) fail(`the module imports ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);

const e = new WebAssembly.Instance(module, {}).exports;
const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (s) => {
  const b = enc.encode(s);
  const p = e.mx_alloc_bytes(b.length);
  new Uint8Array(e.memory.buffer, p, b.length).set(b);
  return [p, b.length];
};
const out = () => dec.decode(new Uint8Array(e.memory.buffer, e.mx_out_ptr(), e.mx_out_len()));
const call = (fn, ...args) => {
  const [p, l] = text(args.pop());
  const code = fn(...args, p, l);
  e.mx_free_bytes(p, l);
  if (code !== 0) fail(out());
  return out();
};

const sr = 48_000;
let t = performance.now();
call(e.mx_generate, JSON.stringify({ style: "house", bpm: 124, camelot: "5A", short: true, sampleRate: sr }));
const audio = new Float32Array(e.memory.buffer, e.mx_out_f32_ptr(), e.mx_out_f32_len()).slice();
const generated = performance.now() - t;

t = performance.now();
const a = e.mx_alloc_f32(audio.length);
new Float32Array(e.memory.buffer, a, audio.length).set(audio);
if (e.mx_analyse(a, audio.length, sr) !== 0) fail(out());
e.mx_free_f32(a, audio.length);
const view = JSON.parse(out());
const analysed = performance.now() - t;
if (Math.abs(view.bpm - 124) > 0.2) fail(`analysed ${view.bpm} BPM, expected 124`);
if (view.key?.camelot !== "5A") fail(`analysed key ${view.key?.camelot}, expected 5A`);

if (e.mx_registry() !== 0 || !out().includes("deck.A.play")) fail("no action registry");

const h = e.mx_host_new(sr);
const p = e.mx_alloc_f32(audio.length);
new Float32Array(e.memory.buffer, p, audio.length).set(audio);
const opts = JSON.stringify({ grid: view.grid, key: view.key.camelot, cue: view.firstBeat });
const [op, ol] = text(opts);
if (e.mx_host_load(h, 0, p, audio.length, op, ol) !== 0) fail(out());
e.mx_free_bytes(op, ol);
for (const msg of [
  { op: "action", id: "deck.A.keylock", input: { type: "set", value: true } },
  { op: "action", id: "deck.A.tempo", input: { type: "value", value: 0.5 } },
  { op: "action", id: "deck.A.play", input: { type: "press" } },
]) {
  call(e.mx_host_call, h, JSON.stringify(msg));
}
t = performance.now();
let energy = 0;
const quanta = Math.round((sr * 10) / 128);
for (let i = 0; i < quanta; i++) {
  const o = new Float32Array(e.memory.buffer, e.mx_host_process(h, 128), 256);
  for (let k = 0; k < 256; k++) energy += o[k] * o[k];
  // The worklet polls about 60 times a second; the telemetry ring is short.
  if (i % 6 === 5) e.mx_host_poll(h);
}
const rendered = performance.now() - t;
if (e.mx_host_poll(h) !== 0) fail(out());
const tele = JSON.parse(out()).t;
const rms = Math.sqrt(energy / (quanta * 256));
if (!tele.decks[0].playing || rms < 0.05) fail(`deck A is not playing (rms ${rms.toFixed(3)})`);
if (Math.abs(tele.decks[0].position - view.firstBeat - 10 * tele.decks[0].rate) > 0.2) fail(`deck A is at ${tele.decks[0].position.toFixed(2)} s`);

// Arrange: two clips of the track, the second coming in over the first's last 8 bars.
const clip = (id, lane, start) => ({ id, track: { hash: null, path: "smoke", title: "Smoke", artist: "", bpm: 124, key: null, duration: view.duration }, lane, start, length: 64, source_start: 0, key_shift: 0, keylock: true, gain_db: 0, lanes: [], fx: null, name: "Smoke" });
const project = {
  version: 1,
  name: "Smoke",
  tempo: { segments: [{ start_beat: 0, bpm: 126, end_bpm: 126 }], time_signatures: [{ start_beat: 0, numerator: 4, denominator: 4 }] },
  clips: [clip(1, 0, 0), clip(2, 1, 32)],
  markers: [],
  master_gain_db: 0,
  next_id: 3,
};
t = performance.now();
const [rp, rl] = text(JSON.stringify({ project, tail: 0.5 }));
const job = e.mx_render_new(rp, rl, sr);
e.mx_free_bytes(rp, rl);
if (!job) fail(out());
const total = JSON.parse(out()).frames;
let got = 0;
let asked = 0;
let renergy = 0;
for (let guard = 0; guard < 1000; guard++) {
  if (e.mx_render_next(job, sr) !== 0) fail(out());
  const pr = JSON.parse(out());
  const o = new Float32Array(e.memory.buffer, e.mx_out_f32_ptr(), e.mx_out_f32_len());
  for (let k = 0; k < o.length; k++) renergy += o[k] * o[k];
  got += pr.frames;
  if (pr.need) {
    asked++;
    const q = e.mx_alloc_f32(audio.length);
    new Float32Array(e.memory.buffer, q, audio.length).set(audio);
    const [pp, pl] = text(pr.need.path);
    const [tp, tl] = text(JSON.stringify({ grid: view.grid, autoGainDb: 0 }));
    if (e.mx_render_track(job, pp, pl, q, audio.length, tp, tl) !== 0) fail(out());
    e.mx_free_bytes(pp, pl);
    e.mx_free_bytes(tp, tl);
  }
  if (pr.done) break;
}
e.mx_render_free(job);
const arranged = performance.now() - t;
const expected = Math.round(((96 * 60) / 126 + 0.5) * sr);
if (Math.abs(got - total) > 0 || Math.abs(total - expected) > sr * 0.05) fail(`rendered ${got} of ${total} frames, expected about ${expected}`);
if (asked < 1) fail("the render never asked for the track");
const arms = Math.sqrt(renergy / (got * 2));
if (arms < 0.05) fail(`the arranged mix is silent (rms ${arms.toFixed(3)})`);

console.log(
  `wasm ok: ${(readFileSync(path).length / 1e6).toFixed(2)} MB, generate ${generated.toFixed(0)} ms, analyse ${analysed.toFixed(0)} ms, ` +
    `10 s with key lock rendered in ${rendered.toFixed(0)} ms (rms ${rms.toFixed(2)}), ` +
    `${(got / sr).toFixed(0)} s arrangement rendered in ${arranged.toFixed(0)} ms (rms ${arms.toFixed(2)})`,
);
