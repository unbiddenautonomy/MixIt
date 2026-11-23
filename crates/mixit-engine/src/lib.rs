//! MixIt's real-time DJ engine.
//!
//! The engine runs on the audio thread and never allocates, locks or blocks there. A
//! [`Controller`] on the UI side sends [`Command`]s through a lock-free ring; heavy
//! objects (decoded tracks, grids, effects, stretchers) are built on the control side and
//! moved in, and anything the engine lets go of comes back through the trash ring to be
//! freed off the audio thread. State flows back as [`Telemetry`] snapshots and [`Event`]s.
//!
//! The same engine renders offline (exports, tests) by calling [`Engine::process`] in a
//! loop, so live and offline output are identical.

pub mod actions;
pub mod arrangement;
pub mod commands;
pub mod deck;
pub mod engine;
pub mod input;
pub mod kernels;
pub mod mixer;
pub mod preview;
pub mod sampler;
pub mod telemetry;
pub mod track;
pub mod trash;
pub mod view;

pub use commands::{
    Command, DeckCommand, EndBehaviour, FxCommand, FxTarget, GlobalCommand, HotCueMode, MixerCommand, PadMode,
    SamplerCommand, SyncMode, Timed, XfAssign,
};
pub use engine::{Controller, Engine, EngineConfig};
pub use input::{InputFeed, MicCommand, push_input};
pub use mixer::{RETURNS, ReturnParam, ScopeSource};
pub use preview::{PreviewCommand, PreviewRoute};
pub use telemetry::{DeckTelemetry, Event, LoopInfo, MasterTelemetry, MicTelemetry, PreviewTelemetry, Telemetry};
pub use track::{CueKind, DeckTrack, HOT_CUES, HotCue, STEMS, StemAudio, TrackAudio};
