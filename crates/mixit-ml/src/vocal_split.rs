//! Cleaner vocals: Kimberley Jensen's Mel-Band RoFormer vocals model (MIT), a large
//! trained model that takes only the singing out of a track, much more cleanly than
//! HTDemucs's vocal stem. It runs after HTDemucs, and its vocals take the place of
//! HTDemucs's; drums and bass stay HTDemucs's, and melody is still the track minus the
//! other three.
//!
//! The ONNX graph is the network between the model's STFT and inverse STFT, so both are
//! done here exactly as its training code does them (2048-point Hann window, hop 441,
//! unnormalised, centred with reflect padding). A track is read in 8 s pieces every 4 s,
//! each faded in and out over 0.8 s, and the ends of the track are mirrored out first, as
//! the authors' `demix()` does.

use std::path::Path;

use crate::{MlError, Result};

/// The model's sample rate.
pub const RATE: u32 = 44_100;
/// Samples in one piece (8 s).
pub const CHUNK: usize = 352_800;
/// A new piece every half piece.
pub const STEP: usize = CHUNK / 2;
/// Samples each piece fades in and out over.
pub const FADE: usize = CHUNK / 10;
const N_FFT: usize = 2048;
const HOP: usize = 441;
const BINS: usize = N_FFT / 2 + 1;
/// Spectrogram frames in one piece.
pub const FRAMES: usize = CHUNK / HOP + 1;

fn hann() -> Vec<f64> {
    (0..N_FFT).map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N_FFT as f64).cos()).collect()
}

/// Mirrors `x` at its ends (without repeating the end sample), for index `i` from
/// `-len` to `2 len`.
fn reflect(x: &[f32], i: isize) -> f32 {
    let n = x.len() as isize;
    if n < 2 {
        return x.first().copied().unwrap_or(0.0);
    }
    let mut i = i;
    while i < 0 || i >= n {
        if i < 0 {
            i = -i;
        }
        if i >= n {
            i = 2 * (n - 1) - i;
        }
    }
    x[i as usize]
}

/// The model's input for one piece of planar stereo (`left`, `right`, `CHUNK` each):
/// `[4, BINS, FRAMES]` (left real, left imaginary, right real, right imaginary).
pub fn spectrum(left: &[f32], right: &[f32]) -> Vec<f32> {
    let window = hann();
    let mut planner = realfft::RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let mut buf = fft.make_input_vec();
    let mut spec = fft.make_output_vec();
    let mut out = vec![0.0f32; 4 * BINS * FRAMES];
    for (c, x) in [left, right].into_iter().enumerate() {
        for t in 0..FRAMES {
            let start = (t * HOP) as isize - (N_FFT / 2) as isize;
            for (k, v) in buf.iter_mut().enumerate() {
                *v = reflect(x, start + k as isize) as f64 * window[k];
            }
            fft.process(&mut buf, &mut spec).expect("sizes match the plan");
            for (f, z) in spec.iter().enumerate() {
                out[((2 * c) * BINS + f) * FRAMES + t] = z.re as f32;
                out[((2 * c + 1) * BINS + f) * FRAMES + t] = z.im as f32;
            }
        }
    }
    out
}

/// Back from the model's output (`[4, BINS, FRAMES]`) to planar stereo, `CHUNK` samples
/// a side: the inverse of [`spectrum`], overlap-added with the window and divided by the
/// sum of its squares.
pub fn waveform(spec: &[f32]) -> [Vec<f32>; 2] {
    let window = hann();
    let mut planner = realfft::RealFftPlanner::<f64>::new();
    let ifft = planner.plan_fft_inverse(N_FFT);
    let mut z = ifft.make_input_vec();
    let mut buf = ifft.make_output_vec();
    let padded = CHUNK + N_FFT;
    let mut wsum = vec![0.0f64; padded];
    for t in 0..FRAMES {
        for (k, w) in window.iter().enumerate() {
            wsum[t * HOP + k] += w * w;
        }
    }
    let mut out = [vec![0.0f32; CHUNK], vec![0.0f32; CHUNK]];
    for (c, o) in out.iter_mut().enumerate() {
        let mut acc = vec![0.0f64; padded];
        for t in 0..FRAMES {
            for (f, v) in z.iter_mut().enumerate() {
                v.re = spec[((2 * c) * BINS + f) * FRAMES + t] as f64;
                v.im = spec[((2 * c + 1) * BINS + f) * FRAMES + t] as f64;
            }
            // A real signal's spectrum has no imaginary part at 0 Hz and at Nyquist.
            z[0].im = 0.0;
            z[BINS - 1].im = 0.0;
            ifft.process(&mut z, &mut buf).expect("sizes match the plan");
            for (k, v) in buf.iter().enumerate() {
                acc[t * HOP + k] += v / N_FFT as f64 * window[k];
            }
        }
        for (i, s) in o.iter_mut().enumerate() {
            let j = i + N_FFT / 2;
            *s = if wsum[j] > 1e-11 { (acc[j] / wsum[j]) as f32 } else { 0.0 };
        }
    }
    out
}

/// Takes the vocals out of one piece's spectrum.
pub trait VocalNet {
    /// `[4, BINS, FRAMES]` in and out.
    fn vocals(&mut self, spec: &[f32]) -> Result<Vec<f32>>;
}

/// The weight of each sample of a piece: a linear fade in and out over [`FADE`], except
/// at the very start of the first piece and the end of the last.
fn weight(i: usize, first: bool, last: bool) -> f32 {
    if !first && i < FADE {
        return i as f32 / (FADE - 1) as f32;
    }
    if !last && i >= CHUNK - FADE {
        return (CHUNK - 1 - i) as f32 / (FADE - 1) as f32;
    }
    1.0
}

/// The vocals of interleaved stereo `audio` at `sample_rate`, interleaved at the same
/// rate and length. `progress` gets 0..1 after each piece and returns false to stop.
pub fn vocals(
    model: &mut dyn VocalNet,
    sample_rate: u32,
    audio: &[f32],
    mut progress: impl FnMut(f32) -> bool,
) -> Result<Vec<f32>> {
    let frames = audio.len() / 2;
    let resampled;
    let at_rate: &[f32] = if sample_rate == RATE {
        audio
    } else {
        resampled =
            mixit_io::resample_interleaved(audio, 2, sample_rate, RATE).map_err(|e| MlError::Run(e.to_string()))?;
        &resampled
    };
    let n0 = at_rate.len() / 2;
    let planar: [Vec<f32>; 2] = [0, 1].map(|c| (0..n0).map(|i| at_rate[2 * i + c]).collect());
    // The ends mirrored out by the part of a piece that isn't the next one's, so every
    // sample of the track is heard in the middle of some piece.
    let border = CHUNK - STEP;
    let padded = n0 > 2 * border;
    let mix: [Vec<f32>; 2] = if padded {
        planar.clone().map(|x| (0..n0 + 2 * border).map(|i| reflect(&x, i as isize - border as isize)).collect())
    } else {
        planar
    };
    let n = mix[0].len();
    let starts: Vec<usize> = (0..n).step_by(STEP).collect();
    let mut sum = [vec![0.0f32; n], vec![0.0f32; n]];
    let mut count = vec![0.0f32; n];
    let mut piece = [vec![0.0f32; CHUNK], vec![0.0f32; CHUNK]];
    for (k, &start) in starts.iter().enumerate() {
        let len = CHUNK.min(n - start);
        for c in 0..2 {
            let part = &mix[c][start..start + len];
            for i in 0..CHUNK {
                piece[c][i] = if i < len {
                    part[i]
                } else if len > CHUNK / 2 + 1 {
                    // A short last piece is mirrored out to length, else filled with silence.
                    reflect(part, i as isize)
                } else {
                    0.0
                };
            }
        }
        let out = model.vocals(&spectrum(&piece[0], &piece[1]))?;
        if out.len() != 4 * BINS * FRAMES {
            return Err(MlError::Run(format!("the vocal model gave {} values, not {}", out.len(), 4 * BINS * FRAMES)));
        }
        let y = waveform(&out);
        let (first, last) = (k == 0, start + CHUNK >= n);
        for i in 0..len {
            let w = weight(i, first, last);
            for c in 0..2 {
                sum[c][start + i] += y[c][i] * w;
            }
            count[start + i] += w;
        }
        if !progress((k + 1) as f32 / starts.len() as f32) {
            return Err(MlError::Cancelled);
        }
    }
    let off = if padded { border } else { 0 };
    let mut out = vec![0.0f32; 2 * n0];
    for i in 0..n0 {
        let w = count[off + i].max(1e-8);
        out[2 * i] = sum[0][off + i] / w;
        out[2 * i + 1] = sum[1][off + i] / w;
    }
    if sample_rate != RATE {
        out = mixit_io::resample_interleaved(&out, 2, RATE, sample_rate).map_err(|e| MlError::Run(e.to_string()))?;
    }
    out.resize(2 * frames, 0.0);
    Ok(out)
}

/// Mel-Band RoFormer loaded.
pub struct MelRoformer {
    #[cfg(feature = "onnx")]
    session: ort::session::Session,
}

impl MelRoformer {
    #[cfg(feature = "onnx")]
    pub fn load(path: &Path) -> Result<MelRoformer> {
        use ort::session::{Session, builder::GraphOptimizationLevel};
        if !path.is_file() {
            return Err(MlError::Missing);
        }
        use ort::execution_providers::CPUExecutionProvider;
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
        let e = |e: ort::Error| MlError::Run(e.to_string());
        // Without the runtime's memory arena and planned buffers a piece needs about 3 GB
        // at its peak instead of 5.4, at no cost in speed: this model is big enough that
        // it matters on an 8 GB computer.
        let session = Session::builder()
            .map_err(e)?
            .with_execution_providers([CPUExecutionProvider::default().with_arena_allocator(false).build()])
            .map_err(e)?
            .with_memory_pattern(false)
            .map_err(e)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(e)?
            .with_intra_threads(threads)
            .map_err(e)?
            .commit_from_file(path)
            .map_err(e)?;
        Ok(MelRoformer { session })
    }

    #[cfg(not(feature = "onnx"))]
    pub fn load(_path: &Path) -> Result<MelRoformer> {
        Err(MlError::NoRuntime)
    }
}

impl VocalNet for MelRoformer {
    #[cfg(feature = "onnx")]
    fn vocals(&mut self, spec: &[f32]) -> Result<Vec<f32>> {
        use ort::value::Tensor;
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let input = Tensor::from_array(([1usize, 4, BINS, FRAMES], spec.to_vec())).map_err(e)?;
        let out = self.session.run(ort::inputs!["mix_spec" => input]).map_err(e)?;
        let (_, y) = out["stems_spec"].try_extract_tensor::<f32>().map_err(e)?;
        Ok(y.to_vec())
    }

    #[cfg(not(feature = "onnx"))]
    fn vocals(&mut self, _spec: &[f32]) -> Result<Vec<f32>> {
        Err(MlError::NoRuntime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(n: usize, hz: f64, phase: f64) -> Vec<f32> {
        (0..n).map(|i| (0.3 * (std::f64::consts::TAU * hz * i as f64 / RATE as f64 + phase).sin()) as f32).collect()
    }

    #[test]
    fn the_spectrum_turns_back_into_the_same_sound() {
        let (l, r) = (tone(CHUNK, 440.0, 0.0), tone(CHUNK, 1_234.5, 1.0));
        let [l2, r2] = waveform(&spectrum(&l, &r));
        let err = l.iter().zip(&l2).chain(r.iter().zip(&r2)).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1e-4, "{err}");
    }

    /// Stands in for the model: gives the input back, so the "vocals" are the track.
    struct Same;

    impl VocalNet for Same {
        fn vocals(&mut self, spec: &[f32]) -> Result<Vec<f32>> {
            Ok(spec.to_vec())
        }
    }

    #[test]
    fn pieces_join_without_a_seam() {
        // 21 s at 48 kHz: resampled, padded, read in six pieces and put back.
        let n = 21 * 48_000;
        let audio: Vec<f32> = (0..n)
            .flat_map(|i| {
                let t = i as f64 / 48_000.0;
                [
                    (0.3 * (std::f64::consts::TAU * 220.0 * t).sin()) as f32,
                    (0.2 * (std::f64::consts::TAU * 330.0 * t).cos()) as f32,
                ]
            })
            .collect();
        let mut calls = 0;
        let out = vocals(&mut Same, 48_000, &audio, |_| {
            calls += 1;
            true
        })
        .unwrap();
        assert_eq!(out.len(), audio.len());
        assert!(calls >= 6, "{calls}");
        // Away from the very ends (where resampling filters ring), the same sound.
        let err = (2_000..n - 2_000)
            .flat_map(|i| [(out[2 * i] - audio[2 * i]).abs(), (out[2 * i + 1] - audio[2 * i + 1]).abs()])
            .fold(0.0f32, f32::max);
        assert!(err < 2e-3, "{err}");
    }
}
