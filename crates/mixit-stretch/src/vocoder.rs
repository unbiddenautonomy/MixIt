//! A pure-Rust phase-vocoder stretcher for key lock and key shift, used where the native
//! Signalsmith build is unavailable (the web build) and as a second opinion in tests.
//!
//! Design, per synthesis frame (Hann windows, synthesis hop N/4):
//!
//! - **Analysis** at the input position mapped to the frame's output time, for left and
//!   right, plus a second short-lag analysis of the sum. The phase difference over that
//!   fixed lag gives each bin's true frequency, independent of the stretch ratio, so
//!   seeks and ratio changes never confuse the estimate.
//! - **Pitch shift in the spectrum**: each spectral peak and the bins around it move as a
//!   block to the shifted frequency (keeping the partial's shape), and advance their
//!   phase at the shifted true frequency. No resampler, so time and pitch are independent.
//! - **Phase locking** (Laroche and Dolson's identity locking, scaled): spectral peaks
//!   advance their phase by their own frequency; the bins around each peak keep their
//!   phase relationship to it. This keeps partials coherent and removes most of the
//!   "phasey" sound of a plain vocoder.
//! - **Stereo coherence**: one phase rotation per bin, computed from the sum, is applied
//!   to both channels, so the stereo image (inter-channel phase) is preserved.
//! - **Transients**: when high-frequency energy jumps between the two analyses, the frame
//!   resets its phases to the input's, so drums stay sharp instead of smeared.
//!
//! Timing follows the same contract as the native stretcher: the output sample written
//! at the end of a `process` call corresponds to the input position
//! `fed - input_latency - output_latency * rate`, where `rate` is input frames per output
//! frame for that call. Nothing allocates after [`PhaseVocoder::new`].

use std::f32::consts::{PI, TAU};
use std::sync::Arc;

use mixit_dsp::stretch::TimeStretch;
use realfft::num_complex::Complex32;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

/// Overlap factor: synthesis hop is N / OVERLAP.
const OVERLAP: usize = 4;
/// Onset strength above which a frame resets its phases.
const TRANSIENT: f32 = 0.35;

pub struct PhaseVocoder {
    n: usize,
    hop: usize,
    /// Lag of the second analysis, for frequency estimation.
    lag: usize,
    window: Vec<f32>,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    scratch_fwd: Vec<Complex32>,
    scratch_inv: Vec<Complex32>,
    /// Input ring (interleaved stereo), indexed by absolute input frame.
    ring: Vec<f32>,
    ring_frames: usize,
    /// Absolute input frames fed so far.
    fed: u64,
    // Per-frame work buffers.
    time: Vec<f32>,
    spec_l: Vec<Complex32>,
    spec_r: Vec<Complex32>,
    spec_lag: Vec<Complex32>,
    out_l: Vec<Complex32>,
    out_r: Vec<Complex32>,
    mag: Vec<f32>,
    freq: Vec<f32>,
    src_phase: Vec<f32>,
    /// Phase written for each output bin in the previous frame.
    phase: Vec<f32>,
    new_phase: Vec<f32>,
    peaks: Vec<usize>,
    /// Overlap-add accumulator (interleaved), N frames.
    acc: Vec<f32>,
    /// Finished output not yet handed out (interleaved), up to one hop.
    left: Vec<f32>,
    left_len: usize,
    left_pos: usize,
    /// Index of the next synthesis frame; frame k finishes output [k·hop, (k+1)·hop).
    next_frame: i64,
    /// Output frames handed out since the last reset.
    emitted: i64,
    transpose: f32,
    primed: bool,
    was_transient: bool,
}

impl PhaseVocoder {
    /// Allocates: create on a control thread and send to the engine. The window is about
    /// 85 ms (4096 frames at 44.1 or 48 kHz), the usual balance for full mixes.
    pub fn new(sample_rate: u32) -> PhaseVocoder {
        let n = ((sample_rate as f32 * 0.085) as usize).next_power_of_two().clamp(1024, 16_384);
        Self::with_window(n)
    }

    /// A vocoder with an explicit window size (a power of two).
    pub fn with_window(n: usize) -> PhaseVocoder {
        assert!(n.is_power_of_two() && n >= 256);
        let bins = n / 2 + 1;
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        let scratch_fwd = fwd.make_scratch_vec();
        let scratch_inv = inv.make_scratch_vec();
        // Periodic Hann: overlap-adds to a constant at hop N/4.
        let window = (0..n).map(|i| 0.5 - 0.5 * (TAU * i as f32 / n as f32).cos()).collect();
        let hop = n / OVERLAP;
        // Room for the pre-roll, the analysis span and the largest supported ratio.
        let ring_frames = (n * 8).next_power_of_two();
        let z = Complex32::new(0.0, 0.0);
        PhaseVocoder {
            n,
            hop,
            lag: n / 8,
            window,
            fwd,
            inv,
            scratch_fwd,
            scratch_inv,
            ring: vec![0.0; ring_frames * 2],
            ring_frames,
            fed: 0,
            time: vec![0.0; n],
            spec_l: vec![z; bins],
            spec_r: vec![z; bins],
            spec_lag: vec![z; bins],
            out_l: vec![z; bins],
            out_r: vec![z; bins],
            mag: vec![0.0; bins],
            freq: vec![0.0; bins],
            src_phase: vec![0.0; bins],
            phase: vec![0.0; bins],
            new_phase: vec![0.0; bins],
            peaks: Vec::with_capacity(bins),
            acc: vec![0.0; n * 2],
            left: vec![0.0; hop * 2],
            left_len: 0,
            left_pos: 0,
            next_frame: -((OVERLAP - 1) as i64),
            emitted: 0,
            transpose: 1.0,
            primed: false,
            was_transient: false,
        }
    }

    pub fn window(&self) -> usize {
        self.n
    }

    fn push_input(&mut self, input: &[f32]) {
        let mask = self.ring_frames - 1;
        for (i, f) in input.chunks_exact(2).enumerate() {
            let at = (self.fed as usize + i) & mask;
            self.ring[at * 2] = f[0];
            self.ring[at * 2 + 1] = f[1];
        }
        self.fed += (input.len() / 2) as u64;
    }

    /// One windowed channel starting at absolute input frame `start` into `self.time`.
    /// `mode`: 0 = left, 1 = right, 2 = sum. Frames not fed yet (or overwritten) are zero.
    fn read_window(&mut self, start: i64, mode: u8) {
        let mask = self.ring_frames - 1;
        let oldest = self.fed as i64 - self.ring_frames as i64;
        for i in 0..self.n {
            let p = start + i as i64;
            let v = if p < 0 || p >= self.fed as i64 || p < oldest {
                0.0
            } else {
                let at = (p as usize) & mask;
                match mode {
                    0 => self.ring[at * 2],
                    1 => self.ring[at * 2 + 1],
                    _ => self.ring[at * 2] + self.ring[at * 2 + 1],
                }
            };
            self.time[i] = v * self.window[i];
        }
    }

    fn analyse(&mut self, start: i64, mode: u8) {
        self.read_window(start, mode);
        let out = match mode {
            0 => &mut self.spec_l,
            1 => &mut self.spec_r,
            _ => &mut self.spec_lag,
        };
        // The FFT cannot fail with correctly sized buffers.
        let _ = self.fwd.process_with_scratch(&mut self.time, out, &mut self.scratch_fwd);
    }

    /// Builds synthesis frame `k` centred on input position `centre` and overlap-adds it.
    fn frame(&mut self, centre: f64) {
        let n = self.n;
        let bins = n / 2 + 1;
        let half = (n / 2) as i64;
        let c = centre.round() as i64;
        self.analyse(c - half, 0);
        self.analyse(c - half, 1);
        self.analyse(c - half - self.lag as i64, 2);

        // Sum spectrum now (by linearity), its magnitude, phase and true frequency.
        let lag = self.lag as f32;
        let mut flux = 0.0f32;
        let mut weight = 0.0f32;
        for k in 0..bins {
            let s = self.spec_l[k] + self.spec_r[k];
            let m = s.norm();
            let ph = s.arg();
            let prev = self.spec_lag[k];
            let expected = TAU * k as f32 * lag / n as f32;
            let dev = princarg(ph - prev.arg() - expected);
            self.mag[k] = m;
            self.src_phase[k] = ph;
            self.freq[k] = TAU * k as f32 / n as f32 + dev / lag;
            // High-frequency-weighted rise in level: an onset.
            let pm = prev.norm();
            flux += k as f32 * (m - pm).max(0.0);
            weight += k as f32 * m;
        }
        let onset = if weight > 1e-9 { flux / weight } else { 0.0 };
        let transient = onset > TRANSIENT && !self.was_transient;
        self.was_transient = onset > TRANSIENT;

        // Peaks of the input spectrum, each owning the bins up to the lowest point
        // between it and the next peak.
        self.peaks.clear();
        let floor = self.mag.iter().fold(0.0f32, |a, &b| a.max(b)) * 1e-6;
        for k in 2..bins.saturating_sub(2) {
            let m = self.mag[k];
            if m > floor && m > self.mag[k - 1] && m >= self.mag[k + 1] && m > self.mag[k - 2] && m >= self.mag[k + 2] {
                self.peaks.push(k);
            }
        }

        // Each region moves as a block to its pitch-shifted place (keeping the peak's
        // shape, so partials stay as narrow as the window makes them), and is rotated so
        // its peak continues the phase it had in the last frame at its true frequency.
        let f = self.transpose;
        let hop = self.hop as f32;
        let reset = transient || !self.primed;
        let z = Complex32::new(0.0, 0.0);
        self.out_l.fill(z);
        self.out_r.fill(z);
        self.new_phase.copy_from_slice(&self.phase);
        let mut start = 0usize;
        for i in 0..self.peaks.len() {
            let p = self.peaks[i];
            let end = match self.peaks.get(i + 1) {
                Some(&q) => region_edge(&self.mag, p, q),
                None => bins,
            };
            let shift = (p as f32 * f).round() as i64 - p as i64;
            let jp = p as i64 + shift;
            if jp <= 0 || jp >= bins as i64 - 1 {
                start = end;
                continue;
            }
            let peak_phase = if reset { self.src_phase[p] } else { self.phase[jp as usize] + self.freq[p] * f * hop };
            let rot = Complex32::from_polar(1.0, peak_phase - self.src_phase[p]);
            for k in start..end {
                let j = k as i64 + shift;
                if j < 0 || j >= bins as i64 {
                    continue;
                }
                let j = j as usize;
                self.out_l[j] += self.spec_l[k] * rot;
                self.out_r[j] += self.spec_r[k] * rot;
                self.new_phase[j] = peak_phase + (self.src_phase[k] - self.src_phase[p]);
            }
            start = end;
        }
        if !self.peaks.is_empty() {
            self.primed = true;
        }
        for j in 0..bins {
            self.phase[j] = princarg(self.new_phase[j]);
        }
        // The real inverse needs real DC and Nyquist bins.
        for spec in [&mut self.out_l, &mut self.out_r] {
            spec[0].im = 0.0;
            spec[bins - 1].im = 0.0;
        }

        // Synthesis: inverse FFT, window, overlap-add.
        let scale = 1.0 / (n as f32 * 1.5);
        for ch in 0..2 {
            let spec = if ch == 0 { &mut self.out_l } else { &mut self.out_r };
            let _ = self.inv.process_with_scratch(spec, &mut self.time, &mut self.scratch_inv);
            for i in 0..n {
                self.acc[i * 2 + ch] += self.time[i] * self.window[i] * scale;
            }
        }
    }

    /// Moves the first hop of the accumulator into `left` and shifts it.
    fn finish_hop(&mut self) {
        let h2 = self.hop * 2;
        self.left[..h2].copy_from_slice(&self.acc[..h2]);
        self.acc.copy_within(h2.., 0);
        let len = self.acc.len();
        self.acc[len - h2..].fill(0.0);
        self.left_len = self.hop;
        self.left_pos = 0;
    }
}

/// Bin where the region of peak `p` ends and that of the next peak `q` begins: the
/// lowest point between them.
fn region_edge(mag: &[f32], p: usize, q: usize) -> usize {
    let mut best = p + 1;
    for j in p + 1..q {
        if mag[j] < mag[best] {
            best = j;
        }
    }
    best.max(p + 1).min(q)
}

fn princarg(x: f32) -> f32 {
    x - TAU * ((x + PI) / TAU).floor()
}

impl TimeStretch for PhaseVocoder {
    fn reset(&mut self) {
        self.ring.fill(0.0);
        self.fed = 0;
        self.acc.fill(0.0);
        self.phase.fill(0.0);
        self.left_len = 0;
        self.left_pos = 0;
        self.next_frame = -((OVERLAP - 1) as i64);
        self.emitted = 0;
        self.primed = false;
        self.was_transient = false;
    }

    fn input_latency(&self) -> usize {
        self.n / 2
    }

    fn output_latency(&self) -> usize {
        self.n / 2
    }

    fn set_transpose(&mut self, factor: f32) {
        self.transpose = if factor.is_finite() { factor.clamp(0.25, 4.0) } else { 1.0 };
    }

    fn process(&mut self, input: &[f32], output: &mut [f32]) {
        let nout = output.len() / 2;
        self.push_input(input);
        if nout == 0 {
            return;
        }
        let rate = (input.len() / 2) as f64 / nout as f64;
        let half = (self.n / 2) as f64;
        // Input position of the last output frame of this call (see the module docs),
        // and the output time it has.
        let end_in = self.fed as f64 - half - half * rate;
        let end_out = (self.emitted + nout as i64) as f64;
        let mut written = 0usize;
        while written < nout {
            if self.left_pos < self.left_len {
                let take = (self.left_len - self.left_pos).min(nout - written);
                let a = self.left_pos * 2;
                output[written * 2..(written + take) * 2].copy_from_slice(&self.left[a..a + take * 2]);
                self.left_pos += take;
                written += take;
                self.emitted += take as i64;
                continue;
            }
            // Frame k is centred at output time k·hop + N/2.
            let k = self.next_frame;
            self.next_frame += 1;
            let centre_out = (k * self.hop as i64) as f64 + half;
            let centre_in = end_in + (centre_out - end_out) * rate;
            self.frame(centre_in);
            self.finish_hop();
            if k < 0 {
                // Frames before the start only complete the overlap; their hop is not heard.
                self.left_len = 0;
            }
        }
    }

    fn seek(&mut self, input: &[f32], _rate: f64) {
        self.reset();
        self.push_input(input);
        // Start with the input's own phases so the first frames are not smeared.
        self.primed = false;
    }

    fn name(&self) -> &'static str {
        "MixIt phase vocoder"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn princarg_wraps() {
        assert!((princarg(3.0 * PI) - PI).abs() < 1e-5 || (princarg(3.0 * PI) + PI).abs() < 1e-5);
        assert!((princarg(0.5) - 0.5).abs() < 1e-6);
        assert!((princarg(-TAU - 0.5) + 0.5).abs() < 1e-5);
    }

    #[test]
    fn unity_rate_keeps_levels() {
        // A vocoder does not keep absolute phase (it drifts slowly), so check what is
        // heard: each partial at its level and nothing else added.
        let mut v = PhaseVocoder::with_window(2048);
        let sr = 48_000.0;
        let x: Vec<f32> = (0..48_000)
            .flat_map(|i| {
                let s = (TAU * 440.0 * i as f32 / sr).sin() * 0.5 + (TAU * 1250.0 * i as f32 / sr).sin() * 0.2;
                [s, s]
            })
            .collect();
        let mut y = vec![0.0f32; x.len()];
        for (a, b) in x.chunks(512).zip(y.chunks_mut(512)) {
            v.process(a, b);
        }
        let l: Vec<f32> = y[20_000..92_000].chunks(2).map(|c| c[0]).collect();
        let a = mixit_dsp::testkit::tone_level(&l, 440.0, sr);
        let b = mixit_dsp::testkit::tone_level(&l, 1250.0, sr);
        assert!((a - 0.5).abs() < 0.02 && (b - 0.2).abs() < 0.01, "levels {a} {b}");
        let expected = (0.5f32 * 0.5 / 2.0 + 0.2 * 0.2 / 2.0).sqrt();
        let rms = mixit_dsp::testkit::rms(&l);
        assert!((rms / expected - 1.0).abs() < 0.03, "rms {rms} vs {expected}");
    }
}
