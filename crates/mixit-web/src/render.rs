//! Arrange preview and render in the browser (worker side): the shared
//! [`ProjectRenderer`] with MixIt's phase vocoder, fed one track at a time. The page
//! answers each "need" with the track's audio and grid, and the job forgets a track as
//! soon as no clip still to come uses it, so only the tracks playing are in memory.

use std::collections::HashMap;
use std::sync::Arc;

use mixit_core::Beatgrid;
use mixit_engine::TrackAudio;
use mixit_engine::arrangement::{ProjectRenderer, RenderOptions, Resolve, ResolvedTrack};
use mixit_project::MixProject;
use mixit_stretch::PhaseVocoder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub project: MixProject,
    /// Render only beats `from..to` (a preview); the whole project when absent.
    #[serde(default)]
    pub from: Option<f64>,
    #[serde(default)]
    pub to: Option<f64>,
    #[serde(default = "default_tail")]
    pub tail: f64,
    #[serde(default = "yes")]
    pub limiter: bool,
    #[serde(default = "yes")]
    pub auto_gain: bool,
}

fn default_tail() -> f64 {
    2.0
}
fn yes() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackOptions {
    pub grid: Beatgrid,
    #[serde(default)]
    pub auto_gain_db: f32,
}

/// A clip's track the page has to send.
#[derive(Debug, Serialize, PartialEq)]
pub struct Need {
    pub clip: u64,
    /// The clip's track path: the page sends it once for every clip that uses it.
    pub path: String,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct Progress {
    pub frames: usize,
    pub position: usize,
    pub total: usize,
    pub need: Option<Need>,
    pub done: bool,
}

/// The key a clip's track is known by.
fn key(c: &mixit_project::Clip) -> String {
    c.track.path.clone().or_else(|| c.track.hash.clone()).unwrap_or_else(|| c.track.title.clone())
}

pub struct RenderJob {
    r: ProjectRenderer,
    tracks: HashMap<String, ResolvedTrack>,
    missing: Option<String>,
}

impl RenderJob {
    pub fn new(req: RenderRequest, sample_rate: u32) -> Result<RenderJob, String> {
        if req.project.clips.is_empty() {
            return Err("the mix has no clips".into());
        }
        let mut project = req.project;
        project.tempo.rebuild();
        if req.from.is_some() || req.to.is_some() {
            let from = req.from.unwrap_or(0.0);
            let to = req.to.unwrap_or(project.length_beats());
            project = project.excerpt(from, to);
        }
        let opts =
            RenderOptions { sample_rate, tail: req.tail, block: 256, limiter: req.limiter, auto_gain: req.auto_gain };
        let r = ProjectRenderer::new(project, opts, Box::new(|sr| Box::new(PhaseVocoder::new(sr))));
        Ok(RenderJob { r, tracks: HashMap::new(), missing: None })
    }

    pub fn total_frames(&self) -> usize {
        self.r.total_frames()
    }

    /// Takes a track's audio (interleaved stereo at the render rate).
    pub fn provide(&mut self, path: &str, audio: Vec<f32>, opts: TrackOptions) {
        let sr = self.r.sample_rate();
        self.tracks.insert(
            path.to_string(),
            ResolvedTrack {
                audio: Arc::new(TrackAudio::new(sr, audio)),
                grid: opts.grid,
                auto_gain_db: opts.auto_gain_db,
            },
        );
    }

    /// Marks a track the page could not find: the render fails when it is needed.
    pub fn missing(&mut self, path: &str) {
        self.missing = Some(path.to_string());
    }

    /// Renders up to `frames` frames into `out` (cleared first).
    pub fn next(&mut self, frames: usize, out: &mut Vec<f32>) -> Result<Progress, String> {
        out.clear();
        out.resize(frames * 2, 0.0);
        let tracks = &self.tracks;
        let missing = &self.missing;
        let mut resolve = |c: &mixit_project::Clip| {
            let k = key(c);
            if let Some(t) = tracks.get(&k) {
                Resolve::Ready(ResolvedTrack {
                    audio: t.audio.clone(),
                    grid: t.grid.clone(),
                    auto_gain_db: t.auto_gain_db,
                })
            } else if missing.as_deref() == Some(k.as_str()) {
                Resolve::Missing
            } else {
                Resolve::Later
            }
        };
        let step = self.r.render(out, &mut resolve).map_err(|e| e.to_string())?;
        out.truncate(step.frames * 2);
        // Forget tracks no clip still to come uses (a playing deck keeps its own copy).
        let still: std::collections::HashSet<String> = self.r.upcoming().map(key).collect();
        self.tracks.retain(|k, _| still.contains(k));
        let need = step.need.and_then(|id| self.r.project().clips.iter().find(|c| c.id == id)).map(|c| Need {
            clip: c.id,
            path: key(c),
            title: c.track.title.clone(),
        });
        Ok(Progress {
            frames: step.frames,
            position: self.r.position(),
            total: self.r.total_frames(),
            need,
            done: step.done,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::Key;
    use mixit_generator::{Style, TrackSpec};

    fn track(bpm: f64, seed: u64, sr: u32) -> (Vec<f32>, Beatgrid) {
        let mut spec = TrackSpec::standard(Style::House, bpm, Key::from_camelot(8, 'A').unwrap());
        spec.sample_rate = sr;
        spec.seed = seed;
        let g = mixit_generator::generate(&spec);
        let first = g.truth.beats[0] * sr as f64;
        (g.audio, Beatgrid::constant(sr, bpm, first))
    }

    #[test]
    fn renders_in_pieces_asking_for_each_track_once() {
        let sr = 22_050;
        let mut p = MixProject::new("Web", 124.0);
        let clip = |id: u64, path: &str, lane: u8, start: f64| mixit_project::Clip {
            id,
            track: mixit_project::TrackRef {
                path: Some(path.into()),
                title: path.into(),
                bpm: 124.0,
                ..Default::default()
            },
            lane,
            start,
            length: 32.0,
            source_start: 0.0,
            key_shift: 0.0,
            keylock: true,
            gain_db: 0.0,
            lanes: vec![],
            fx: None,
            name: path.into(),
        };
        p.add_clip(clip(1, "a", 0, 0.0));
        p.add_clip(clip(2, "b", 1, 24.0));
        p.add_clip(clip(3, "a", 0, 48.0));
        let req = RenderRequest { project: p, from: None, to: None, tail: 0.5, limiter: true, auto_gain: false };
        let mut job = RenderJob::new(req, sr).unwrap();
        let total = job.total_frames();
        let mut out = Vec::new();
        let mut asked = Vec::new();
        let mut got = 0usize;
        let mut energy = 0.0f64;
        for _ in 0..10_000 {
            let pr = job.next(sr as usize, &mut out).unwrap();
            got += pr.frames;
            energy += out.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
            if let Some(n) = pr.need {
                asked.push(n.path.clone());
                let (audio, grid) = track(124.0, if n.path == "a" { 1 } else { 2 }, sr);
                job.provide(&n.path, audio, TrackOptions { grid, auto_gain_db: 0.0 });
            }
            if pr.done {
                break;
            }
        }
        assert_eq!(got, total);
        assert!(energy / got as f64 > 1e-4, "silent render");
        // "a" is asked for again only if it was forgotten between its two clips.
        assert_eq!(asked.first().map(String::as_str), Some("a"));
        assert!(asked.contains(&"b".to_string()));
        assert!(job.tracks.is_empty(), "every track forgotten at the end");
    }

    #[test]
    fn previews_an_excerpt_and_reports_missing_tracks() {
        let mut p = MixProject::new("Web", 124.0);
        p.add_clip(mixit_project::Clip {
            id: 1,
            track: mixit_project::TrackRef {
                path: Some("x".into()),
                title: "X".into(),
                bpm: 124.0,
                ..Default::default()
            },
            lane: 0,
            start: 0.0,
            length: 256.0,
            source_start: 0.0,
            key_shift: 0.0,
            keylock: true,
            gain_db: 0.0,
            lanes: vec![],
            fx: None,
            name: "X".into(),
        });
        let req =
            RenderRequest { project: p, from: Some(64.0), to: Some(96.0), tail: 0.0, limiter: true, auto_gain: false };
        let mut job = RenderJob::new(req, 22_050).unwrap();
        // 32 beats at 124 BPM.
        let secs = job.total_frames() as f64 / 22_050.0;
        assert!((secs - 32.0 * 60.0 / 124.0).abs() < 0.1, "{secs}");
        let mut out = Vec::new();
        let pr = job.next(1024, &mut out).unwrap();
        assert_eq!(pr.need.as_ref().map(|n| n.path.as_str()), Some("x"));
        job.missing("x");
        assert!(job.next(1024, &mut out).unwrap_err().contains("X"));
    }
}
