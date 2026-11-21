//! Delay-based effects: beat-synced echo (classic, ping-pong and dub styles) and a
//! pitch delay whose repeats climb or fall in pitch.

use super::{Effect, FxContext, FxKind, MixMode};
use crate::delay::{DelayLine, StereoDelay};
use crate::smooth::Smoothed;
use crate::svf::{Svf, SvfCoeffs, SvfMode};
use crate::util::{TAU, flush};
use std::f32::consts::FRAC_1_SQRT_2;

/// Longest delay any echo supports (longer beat settings are halved until they fit).
pub const MAX_DELAY_SECONDS: f32 = 6.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EchoStyle {
    Classic,
    PingPong,
    Dub,
}

/// Delay time in frames for `beats` at the context tempo, folded to fit the buffer.
fn beat_delay(beats: f32, ctx: &FxContext, max_frames: f32) -> f32 {
    let mut d = beats * ctx.frames_per_beat();
    while d > max_frames {
        d *= 0.5;
    }
    d.max(16.0)
}

pub struct Echo {
    style: EchoStyle,
    sr: f32,
    buf: StereoDelay,
    max: f32,
    time: Smoothed,
    feedback: Smoothed,
    tone: f32,
    beats: f32,
    lp: [Svf; 2],
    hp: [Svf; 2],
    lpc: SvfCoeffs,
    hpc: SvfCoeffs,
    wow: f32,
}

impl Echo {
    pub fn new(sr: f32, style: EchoStyle) -> Echo {
        let max_frames = (MAX_DELAY_SECONDS * sr) as usize;
        let mut e = Echo {
            style,
            sr,
            buf: StereoDelay::new(max_frames + 8),
            max: max_frames as f32,
            time: Smoothed::new(sr * 0.25, 60.0, sr),
            feedback: Smoothed::new(0.45, 20.0, sr),
            tone: 0.5,
            beats: 0.75,
            lp: [Svf::default(); 2],
            hp: [Svf::default(); 2],
            lpc: SvfCoeffs::design(SvfMode::Lowpass, 18_000.0, FRAC_1_SQRT_2, 0.0, sr),
            hpc: SvfCoeffs::design(SvfMode::Highpass, 20.0, FRAC_1_SQRT_2, 0.0, sr),
            wow: 0.0,
        };
        e.update_tone();
        e
    }

    fn update_tone(&mut self) {
        // Tone below 0.5 darkens the repeats, above 0.5 thins them.
        let t = self.tone;
        let (lp, hp) = match self.style {
            EchoStyle::Dub => (1_200.0 + 3_000.0 * t, 120.0 + 300.0 * t),
            _ => {
                if t < 0.5 {
                    (1_000.0 * (18.0f32).powf(t * 2.0), 20.0)
                } else {
                    (18_000.0, 20.0 * (100.0f32).powf((t - 0.5) * 2.0))
                }
            }
        };
        self.lpc = SvfCoeffs::design(SvfMode::Lowpass, lp, FRAC_1_SQRT_2, 0.0, self.sr);
        self.hpc = SvfCoeffs::design(SvfMode::Highpass, hp, FRAC_1_SQRT_2, 0.0, self.sr);
    }
}

impl Effect for Echo {
    fn kind(&self) -> FxKind {
        match self.style {
            EchoStyle::Classic => FxKind::Echo,
            EchoStyle::PingPong => FxKind::PingPong,
            EchoStyle::Dub => FxKind::DubEcho,
        }
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Send
    }
    fn reset(&mut self) {
        self.buf.clear();
        for f in self.lp.iter_mut().chain(self.hp.iter_mut()) {
            f.reset();
        }
    }
    fn set_param(&mut self, index: usize, v: f32) {
        match index {
            0 => {
                let max_fb = if self.style == EchoStyle::Dub { 1.05 } else { 0.95 };
                self.feedback.set(v.clamp(0.0, 1.0) * max_fb);
            }
            1 => {
                self.tone = v.clamp(0.0, 1.0);
                self.update_tone();
            }
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 64.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        self.time.set(beat_delay(self.beats, ctx, self.max - 8.0));
        let wow_inc = TAU * 0.4 / self.sr;
        for i in 0..l.len() {
            let mut d = self.time.next();
            let fb = self.feedback.next();
            if self.style == EchoStyle::Dub {
                self.wow = (self.wow + wow_inc) % TAU;
                d *= 1.0 + 0.002 * self.wow.sin();
            }
            let wl = self.buf.l.read(d);
            let wr = self.buf.r.read(d);
            let mut fl = self.hp[0].process(&self.hpc, self.lp[0].process(&self.lpc, wl)) * fb;
            let mut fr = self.hp[1].process(&self.hpc, self.lp[1].process(&self.lpc, wr)) * fb;
            if self.style == EchoStyle::Dub {
                fl = fl.tanh();
                fr = fr.tanh();
            }
            let (xl, xr) = (l[i], r[i]);
            match self.style {
                EchoStyle::PingPong => {
                    // Mono input enters the left line; the lines feed each other.
                    self.buf.l.push(flush(0.5 * (xl + xr) + fr));
                    self.buf.r.push(flush(fl));
                }
                _ => {
                    self.buf.l.push(flush(xl + fl));
                    self.buf.r.push(flush(xr + fr));
                }
            }
            l[i] = wl;
            r[i] = wr;
        }
    }
}

/// A two-head delay-line pitch shifter (rotating taps with crossfades).
#[derive(Clone, Debug)]
struct Shifter {
    line: DelayLine,
    phase: f32,
    window: f32,
}

impl Shifter {
    fn new(window: f32) -> Shifter {
        Shifter { line: DelayLine::new(window as usize * 2 + 8), phase: 0.0, window }
    }

    #[inline]
    fn process(&mut self, x: f32, ratio: f32) -> f32 {
        self.line.push(x);
        // Each head's delay sweeps through the window at (1 − ratio) frames per frame.
        self.phase = (self.phase + (1.0 - ratio) / self.window).rem_euclid(1.0);
        let p2 = (self.phase + 0.5) % 1.0;
        let d1 = 2.0 + self.phase * self.window;
        let d2 = 2.0 + p2 * self.window;
        let g1 = (std::f32::consts::PI * self.phase).sin();
        let g2 = (std::f32::consts::PI * p2).sin();
        self.line.read(d1) * g1 * g1 + self.line.read(d2) * g2 * g2
    }

    fn clear(&mut self) {
        self.line.clear();
    }
}

/// Echo whose every repeat is shifted in pitch (p2: −12 … +12 semitones).
pub struct PitchDelay {
    echo: StereoDelay,
    max: f32,
    time: Smoothed,
    feedback: Smoothed,
    ratio: f32,
    beats: f32,
    shift: [Shifter; 2],
}

impl PitchDelay {
    pub fn new(sr: f32) -> PitchDelay {
        let max = (MAX_DELAY_SECONDS * sr) as usize;
        PitchDelay {
            echo: StereoDelay::new(max + 8),
            max: max as f32,
            time: Smoothed::new(sr * 0.25, 60.0, sr),
            feedback: Smoothed::new(0.5, 20.0, sr),
            ratio: 2f32.powf(5.0 / 12.0),
            beats: 0.5,
            shift: [Shifter::new(sr * 0.04), Shifter::new(sr * 0.04)],
        }
    }
}

impl Effect for PitchDelay {
    fn kind(&self) -> FxKind {
        FxKind::PitchDelay
    }
    fn mix_mode(&self) -> MixMode {
        MixMode::Send
    }
    fn reset(&mut self) {
        self.echo.clear();
        for s in &mut self.shift {
            s.clear();
        }
    }
    fn set_param(&mut self, index: usize, v: f32) {
        match index {
            0 => self.feedback.set(v.clamp(0.0, 1.0) * 0.9),
            1 => self.ratio = 2f32.powf(((v.clamp(0.0, 1.0) - 0.5) * 24.0).round() / 12.0),
            _ => {}
        }
    }
    fn set_beats(&mut self, beats: f32) {
        self.beats = beats.max(1.0 / 64.0);
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32], ctx: &FxContext) {
        self.time.set(beat_delay(self.beats, ctx, self.max - 8.0));
        for i in 0..l.len() {
            let d = self.time.next();
            let fb = self.feedback.next();
            let wl = self.echo.l.read(d);
            let wr = self.echo.r.read(d);
            let sl = self.shift[0].process(wl, self.ratio);
            let sr_ = self.shift[1].process(wr, self.ratio);
            self.echo.l.push(flush(l[i] + sl * fb));
            self.echo.r.push(flush(r[i] + sr_ * fb));
            l[i] = sl;
            r[i] = sr_;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_delay_matches_beat_length() {
        let sr = 48_000.0;
        let mut e = Echo::new(sr, EchoStyle::Classic);
        e.set_beats(1.0);
        e.set_param(0, 0.0);
        let ctx = FxContext::free(sr, 120.0); // one beat = 24,000 frames
        // Settle the smoothed delay time first.
        let mut l = vec![0.0f32; 4_800];
        let mut r = l.clone();
        e.process(&mut l, &mut r, &ctx);
        let mut l = vec![0.0f32; 48_000];
        l[0] = 1.0;
        let mut r = l.clone();
        e.process(&mut l, &mut r, &ctx);
        let (idx, _) = l.iter().enumerate().fold((0, 0.0f32), |b, (i, v)| if v.abs() > b.1 { (i, v.abs()) } else { b });
        assert!((idx as i64 - 24_000).abs() <= 1, "echo at {idx}");
    }
}
