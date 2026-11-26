//! The beat helper: Beat This! (Foscarin, Schlüter and Widmer, JKU Linz; MIT code and
//! weights), a trained beat and downbeat tracker, as a second opinion for tracks
//! where MixIt's own beat finder is unsure (live bands, swing, tracks with no clear kick).
//!
//! The model reads a log-mel spectrogram made the way its training made it (22.05 kHz
//! mono, 1024-point Hann window, hop 441 so 50 frames a second, magnitude divided by
//! √1024, 128 Slaney mel bands from 30 Hz to 11 kHz without area normalisation, then
//! `ln(1 + 1000 x)`): [`log_mel`] does that here. It says, frame by frame, how likely a
//! beat and a downbeat are. A long track is read in 30 s pieces that overlap by a few
//! frames ([`pieces`]), the way the authors' own code does, and the likely frames are
//! picked as their reference "minimal" post-processing does ([`pick`]).

use std::path::Path;

use crate::{MlError, Result};

/// The model's sample rate.
pub const RATE: u32 = 22_050;
/// Spectrogram frames a second.
pub const FPS: f64 = 50.0;
/// Mel bands.
pub const MELS: usize = 128;
/// Frames in one piece the model reads (30 s).
pub const PIECE: usize = 1_500;
/// Frames at each end of a piece whose answers are thrown away.
pub const BORDER: usize = 6;
/// The name a helper's grid is stored under.
pub const MODEL_ID: &str = "beat-this-final0";

const N_FFT: usize = 1024;
const HOP: usize = 441;
const BINS: usize = N_FFT / 2 + 1;
const F_MIN: f64 = 30.0;
const F_MAX: f64 = 11_000.0;

fn hz_to_mel(f: f64) -> f64 {
    if f < 1_000.0 { 3.0 * f / 200.0 } else { 15.0 + (f / 1_000.0).ln() * 27.0 / 6.4f64.ln() }
}

fn mel_to_hz(m: f64) -> f64 {
    if m < 15.0 { 200.0 * m / 3.0 } else { 1_000.0 * (6.4f64.ln() / 27.0 * (m - 15.0)).exp() }
}

/// The 513 × 128 mel filter bank (row-major by frequency bin), triangles of height 1.
fn mel_bank() -> Vec<f32> {
    let edges: Vec<f64> = (0..MELS + 2)
        .map(|i| mel_to_hz(hz_to_mel(F_MIN) + (hz_to_mel(F_MAX) - hz_to_mel(F_MIN)) * i as f64 / (MELS + 1) as f64))
        .collect();
    let mut fb = vec![0.0f32; BINS * MELS];
    for b in 0..BINS {
        let f = (RATE / 2) as f64 * b as f64 / (BINS - 1) as f64;
        for m in 0..MELS {
            let down = (f - edges[m]) / (edges[m + 1] - edges[m]);
            let up = (edges[m + 2] - f) / (edges[m + 2] - edges[m + 1]);
            fb[b * MELS + m] = down.min(up).max(0.0) as f32;
        }
    }
    fb
}

/// The model's input for mono 22.05 kHz audio: `frames` × [`MELS`] values, frame by
/// frame, with `frames = len / 441 + 1`.
pub fn log_mel(x: &[f32]) -> Vec<f32> {
    let fb = mel_bank();
    let window: Vec<f64> =
        (0..N_FFT).map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N_FFT as f64).cos()).collect();
    let half = N_FFT / 2;
    let n = x.len();
    // Centred frames: the signal is mirrored at both ends.
    let at = |i: isize| -> f32 {
        if n < 2 {
            return x.first().copied().unwrap_or(0.0);
        }
        let mut i = i;
        while i < 0 || i >= n as isize {
            if i < 0 {
                i = -i;
            }
            if i >= n as isize {
                i = 2 * (n as isize - 1) - i;
            }
        }
        x[i as usize]
    };
    let frames = n / HOP + 1;
    let mut planner = realfft::RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut buf = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    let mut mag = vec![0.0f32; BINS];
    let scale = 1.0 / (N_FFT as f64).sqrt();
    let mut out = vec![0.0f32; frames * MELS];
    for t in 0..frames {
        let start = (t * HOP) as isize - half as isize;
        for (k, v) in buf.iter_mut().enumerate() {
            *v = at(start + k as isize) as f64 * window[k];
        }
        fft.process(&mut buf, &mut spec).expect("sizes match the plan");
        for (m, c) in mag.iter_mut().zip(&spec) {
            *m = (c.norm() * scale) as f32;
        }
        for m in 0..MELS {
            let e: f32 = (0..BINS).map(|b| mag[b] * fb[b * MELS + m]).sum();
            out[t * MELS + m] = (1.0 + 1_000.0 * e).ln();
        }
    }
    out
}

/// Mono 22.05 kHz from interleaved stereo at `sample_rate`.
pub fn mono_22k(sample_rate: u32, stereo: &[f32]) -> Result<Vec<f32>> {
    let mono: Vec<f32> = stereo.chunks_exact(2).map(|f| 0.5 * (f[0] + f[1])).collect();
    if sample_rate == RATE {
        return Ok(mono);
    }
    mixit_io::resample_interleaved(&mono, 1, sample_rate, RATE).map_err(|e| MlError::Run(e.to_string()))
}

/// Where the pieces of a `frames`-long spectrogram start (the first one before the start,
/// so its thrown-away border is outside the track): every `PIECE - 2 × BORDER` frames,
/// with the last moved back so it ends with the track instead of running short.
pub fn pieces(frames: usize) -> Vec<isize> {
    let step = PIECE - 2 * BORDER;
    let mut starts: Vec<isize> = (-(BORDER as isize)..frames as isize - BORDER as isize).step_by(step).collect();
    if starts.is_empty() {
        starts.push(-(BORDER as isize));
    }
    if frames > step {
        *starts.last_mut().expect("not empty") = frames as isize - PIECE as isize + BORDER as isize;
    }
    starts
}

/// Reads a spectrogram and says, frame by frame, how likely a beat and a downbeat are.
pub trait BeatNet {
    /// `frames` × [`MELS`] values in; beat and downbeat scores (logits, above 0 is
    /// likely) for each frame out.
    fn scores(&mut self, mel: &[f32], frames: usize) -> Result<(Vec<f32>, Vec<f32>)>;
}

/// Scores for a whole track, read piece by piece: each frame keeps the answer of the
/// first piece that covers it away from that piece's borders.
pub fn track_scores(
    model: &mut dyn BeatNet,
    mel: &[f32],
    mut progress: impl FnMut(f32) -> bool,
) -> Result<(Vec<f32>, Vec<f32>)> {
    let n = mel.len() / MELS;
    let mut beat = vec![-1_000.0f32; n];
    let mut down = vec![-1_000.0f32; n];
    let mut filled = vec![false; n];
    let starts = pieces(n);
    for (i, &start) in starts.iter().enumerate() {
        if !progress(i as f32 / starts.len() as f32) {
            return Err(MlError::Cancelled);
        }
        let (a, b) = (start.max(0) as usize, ((start + PIECE as isize).max(0) as usize).min(n));
        let left = (-start).max(0) as usize;
        let right = (start + PIECE as isize - n as isize).clamp(0, BORDER as isize) as usize;
        let len = left + (b - a) + right;
        let mut input = vec![0.0f32; len * MELS];
        input[left * MELS..(left + b - a) * MELS].copy_from_slice(&mel[a * MELS..b * MELS]);
        let (pb, pd) = model.scores(&input, len)?;
        if pb.len() != len || pd.len() != len {
            return Err(MlError::Run(format!("the beat helper gave {} answers for {len} frames", pb.len())));
        }
        for j in BORDER..len.saturating_sub(BORDER) {
            let f = start + j as isize;
            if f < 0 || f >= n as isize || filled[f as usize] {
                continue;
            }
            let f = f as usize;
            beat[f] = pb[j];
            down[f] = pd[j];
            filled[f] = true;
        }
    }
    Ok((beat, down))
}

/// Peaks: frames that are the highest within ±3 frames (70 ms) and score above 0,
/// with neighbouring peaks merged into their mean.
fn peaks(x: &[f32]) -> Vec<f64> {
    let n = x.len();
    let mut found: Vec<usize> = Vec::new();
    for i in 0..n {
        let (a, b) = (i.saturating_sub(3), (i + 4).min(n));
        let max = x[a..b].iter().copied().fold(f32::MIN, f32::max);
        if x[i] == max && x[i] > 0.0 {
            found.push(i);
        }
    }
    let mut out = Vec::new();
    let mut it = found.into_iter();
    let Some(first) = it.next() else { return out };
    let (mut p, mut c) = (first as f64, 1.0);
    for q in it {
        let q = q as f64;
        if q - p <= 1.0 {
            c += 1.0;
            p += (q - p) / c;
        } else {
            out.push(p);
            p = q;
            c = 1.0;
        }
    }
    out.push(p);
    out
}

/// Beats and downbeats the helper heard, in seconds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Heard {
    pub beats: Vec<f64>,
    /// Each one is also in `beats`.
    pub downbeats: Vec<f64>,
}

/// Picks beats and downbeats from the scores, each downbeat moved to its nearest beat.
pub fn pick(beat: &[f32], down: &[f32]) -> Heard {
    let beats: Vec<f64> = peaks(beat).into_iter().map(|f| f / FPS).collect();
    let mut downbeats: Vec<f64> = peaks(down)
        .into_iter()
        .map(|f| f / FPS)
        .filter_map(|d| beats.iter().copied().min_by(|a, b| (a - d).abs().total_cmp(&(b - d).abs())))
        .collect();
    downbeats.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    Heard { beats, downbeats }
}

/// Listens to a track (interleaved stereo) for its beats and downbeats.
pub fn hear(
    model: &mut dyn BeatNet,
    sample_rate: u32,
    stereo: &[f32],
    progress: impl FnMut(f32) -> bool,
) -> Result<Heard> {
    let mono = mono_22k(sample_rate, stereo)?;
    if mono.iter().all(|v| v.abs() < 1e-6) {
        return Err(MlError::Run("the track is silent".into()));
    }
    let mel = log_mel(&mono);
    let (b, d) = track_scores(model, &mel, progress)?;
    Ok(pick(&b, &d))
}

/// Beat This! loaded.
pub struct BeatThis {
    #[cfg(feature = "onnx")]
    session: ort::session::Session,
}

impl BeatThis {
    #[cfg(feature = "onnx")]
    pub fn load(path: &Path) -> Result<BeatThis> {
        use ort::session::{Session, builder::GraphOptimizationLevel};
        if !path.is_file() {
            return Err(MlError::Missing);
        }
        // It runs in the background after analysis, maybe while someone plays.
        let threads = std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1));
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let session = Session::builder()
            .map_err(e)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(e)?
            .with_intra_threads(threads)
            .map_err(e)?
            .commit_from_file(path)
            .map_err(e)?;
        Ok(BeatThis { session })
    }

    #[cfg(not(feature = "onnx"))]
    pub fn load(_path: &Path) -> Result<BeatThis> {
        Err(MlError::NoRuntime)
    }
}

impl BeatNet for BeatThis {
    #[cfg(feature = "onnx")]
    fn scores(&mut self, mel: &[f32], frames: usize) -> Result<(Vec<f32>, Vec<f32>)> {
        use ort::value::Tensor;
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let name = self.session.inputs[0].name.clone();
        // The graph reads exactly one piece: a shorter one is made up with silence.
        let len = frames.max(PIECE);
        let mut x = mel[..frames * MELS].to_vec();
        x.resize(len * MELS, 0.0);
        let input = Tensor::from_array(([1usize, len, MELS], x)).map_err(e)?;
        let out = self.session.run(ort::inputs![name => input]).map_err(e)?;
        let (_, b) = out["beat"].try_extract_tensor::<f32>().map_err(e)?;
        let (_, d) = out["downbeat"].try_extract_tensor::<f32>().map_err(e)?;
        Ok((b[..frames].to_vec(), d[..frames].to_vec()))
    }

    #[cfg(not(feature = "onnx"))]
    fn scores(&mut self, _mel: &[f32], _frames: usize) -> Result<(Vec<f32>, Vec<f32>)> {
        Err(MlError::NoRuntime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_cover_the_track_like_the_authors_code() {
        // Short: one piece starting before the track.
        assert_eq!(pieces(100), vec![-6]);
        // Long: every 1488 frames, the last one ending with the track.
        assert_eq!(pieces(4_000), vec![-6, 1_482, 2_506]);
        assert_eq!(pieces(4_000).last().unwrap() + PIECE as isize - BORDER as isize, 4_000);
    }

    #[test]
    fn the_filter_bank_spans_30_hz_to_11_khz() {
        let fb = mel_bank();
        // The lowest band starts above 0 Hz, the highest ends below Nyquist.
        assert_eq!(fb[0], 0.0);
        assert_eq!(fb[(BINS - 1) * MELS + MELS - 1], 0.0);
        let peak = fb.iter().copied().fold(0.0f32, f32::max);
        assert!(peak > 0.99 && peak <= 1.0, "{peak}");
    }

    /// Stands in for the model: a beat score that peaks every `period` frames, with a
    /// downbeat every fourth.
    struct Pulse {
        period: usize,
        offset: usize,
    }

    impl Pulse {
        fn score(&self, f: usize, every: usize) -> f32 {
            if f < self.offset {
                return -5.0;
            }
            let d = (f - self.offset) % (self.period * every);
            let d = d.min(self.period * every - d) as f32;
            3.0 - d
        }
    }

    /// The same, read piece by piece: each piece knows where it is in the track.
    struct Pieces<'a> {
        pulse: &'a Pulse,
        starts: std::vec::IntoIter<isize>,
    }

    impl BeatNet for Pieces<'_> {
        fn scores(&mut self, _mel: &[f32], frames: usize) -> Result<(Vec<f32>, Vec<f32>)> {
            let s = self.starts.next().expect("one call per piece");
            let at = |j: usize, every| {
                let f = s + j as isize;
                if f < 0 { -5.0 } else { self.pulse.score(f as usize, every) }
            };
            Ok(((0..frames).map(|j| at(j, 1)).collect(), (0..frames).map(|j| at(j, 4)).collect()))
        }
    }

    #[test]
    fn beats_come_out_where_the_scores_peak_across_pieces() {
        // 120 BPM: a beat every 25 frames, from frame 10, over 100 s.
        let pulse = Pulse { period: 25, offset: 10 };
        let n = 5_000;
        let mel = vec![0.0f32; n * MELS];
        let mut net = Pieces { pulse: &pulse, starts: pieces(n).into_iter() };
        let (b, d) = track_scores(&mut net, &mel, |_| true).unwrap();
        let h = pick(&b, &d);
        assert_eq!(h.beats.len(), (n - 10) / 25 + 1);
        for (i, t) in h.beats.iter().enumerate() {
            assert!((t - (10 + 25 * i) as f64 / FPS).abs() < 1e-9, "beat {i} at {t}");
        }
        assert_eq!(h.downbeats.len(), (n - 10) / 100 + 1);
        assert!((h.downbeats[1] - 110.0 / FPS).abs() < 1e-9);
    }

    #[test]
    fn neighbouring_peaks_merge() {
        let mut x = vec![-1.0f32; 20];
        x[5] = 2.0;
        x[6] = 2.0;
        assert_eq!(peaks(&x), vec![5.5]);
    }
}
