//! Trained models that run on the person's own computer.
//!
//! Every model here is optional. A model is a file the [`models::ModelStore`] downloads
//! once (and checks), and the code that uses it falls back to what MixIt did before
//! when the file is missing, the download fails or the crate is built without the
//! `onnx` feature. Nothing here runs on the audio thread: models run in background jobs
//! and hand their results over the same way decoded tracks are.
//!
//! * [`beats`]: Beat This!, a trained beat and downbeat tracker, as a second opinion
//!   where MixIt's own beat finder is unsure.
//! * [`stems`]: HTDemucs, the trained four-stem splitter (vocals, drums, bass and the
//!   rest).
//! * [`sound`]: CLAP, which describes how a track sounds, for search by sound, behind
//!   the `sound` feature.
//! * [`voice`]: cleans the mic (echo cancelling and noise removal), behind the `voice`
//!   feature.

pub mod beats;
pub mod models;
pub mod sound;
pub mod stems;
pub mod voice;

#[derive(Debug, thiserror::Error)]
pub enum MlError {
    #[error("the model file is missing")]
    Missing,
    #[error("this build has no model runtime")]
    NoRuntime,
    #[error("download failed: {0}")]
    Download(String),
    #[error("the downloaded model is damaged (its checksum does not match)")]
    Checksum,
    #[error("the model could not run: {0}")]
    Run(String),
    #[error("stopped")]
    Cancelled,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, MlError>;
