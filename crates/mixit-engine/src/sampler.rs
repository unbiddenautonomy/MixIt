//! Sampler pads: one-shots, gated hits and tempo-locked loops.

use std::sync::Arc;

use mixit_dsp::curves::{PanLaw, pan_gains};
use mixit_dsp::interp::hermite_stereo;
use mixit_dsp::ramp::MicroFade;
use mixit_dsp::smooth::Smoothed;
use mixit_dsp::util::db_to_gain;

use crate::commands::{PadMode, SamplerCommand};
use crate::telemetry::{Event, EventSink};
use crate::track::TrackAudio;
use crate::trash::{Trash, TrashBin};

pub const MAX_PADS: usize = 16;

struct Pad {
    audio: Option<Arc<TrackAudio>>,
    bpm: Option<f64>,
    mode: PadMode,
    gain: f32,
    pan: f32,
    sync: bool,
    quantized: bool,
    playing: bool,
    pos: f64,
    /// Frames to wait before starting (quantised trigger).
    delay: Option<u64>,
    fade: MicroFade,
}

impl Pad {
    fn new(sr: f32) -> Pad {
        Pad {
            audio: None,
            bpm: None,
            mode: PadMode::OneShot,
            gain: 1.0,
            pan: 0.0,
            sync: true,
            quantized: true,
            playing: false,
            pos: 0.0,
            delay: None,
            fade: MicroFade::new((0.002 * sr) as u32, false),
        }
    }
}

pub struct Sampler {
    pads: Vec<Pad>,
    volume: Smoothed,
}

/// Musical timing for pad triggers and tempo-locked loops.
#[derive(Clone, Copy, Debug)]
pub struct SamplerEnv {
    pub clock_bpm: f64,
    pub clock_beat: f64,
    pub beats_per_frame: f64,
    pub quantize: Option<f64>,
}

impl Sampler {
    pub fn new(sr: f32, pads: usize) -> Sampler {
        Sampler { pads: (0..pads.min(MAX_PADS)).map(|_| Pad::new(sr)).collect(), volume: Smoothed::new(0.8, 20.0, sr) }
    }

    pub fn playing_mask(&self) -> u32 {
        self.pads.iter().enumerate().fold(0, |m, (i, p)| if p.playing || p.delay.is_some() { m | (1 << i) } else { m })
    }

    fn trigger(&mut self, i: usize, env: &SamplerEnv) {
        let p = &mut self.pads[i];
        if p.audio.is_none() {
            return;
        }
        if p.mode == PadMode::Loop && (p.playing || p.delay.is_some()) {
            // Loop pads toggle.
            p.fade.fade_out();
            p.delay = None;
            return;
        }
        p.pos = 0.0;
        match (p.quantized, env.quantize) {
            (true, Some(q)) if env.beats_per_frame > 0.0 => {
                let q = q.min(1.0);
                let next = (env.clock_beat / q).ceil() * q;
                let wait = ((next - env.clock_beat) / env.beats_per_frame).round().max(0.0) as u64;
                p.delay = Some(wait);
            }
            _ => {
                p.delay = None;
                p.playing = true;
                p.fade.set_open(false);
                p.fade.fade_in();
            }
        }
    }

    pub fn handle(&mut self, cmd: SamplerCommand, env: &SamplerEnv, trash: &mut TrashBin, ev: &mut EventSink) {
        use SamplerCommand as S;
        let n = self.pads.len();
        match cmd {
            S::Load { pad, audio, bpm } if pad < n => {
                let p = &mut self.pads[pad];
                let old = p.audio.replace(audio);
                trash.put_opt(old, Trash::Audio);
                p.bpm = bpm;
                p.playing = false;
                p.delay = None;
                p.fade.set_open(false);
            }
            S::Unload(pad) if pad < n => {
                let p = &mut self.pads[pad];
                let old = p.audio.take();
                trash.put_opt(old, Trash::Audio);
                p.playing = false;
                p.delay = None;
            }
            S::Down(pad) if pad < n => {
                self.trigger(pad, env);
                if self.pads[pad].playing {
                    ev.send(Event::PadStarted { pad });
                }
            }
            S::Up(pad) if pad < n => {
                let p = &mut self.pads[pad];
                if p.mode == PadMode::Gate {
                    p.fade.fade_out();
                    p.delay = None;
                }
            }
            S::Stop(pad) if pad < n => {
                self.pads[pad].fade.fade_out();
                self.pads[pad].delay = None;
            }
            S::StopAll => {
                for p in &mut self.pads {
                    p.fade.fade_out();
                    p.delay = None;
                }
            }
            S::SetMode(pad, m) if pad < n => self.pads[pad].mode = m,
            S::SetGainDb(pad, db) if pad < n => self.pads[pad].gain = db_to_gain(db.clamp(-60.0, 12.0)),
            S::SetPan(pad, x) if pad < n => self.pads[pad].pan = x.clamp(-1.0, 1.0),
            S::SetSync(pad, on) if pad < n => self.pads[pad].sync = on,
            S::SetQuantized(pad, on) if pad < n => self.pads[pad].quantized = on,
            S::SetVolume(v) => self.volume.set(v.clamp(0.0, 1.0)),
            _ => {}
        }
    }

    /// Adds the pads' output to the master bus.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], n: usize, env: &SamplerEnv, ev: &mut EventSink) {
        let vol_start = self.volume.value();
        let vol_end = self.volume.advance(n as u32);
        for (idx, p) in self.pads.iter_mut().enumerate() {
            let Some(audio) = p.audio.as_ref() else { continue };
            let mut start = 0usize;
            if let Some(d) = p.delay {
                if d >= n as u64 {
                    p.delay = Some(d - n as u64);
                    continue;
                }
                start = d as usize;
                p.delay = None;
                p.playing = true;
                p.pos = 0.0;
                p.fade.set_open(false);
                p.fade.fade_in();
                ev.send(Event::PadStarted { pad: idx });
            }
            if !p.playing {
                continue;
            }
            let step = match (p.sync, p.bpm, p.mode) {
                (true, Some(b), PadMode::Loop) if b > 0.0 => (env.clock_bpm / b).clamp(0.25, 4.0),
                _ => 1.0,
            };
            let frames = audio.frames();
            let len = frames as f64;
            let (gl, gr) = pan_gains(p.pan, PanLaw::Minus3);
            for i in start..n {
                if p.pos >= len {
                    if p.mode == PadMode::Loop {
                        p.pos -= len;
                    } else {
                        p.playing = false;
                        break;
                    }
                }
                let (l, r) = hermite_stereo(&audio.data, frames, p.pos);
                let v = vol_start + (vol_end - vol_start) * (i as f32 / n as f32);
                let g = p.fade.next() * p.gain * v;
                out_l[i] += l * g * gl;
                out_r[i] += r * g * gr;
                p.pos += step;
                if p.fade.is_silent() {
                    p.playing = false;
                    break;
                }
            }
            if !p.playing {
                ev.send(Event::PadStopped { pad: idx });
            }
        }
    }
}
