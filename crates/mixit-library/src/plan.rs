//! Turns analysed tracks into automix plans, and orders crates into sets.

use mixit_analysis::Analysis;
use mixit_core::TrackId;
use mixit_project::TrackRef;
use mixit_project::automix::PlanTrack;

use crate::suggest::{self, EnergyDirection};
use crate::{Library, LibraryError, Result, Track};

/// How a project refers to a library track (content hash first, path as a fallback).
pub fn track_ref(t: &Track) -> TrackRef {
    TrackRef {
        hash: t.hash.clone(),
        path: Some(t.path.to_string_lossy().into_owned()),
        title: t.display_title(),
        artist: t.artist.clone(),
        bpm: t.best_bpm().unwrap_or(0.0),
        key: t.best_key(),
        duration: t.duration,
    }
}

/// A plan from an analysis (its mix points in the analysis grid's beats).
pub fn plan_track(track: TrackRef, a: &Analysis) -> PlanTrack {
    let mp = a.mix_points();
    let mut track = track;
    if track.bpm <= 0.0 {
        track.bpm = a.bpm;
    }
    if track.key.is_none() {
        track.key = a.key.as_ref().map(|k| k.key);
    }
    if track.duration <= 0.0 {
        track.duration = a.duration;
    }
    PlanTrack { track, first_beat: mp.first_beat, last_beat: mp.last_beat, mix_in: mp.mix_in, mix_out: mp.mix_out }
}

impl Library {
    /// Plans for analysed library tracks, in the given order. The track's current grid
    /// (which the user may have corrected) is used for the mix points.
    pub fn plan_tracks(&self, ids: &[TrackId]) -> Result<Vec<PlanTrack>> {
        let mut out = Vec::with_capacity(ids.len());
        for &id in ids {
            let t = self.track(id)?;
            let mut a =
                self.analysis(id)?.ok_or_else(|| LibraryError::Invalid(format!("track {id} is not analysed")))?;
            if let Some(g) = self.grid(id)? {
                a.grid = g;
            }
            out.push(plan_track(track_ref(&t), &a));
        }
        Ok(out)
    }

    /// Orders tracks into a set (see [`suggest::order_set`]). `start` is a track id.
    pub fn order_set(&self, ids: &[TrackId], start: Option<TrackId>, energy: EnergyDirection) -> Result<Vec<TrackId>> {
        let cands: Vec<suggest::Candidate> =
            ids.iter().map(|&id| self.track(id).map(|t| t.candidate())).collect::<Result<_>>()?;
        let start = start.and_then(|s| ids.iter().position(|&i| i == s));
        Ok(suggest::order_set(&cands, start, energy).into_iter().map(|i| ids[i]).collect())
    }
}
