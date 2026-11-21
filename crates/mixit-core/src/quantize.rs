//! Quantise settings and the standard musical sizes used by loops and jumps.

use serde::{Deserialize, Serialize};

/// Snaps cues, loops, jumps and starts to the beatgrid.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Default)]
pub enum Quantize {
    Off,
    /// Snap to multiples of this many beats (0.125, 0.25, 0.5, 1, 4 …).
    Beats(f64),
    /// One beat (the default).
    #[default]
    Beat,
    /// One bar.
    Bar,
    /// One phrase (bars per phrase from the grid).
    Phrase,
}

impl Quantize {
    /// Quantum in beats, given the bar and phrase sizes, or `None` when off.
    pub fn beats(self, beats_per_bar: u32, phrase_bars: u32) -> Option<f64> {
        match self {
            Quantize::Off => None,
            Quantize::Beats(b) => Some(b),
            Quantize::Beat => Some(1.0),
            Quantize::Bar => Some(beats_per_bar as f64),
            Quantize::Phrase => Some((beats_per_bar * phrase_bars) as f64),
        }
    }

    pub fn is_on(self) -> bool {
        !matches!(self, Quantize::Off)
    }
}

/// Auto-loop sizes in beats: 1/32 to 32.
pub const LOOP_SIZES: [f64; 11] =
    [1.0 / 32.0, 1.0 / 16.0, 1.0 / 8.0, 1.0 / 4.0, 1.0 / 2.0, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0];

/// Beat jump sizes in beats.
pub const BEAT_JUMP_SIZES: [f64; 6] = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0];

/// Quantise choices offered in settings.
pub const QUANTIZE_CHOICES: [(&str, Quantize); 7] = [
    ("Off", Quantize::Off),
    ("1/8 beat", Quantize::Beats(0.125)),
    ("1/4 beat", Quantize::Beats(0.25)),
    ("1/2 beat", Quantize::Beats(0.5)),
    ("1 beat", Quantize::Beat),
    ("1 bar", Quantize::Bar),
    ("1 phrase", Quantize::Phrase),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quanta() {
        assert_eq!(Quantize::Off.beats(4, 8), None);
        assert_eq!(Quantize::Bar.beats(4, 8), Some(4.0));
        assert_eq!(Quantize::Phrase.beats(4, 8), Some(32.0));
        assert_eq!(Quantize::Beats(0.25).beats(3, 8), Some(0.25));
        assert_eq!(LOOP_SIZES[5], 1.0);
    }
}
