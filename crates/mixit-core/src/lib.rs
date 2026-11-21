//! Shared types for MixIt.
//!
//! This crate holds the vocabulary every other crate speaks: positions in sample
//! frames, beatgrids, tempo maps, musical keys, parameter specifications and the
//! action registry. It has no platform dependencies and compiles to
//! `wasm32-unknown-unknown`, so a later web companion can reuse it unchanged.
//!
//! Time rules (see `docs/engine-rules.md`):
//! * Canonical positions are sample frames. Integer positions use [`Frame`] (`i64`);
//!   playheads that move at fractional rates use `f64` frames. `f32` is never used
//!   for a position, because it stops resolving single samples after 2^24 frames
//!   (about 349 s at 48 kHz).
//! * Musical time (beats, bars, phrases) is always derived from a [`beatgrid::Beatgrid`]
//!   (for a track) or a [`tempo_map::TempoMap`] (for an arrangement), never stored twice.

pub mod actions;
pub mod beatgrid;
pub mod ids;
pub mod key;
pub mod params;
pub mod quantize;
pub mod tempo_map;
pub mod time;

pub use beatgrid::{Beatgrid, GridAnchor, GridEdit, GridEditError};
pub use ids::{ContentHash, DeckId, TrackId};
pub use key::{Key, Mode};
pub use params::{ParamSpec, Taper, Unit};
pub use quantize::Quantize;
pub use tempo_map::TempoMap;
pub use time::Frame;
