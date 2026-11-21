//! Sampler pads: one-shots, gated hits and tempo-locked loops, and a step sequencer that
//! plays them in time with the master clock.
//!
//! The sequencer is sample-accurate: each block it finds the steps whose time (on the
//! master clock's beat count, plus swing) falls inside the block and starts those pads
//! at that exact frame. A pad that is still sounding when it is retriggered keeps a short
//! tail that fades out over 2 ms under the new hit, so fast patterns do not click.

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
/// Most steps in a sequencer pattern.
pub const MAX_STEPS: u8 = 64;

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
    /// Sequencer steps this pad plays (bit n = step n).
    pattern: u64,
    /// Stopped during the current block (reported once).
    stopped_now: bool,
    /// The previous hit, fading out under a retrigger: position and frames left.
    tail_pos: f64,
    tail_left: u32,
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
            pattern: 0,
            stopped_now: false,
            tail_pos: 0.0,
            tail_left: 0,
        }
    }
}

pub struct Sampler {
    pads: Vec<Pad>,
    volume: Smoothed,
    seq: Sequencer,
    /// Frames of fade before a retrigger.
    retrigger_fade: u32,
}

#[derive(Clone, Copy, Debug)]
struct Sequencer {
    on: bool,
    steps: u8,
    step_beats: f64,
    swing: f64,
    /// Clock beat where the last block ended (to stay continuous across blocks).
    last: f64,
    step: i16,
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
        Sampler {
            pads: (0..pads.min(MAX_PADS)).map(|_| Pad::new(sr)).collect(),
            volume: Smoothed::new(0.8, 20.0, sr),
            seq: Sequencer { on: false, steps: 16, step_beats: 0.25, swing: 0.0, last: f64::NAN, step: -1 },
            retrigger_fade: (0.002 * sr).max(1.0) as u32,
        }
    }

    /// The step the sequencer is on, or -1 when it is off.
    pub fn sequencer_step(&self) -> i16 {
        if self.seq.on { self.seq.step } else { -1 }
    }

    /// Starts the pads of every sequencer step that falls in this block, at its frame.
    fn sequence(&mut self, n: usize, env: &SamplerEnv) {
        let q = &mut self.seq;
        if !q.on || env.beats_per_frame <= 0.0 || q.steps == 0 {
            q.last = f64::NAN;
            return;
        }
        let b1 = env.clock_beat + env.beats_per_frame * n as f64;
        // Carry on from where the last block ended unless the clock jumped (a seek or a
        // loop), so no step is played twice or skipped at block edges.
        let b0 = if q.last.is_finite() && (env.clock_beat - q.last).abs() < 0.05 { q.last } else { env.clock_beat };
        q.last = b1;
        if b1 <= b0 {
            return;
        }
        let sb = q.step_beats;
        let swing = q.swing * sb;
        let steps = q.steps as i64;
        let first = (b0 / sb).floor() as i64 - 1;
        let last = (b1 / sb).floor() as i64;
        for k in first..=last {
            let t = k as f64 * sb + if k.rem_euclid(2) == 1 { swing } else { 0.0 };
            if t < b0 || t >= b1 {
                continue;
            }
            let step = k.rem_euclid(steps) as u32;
            q.step = step as i16;
            let at = (((t - env.clock_beat) / env.beats_per_frame).round().max(0.0) as u64).min(n as u64 - 1);
            for p in self.pads.iter_mut() {
                if p.audio.is_some() && p.pattern >> step & 1 == 1 {
                    p.delay = Some(at);
                }
            }
        }
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
        // A quantised hit starts later (the pad keeps sounding until then); an immediate
        // one restarts now.
        match (p.quantized, env.quantize) {
            (true, Some(q)) if env.beats_per_frame > 0.0 => {
                let q = q.min(1.0);
                let next = (env.clock_beat / q).ceil() * q;
                let wait = ((next - env.clock_beat) / env.beats_per_frame).round().max(0.0) as u64;
                p.delay = Some(wait);
            }
            _ => {
                p.delay = None;
                p.pos = 0.0;
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
            S::SeqPattern { pad, steps } if pad < n => self.pads[pad].pattern = steps,
            S::SeqSettings { on, steps, step_beats, swing } => {
                let q = &mut self.seq;
                if on && !q.on {
                    q.last = f64::NAN;
                }
                q.on = on;
                q.steps = steps.clamp(1, MAX_STEPS);
                q.step_beats = step_beats.clamp(1.0 / 16.0, 4.0);
                q.swing = swing.clamp(0.0, 0.5) as f64;
                if !on {
                    q.step = -1;
                }
            }
            _ => {}
        }
    }

    /// Playback speed: tempo-locked loops follow the clock, everything else plays as is.
    fn step_for(sync: bool, bpm: Option<f64>, mode: PadMode, clock_bpm: f64) -> f64 {
        match (sync, bpm, mode) {
            (true, Some(b), PadMode::Loop) if b > 0.0 => (clock_bpm / b).clamp(0.25, 4.0),
            _ => 1.0,
        }
    }

    /// Adds the pads' output to the master bus.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], n: usize, env: &SamplerEnv, ev: &mut EventSink) {
        self.sequence(n, env);
        let vol_start = self.volume.value();
        let vol_end = self.volume.advance(n as u32);
        let xf = self.retrigger_fade;
        for (idx, p) in self.pads.iter_mut().enumerate() {
            let Some(audio) = p.audio.clone() else { continue };
            // Where in this block the pad (re)starts, if it does.
            let restart = match p.delay {
                Some(d) if d < n as u64 => Some(d as usize),
                Some(d) => {
                    p.delay = Some(d - n as u64);
                    None
                }
                None => None,
            };
            let ctx = Voice { audio: &audio, vol_start, vol_end, n, clock_bpm: env.clock_bpm, tail_frames: xf };
            match restart {
                None => {
                    if p.playing {
                        render_voice(p, &ctx, 0, n, out_l, out_r);
                    }
                }
                Some(at) => {
                    // The sound already playing runs up to the restart, then fades out under
                    // the new hit so the retrigger does not click.
                    if p.playing {
                        render_voice(p, &ctx, 0, at, out_l, out_r);
                        if p.playing {
                            p.tail_pos = p.pos;
                            p.tail_left = xf;
                        }
                    }
                    p.delay = None;
                    p.playing = true;
                    p.pos = 0.0;
                    p.fade.set_open(false);
                    p.fade.fade_in();
                    ev.send(Event::PadStarted { pad: idx });
                    render_voice(p, &ctx, at, n, out_l, out_r);
                }
            }
            if p.stopped_now {
                p.stopped_now = false;
                ev.send(Event::PadStopped { pad: idx });
            }
        }
    }
}

/// What a pad needs to render a stretch of a block.
struct Voice<'a> {
    audio: &'a Arc<TrackAudio>,
    vol_start: f32,
    vol_end: f32,
    n: usize,
    clock_bpm: f64,
    tail_frames: u32,
}

/// Renders frames `from..to` of a pad (and any fading tail of its previous hit) into the bus.
fn render_voice(p: &mut Pad, v: &Voice, from: usize, to: usize, out_l: &mut [f32], out_r: &mut [f32]) {
    let frames = v.audio.frames();
    let len = frames as f64;
    let (gl, gr) = pan_gains(p.pan, PanLaw::Minus3);
    let step = Sampler::step_for(p.sync, p.bpm, p.mode, v.clock_bpm);
    for i in from..to {
        if p.pos >= len {
            if p.mode == PadMode::Loop {
                p.pos -= len;
            } else {
                p.playing = false;
                p.stopped_now = true;
                return;
            }
        }
        let (mut l, mut r) = hermite_stereo(&v.audio.data, frames, p.pos);
        let vol = v.vol_start + (v.vol_end - v.vol_start) * (i as f32 / v.n as f32);
        let g = p.fade.next() * p.gain * vol;
        l *= g;
        r *= g;
        if p.tail_left > 0 {
            let k = p.tail_left as f32 / v.tail_frames.max(1) as f32;
            if p.tail_pos < len {
                let (tl, tr) = hermite_stereo(&v.audio.data, frames, p.tail_pos);
                l += tl * p.gain * vol * k;
                r += tr * p.gain * vol * k;
            }
            p.tail_pos += step;
            p.tail_left -= 1;
        }
        out_l[i] += l * gl;
        out_r[i] += r * gr;
        p.pos += step;
        if p.fade.is_silent() {
            p.playing = false;
            p.stopped_now = true;
            return;
        }
    }
}
