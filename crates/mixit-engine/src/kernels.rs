//! Playback interpolation kernels.
//!
//! Decks read the track at fractional positions with a 16-tap Kaiser-windowed sinc.
//! Above normal speed the kernel's cutoff must drop with the speed or the material above
//! the new Nyquist folds back as aliasing; so there is one table per speed band, each
//! band-limited for the fastest speed it serves.

use mixit_dsp::interp::SincTable;

/// Upper speed of each band; the table for a band has cutoff 0.94 / speed.
pub const SPEED_BANDS: [f64; 7] = [1.0, 1.25, 1.6, 2.0, 2.8, 4.0, 8.0];

pub struct PlaybackKernels {
    tables: Vec<SincTable>,
}

impl PlaybackKernels {
    /// Allocates (about 250 KB): build once on a control thread and share by `Arc`.
    pub fn new() -> PlaybackKernels {
        let tables = SPEED_BANDS
            .iter()
            .map(|&s| if s == 1.0 { SincTable::playback() } else { SincTable::new(16, 512, 0.94 / s, 9.0) })
            .collect();
        PlaybackKernels { tables }
    }

    /// The kernel for playback at `speed` (absolute rate).
    #[inline]
    pub fn for_speed(&self, speed: f64) -> &SincTable {
        let i = SPEED_BANDS.iter().position(|&s| speed <= s + 1e-9).unwrap_or(SPEED_BANDS.len() - 1);
        &self.tables[i]
    }
}

impl Default for PlaybackKernels {
    fn default() -> Self {
        Self::new()
    }
}
