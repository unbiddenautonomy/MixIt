//! The trained stem splitter: HTDemucs through ONNX Runtime.
//!
//! The model takes 7.8 s of 44.1 kHz stereo at a time and gives back drums, bass,
//! "other" and vocals for the same 7.8 s. A track is worked through in pieces that
//! overlap by a quarter, and each piece fades in and out across the overlap so the joins
//! are seamless (the very start and end are not faded, so nothing there is lost). A
//! track at another rate is resampled to 44.1 kHz for the model and its stems back to
//! the track's rate.
//!
//! Only vocals, drums and bass are kept: the engine plays the fourth stem, melody, as
//! the track minus those three, so the four always add back to the track exactly.

use std::path::Path;

use crate::{MlError, Result};

/// The model's sample rate.
pub const MODEL_RATE: u32 = 44_100;
/// Frames per piece (7.8 s at 44.1 kHz).
pub const SEGMENT: usize = 343_980;
/// Frames two neighbouring pieces share.
pub const OVERLAP: usize = SEGMENT / 4;
const STRIDE: usize = SEGMENT - OVERLAP;

/// Output order of the model.
const DRUMS: usize = 0;
const BASS: usize = 1;
const VOCALS: usize = 3;
const MODEL_STEMS: usize = 4;

/// Vocals, drums and bass, interleaved stereo at the track's rate and length.
pub struct Stems {
    pub vocals: Vec<f32>,
    pub drums: Vec<f32>,
    pub bass: Vec<f32>,
}

/// Where each piece of a track of `frames` frames starts.
pub fn piece_starts(frames: usize) -> Vec<usize> {
    if frames <= SEGMENT {
        return vec![0];
    }
    let n = (frames - OVERLAP).div_ceil(STRIDE);
    (0..n).map(|i| i * STRIDE).collect()
}

/// The weight of each frame of a piece: a linear fade over the overlap on each side,
/// except at the track's start (`first`) and end (`last`).
fn piece_weight(i: usize, first: bool, last: bool) -> f32 {
    if !first && i < OVERLAP {
        return (i as f32 + 0.5) / OVERLAP as f32;
    }
    if !last && i >= SEGMENT - OVERLAP {
        return (SEGMENT - i) as f32 / OVERLAP as f32 - 0.5 / OVERLAP as f32;
    }
    1.0
}

/// Runs one piece: planar stereo in (`2 × SEGMENT`), the model's four stems out
/// (`4 × 2 × SEGMENT`, planar).
pub trait Separator {
    fn run(&mut self, input: &[f32]) -> Result<Vec<f32>>;
}

/// Splits interleaved stereo `audio` at `sample_rate` with `model`. `progress` gets
/// 0..1 after each piece and returns false to stop.
pub fn split(
    model: &mut dyn Separator,
    sample_rate: u32,
    audio: &[f32],
    mut progress: impl FnMut(f32) -> bool,
) -> Result<Stems> {
    let frames = audio.len() / 2;
    let resampled;
    let at_rate: &[f32] = if sample_rate == MODEL_RATE {
        audio
    } else {
        resampled = mixit_io::resample_interleaved(audio, 2, sample_rate, MODEL_RATE)
            .map_err(|e| MlError::Run(e.to_string()))?;
        &resampled
    };
    let n = at_rate.len() / 2;
    let starts = piece_starts(n);
    // Planar sums for the three stems kept, and the total weight per frame.
    let mut sums = [vec![0.0f32; 2 * n], vec![0.0f32; 2 * n], vec![0.0f32; 2 * n]];
    let mut weight = vec![0.0f32; n];
    let mut input = vec![0.0f32; 2 * SEGMENT];
    for (k, &start) in starts.iter().enumerate() {
        let len = SEGMENT.min(n - start);
        input.fill(0.0);
        for i in 0..len {
            input[i] = at_rate[2 * (start + i)];
            input[SEGMENT + i] = at_rate[2 * (start + i) + 1];
        }
        let out = model.run(&input)?;
        if out.len() != MODEL_STEMS * 2 * SEGMENT {
            return Err(MlError::Run(format!(
                "the model gave {} values, not {}",
                out.len(),
                MODEL_STEMS * 2 * SEGMENT
            )));
        }
        let (first, last) = (k == 0, k + 1 == starts.len());
        for i in 0..len {
            let w = piece_weight(i, first, last);
            weight[start + i] += w;
            for (s, stem) in [VOCALS, DRUMS, BASS].into_iter().enumerate() {
                for ch in 0..2 {
                    sums[s][ch * n + start + i] += w * out[(stem * 2 + ch) * SEGMENT + i];
                }
            }
        }
        if !progress((k + 1) as f32 / starts.len() as f32) {
            return Err(MlError::Cancelled);
        }
    }
    let mut parts = sums.map(|planar| {
        let mut inter = vec![0.0f32; 2 * n];
        for i in 0..n {
            let w = weight[i].max(1e-6);
            inter[2 * i] = planar[i] / w;
            inter[2 * i + 1] = planar[n + i] / w;
        }
        inter
    });
    if sample_rate != MODEL_RATE {
        for p in &mut parts {
            *p = mixit_io::resample_interleaved(p, 2, MODEL_RATE, sample_rate)
                .map_err(|e| MlError::Run(e.to_string()))?;
        }
    }
    for p in &mut parts {
        p.resize(2 * frames, 0.0);
    }
    let [vocals, drums, bass] = parts;
    Ok(Stems { vocals, drums, bass })
}

/// HTDemucs loaded and ready to run.
pub struct HtDemucs {
    #[cfg(feature = "onnx")]
    session: ort::session::Session,
}

impl HtDemucs {
    /// Loads the model file. It uses all but one of the processor's cores, so the
    /// audio thread always has one to itself.
    #[cfg(feature = "onnx")]
    pub fn load(path: &Path) -> Result<HtDemucs> {
        use ort::session::{Session, builder::GraphOptimizationLevel};
        if !path.is_file() {
            return Err(MlError::Missing);
        }
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1));
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let session = Session::builder()
            .map_err(e)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(e)?
            .with_intra_threads(threads)
            .map_err(e)?
            .commit_from_file(path)
            .map_err(e)?;
        Ok(HtDemucs { session })
    }

    #[cfg(not(feature = "onnx"))]
    pub fn load(_path: &Path) -> Result<HtDemucs> {
        Err(MlError::NoRuntime)
    }
}

impl Separator for HtDemucs {
    #[cfg(feature = "onnx")]
    fn run(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        use ort::value::Tensor;
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let x = Tensor::from_array(([1usize, 2, SEGMENT], input.to_vec())).map_err(e)?;
        let outputs = self.session.run(ort::inputs!["mix" => x]).map_err(e)?;
        let (_, data) = outputs["stems"].try_extract_tensor::<f32>().map_err(e)?;
        Ok(data.to_vec())
    }

    #[cfg(not(feature = "onnx"))]
    fn run(&mut self, _input: &[f32]) -> Result<Vec<f32>> {
        Err(MlError::NoRuntime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in model that sends the left channel to drums and the right to vocals,
    /// scaled, so the plumbing can be checked without the real model.
    struct Fake {
        calls: usize,
    }

    impl Separator for Fake {
        fn run(&mut self, input: &[f32]) -> Result<Vec<f32>> {
            self.calls += 1;
            let mut out = vec![0.0f32; MODEL_STEMS * 2 * SEGMENT];
            for i in 0..SEGMENT {
                // drums: both channels = left; vocals: both = right; bass: half the left.
                for ch in 0..2 {
                    out[(DRUMS * 2 + ch) * SEGMENT + i] = input[i];
                    out[(VOCALS * 2 + ch) * SEGMENT + i] = input[SEGMENT + i];
                    out[(BASS * 2 + ch) * SEGMENT + i] = 0.5 * input[i];
                }
            }
            Ok(out)
        }
    }

    #[test]
    fn pieces_cover_the_whole_track_and_overlap_by_a_quarter() {
        assert_eq!(piece_starts(10), vec![0]);
        assert_eq!(piece_starts(SEGMENT), vec![0]);
        for frames in [SEGMENT + 1, 3 * SEGMENT, 10 * SEGMENT + 12_345] {
            let s = piece_starts(frames);
            assert_eq!(s[0], 0);
            assert!(s.windows(2).all(|w| w[1] - w[0] == STRIDE));
            assert!(s.last().unwrap() + SEGMENT >= frames, "{frames}");
            // No piece starts past the end of the previous one's overlap needlessly.
            assert!(s.last().unwrap() + OVERLAP < frames, "{frames}");
        }
    }

    #[test]
    fn overlapping_fades_add_up_to_one() {
        for i in 0..OVERLAP {
            let sum = piece_weight(STRIDE + i, false, false) + piece_weight(i, false, false);
            assert!((sum - 1.0).abs() < 1e-5, "{i}: {sum}");
        }
        assert_eq!(piece_weight(0, true, false), 1.0);
        assert_eq!(piece_weight(SEGMENT - 1, false, true), 1.0);
    }

    #[test]
    fn a_long_track_comes_back_whole_through_the_pieces() {
        // 20 s at 48 kHz: resampled to 44.1 kHz and back, in several pieces.
        let sr = 48_000;
        let frames = sr as usize * 20;
        let audio: Vec<f32> = (0..frames)
            .flat_map(|i| {
                let t = i as f32 / sr as f32;
                [(t * 220.0 * std::f32::consts::TAU).sin() * 0.5, (t * 330.0 * std::f32::consts::TAU).sin() * 0.25]
            })
            .collect();
        let mut fake = Fake { calls: 0 };
        let mut seen = Vec::new();
        let s = split(&mut fake, sr, &audio, |p| {
            seen.push(p);
            true
        })
        .unwrap();
        assert_eq!(fake.calls, piece_starts(frames * 441 / 480).len());
        assert!(fake.calls >= 3);
        assert_eq!(seen.last(), Some(&1.0));
        assert_eq!(s.drums.len(), audio.len());
        // Away from the very ends (resampler edges), drums = left, vocals = right.
        let mut worst = 0.0f32;
        for i in 2_000..frames - 2_000 {
            worst = worst.max((s.drums[2 * i] - audio[2 * i]).abs());
            worst = worst.max((s.vocals[2 * i + 1] - audio[2 * i + 1]).abs());
            worst = worst.max((s.bass[2 * i] - 0.5 * audio[2 * i]).abs());
        }
        assert!(worst < 0.01, "{worst}");
    }

    #[test]
    fn stops_when_asked() {
        let audio = vec![0.1f32; 2 * MODEL_RATE as usize * 30];
        let mut fake = Fake { calls: 0 };
        assert!(matches!(split(&mut fake, MODEL_RATE, &audio, |_| false), Err(MlError::Cancelled)));
        assert_eq!(fake.calls, 1);
    }
}
