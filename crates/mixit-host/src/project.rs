//! Renders a [`MixProject`] by playing it through the real engine, so a bounced mix
//! sounds exactly like the live decks (same time-stretch, EQ, filter, FX and limiter).
//! The playback logic lives in [`mixit_engine::arrangement`] (shared with the browser
//! build); natively it uses the high-quality Signalsmith stretcher.

use std::sync::atomic::{AtomicBool, Ordering};

use mixit_project::{Clip, MixProject};

pub use mixit_engine::arrangement::{RenderError, RenderOptions, ResolvedTrack};

/// Renders the project to interleaved stereo. `progress(fraction)` is called as it goes.
pub fn render_project(
    project: &MixProject,
    opts: &RenderOptions,
    resolve: impl FnMut(&Clip) -> Option<ResolvedTrack>,
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
) -> Result<Vec<f32>, RenderError> {
    mixit_engine::arrangement::render_all(
        project,
        opts,
        Box::new(|sr| Box::new(mixit_stretch::SignalsmithStretch::new(sr, mixit_stretch::StretchQuality::High))),
        resolve,
        || cancel.load(Ordering::Relaxed),
        progress,
    )
}
