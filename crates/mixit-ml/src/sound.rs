//! Search by sound: LAION's CLAP listens to a track and describes how it sounds as 512
//! numbers (an *embedding*); it reads a description ("dark rolling bass") into the same
//! kind of numbers. Tracks whose numbers point the same way sound alike, and a track
//! whose numbers point the way a description's do sounds like the description.
//!
//! The listener takes ten seconds at a time, so a track is heard in a few ten-second
//! windows spread over its body (past the intro, before the outro) and the windows'
//! descriptions are averaged. Its input is a log-mel spectrogram made exactly as CLAP's
//! own feature extractor makes it (48 kHz, 1024-point Hann window, hop 480, 64 Slaney mel
//! bands from 50 Hz to 14 kHz, power in dB): [`log_mel`] does that here.

use std::path::Path;

use crate::{MlError, Result};

/// The listener's sample rate.
pub const RATE: u32 = 48_000;
/// Samples per window (10 s).
pub const WINDOW: usize = 480_000;
/// Spectrogram frames per window.
pub const FRAMES: usize = WINDOW / HOP + 1;
/// Mel bands.
pub const MELS: usize = 64;
/// Numbers in an embedding.
pub const EMBED_LEN: usize = 512;
/// The name embeddings are stored under, so another model's are never compared with
/// these.
pub const MODEL_ID: &str = "clap-ms-q8";
/// Most windows a track is heard in.
pub const MAX_WINDOWS: usize = 4;

const N_FFT: usize = 1024;
const HOP: usize = 480;
const BINS: usize = N_FFT / 2 + 1;
const F_MIN: f64 = 50.0;
const F_MAX: f64 = 14_000.0;
/// Longest description read, in tokens.
#[cfg(feature = "sound")]
const MAX_TOKENS: usize = 77;

fn hz_to_mel(f: f64) -> f64 {
    // Slaney: linear below 1 kHz, logarithmic above.
    if f < 1_000.0 { 3.0 * f / 200.0 } else { 15.0 + (f / 1_000.0).ln() * 27.0 / 6.4f64.ln() }
}

fn mel_to_hz(m: f64) -> f64 {
    if m < 15.0 { 200.0 * m / 3.0 } else { 1_000.0 * (6.4f64.ln() / 27.0 * (m - 15.0)).exp() }
}

/// The 513 × 64 mel filter bank (row-major by frequency bin), Slaney-normalised.
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
            let w = down.min(up).max(0.0) * 2.0 / (edges[m + 2] - edges[m]);
            fb[b * MELS + m] = w as f32;
        }
    }
    fb
}

/// CLAP's input for one 10 s window (`WINDOW` samples, mono 48 kHz): `FRAMES` × `MELS`
/// log-mel values, frame by frame.
pub fn log_mel(x: &[f32]) -> Vec<f32> {
    let fb = mel_bank();
    let window: Vec<f64> =
        (0..N_FFT).map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N_FFT as f64).cos()).collect();
    // Centred frames: the signal is mirrored at both ends by half a window.
    let half = N_FFT / 2;
    let n = x.len();
    let at = |i: isize| -> f32 {
        let mut i = i;
        if n < 2 {
            return x.first().copied().unwrap_or(0.0);
        }
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
    let mut power = vec![0.0f32; BINS];
    let mut out = vec![0.0f32; frames * MELS];
    for t in 0..frames {
        let start = (t * HOP) as isize - half as isize;
        for (k, v) in buf.iter_mut().enumerate() {
            *v = at(start + k as isize) as f64 * window[k];
        }
        fft.process(&mut buf, &mut spec).expect("sizes match the plan");
        for (p, c) in power.iter_mut().zip(&spec) {
            *p = c.norm_sqr() as f32;
        }
        for m in 0..MELS {
            let e: f32 = (0..BINS).map(|b| power[b] * fb[b * MELS + m]).sum();
            out[t * MELS + m] = 10.0 * e.max(1e-10).log10();
        }
    }
    out
}

/// Where the windows a track is heard in start, for `len` samples at 48 kHz: one for a
/// short track, up to [`MAX_WINDOWS`] spread over the middle 80 % of a long one.
pub fn window_starts(len: usize) -> Vec<usize> {
    if len <= WINDOW {
        return vec![0];
    }
    let secs = len as f64 / RATE as f64;
    let count = ((secs / 45.0).ceil() as usize).clamp(1, MAX_WINDOWS);
    let (lo, hi) = ((len as f64 * 0.1) as usize, (len as f64 * 0.9) as usize);
    let (lo, hi) = if hi > lo + WINDOW { (lo, hi - WINDOW) } else { (0, len - WINDOW) };
    if count == 1 {
        return vec![(lo + hi) / 2];
    }
    (0..count).map(|i| lo + (hi - lo) * i / (count - 1)).collect()
}

/// The 10 s of audio at `start`, made up to length the way CLAP pads short clips: the
/// clip repeated, then silence.
pub fn window(mono: &[f32], start: usize) -> Vec<f32> {
    let clip = &mono[start.min(mono.len())..(start + WINDOW).min(mono.len())];
    if clip.len() >= WINDOW || clip.is_empty() {
        let mut w = clip.to_vec();
        w.resize(WINDOW, 0.0);
        return w;
    }
    let repeats = WINDOW / clip.len();
    let mut w = Vec::with_capacity(WINDOW);
    for _ in 0..repeats {
        w.extend_from_slice(clip);
    }
    w.resize(WINDOW, 0.0);
    w
}

/// How alike two embeddings are: their cosine, -1..1 (1 = the same sound).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
    for (&x, &y) in a.iter().zip(b) {
        ab += x as f64 * y as f64;
        aa += x as f64 * x as f64;
        bb += y as f64 * y as f64;
    }
    if aa == 0.0 || bb == 0.0 {
        return 0.0;
    }
    (ab / (aa * bb).sqrt()) as f32
}

fn normalise(v: &mut [f32]) {
    let n = v.iter().map(|&x| x as f64 * x as f64).sum::<f64>().sqrt();
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x = (*x as f64 / n) as f32);
    }
}

/// Mono 48 kHz from interleaved stereo at `sample_rate`.
pub fn mono_48k(sample_rate: u32, stereo: &[f32]) -> Result<Vec<f32>> {
    let mono: Vec<f32> = stereo.chunks_exact(2).map(|f| 0.5 * (f[0] + f[1])).collect();
    if sample_rate == RATE {
        return Ok(mono);
    }
    mixit_io::resample_interleaved(&mono, 1, sample_rate, RATE).map_err(|e| MlError::Run(e.to_string()))
}

/// Turns windows' spectrograms into one embedding.
pub trait Listener {
    /// `windows` spectrograms (`FRAMES` × `MELS` each, back to back) in, `windows` ×
    /// `EMBED_LEN` numbers out.
    fn listen(&mut self, mels: &[f32], windows: usize) -> Result<Vec<f32>>;
}

/// How a track sounds: the average of its windows' embeddings, unit length.
pub fn embed_track(model: &mut dyn Listener, sample_rate: u32, stereo: &[f32]) -> Result<Vec<f32>> {
    let mono = mono_48k(sample_rate, stereo)?;
    if mono.iter().all(|v| v.abs() < 1e-6) {
        return Err(MlError::Run("the track is silent".into()));
    }
    let starts = window_starts(mono.len());
    let mut mels = Vec::with_capacity(starts.len() * FRAMES * MELS);
    for &s in &starts {
        mels.extend(log_mel(&window(&mono, s)));
    }
    let out = model.listen(&mels, starts.len())?;
    if out.len() != starts.len() * EMBED_LEN {
        return Err(MlError::Run(format!("the listener gave {} numbers, not {}", out.len(), starts.len() * EMBED_LEN)));
    }
    let mut mean = vec![0.0f32; EMBED_LEN];
    for w in out.chunks_exact(EMBED_LEN) {
        let mut w = w.to_vec();
        normalise(&mut w);
        mean.iter_mut().zip(&w).for_each(|(m, v)| *m += v);
    }
    normalise(&mut mean);
    Ok(mean)
}

/// CLAP loaded: the listener, and the describer when words are to be searched.
pub struct Clap {
    #[cfg(feature = "sound")]
    audio: ort::session::Session,
    #[cfg(feature = "sound")]
    text: Option<(ort::session::Session, tokenizers::Tokenizer)>,
}

#[cfg(feature = "sound")]
fn session(path: &Path) -> Result<ort::session::Session> {
    use ort::session::{Session, builder::GraphOptimizationLevel};
    if !path.is_file() {
        return Err(MlError::Missing);
    }
    // Indexing runs in the background while someone may be playing: half the cores.
    let threads = std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1));
    let e = |e: ort::Error| MlError::Run(e.to_string());
    Session::builder()
        .map_err(e)?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(e)?
        .with_intra_threads(threads)
        .map_err(e)?
        .commit_from_file(path)
        .map_err(e)
}

impl Clap {
    /// Loads the listener, and the describer with its word list when `text` names them.
    #[cfg(feature = "sound")]
    pub fn load(audio: &Path, text: Option<(&Path, &Path)>) -> Result<Clap> {
        let audio = session(audio)?;
        let text = match text {
            None => None,
            Some((model, words)) => {
                if !words.is_file() {
                    return Err(MlError::Missing);
                }
                let tok = tokenizers::Tokenizer::from_file(words).map_err(|e| MlError::Run(e.to_string()))?;
                Some((session(model)?, tok))
            }
        };
        Ok(Clap { audio, text })
    }

    #[cfg(not(feature = "sound"))]
    pub fn load(_audio: &Path, _text: Option<(&Path, &Path)>) -> Result<Clap> {
        Err(MlError::NoRuntime)
    }

    /// The word pieces a description is read as.
    #[cfg(feature = "sound")]
    pub fn tokens(&self, text: &str) -> Result<Vec<i64>> {
        let (_, tok) = self.text.as_ref().ok_or(MlError::Missing)?;
        let enc = tok.encode(text, true).map_err(|e| MlError::Run(e.to_string()))?;
        let mut ids: Vec<i64> = enc.get_ids().iter().map(|&i| i as i64).collect();
        if ids.len() > MAX_TOKENS {
            // Keep the end marker.
            let end = *ids.last().expect("not empty");
            ids.truncate(MAX_TOKENS - 1);
            ids.push(end);
        }
        Ok(ids)
    }

    /// What a description sounds like, in the listener's terms (unit length).
    #[cfg(feature = "sound")]
    pub fn embed_text(&mut self, text: &str) -> Result<Vec<f32>> {
        use ort::value::Tensor;
        let ids = self.tokens(text)?;
        let (session, _) = self.text.as_mut().ok_or(MlError::Missing)?;
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let n = ids.len();
        let wants_mask = session.inputs.iter().any(|i| i.name == "attention_mask");
        let mut inputs = ort::inputs!["input_ids" => Tensor::from_array(([1usize, n], ids)).map_err(e)?];
        if wants_mask {
            inputs.push(("attention_mask".into(), Tensor::from_array(([1usize, n], vec![1i64; n])).map_err(e)?.into()));
        }
        let outputs = session.run(inputs).map_err(e)?;
        let (_, data) = outputs["text_embeds"].try_extract_tensor::<f32>().map_err(e)?;
        let mut v = data.to_vec();
        if v.len() != EMBED_LEN {
            return Err(MlError::Run(format!("the describer gave {} numbers, not {EMBED_LEN}", v.len())));
        }
        normalise(&mut v);
        Ok(v)
    }

    #[cfg(not(feature = "sound"))]
    pub fn embed_text(&mut self, _text: &str) -> Result<Vec<f32>> {
        Err(MlError::NoRuntime)
    }
}

impl Listener for Clap {
    #[cfg(feature = "sound")]
    fn listen(&mut self, mels: &[f32], windows: usize) -> Result<Vec<f32>> {
        use ort::value::Tensor;
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let x = Tensor::from_array(([windows, 1, FRAMES, MELS], mels.to_vec())).map_err(e)?;
        let outputs = self.audio.run(ort::inputs!["input_features" => x]).map_err(e)?;
        let (_, data) = outputs["audio_embeds"].try_extract_tensor::<f32>().map_err(e)?;
        Ok(data.to_vec())
    }

    #[cfg(not(feature = "sound"))]
    fn listen(&mut self, _mels: &[f32], _windows: usize) -> Result<Vec<f32>> {
        Err(MlError::NoRuntime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spectrogram_matches_clap_s_own() {
        // Reference values from CLAP's feature extractor (transformers, rand_trunc mode)
        // for the same signal: a 220 Hz tone and a 3150 Hz tone that beeps every second.
        let x: Vec<f32> = (0..WINDOW)
            .map(|i| {
                let t = i as f64 / RATE as f64;
                let beep = if t % 1.0 < 0.5 { 0.1 * (std::f64::consts::TAU * 3_150.0 * t).sin() } else { 0.0 };
                (0.3 * (std::f64::consts::TAU * 220.0 * t).sin() + beep) as f32
            })
            .collect();
        let m = log_mel(&x);
        assert_eq!(m.len(), FRAMES * MELS);
        assert_eq!(FRAMES, 1_001);
        let mean = m.iter().map(|&v| v as f64).sum::<f64>() / m.len() as f64;
        let near = |got: f64, want: f64| assert!((got - want).abs() < 0.01 * want.abs().max(1.0), "{got} vs {want}");
        near(mean, -69.513_514);
        near(m[0] as f64, 13.854_649);
        near(m[500 * MELS + 10] as f64, -28.768_945);
        near(m[1_000 * MELS + 63] as f64, -59.283_220);
        near(m[250 * MELS + 40] as f64, -19.878_302);
        let fb = mel_bank();
        near(fb.iter().map(|&v| v as f64).sum(), 1.364_433);
    }

    #[test]
    fn windows_cover_the_body_of_a_track() {
        assert_eq!(window_starts(100), vec![0]);
        assert_eq!(window_starts(WINDOW), vec![0]);
        let s = window_starts(RATE as usize * 40);
        assert_eq!(s.len(), 1);
        let len = RATE as usize * 240;
        let s = window_starts(len);
        assert_eq!(s.len(), MAX_WINDOWS);
        assert!(s[0] >= len / 10 && s.last().unwrap() + WINDOW <= len * 9 / 10 + 1, "{s:?}");
        // A short clip is repeated to fill the window, then padded.
        let w = window(&[1.0, 2.0, 3.0], 0);
        assert_eq!(w.len(), WINDOW);
        assert_eq!(&w[..7], &[1.0, 2.0, 3.0, 1.0, 2.0, 3.0, 1.0]);
        let clip = vec![0.5f32; WINDOW * 2 / 3];
        let w = window(&clip, 0);
        assert!(w[..clip.len()].iter().all(|&v| v == 0.5) && w[clip.len()..].iter().all(|&v| v == 0.0));
    }

    struct Fake;
    impl Listener for Fake {
        fn listen(&mut self, mels: &[f32], windows: usize) -> Result<Vec<f32>> {
            // Each window's "embedding" is its mean level in the first slot.
            Ok((0..windows)
                .flat_map(|w| {
                    let m = &mels[w * FRAMES * MELS..(w + 1) * FRAMES * MELS];
                    let mut e = vec![0.0f32; EMBED_LEN];
                    e[0] = 1.0;
                    e[1] = m.iter().sum::<f32>() / m.len() as f32 / 100.0;
                    e
                })
                .collect())
        }
    }

    #[test]
    fn a_track_s_embedding_is_unit_length_and_silence_is_refused() {
        let audio: Vec<f32> = (0..44_100 * 30).flat_map(|i| [((i as f32) * 0.05).sin() * 0.3; 2]).collect();
        let e = embed_track(&mut Fake, 44_100, &audio).unwrap();
        assert_eq!(e.len(), EMBED_LEN);
        assert!((e.iter().map(|v| v * v).sum::<f32>() - 1.0).abs() < 1e-4);
        assert!((cosine(&e, &e) - 1.0).abs() < 1e-6);
        assert!(embed_track(&mut Fake, 48_000, &vec![0.0; 96_000]).is_err());
    }
}
