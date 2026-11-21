//! The preview player: listen to a track from the library in the headphones without
//! loading it on a deck, the way a DJ checks the next record while the set plays.
//!
//! It plays at the track's own speed, straight to the headphones (or to the speakers when
//! there are no separate headphones). It never reaches the master bus, so it is not in a
//! recording and does not move the loudness meters. Starts, stops and jumps fade over a
//! few milliseconds so they never click.

use std::sync::Arc;

use mixit_core::Beatgrid;
use mixit_dsp::interp::hermite_stereo;
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
    /// Puts a track in the player (stopped, at `start` frames), with its beat grid when
    /// it has one (needed to play in time with the decks).
    Load(Arc<TrackAudio>, f64, Option<Arc<Beatgrid>>),
    /// Takes the track out.
    Unload,
    Play(bool),
    /// Jumps to a frame.
    Seek(f64),
    /// Linear gain.
    SetGain(f32),
    SetRoute(PreviewRoute),
    /// Plays in time with the master clock: tempo matched (like a turntable, so the pitch
    /// moves with it) and bars lined up with the playing deck.
    SetSync(bool),
}

/// The furthest the preview is sped up or slowed down to follow the decks (a turntable's
/// usual pitch range).
const MAX_STRETCH: f64 = 0.16;

pub struct Previewer {
    audio: Option<Arc<TrackAudio>>,
    grid: Option<Arc<Beatgrid>>,
    sync: bool,
    /// Following the clock in the last block (sync on, a grid, and tempos close enough).
    following: bool,
    /// Playback speed of the last block (1 = the track's own tempo).
    rate: f64,
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
            grid: None,
            sync: false,
            following: false,
            rate: 1.0,
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
            PreviewCommand::Load(audio, start, grid) => {
                let frames = audio.frames() as f64;
                trash.put_opt(self.audio.replace(audio), Trash::Audio);
                match grid {
                    Some(g) => trash.put_opt(self.grid.replace(g), Trash::Grid),
                    None => trash.put_opt(self.grid.take(), Trash::Grid),
                }
                self.rate = 1.0;
                self.pos = start.clamp(0.0, frames);
                self.playing = false;
                self.stopping = false;
                self.pending_seek = None;
                self.fade.set_open(false);
                self.ended = false;
            }
            PreviewCommand::Unload => {
                trash.put_opt(self.audio.take(), Trash::Audio);
                trash.put_opt(self.grid.take(), Trash::Grid);
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
            PreviewCommand::SetSync(on) => {
                self.sync = on;
                if !on {
                    self.rate = 1.0;
                }
            }
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

    /// Playing in time with the clock (sync is on, the track has a grid and its tempo is
    /// within reach).
    pub fn is_synced(&self) -> bool {
        self.sync && self.grid.is_some() && self.following
    }

    /// Playback speed (1 = the track's own tempo).
    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// Speed and phase for this block when following the clock: the tempo ratio (taking
    /// double or half time when that is closer), nudged to pull the bars into line; or a
    /// jump when they are more than a fifth of a beat apart (just started, or after a seek).
    /// Tempos more than `MAX_STRETCH` apart play at the track's own speed: nobody would
    /// mix them, and a track that far off its tempo sounds wrong.
    fn follow(&mut self, clock_bpm: f64, clock_beat: f64, frames: usize) -> f64 {
        let Some(g) = &self.grid else {
            self.following = false;
            return 1.0;
        };
        if !self.sync || clock_bpm <= 1.0 {
            self.following = false;
            return 1.0;
        }
        if self.pending_seek.is_some() || self.stopping {
            return self.rate;
        }
        let own = g.bpm_at(self.pos).max(1.0);
        let k = [1.0, 2.0, 0.5]
            .into_iter()
            .min_by(|a, b| (clock_bpm / (own * a) - 1.0).abs().total_cmp(&(clock_bpm / (own * b) - 1.0).abs()))
            .unwrap_or(1.0);
        let step = clock_bpm / (own * k);
        self.following = (step - 1.0).abs() <= MAX_STRETCH;
        if !self.following {
            return 1.0;
        }
        let bar = g.beats_per_bar.max(1) as f64;
        let mine = g.beat_at(self.pos) * k;
        let mut e = (mine - clock_beat).rem_euclid(bar);
        if e > bar / 2.0 {
            e -= bar;
        }
        if e.abs() > 0.2 {
            let target = g.frame_at((mine - e) / k);
            if target >= 0.0 && target < frames as f64 {
                self.pending_seek = Some(target);
                self.fade.fade_out();
            }
            step
        } else {
            step * (1.0 - (e * 0.15).clamp(-0.03, 0.03))
        }
    }

    /// Renders `n` frames into `out_l`/`out_r` (silence when stopped). Returns whether
    /// anything was written.
    pub fn render(&mut self, n: usize, clock_bpm: f64, clock_beat: f64) -> bool {
        if !self.playing {
            return false;
        }
        let Some(frames) = self.audio.as_ref().map(|a| a.frames()) else {
            self.playing = false;
            return false;
        };
        let step = self.follow(clock_bpm, clock_beat, frames);
        self.rate = step;
        let Some(audio) = &self.audio else { return false };
        let data = &audio.data;
        for i in 0..n {
            let g = self.fade.next() * self.gain.next();
            let p = self.pos as usize;
            let (l, r) = if p >= frames {
                (0.0, 0.0)
            } else if step == 1.0 && self.pos.fract() == 0.0 {
                (data[2 * p], data[2 * p + 1])
            } else {
                hermite_stereo(data, frames, self.pos)
            };
            self.out_l[i] = l * g;
            self.out_r[i] = r * g;
            if p < frames {
                self.pos += step;
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
        p.handle(PreviewCommand::Load(audio, 0.0, None), &mut t);
        p.handle(PreviewCommand::SetGain(1.0), &mut t);
        assert!(!p.render(512, 120.0, 0.0), "stopped until played");
        p.handle(PreviewCommand::Play(true), &mut t);
        // Gain smoothing and the fade both start from their current value: let them settle.
        for _ in 0..20 {
            p.render(512, 120.0, 0.0);
        }
        assert!((p.out_l[511] - 0.5).abs() < 1e-3);
        let before = p.position();
        p.handle(PreviewCommand::Seek(10_000.0), &mut t);
        assert_eq!(p.position(), 10_000.0);
        p.render(512, 120.0, 0.0);
        // The jump happened after the fade-out, and the level never stepped.
        let step = p.out_l[..512].windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(step < 0.01, "step {step}");
        assert!(p.position() > 10_000.0 && p.position() < 10_512.0, "{} after {before}", p.position());
        p.handle(PreviewCommand::Play(false), &mut t);
        p.render(512, 120.0, 0.0);
        assert!(!p.is_playing());
        assert!(!p.render(512, 120.0, 0.0));
    }

    #[test]
    fn reports_the_end_and_restarts_from_the_top() {
        let mut p = Previewer::new(48_000.0, 512);
        let (mut t, _rx) = bin();
        p.handle(PreviewCommand::Load(Arc::new(TrackAudio::new(48_000, vec![0.1; 1_000 * 2])), 0.0, None), &mut t);
        p.handle(PreviewCommand::Play(true), &mut t);
        p.render(512, 120.0, 0.0);
        p.render(512, 120.0, 0.0);
        assert!(p.ended && !p.is_playing());
        p.handle(PreviewCommand::Play(true), &mut t);
        assert_eq!(p.position(), 0.0);
        assert!(p.is_playing());
    }

    #[test]
    fn follows_the_clock_in_tempo_and_in_phase() {
        let sr = 48_000u32;
        let mut p = Previewer::new(sr as f32, 512);
        let (mut t, _rx) = bin();
        let audio = Arc::new(TrackAudio::new(sr, vec![0.2; sr as usize * 20 * 2]));
        let grid = Arc::new(Beatgrid::constant(sr, 120.0, 0.0));
        p.handle(PreviewCommand::Load(audio, 0.0, Some(grid.clone())), &mut t);
        p.handle(PreviewCommand::SetSync(true), &mut t);
        p.handle(PreviewCommand::Play(true), &mut t);
        // The clock runs at 126 BPM and is a beat and a half ahead of the track.
        let mut beat = 1.5;
        let per_block = 126.0 / 60.0 * 512.0 / sr as f64;
        for _ in 0..400 {
            p.render(512, 126.0, beat);
            beat += per_block;
        }
        assert!(p.is_synced());
        assert!((p.rate() - 1.05).abs() < 0.003, "rate {}", p.rate());
        let mine = grid.beat_at(p.position());
        let mut e = (mine - beat).rem_euclid(4.0);
        if e > 2.0 {
            e -= 4.0;
        }
        assert!(e.abs() < 0.03, "phase error {e} beats");
        // A clock far from the track's tempo (and its double and half): its own speed.
        for _ in 0..4 {
            p.render(512, 170.0, beat);
        }
        assert!(!p.is_synced());
        assert_eq!(p.rate(), 1.0);
        // Off again: back to the track's own speed.
        p.handle(PreviewCommand::SetSync(false), &mut t);
        p.render(512, 126.0, beat);
        assert_eq!(p.rate(), 1.0);
    }
}
