//! Finds and loads the audio a project's clips refer to.
//!
//! A clip's track is looked up by its stored path (absolute, or relative to the project
//! file), then by content hash in the library (so moved files are still found). The
//! beatgrid comes from the library when the track is there (so grid corrections are
//! respected), otherwise the file is analysed on the spot.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixit_analysis::{Analysis, AnalysisOptions};
use mixit_core::Beatgrid;
use mixit_engine::TrackAudio;
use mixit_host::project::ResolvedTrack;
use mixit_io::DecodeCache;
use mixit_library::Library;
use mixit_project::{Clip, TrackRef};

struct Loaded {
    audio: Arc<TrackAudio>,
    grid: Beatgrid,
    auto_gain_db: f32,
}

pub struct Resolver<'a> {
    pub sample_rate: u32,
    pub library: Option<&'a Library>,
    pub cache: Option<DecodeCache>,
    /// Directory relative paths are resolved against (the project's folder).
    pub base_dir: Option<PathBuf>,
    loaded: HashMap<PathBuf, Loaded>,
    /// Why the last lookup failed, for the error message.
    pub last_error: Option<String>,
    /// Tracks that were found somewhere other than their stored path.
    pub relocated: Vec<(String, PathBuf)>,
}

impl<'a> Resolver<'a> {
    pub fn new(sample_rate: u32, library: Option<&'a Library>, cache: Option<DecodeCache>) -> Resolver<'a> {
        Resolver {
            sample_rate,
            library,
            cache,
            base_dir: None,
            loaded: HashMap::new(),
            last_error: None,
            relocated: vec![],
        }
    }

    /// Where the file for `r` is now, if it can be found.
    pub fn find(&self, r: &TrackRef) -> Option<PathBuf> {
        if let Some(p) = &r.path {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
            if let Some(base) = &self.base_dir {
                let q = base.join(&p);
                if q.is_file() {
                    return Some(q);
                }
            }
        }
        let (Some(lib), Some(hash)) = (self.library, &r.hash) else { return None };
        lib.tracks_by_hash(hash).ok()?.into_iter().find(|t| !t.missing && t.path.is_file()).map(|t| t.path)
    }

    fn library_grid(&self, path: &Path, hash: Option<&str>) -> Option<(Beatgrid, f32)> {
        let lib = self.library?;
        let t = match lib.track_by_path(path).ok()? {
            Some(t) => t,
            None => lib.tracks_by_hash(hash?).ok()?.into_iter().next()?,
        };
        let grid = lib.grid(t.id).ok()??;
        Some((grid, t.auto_gain_db.unwrap_or(0.0) as f32))
    }

    fn load(&mut self, path: &Path, hash: Option<&str>) -> Result<(), String> {
        if self.loaded.contains_key(path) {
            return Ok(());
        }
        let t = mixit_io::load_track(path, self.sample_rate, self.cache.as_ref()).map_err(|e| e.to_string())?;
        let (grid, gain) = match self.library_grid(path, hash) {
            Some(g) => g,
            None => {
                let a: Analysis = mixit_analysis::analyze(
                    &t.data,
                    t.sample_rate,
                    &AnalysisOptions { waveform: false, ..Default::default() },
                );
                (a.grid, a.loudness.auto_gain_db as f32)
            }
        };
        let audio = Arc::new(TrackAudio::new(t.sample_rate, t.data));
        self.loaded.insert(path.to_path_buf(), Loaded { audio, grid, auto_gain_db: gain });
        Ok(())
    }

    /// For [`mixit_host::project::render_project`].
    pub fn resolve(&mut self, c: &Clip) -> Option<ResolvedTrack> {
        let Some(path) = self.find(&c.track) else {
            self.last_error = Some(format!("{}: file not found", c.track.title));
            return None;
        };
        if c.track.path.as_deref().map(Path::new) != Some(path.as_path())
            && !self.relocated.iter().any(|(t, _)| *t == c.track.title)
        {
            self.relocated.push((c.track.title.clone(), path.clone()));
        }
        if let Err(e) = self.load(&path, c.track.hash.as_deref()) {
            self.last_error = Some(format!("{}: {e}", path.display()));
            return None;
        }
        let l = &self.loaded[&path];
        Some(ResolvedTrack { audio: l.audio.clone(), grid: l.grid.clone(), auto_gain_db: l.auto_gain_db })
    }
}
