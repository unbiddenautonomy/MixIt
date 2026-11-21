//! MixIt in the browser.
//!
//! The same engine, analysis and generator the desktop app uses, compiled to
//! `wasm32-unknown-unknown` with a small C ABI ([`ffi`]). The page runs two instances:
//!
//! - an **AudioWorklet** instance with a [`host::Host`]: decks, mixer, effects, sampler and
//!   key lock (MixIt's own phase vocoder, since the native stretcher is C++);
//! - a **Worker** instance for heavy one-off work ([`tools`]): generating tracks and kit
//!   sounds, and analysing audio the page decoded.
//!
//! Everything here is plain Rust and is tested natively.

pub mod ffi;
pub mod host;
pub mod tools;
