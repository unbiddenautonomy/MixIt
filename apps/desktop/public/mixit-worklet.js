// MixIt's engine inside an AudioWorklet: the page sends the compiled module, this
// instantiates it and renders every 128-frame quantum. Calls arrive as messages between
// quanta; telemetry goes back about 60 times a second.
/* global sampleRate, AudioWorkletProcessor, registerProcessor */

// AudioWorkletGlobalScope has no TextEncoder or TextDecoder, so UTF-8 is done by hand.
function encode(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

function decode(b) {
  let s = "";
  let i = 0;
  while (i < b.length) {
    // Runs of ASCII (all of the telemetry) are converted in blocks.
    let j = i;
    while (j < b.length && b[j] < 0x80 && j - i < 8192) j++;
    if (j > i) {
      s += String.fromCharCode.apply(null, b.subarray(i, j));
      i = j;
      continue;
    }
    const c = b[i];
    let cp;
    if (c >= 0xf0) {
      cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
      i += 4;
    } else if (c >= 0xe0) {
      cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63);
      i += 3;
    } else {
      cp = ((c & 31) << 6) | (b[i + 1] & 63);
      i += 2;
    }
    s += String.fromCodePoint(cp);
  }
  return s;
}
/** Frames per recorded chunk sent to the page (about 85 ms at 48 kHz). */
const REC_CHUNK = 4096;

class MixitProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { module } = options.processorOptions;
    this.e = new WebAssembly.Instance(module, {}).exports;
    this.h = this.e.mx_host_new(sampleRate);
    this.quanta = 0;
    this.every = Math.max(1, Math.round(sampleRate / 128 / 60));
    // Recording: the master output is copied into chunks the page writes to a WAV file.
    this.rec = null;
    this.recAt = 0;
    // Mic: input quanta go into the engine's mic channel; a mic recording is drained from
    // the engine with the telemetry and sent to the page.
    this.mic = false;
    this.micRec = false;
    this.port.onmessage = (ev) => this.message(ev.data);
    this.port.postMessage({ type: "ready", sampleRate });
  }

  text(s) {
    const b = encode(s);
    const p = this.e.mx_alloc_bytes(b.length);
    new Uint8Array(this.e.memory.buffer, p, b.length).set(b);
    return [p, b.length];
  }

  out() {
    return decode(new Uint8Array(this.e.memory.buffer, this.e.mx_out_ptr(), this.e.mx_out_len()));
  }

  /** Copies audio into wasm memory; the engine takes ownership on load. */
  audio(f32) {
    const p = this.e.mx_alloc_f32(f32.length);
    new Float32Array(this.e.memory.buffer, p, f32.length).set(f32);
    return p;
  }

  message(m) {
    let code = 0;
    if (m.type === "call") {
      const [p, l] = this.text(m.json);
      code = this.e.mx_host_call(this.h, p, l);
      this.e.mx_free_bytes(p, l);
    } else if (m.type === "load" || m.type === "loadPad" || m.type === "loadPreview") {
      const a = this.audio(m.audio);
      const [p, l] = this.text(m.json);
      code =
        m.type === "load"
          ? this.e.mx_host_load(this.h, m.deck, a, m.audio.length, p, l)
          : m.type === "loadPad"
            ? this.e.mx_host_load_pad(this.h, m.pad, a, m.audio.length, p, l)
            : this.e.mx_host_load_preview(this.h, a, m.audio.length, p, l);
      this.e.mx_free_bytes(p, l);
    } else if (m.type === "mic") {
      this.mic = !!m.on;
      const [p, l] = this.text(JSON.stringify({ op: m.on ? "micOpen" : "micClose" }));
      code = this.e.mx_host_call(this.h, p, l);
      this.e.mx_free_bytes(p, l);
    } else if (m.type === "micRecord") {
      const [p, l] = this.text(JSON.stringify({ op: "micCapture", on: !!m.on }));
      this.e.mx_host_call(this.h, p, l);
      this.e.mx_free_bytes(p, l);
      if (m.on) {
        this.micRec = true;
      } else {
        this.drainMic();
        this.micRec = false;
        this.port.postMessage({ type: "micDone" });
      }
      return;
    } else if (m.type === "record") {
      if (m.on && !this.rec) {
        this.rec = new Float32Array(REC_CHUNK * 2);
        this.recAt = 0;
      } else if (!m.on && this.rec) {
        this.flush();
        this.rec = null;
      }
      if (!m.on) this.port.postMessage({ type: "recDone" });
      return;
    } else {
      return;
    }
    if (m.id !== undefined) this.port.postMessage({ type: "reply", id: m.id, ok: code === 0, body: this.out() });
  }

  flush() {
    if (!this.rec || this.recAt === 0) return;
    const chunk = this.recAt === this.rec.length ? this.rec : this.rec.slice(0, this.recAt);
    this.port.postMessage({ type: "rec", data: chunk }, [chunk.buffer]);
    this.rec = new Float32Array(REC_CHUNK * 2);
    this.recAt = 0;
  }

  drainMic() {
    const n = this.e.mx_host_capture(this.h);
    if (n > 0) {
      const data = new Float32Array(this.e.memory.buffer, this.e.mx_out_f32_ptr(), n).slice();
      this.port.postMessage({ type: "micData", data }, [data.buffer]);
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    if (!left) return true;
    const right = out[1] || left;
    const n = left.length;
    const input = inputs[0];
    if (this.mic && input && input.length > 0) {
      const il = input[0];
      const ir = input[1] || il;
      const dst = new Float32Array(this.e.memory.buffer, this.e.mx_host_mic_in(this.h), n * 2);
      for (let i = 0; i < n; i++) {
        dst[i * 2] = il[i];
        dst[i * 2 + 1] = ir[i];
      }
      this.e.mx_host_mic_push(this.h, n);
    }
    const p = this.e.mx_host_process(this.h, n);
    const f = new Float32Array(this.e.memory.buffer, p, n * 2);
    for (let i = 0; i < n; i++) {
      left[i] = f[i * 2];
      right[i] = f[i * 2 + 1];
    }
    if (this.rec) {
      this.rec.set(f, this.recAt);
      this.recAt += n * 2;
      if (this.recAt + n * 2 > this.rec.length) this.flush();
    }
    if (++this.quanta % this.every === 0) {
      if (this.micRec) this.drainMic();
      this.e.mx_host_poll(this.h);
      this.port.postMessage({ type: "poll", body: this.out() });
    }
    return true;
  }
}

registerProcessor("mixit", MixitProcessor);
