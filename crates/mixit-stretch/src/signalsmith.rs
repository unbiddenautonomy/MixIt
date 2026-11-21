//! Signalsmith Stretch (MIT licence), the native stretcher.

use mixit_dsp::stretch::TimeStretch;
use signalsmith_stretch::Stretch;

use crate::StretchQuality;

/// Signalsmith Stretch for one stereo deck.
pub struct SignalsmithStretch {
    inner: Stretch,
    quality: StretchQuality,
    sample_rate: u32,
    transpose: f32,
}

impl SignalsmithStretch {
    /// Allocates: create on a control thread and send to the engine.
    pub fn new(sample_rate: u32, quality: StretchQuality) -> SignalsmithStretch {
        let inner = match quality {
            StretchQuality::High => Stretch::preset_default(2, sample_rate),
            StretchQuality::Efficient => Stretch::preset_cheaper(2, sample_rate),
        };
        SignalsmithStretch { inner, quality, sample_rate, transpose: 1.0 }
    }

    pub fn quality(&self) -> StretchQuality {
        self.quality
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Shifts formants independently of pitch (for vocal-friendly key changes).
    pub fn set_formant_semitones(&mut self, semitones: f32, compensate_pitch: bool) {
        self.inner.set_formant_factor_semitones(semitones, compensate_pitch);
    }
}

impl TimeStretch for SignalsmithStretch {
    fn reset(&mut self) {
        self.inner.reset();
        // Reset clears the configuration's transpose too; restore it.
        self.inner.set_transpose_factor(self.transpose, None);
    }
    fn input_latency(&self) -> usize {
        self.inner.input_latency()
    }
    fn output_latency(&self) -> usize {
        self.inner.output_latency()
    }
    fn set_transpose(&mut self, factor: f32) {
        let f = if factor.is_finite() { factor.clamp(0.25, 4.0) } else { 1.0 };
        if f != self.transpose {
            self.transpose = f;
            self.inner.set_transpose_factor(f, None);
        }
    }
    fn process(&mut self, input: &[f32], output: &mut [f32]) {
        debug_assert!(input.len() % 2 == 0 && output.len() % 2 == 0);
        if output.is_empty() {
            return;
        }
        self.inner.process(input, output);
    }
    fn seek(&mut self, input: &[f32], rate: f64) {
        debug_assert!(input.len() % 2 == 0);
        self.inner.seek(input, rate);
    }
    fn name(&self) -> &'static str {
        match self.quality {
            StretchQuality::High => "Signalsmith Stretch",
            StretchQuality::Efficient => "Signalsmith Stretch (efficient)",
        }
    }
}
