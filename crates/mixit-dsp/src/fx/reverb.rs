//! Algorithmic reverb: an 8-line feedback delay network with a Hadamard mixing
//! matrix, per-line frequency-dependent decay, input diffusion and slow modulation.
//!
//! * p1: decay time (0.3 s … 12 s; the top of the range freezes the tail).
//! * p2: tone (dark … bright damping).
//! * beats: pre-delay (a quarter of the beat length, capped at 120 ms).

use super::{Effect, FxContext, FxKind, MixMode};
use crate::delay::DelayLine;
use crate::smooth::Smoothed;
use crate::util::{TAU, flush};

const LINES: usize = 8;
const LINE_MS: [f32; LINES] = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
const DIFFUSER_MS: [f32; 4] = [4.7, 3.6, 12.7, 9.3];

#[derive(Clone, Debug)]
struct Allpass {
    line: DelayLine,
    d: usize,
    g: f32,
}

impl Allpass {
    fn new(frames: usize, g: f32) -> Allpass {
        Allpass { line: DelayLine::new(frames + 2), d: frames.max(1), g }
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let delayed = self.line.tap(self.d);
        let v = x + self.g * delayed;
        self.line.push(flush(v));
        delayed - self.g * v
    }
}

pub struct Reverb {
    sr: f32,
    lines: Vec<DelayLine>,
    len: [f32; LINES],
    damp_state: [f32; LINES],
    gains: [f32; LINES],
    damp: f32,
    diff_l: Vec<Allpass>,
    diff_r: Vec<Allpass>,
    pre: [DelayLine; 2],
    pre_frames: Smoothed,
    decay_s: f32,
    freeze: bool,
    lfo: f32,
    beats: f32,
    input_gain: Smoothed,
}

impl Reverb {
    pub fn new(sr: f32) -> Reverb {
        let scale = sr / 1000.0;
        let len = LINE_MS.map(|ms| ms * scale);
        let lines = len.iter().map(|&l| DelayLine::new(l as usize + 64)).collect();
        let mk = |ms: &[f32], g: f32| ms.iter().map(|&m| Allpass::new((m * scale) as usize, g)).collect::<Vec<_>>();
        let mut r = Reverb {
            sr,
            lines,
            len,
            damp_state: [0.0; LINES],
            gains: [0.0; LINES],
            damp: 0.3,
            diff_l: mk(&DIFFUSER_MS, 0.7),
            diff_r: mk(&[5.3, 3.1, 11.9, 8.7], 0.7),
            pre: [DelayLine::new((0.13 * sr) as usize), DelayLine::new((0.13 * sr) as usize)],
            pre_frames: Smoothed::new(0.02 * sr, 50.0, sr),
            decay_s: 2.5,
            freeze: false,
            lfo: 0.0,
            beats: 0.25,
            input_gain: Smoothed::new(1.0, 30.0, sr),
        };
        r.update_gains();
        r
    }

    fn update_gains(&mut self) {
        for i in 0..LINES {
            self.gains[i] = if self.freeze { 1.0 } else { 10f32.powf(-3.0 * self.len[i] / (self.decay_s * self.sr)) };
        }
    }
}

impl Effect for Reverb {
    fn kind(&self) -> FxKind {
        FxKind::Reverb
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Send
    }
    fn reset(&mut self) {
        for l in &mut self.lines {
            l.clear();
        }
        for p in &mut self.pre {
            p.clear();
        }
        for a in self.diff_l.iter_mut().chain(self.diff_r.iter_mut()) {
            a.line.clear();
        }
        self.damp_state = [0.0; LINES];
    }
    fn set_param(&mut self, index: usize, v: f32) {
        let v = v.clamp(0.0, 1.0);
        match index {
            0 => {
                self.freeze = v >= 0.995;
                self.input_gain.set(if self.freeze { 0.0 } else { 1.0 });
                self.decay_s = 0.3 * (40.0f32).powf(v);
                self.update_gains();
            }
            1 => self.damp = 0.85 - 0.8 * v,
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats;
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        let pre = (self.beats * 0.25 * ctx.frames_per_beat()).min(0.12 * self.sr).max(1.0);
        self.pre_frames.set(pre);
        let lfo_inc = TAU * 0.3 / self.sr;
        let damp = if self.freeze { 0.0 } else { self.damp };
        let norm = 1.0 / (LINES as f32).sqrt();
        for i in 0..l.len() {
            let g_in = self.input_gain.next();
            let pd = self.pre_frames.next();
            self.pre[0].push(l[i] * g_in);
            self.pre[1].push(r[i] * g_in);
            let mut il = self.pre[0].read(pd);
            let mut ir = self.pre[1].read(pd);
            for a in &mut self.diff_l {
                il = a.process(il);
            }
            for a in &mut self.diff_r {
                ir = a.process(ir);
            }
            self.lfo = (self.lfo + lfo_inc) % TAU;
            let m = self.lfo.sin() * 6.0;
            // Read every line (two are slowly modulated to break up ringing).
            let mut y = [0.0f32; LINES];
            for k in 0..LINES {
                let d = self.len[k]
                    + if k == 0 {
                        m
                    } else if k == 4 {
                        -m
                    } else {
                        0.0
                    };
                let v = self.lines[k].read(d);
                self.damp_state[k] = flush(v + damp * (self.damp_state[k] - v));
                y[k] = self.damp_state[k] * self.gains[k];
            }
            // Fast Walsh–Hadamard transform (8 points), normalised.
            let mut h = y;
            let mut step = 1;
            while step < LINES {
                for j in (0..LINES).step_by(step * 2) {
                    for k in j..j + step {
                        let (a, b) = (h[k], h[k + step]);
                        h[k] = a + b;
                        h[k + step] = a - b;
                    }
                }
                step *= 2;
            }
            for k in 0..LINES {
                let inject = if k < 4 { il } else { ir };
                let sign = if k % 2 == 0 { 1.0 } else { -1.0 };
                self.lines[k].push(flush(h[k] * norm + inject * sign * 0.5));
            }
            l[i] = (y[0] - y[2] + y[5] + y[7]) * 0.5;
            r[i] = (y[1] + y[3] - y[4] + y[6]) * 0.5;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_time_is_close_to_setting() {
        let sr = 48_000.0;
        let mut rv = Reverb::new(sr);
        // decay = 0.3 · 40^v; v ≈ 0.5 → about 1.9 s.
        rv.set_param(0, 0.5);
        let target = rv.decay_s;
        let ctx = FxContext::free(sr, 120.0);
        let mut energies = Vec::new();
        let block = 4_800;
        for b in 0..60 {
            let mut l = vec![0.0f32; block];
            let mut r = vec![0.0f32; block];
            if b == 0 {
                for v in l.iter_mut().take(480) {
                    *v = 0.5;
                }
                r.copy_from_slice(&l);
            }
            rv.process(&mut l, &mut r, &ctx);
            let e: f32 = l.iter().map(|v| v * v).sum::<f32>() / block as f32;
            energies.push(10.0 * e.max(1e-30).log10());
        }
        // Fit the decay slope between 0.5 s and 2.5 s.
        let a = energies[5];
        let b = energies[25];
        let slope_db_per_s = (a - b) / 2.0;
        let t60 = 60.0 / slope_db_per_s;
        assert!((t60 - target).abs() / target < 0.25, "T60 {t60} vs {target}");
    }
}
