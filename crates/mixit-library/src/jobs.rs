//! Background analysis: decodes and analyses tracks on worker threads; results come
//! back to the calling thread, which owns the database connection.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use mixit_analysis::{Analysis, AnalysisOptions};
use mixit_core::TrackId;
use mixit_io::DecodeCache;

use crate::{Library, Result, Track};

#[derive(Clone, Debug)]
pub struct JobOptions {
    pub threads: usize,
    /// Rate tracks are decoded at for analysis.
    pub sample_rate: u32,
    pub analysis: AnalysisOptions,
    /// Decoded audio is cached here so later loads are instant.
    pub cache_dir: Option<PathBuf>,
}

impl Default for JobOptions {
    fn default() -> Self {
        JobOptions {
            threads: std::thread::available_parallelism().map(|n| n.get().saturating_sub(1).max(1)).unwrap_or(2),
            sample_rate: 44_100,
            analysis: AnalysisOptions::default(),
            cache_dir: None,
        }
    }
}

pub enum JobEvent {
    Done(TrackId, Box<Analysis>),
    Failed(TrackId, String),
}

/// Analyses `items` in parallel, calling `on_event` on this thread as each finishes.
/// Setting `cancel` stops after the tracks in flight.
pub fn analyze_tracks(
    items: Vec<(TrackId, PathBuf)>,
    opts: &JobOptions,
    cancel: &AtomicBool,
    mut on_event: impl FnMut(JobEvent),
) {
    let (work_tx, work_rx) = crossbeam_channel::unbounded::<(TrackId, PathBuf)>();
    let (res_tx, res_rx) = crossbeam_channel::unbounded::<JobEvent>();
    let n = items.len();
    for it in items {
        let _ = work_tx.send(it);
    }
    drop(work_tx);
    let cache = opts.cache_dir.as_ref().and_then(|d| DecodeCache::new(d).ok());
    std::thread::scope(|s| {
        for _ in 0..opts.threads.max(1).min(n.max(1)) {
            let work_rx = work_rx.clone();
            let res_tx = res_tx.clone();
            let cache = cache.as_ref();
            s.spawn(move || {
                while let Ok((id, path)) = work_rx.recv() {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let ev = match mixit_io::load_track(&path, opts.sample_rate, cache) {
                        Ok(t) => {
                            let a = mixit_analysis::analyze(&t.data, t.sample_rate, &opts.analysis);
                            JobEvent::Done(id, Box::new(a))
                        }
                        Err(e) => JobEvent::Failed(id, e.to_string()),
                    };
                    if res_tx.send(ev).is_err() {
                        break;
                    }
                }
            });
        }
        drop(res_tx);
        for ev in res_rx.iter() {
            on_event(ev);
        }
    });
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JobSummary {
    pub analysed: usize,
    pub failed: usize,
}

impl Library {
    /// Analyses every pending track, saving results as they arrive.
    /// `progress(done, total, track_id)` is called after each track.
    pub fn analyze_pending(
        &self,
        opts: &JobOptions,
        cancel: &AtomicBool,
        mut progress: impl FnMut(usize, usize, TrackId),
    ) -> Result<JobSummary> {
        let pending: Vec<Track> = self.pending_analysis(usize::MAX >> 1)?;
        let total = pending.len();
        let items: Vec<(TrackId, PathBuf)> = pending.into_iter().map(|t| (t.id, t.path)).collect();
        let mut summary = JobSummary::default();
        let mut err = None;
        analyze_tracks(items, opts, cancel, |ev| {
            let (id, r) = match ev {
                JobEvent::Done(id, a) => {
                    summary.analysed += 1;
                    (id, self.save_analysis(id, &a))
                }
                JobEvent::Failed(id, e) => {
                    summary.failed += 1;
                    (id, self.mark_analysis_failed(id, &e))
                }
            };
            if let Err(e) = r {
                err.get_or_insert(e);
            }
            progress(summary.analysed + summary.failed, total, id);
        });
        match err {
            Some(e) => Err(e),
            None => Ok(summary),
        }
    }
}
