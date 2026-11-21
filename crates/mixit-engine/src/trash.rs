//! Returning heap objects from the audio thread.
//!
//! The audio thread must never free memory (the allocator can lock). Anything it lets go
//! of is pushed into the trash ring and dropped by the control thread. If the ring is
//! full, items wait in a fixed overflow array and are retried on the next block.

use std::sync::Arc;

use mixit_core::Beatgrid;
use mixit_dsp::fx::Effect;
use mixit_dsp::stretch::TimeStretch;

use crate::track::{DeckTrack, TrackAudio};

/// A heap object released by the audio thread.
pub enum Trash {
    Track(Box<DeckTrack>),
    Audio(Arc<TrackAudio>),
    Grid(Arc<Beatgrid>),
    Effect(Box<dyn Effect>),
    Stretch(Box<dyn TimeStretch>),
}

const OVERFLOW: usize = 64;

/// The audio-thread end of the trash ring.
pub struct TrashBin {
    tx: rtrb::Producer<Trash>,
    overflow: [Option<Trash>; OVERFLOW],
    /// Items that could not be returned at all (overflow full). They are leaked rather
    /// than freed on the audio thread; this counter exposes the problem in telemetry.
    pub leaked: u32,
}

impl TrashBin {
    pub fn new(tx: rtrb::Producer<Trash>) -> TrashBin {
        TrashBin { tx, overflow: std::array::from_fn(|_| None), leaked: 0 }
    }

    /// Releases an object without freeing it on this thread.
    pub fn put(&mut self, item: Trash) {
        if let Err(rtrb::PushError::Full(item)) = self.tx.push(item) {
            if let Some(slot) = self.overflow.iter_mut().find(|s| s.is_none()) {
                *slot = Some(item);
            } else {
                self.leaked += 1;
                std::mem::forget(item);
            }
        }
    }

    pub fn put_opt<T>(&mut self, item: Option<T>, wrap: impl FnOnce(T) -> Trash) {
        if let Some(x) = item {
            self.put(wrap(x));
        }
    }

    /// Retries items waiting in the overflow array.
    pub fn flush(&mut self) {
        for slot in self.overflow.iter_mut() {
            if let Some(item) = slot.take() {
                match self.tx.push(item) {
                    Ok(()) => {}
                    Err(rtrb::PushError::Full(item)) => {
                        *slot = Some(item);
                        return;
                    }
                }
            }
        }
    }
}
