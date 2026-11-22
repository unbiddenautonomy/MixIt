//! The preview player: listen to a track from the library in the headphones without
//! loading it on a deck, the way a DJ checks the next record while the set plays.
//!
//! It plays at the track's own speed, straight to the headphones (or to the speakers when
//! there are no separate headphones). It never reaches the master bus, so it is not in a
//! recording and does not move the loudness meters. Starts, stops and jumps fade over a
//! few milliseconds so they never click.

use std::sync::Arc;

use mixit_dsp::ramp::MicroFade;
use mixit_dsp::smooth::Smoothed;

use crate::track::TrackAudio;
use crate::trash::{Trash, TrashBin};

/// Where the preview is heard.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PreviewRoute {
    /// The headphone (cue) output.
    #[default]
    Headphones,
    /// The main output, for a laptop with no separate headphone output.
    Speakers,
}

#[derive(Debug)]
pub enum PreviewCommand {
    /// Puts a track in the player (stopped, at `start` frames).
    Load(Arc<TrackAudio>, f64),
    /// Takes the track out.
    Unload,
    Play(bool),
    /// Jumps to a frame.
    Seek(f64),
    /// Linear gain.
    SetGain(f32),
    SetRoute(PreviewRoute),
}

pub struct Previewer {
    audio: Option<Arc<TrackAudio>>,
    pos: f64,
    playing: bool,
    /// A jump waiting for the fade-out to finish.
    pending_seek: Option<f64>,
    /// Stop once the fade-out finishes.
    stopping: bool,
    fade: MicroFade,
    gain: Smoothed,
    pub route: PreviewRoute,
    pub out_l: Vec<f32>,
    pub out_r: Vec<f32>,
    /// Set when the track played to its end (cleared by the next snapshot).
    pub ended: bool,
}

impl Previewer {
    pub fn new(sr: f32, block: usize) -> Previewer {
        Previewer {
            audio: None,
            pos: 0.0,
            playing: false,
            pending_seek: None,
            stopping: false,
            fade: MicroFade::new((sr * 0.004) as u32, false),
            gain: Smoothed::new(0.8, 20.0, sr),
            route: PreviewRoute::Headphones,
            out_l: vec![0.0; block],
            out_r: vec![0.0; block],
            ended: false,
        }
    }

    pub fn handle(&mut self, cmd: PreviewCommand, trash: &mut TrashBin) {
        match cmd {
            PreviewCommand::Load(audio, start) => {
                let frames = audio.frames() as f64;
                trash.put_opt(self.audio.replace(audio), Trash::Audio);
                self.pos = start.clamp(0.0, frames);
                self.playing = false;
                self.stopping = false;
                self.pending_seek = None;
                self.fade.set_open(false);
                self.ended = false;
            }
            PreviewCommand::Unload => {
                trash.put_opt(self.audio.take(), Trash::Audio);
                self.playing = false;
                self.fade.set_open(false);
            }
            PreviewCommand::Play(on) => {
                if self.audio.is_none() {
                    return;
                }
                if on {
                    if self.at_end() {
                        self.pos = 0.0;
                    }
                    self.playing = true;
                    self.stopping = false;
                    self.ended = false;
                    self.fade.fade_in();
                } else if self.playing {
                    self.stopping = true;
                    self.fade.fade_out();
                }
            }
            PreviewCommand::Seek(f) => {
                let Some(a) = &self.audio else { return };
                let f = f.clamp(0.0, a.frames() as f64);
                if self.playing && !self.stopping {
                    self.pending_seek = Some(f);
                    self.fade.fade_out();
                } else {
                    self.pos = f;
                    self.pending_seek = None;
                }
            }
            PreviewCommand::SetGain(g) => self.gain.set(g.clamp(0.0, 2.0)),
            PreviewCommand::SetRoute(r) => self.route = r,
        }
    }

    fn at_end(&self) -> bool {
        self.audio.as_ref().is_none_or(|a| self.pos >= a.frames() as f64 - 1.0)
    }

    pub fn is_loaded(&self) -> bool {
        self.audio.is_some()
    }

    pub fn is_playing(&self) -> bool {
        self.playing && !self.stopping
    }

    /// Position in frames.
    pub fn position(&self) -> f64 {
        self.pending_seek.unwrap_or(self.pos)
    }

    pub fn frames(&self) -> f64 {
        self.audio.as_ref().map_or(0.0, |a| a.frames() as f64)
    }

    /// Renders `n` frames into `out_l`/`out_r` (silence when stopped). Returns whether
    /// anything was written.
    pub fn render(&mut self, n: usize) -> bool {
        if !self.playing {
            return false;
        }
        let Some(audio) = &self.audio else {
            self.playing = false;
            return false;
        };
        let data = &audio.data;
        let frames = audio.frames();
        for i in 0..n {
            let g = self.fade.next() * self.gain.next();
            let p = self.pos as usize;
            let (l, r) = if p < frames { (data[2 * p], data[2 * p + 1]) } else { (0.0, 0.0) };
            self.out_l[i] = l * g;
            self.out_r[i] = r * g;
            if p < frames {
                self.pos += 1.0;
            }
            if self.fade.is_silent() {
                if let Some(s) = self.pending_seek.take() {
                    self.pos = s;
                    self.fade.fade_in();
                } else if self.stopping {
                    self.playing = false;
                    self.stopping = false;
                    for j in i + 1..n {
                        self.out_l[j] = 0.0;
                        self.out_r[j] = 0.0;
                    }
                    break;
                }
            }
        }
        if self.playing && self.pos as usize >= frames {
            self.playing = false;
            self.fade.set_open(false);
            self.ended = true;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bin() -> (TrashBin, rtrb::Consumer<Trash>) {
        let (tx, rx) = rtrb::RingBuffer::new(8);
        (TrashBin::new(tx), rx)
    }

    #[test]
    fn plays_seeks_and_stops_without_clicks() {
        let sr = 48_000.0;
        let mut p = Previewer::new(sr, 512);
        let (mut t, _rx) = bin();
        let audio = Arc::new(TrackAudio::new(48_000, vec![0.5; 48_000 * 2]));
        p.handle(PreviewCommand::Load(audio, 0.0), &mut t);
        p.handle(PreviewCommand::SetGain(1.0), &mut t);
        assert!(!p.render(512), "stopped until played");
        p.handle(PreviewCommand::Play(true), &mut t);
        // Gain smoothing and the fade both start from their current value: let them settle.
        for _ in 0..20 {
            p.render(512);
        }
        assert!((p.out_l[511] - 0.5).abs() < 1e-3);
        let before = p.position();
        p.handle(PreviewCommand::Seek(10_000.0), &mut t);
        assert_eq!(p.position(), 10_000.0);
        p.render(512);
        // The jump happened after the fade-out, and the level never stepped.
        let step = p.out_l[..512].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(step < 0.01, "step {step}");
        assert!(p.position() > 10_000.0 && p.position() < 10_512.0, "{} after {before}", p.position());
        p.handle(PreviewCommand::Play(false), &mut t);
        p.render(512);
        assert!(!p.is_playing());
        assert!(!p.render(512));
    }

    #[test]
    fn reports_the_end_and_restarts_from_the_top() {
        let mut p = Previewer::new(48_000.0, 512);
        let (mut t, _rx) = bin();
        p.handle(PreviewCommand::Load(Arc::new(TrackAudio::new(48_000, vec![0.1; 1_000 * 2])), 0.0), &mut t);
        p.handle(PreviewCommand::Play(true), &mut t);
        p.render(512);
        p.render(512);
        assert!(p.ended && !p.is_playing());
        p.handle(PreviewCommand::Play(true), &mut t);
        assert_eq!(p.position(), 0.0);
        assert!(p.is_playing());
    }
}
