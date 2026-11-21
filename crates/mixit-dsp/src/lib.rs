//! Real-time-safe DSP building blocks for MixIt.
//!
//! Rules every type here follows (the full list is in `docs/engine-rules.md`):
//!
//! 1. **No allocation, locking or I/O after construction.** Buffers are sized in
//!    `new()`; `process` methods only touch preallocated memory.
//! 2. **Click-free and zipper-free.** Every continuous parameter is smoothed; every
//!    discontinuity (start, stop, jump, switch) is covered by a short fade.
//! 3. **Numerically safe.** Feedback paths flush denormals and recover from NaN/Inf.
//! 4. **Deterministic.** Same input, settings, build and platform give bit-identical
//!    output; no randomness without an explicit seed.
//!
//! The crate has no dependencies and compiles to `wasm32-unknown-unknown`.

pub mod biquad;
pub mod crossover;
pub mod curves;
pub mod delay;
pub mod djeq;
pub mod djfilter;
pub mod dynamics;
pub mod edit;
pub mod fx;
pub mod interp;
pub mod meters;
pub mod oversample;
pub mod peq;
pub mod ramp;
pub mod rng;
pub mod smooth;
pub mod stretch;
pub mod studio;
pub mod svf;
pub mod util;

#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

pub use util::{db_to_gain, gain_to_db};
