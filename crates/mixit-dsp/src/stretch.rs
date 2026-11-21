//! The time-stretch interface used by decks for key lock and key shift.
//!
//! The native build uses Signalsmith Stretch (see the `mixit-stretch` crate). This module
//! defines the trait and a portable fallback so the engine also builds for WebAssembly.

/// Time-stretching and pitch-shifting of interleaved stereo audio.
///
/// Real-time contract: `process` and `seek` must not allocate, lock or block.
pub trait TimeStretch: Send {
    /// Clears internal state (after a jump or when enabling).
    fn reset(&mut self);
    /// Frames of input needed ahead of the output position.
    fn input_latency(&self) -> usize;
    /// Frames by which output trails the effect centre.
    fn output_latency(&self) -> usize;
    /// Pitch factor (1.0 = unchanged, 2.0 = an octave up).
    fn set_transpose(&mut self, factor: f32);
    /// Consumes `input.len()/2` frames and writes `output.len()/2` frames.
    /// The ratio between them is the stretch.
    fn process(&mut self, input: &[f32], output: &mut [f32]);
    /// Pre-rolls with input that ends at the new position, so output continues from it
    /// without waiting for the latency to fill. `rate` is input frames per output frame.
    fn seek(&mut self, input: &[f32], rate: f64);
    /// Name for diagnostics.
    fn name(&self) -> &'static str;
}

/// A portable fallback that resamples (speed changes alter pitch, like vinyl).
/// It satisfies the interface so builds without the native stretcher still work.
pub struct ResampleStretch {
    transpose: f32,
    last: [f32; 2],
    frac: f64,
}

impl ResampleStretch {
    pub fn new() -> ResampleStretch {
        ResampleStretch { transpose: 1.0, last: [0.0; 2], frac: 0.0 }
    }
}

impl Default for ResampleStretch {
    fn default() -> Self {
        Self::new()
    }
}

impl TimeStretch for ResampleStretch {
    fn reset(&mut self) {
        self.last = [0.0; 2];
        self.frac = 0.0;
    }
    fn input_latency(&self) -> usize {
        0
    }
    fn output_latency(&self) -> usize {
        0
    }
    fn set_transpose(&mut self, factor: f32) {
        self.transpose = factor;
    }
    fn process(&mut self, input: &[f32], output: &mut [f32]) {
        let nin = input.len() / 2;
        let nout = output.len() / 2;
        if nout == 0 {
            return;
        }
        if nin == 0 {
            output.fill(0.0);
            return;
        }
        let step = nin as f64 / nout as f64;
        for i in 0..nout {
            let p = i as f64 * step;
            let i0 = p.floor() as usize;
            let t = (p - i0 as f64) as f32;
            for c in 0..2 {
                let a = if i0 == 0 && t < 0.0 { self.last[c] } else { input[i0.min(nin - 1) * 2 + c] };
                let b = input[(i0 + 1).min(nin - 1) * 2 + c];
                output[i * 2 + c] = a + (b - a) * t;
            }
        }
        self.last = [input[(nin - 1) * 2], input[(nin - 1) * 2 + 1]];
    }
    fn seek(&mut self, _input: &[f32], _rate: f64) {
        self.reset();
    }
    fn name(&self) -> &'static str {
        "resample (no key lock)"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_changes_length() {
        let mut s = ResampleStretch::new();
        let input: Vec<f32> = (0..200).map(|i| (i / 2) as f32).collect();
        let mut out = vec![0.0f32; 100];
        s.process(&input, &mut out);
        assert_eq!(out[0], 0.0);
        assert!(out[98] > 90.0);
    }
}
