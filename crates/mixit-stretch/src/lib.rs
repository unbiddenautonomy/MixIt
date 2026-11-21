//! Key lock and key shift for decks, backed by Signalsmith Stretch (MIT licence).
//!
//! Signalsmith Stretch is a phase-vocoder stretcher with multi-resolution analysis and
//! transient-aware phase handling. It is the current open-source state of the art for
//! music (comparable to commercial engines on tonal material) and it never allocates
//! after construction, so it can run on the audio thread.
//!
//! [`SignalsmithStretch`] implements [`mixit_dsp::stretch::TimeStretch`] so the engine
//! can swap it for the portable fallback when built for the web.

use mixit_dsp::stretch::TimeStretch;
use signalsmith_stretch::Stretch;

/// Quality presets, trading CPU for smearing on transients and low notes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StretchQuality {
    /// About 120 ms analysis blocks: the best result for full mixes.
    #[default]
    High,
    /// Shorter blocks and fewer channels of analysis: about half the CPU.
    Efficient,
}

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

/// Time-stretches and pitch-shifts a whole interleaved stereo buffer offline.
///
/// `speed` is input frames per output frame (1.05 plays 5 % faster, so the result is
/// shorter); `semitones` shifts the pitch independently. The output is aligned with the
/// input (latency removed) and is `frames / speed` frames long.
pub fn stretch_buffer(
    input: &[f32],
    sample_rate: u32,
    speed: f64,
    semitones: f32,
    quality: StretchQuality,
) -> Vec<f32> {
    let frames = input.len() / 2;
    let speed = if speed.is_finite() { speed.clamp(0.25, 4.0) } else { 1.0 };
    let out_frames = (frames as f64 / speed).round() as usize;
    let mut st = SignalsmithStretch::new(sample_rate, quality);
    st.set_transpose(2f32.powf(semitones / 12.0));
    let in_lat = st.input_latency();
    let out_lat = st.output_latency();
    // Pre-roll with exactly the input latency; output then trails by the output latency.
    let lead = in_lat;
    // Input with silence after the end so the tail drains.
    let tail = ((out_lat as f64 + 64.0) * speed).ceil() as usize + in_lat;
    let mut padded = Vec::with_capacity((frames + tail) * 2);
    padded.extend_from_slice(&input[..frames * 2]);
    padded.resize((frames + tail) * 2, 0.0);
    let pre = lead.min(padded.len() / 2);
    st.seek(&padded[..pre * 2], speed);
    let want = out_frames + out_lat;
    let mut out = vec![0.0f32; want * 2];
    let block = 1024usize;
    let mut done = 0usize;
    let mut in_pos = pre as f64;
    while done < want {
        let n = block.min(want - done);
        let next = in_pos + n as f64 * speed;
        let a = (in_pos as usize).min(padded.len() / 2);
        let b = (next as usize).min(padded.len() / 2);
        st.process(&padded[a * 2..b * 2], &mut out[done * 2..(done + n) * 2]);
        done += n;
        in_pos = next;
    }
    out.drain(..out_lat * 2);
    out.truncate(out_frames * 2);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_dsp::testkit;

    fn interleave(x: &[f32]) -> Vec<f32> {
        x.iter().flat_map(|&v| [v, v]).collect()
    }

    fn left(x: &[f32]) -> Vec<f32> {
        x.chunks(2).map(|c| c[0]).collect()
    }

    /// Runs `seconds` of a 440 Hz tone through the stretcher at `rate` (input frames
    /// per output frame), in 256-frame output blocks as the engine does.
    fn run(st: &mut SignalsmithStretch, rate: f64, seconds: f32) -> Vec<f32> {
        let sr = 48_000.0;
        let src = interleave(&testkit::sine((sr * seconds * 3.0) as usize, 440.0, sr, 0.5));
        let mut out = Vec::new();
        let mut pos = 0.0f64;
        let block = 256usize;
        let mut buf = vec![0.0f32; block * 2];
        while out.len() < (sr * seconds) as usize * 2 {
            let next = pos + block as f64 * rate;
            let (a, b) = (pos as usize, next as usize);
            st.process(&src[a * 2..b * 2], &mut buf);
            out.extend_from_slice(&buf);
            pos = next;
        }
        out
    }

    #[test]
    fn key_lock_keeps_pitch_when_slowed() {
        let mut st = SignalsmithStretch::new(48_000, StretchQuality::High);
        let out = left(&run(&mut st, 0.8, 2.0));
        let tail = &out[24_000..];
        let at_440 = testkit::tone_level(tail, 440.0, 48_000.0);
        let at_352 = testkit::tone_level(tail, 352.0, 48_000.0);
        assert!(at_440 > 0.3, "440 Hz level {at_440}");
        assert!(at_352 < 0.02, "352 Hz level {at_352}");
    }

    #[test]
    fn transpose_moves_pitch() {
        let mut st = SignalsmithStretch::new(48_000, StretchQuality::High);
        st.set_transpose(2f32.powf(3.0 / 12.0));
        let out = left(&run(&mut st, 1.0, 2.0));
        let tail = &out[24_000..];
        let shifted = 440.0 * 2f32.powf(3.0 / 12.0);
        // Find the strongest frequency near the target (0.25 Hz resolution).
        let (peak_f, peak_level) = (0..240)
            .map(|k| 500.0 + k as f32 * 0.25)
            .map(|f| (f, testkit::tone_level(tail, f, 48_000.0)))
            .fold((0.0, 0.0), |best, x| if x.1 > best.1 { x } else { best });
        let cents = 1200.0 * (peak_f / shifted).log2();
        assert!(peak_level > 0.3, "level {peak_level}");
        // A few cents of error is inaudible (the threshold for pure tones is about 5–10).
        assert!(cents.abs() < 8.0, "{peak_f} Hz is {cents} cents from {shifted}");
        assert!(testkit::tone_level(tail, 440.0, 48_000.0) < 0.03);
    }

    #[test]
    fn reports_latency() {
        let st = SignalsmithStretch::new(48_000, StretchQuality::High);
        assert!(st.input_latency() > 0 && st.output_latency() > 0);
        assert!(st.input_latency() + st.output_latency() < 48_000 / 2);
    }

    fn click_at(frames: usize, at: usize) -> Vec<f32> {
        let mut x = vec![0.0f32; frames * 2];
        for i in 0..32 {
            let v = (1.0 - i as f32 / 32.0) * if i % 2 == 0 { 0.9 } else { -0.9 };
            x[(at + i) * 2] = v;
            x[(at + i) * 2 + 1] = v;
        }
        x
    }

    fn peak_frame(x: &[f32]) -> usize {
        let l = left(x);
        (0..l.len()).max_by(|&a, &b| l[a].abs().partial_cmp(&l[b].abs()).unwrap()).unwrap()
    }

    #[test]
    fn offline_stretch_is_aligned_and_sized() {
        for speed in [1.0, 1.25, 0.8, 1.5, 2.0, 0.5] {
            let x = click_at(96_000, 30_000);
            let y = stretch_buffer(&x, 48_000, speed, 0.0, StretchQuality::High);
            assert_eq!(y.len() / 2, (96_000.0 / speed).round() as usize);
            let expect = 30_000.0 / speed;
            let got = peak_frame(&y) as f64;
            assert!((got - expect).abs() < 48.0 * 3.0, "speed {speed}: click at {got}, expected {expect}");
        }
        // Pitch shift keeps the length and moves the tone.
        let tone = interleave(&testkit::sine(96_000, 440.0, 48_000.0, 0.5));
        let y = left(&stretch_buffer(&tone, 48_000, 1.0, 12.0, StretchQuality::High));
        assert_eq!(y.len(), 96_000);
        assert!(testkit::tone_level(&y[24_000..72_000], 880.0, 48_000.0) > 0.3);
    }
}
