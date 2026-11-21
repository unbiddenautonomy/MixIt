// MixIt's heavy one-off work in a Web Worker: generating tracks and kit sounds,
// analysing audio, and rendering Arrange projects. Same wasm module as the worklet.

const enc = new TextEncoder();
const dec = new TextDecoder();
let e = null;
/** Arrange render jobs by the page's job number. */
const jobs = new Map();
const jobOf = (n) => {
  const j = jobs.get(n);
  if (!j) throw new Error("That render was stopped.");
  return j;
};

function text(s) {
  const b = enc.encode(s);
  const p = e.mx_alloc_bytes(b.length);
  new Uint8Array(e.memory.buffer, p, b.length).set(b);
  return [p, b.length];
}
const out = () => dec.decode(new Uint8Array(e.memory.buffer, e.mx_out_ptr(), e.mx_out_len()));
const outF32 = () => new Float32Array(e.memory.buffer, e.mx_out_f32_ptr(), e.mx_out_f32_len()).slice();
const outBin = () => new Uint8Array(e.memory.buffer, e.mx_out_bin_ptr(), e.mx_out_bin_len()).slice();

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === "init") {
    e = (await WebAssembly.instantiate(m.module, {})).exports;
    self.postMessage({ type: "ready" });
    return;
  }
  try {
    if (m.type === "generate") {
      const [p, l] = text(JSON.stringify(m.request));
      const code = e.mx_generate(p, l);
      e.mx_free_bytes(p, l);
      if (code !== 0) throw new Error(out());
      const audio = outF32();
      self.postMessage({ type: "reply", id: m.id, ok: true, audio }, [audio.buffer]);
    } else if (m.type === "prepare") {
      // Generate and analyse in one go, without copying the audio out and back in.
      const [p, l] = text(JSON.stringify(m.request));
      const code = e.mx_generate(p, l);
      e.mx_free_bytes(p, l);
      if (code !== 0) throw new Error(out());
      if (e.mx_analyse(e.mx_out_f32_ptr(), e.mx_out_f32_len(), m.request.sampleRate) !== 0) throw new Error(out());
      const view = JSON.parse(out());
      const wave = outBin();
      const audio = outF32();
      self.postMessage({ type: "reply", id: m.id, ok: true, audio, view, wave }, [audio.buffer, wave.buffer]);
    } else if (m.type === "analyse") {
      const a = e.mx_alloc_f32(m.audio.length);
      new Float32Array(e.memory.buffer, a, m.audio.length).set(m.audio);
      const code = e.mx_analyse(a, m.audio.length, m.sampleRate);
      e.mx_free_f32(a, m.audio.length);
      if (code !== 0) throw new Error(out());
      const wave = outBin();
      self.postMessage({ type: "reply", id: m.id, ok: true, view: JSON.parse(out()), wave }, [wave.buffer]);
    } else if (m.type === "registry") {
      e.mx_registry();
      self.postMessage({ type: "reply", id: m.id, ok: true, info: JSON.parse(out()) });
    } else if (m.type === "renderStart") {
      const [p, l] = text(JSON.stringify(m.request));
      const job = e.mx_render_new(p, l, m.sampleRate);
      e.mx_free_bytes(p, l);
      if (!job) throw new Error(out());
      jobs.set(m.job, job);
      self.postMessage({ type: "reply", id: m.id, ok: true, frames: JSON.parse(out()).frames });
    } else if (m.type === "renderTrack") {
      const job = jobOf(m.job);
      const a = e.mx_alloc_f32(m.audio.length);
      new Float32Array(e.memory.buffer, a, m.audio.length).set(m.audio);
      const [pp, pl] = text(m.path);
      const [op, ol] = text(JSON.stringify(m.options));
      const code = e.mx_render_track(job, pp, pl, a, m.audio.length, op, ol);
      e.mx_free_bytes(pp, pl);
      e.mx_free_bytes(op, ol);
      if (code !== 0) throw new Error(out());
      self.postMessage({ type: "reply", id: m.id, ok: true });
    } else if (m.type === "renderMissing") {
      const [pp, pl] = text(m.path);
      e.mx_render_missing(jobOf(m.job), pp, pl);
      e.mx_free_bytes(pp, pl);
      self.postMessage({ type: "reply", id: m.id, ok: true });
    } else if (m.type === "renderNext") {
      if (e.mx_render_next(jobOf(m.job), m.frames) !== 0) throw new Error(out());
      const progress = JSON.parse(out());
      const audio = outF32();
      self.postMessage({ type: "reply", id: m.id, ok: true, progress, audio }, [audio.buffer]);
    } else if (m.type === "renderFree") {
      const job = jobs.get(m.job);
      if (job) e.mx_render_free(job);
      jobs.delete(m.job);
      self.postMessage({ type: "reply", id: m.id, ok: true });
    } else if (m.type === "kit") {
      const [p, l] = text(m.sound);
      const code = e.mx_kit(p, l, m.sampleRate);
      e.mx_free_bytes(p, l);
      if (code !== 0) throw new Error(out());
      const info = JSON.parse(out());
      const audio = outF32();
      self.postMessage({ type: "reply", id: m.id, ok: true, audio, bpm: info.bpm, mode: info.mode }, [audio.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: "reply", id: m.id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
