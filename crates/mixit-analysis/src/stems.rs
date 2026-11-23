//! A quick stem split that needs no download: vocals, drums and bass pulled out of a
//! track with signal processing alone. It is rough next to a trained model (the melody
//! keeps some singing, the bass takes the boom of the kick drum), but it runs anywhere, in seconds,
//! and the stems always add back to the track exactly, because the fourth one, melody,
//! is the remainder (see `mixit_engine::StemAudio`).
//!
//! How each frame of the spectrum is shared out:
//!
//! * **Drums** are what is short in time and wide in pitch: harmonic/percussive
//!   separation compares each point with the median along time (steady tones) and along
//!   frequency (hits), and gives drums the percussive share.
//! * **Bass** is the steady, harmonic part below about 200 Hz.
//! * **Vocals** are the harmonic part in the voice range that sits in the centre of the
//!   stereo picture and does not hold still the way pads and chords do.
//!
//! The masks are soft and never add up to more than the whole, so nothing is created or
//! doubled.

use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

const SIZE: usize = 4096;
const HOP: usize = SIZE / 4;
/// Frames either side for the steady-tone median (about 0.14 s at 44.1 kHz).
const TIME_MED: usize = 6;
/// Bins either side for the hit median.
const FREQ_MED: usize = 8;
/// Frames either side for "holds still" (about 0.75 s).
const STILL: usize = 16;

/// Vocals, drums and bass, interleaved stereo like the track they came from.
pub struct Split {
    pub vocals: Vec<f32>,
    pub drums: Vec<f32>,
    pub bass: Vec<f32>,
}

/// Samples per piece the track is split in (about 20 s), and the extra context read on
/// each side so the medians at a piece's edges see what they would in the whole track.
/// Both are whole hops, so every piece's frames fall where the whole track's would.
const PIECE: usize = HOP * 900;
const CONTEXT: usize = HOP * 64;

/// Splits interleaved stereo `audio`. `progress` gets 0..1 now and then and returns
/// false to stop (then `None` comes back). The track is worked through in pieces of
/// about 20 s, so memory stays small however long it is.
pub fn quick_split(sample_rate: u32, audio: &[f32], mut progress: impl FnMut(f32) -> bool) -> Option<Split> {
    let n = audio.len() / 2;
    let (l, r): (Vec<f32>, Vec<f32>) = audio.chunks_exact(2).map(|c| (c[0], c[1])).unzip();
    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(SIZE);
    let inv = planner.plan_fft_inverse(SIZE);
    let win = sqrt_hann(SIZE);
    let ctx = Ctx::new(sample_rate);
    let mut out = [vec![0.0f32; n * 2], vec![0.0f32; n * 2], vec![0.0f32; n * 2]];
    let mut at = 0;
    while at < n {
        if !progress(at as f32 / n.max(1) as f32) {
            return None;
        }
        let end = (at + PIECE).min(n);
        let (s0, s1) = (at.saturating_sub(CONTEXT), (end + CONTEXT).min(n));
        let parts = ctx.split(&l[s0..s1], &r[s0..s1], &win, &fwd, &inv);
        for (o, (pl, pr)) in out.iter_mut().zip(parts) {
            for i in at..end {
                o[i * 2] = pl[i - s0];
                o[i * 2 + 1] = pr[i - s0];
            }
        }
        at = end;
    }
    progress(1.0);
    let [vocals, drums, bass] = out;
    Some(Split { vocals, drums, bass })
}

/// The frequency weights for one sample rate.
struct Ctx {
    bass_w: Vec<f32>,
    voice_w: Vec<f32>,
}

impl Ctx {
    fn new(sample_rate: u32) -> Ctx {
        let bins = SIZE / 2 + 1;
        let hz = |k: usize| k as f32 * sample_rate as f32 / SIZE as f32;
        Ctx {
            bass_w: (0..bins).map(|k| 1.0 - smoothstep(150.0, 260.0, hz(k))).collect(),
            voice_w: (0..bins)
                .map(|k| smoothstep(120.0, 220.0, hz(k)) * (1.0 - smoothstep(5_000.0, 9_000.0, hz(k))))
                .collect(),
        }
    }

    /// Splits one piece: (left, right) of vocals, drums and bass.
    fn split(
        &self,
        l: &[f32],
        r: &[f32],
        win: &[f32],
        fwd: &Arc<dyn RealToComplex<f32>>,
        inv: &Arc<dyn ComplexToReal<f32>>,
    ) -> [(Vec<f32>, Vec<f32>); 3] {
        let n = l.len();
        let sl = spectrum(l, win, fwd);
        let sr = spectrum(r, win, fwd);
        let frames = sl.len();
        let bins = SIZE / 2 + 1;
        let mag: Vec<Vec<f32>> =
            (0..frames).map(|f| (0..bins).map(|k| 0.5 * (sl[f][k].norm() + sr[f][k].norm())).collect()).collect();
        // Medians along time (steady) and along frequency (hits), and a long one for "still".
        let steady = median_time(&mag, TIME_MED);
        let still = median_time(&mag, STILL);
        let mut masks: Vec<Vec<[f32; 3]>> = Vec::with_capacity(frames);
        let mut row = vec![0.0f32; bins];
        for f in 0..frames {
            median_freq(&mag[f], FREQ_MED, &mut row);
            let m = (0..bins)
                .map(|k| {
                    let (h, p) = (steady[f][k], row[k]);
                    let (h2, p2) = (h * h, p * p);
                    let perc = if h2 + p2 > 1e-20 { p2 / (h2 + p2) } else { 0.0 };
                    let harm = 1.0 - perc;
                    // Centred: left and right in phase and alike in level.
                    let (a, b) = (sl[f][k], sr[f][k]);
                    let e = a.norm_sqr() + b.norm_sqr();
                    let centre = if e > 1e-20 { (2.0 * (a * b.conj()).re / e).max(0.0) } else { 0.0 };
                    // Holds still: as loud now as over the second around it (pads, chords).
                    let mk = mag[f][k];
                    let held = if mk > 1e-12 { (still[f][k] / mk).min(1.0) } else { 1.0 };
                    let bass = harm * self.bass_w[k];
                    let vocals = harm * (1.0 - self.bass_w[k]) * self.voice_w[k] * centre * centre * (1.0 - 0.8 * held);
                    [vocals, perc, bass]
                })
                .collect();
            masks.push(m);
        }
        std::array::from_fn(|s| (resynth(&sl, &masks, s, win, inv, n), resynth(&sr, &masks, s, win, inv, n)))
    }
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A square-root Hann window: used to analyse and to resynthesise, so with a quarter-size
/// hop the overlapped windows add up to a constant (2).
fn sqrt_hann(n: usize) -> Vec<f32> {
    (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()).sqrt() as f32).collect()
}

fn spectrum(x: &[f32], win: &[f32], fft: &Arc<dyn RealToComplex<f32>>) -> Vec<Vec<Complex<f32>>> {
    let frames = x.len().div_ceil(HOP) + SIZE / HOP;
    let mut input = fft.make_input_vec();
    let mut scratch = fft.make_scratch_vec();
    (0..frames)
        .map(|f| {
            let start = (f * HOP) as i64 - SIZE as i64;
            for (k, v) in input.iter_mut().enumerate() {
                let i = start + k as i64;
                *v = if i >= 0 && (i as usize) < x.len() { x[i as usize] * win[k] } else { 0.0 };
            }
            let mut out = fft.make_output_vec();
            let _ = fft.process_with_scratch(&mut input, &mut out, &mut scratch);
            out
        })
        .collect()
}

fn resynth(
    spec: &[Vec<Complex<f32>>],
    masks: &[Vec<[f32; 3]>],
    which: usize,
    win: &[f32],
    ifft: &Arc<dyn ComplexToReal<f32>>,
    n: usize,
) -> Vec<f32> {
    let mut y = vec![0.0f32; n];
    let mut buf = ifft.make_input_vec();
    let mut out = ifft.make_output_vec();
    let mut scratch = ifft.make_scratch_vec();
    // The inverse FFT is unscaled, and the overlapped windows add to 2.
    let norm = 1.0 / (SIZE as f32 * 2.0);
    for (f, (s, m)) in spec.iter().zip(masks).enumerate() {
        for (k, c) in buf.iter_mut().enumerate() {
            *c = s[k] * m[k][which];
        }
        // The DC and Nyquist bins must be real for the inverse transform.
        buf[0].im = 0.0;
        let last = buf.len() - 1;
        buf[last].im = 0.0;
        let _ = ifft.process_with_scratch(&mut buf, &mut out, &mut scratch);
        let start = (f * HOP) as i64 - SIZE as i64;
        for (k, &v) in out.iter().enumerate() {
            let i = start + k as i64;
            if i >= 0 && (i as usize) < n {
                y[i as usize] += v * win[k] * norm;
            }
        }
    }
    y
}

/// Median of each bin over `w` frames either side.
fn median_time(mag: &[Vec<f32>], w: usize) -> Vec<Vec<f32>> {
    let frames = mag.len();
    let bins = mag.first().map_or(0, Vec::len);
    let mut out = vec![vec![0.0f32; bins]; frames];
    let mut tmp = Vec::with_capacity(2 * w + 1);
    for k in 0..bins {
        for f in 0..frames {
            tmp.clear();
            tmp.extend((f.saturating_sub(w)..(f + w + 1).min(frames)).map(|g| mag[g][k]));
            out[f][k] = median(&mut tmp);
        }
    }
    out
}

/// Median of each bin over `w` bins either side, into `out`.
fn median_freq(row: &[f32], w: usize, out: &mut [f32]) {
    let mut tmp = Vec::with_capacity(2 * w + 1);
    for k in 0..row.len() {
        tmp.clear();
        tmp.extend_from_slice(&row[k.saturating_sub(w)..(k + w + 1).min(row.len())]);
        out[k] = median(&mut tmp);
    }
}

fn median(v: &mut [f32]) -> f32 {
    let mid = v.len() / 2;
    *v.select_nth_unstable_by(mid, f32::total_cmp).1
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::{Key, Mode};
    use mixit_generator::{STEM_PARTS, Style, TrackSpec, generate};

    fn energy(x: &[f32]) -> f64 {
        x.iter().map(|&v| (v as f64) * (v as f64)).sum()
    }

    /// How much of the true part's energy the estimate shares (1 = all of it, in place).
    fn overlap(est: &[f32], truth: &[f32]) -> f64 {
        let dot: f64 = est.iter().zip(truth).map(|(&a, &b)| a as f64 * b as f64).sum();
        dot / energy(truth).max(1e-12)
    }

    #[test]
    fn a_frame_with_full_masks_comes_back_unchanged() {
        // Resynthesis alone (every mask 1) must give the input back.
        let x: Vec<f32> =
            (0..48_000).map(|i| ((i as f32 * 0.031).sin() * 0.5) + if i % 9_000 == 0 { 0.4 } else { 0.0 }).collect();
        let mut planner = RealFftPlanner::<f32>::new();
        let (fwd, inv) = (planner.plan_fft_forward(SIZE), planner.plan_fft_inverse(SIZE));
        let win = sqrt_hann(SIZE);
        let s = spectrum(&x, &win, &fwd);
        let masks = vec![vec![[1.0f32; 3]; SIZE / 2 + 1]; s.len()];
        let y = resynth(&s, &masks, 0, &win, &inv, x.len());
        let err = x.iter().zip(&y).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1e-4, "{err}");
    }

    #[test]
    fn pulls_the_parts_of_a_generated_track_towards_the_right_stems() {
        let mut spec = TrackSpec::short(Style::House, 124.0, Key::new(9, Mode::Minor));
        spec.vocals = true;
        let g = generate(&spec);
        let s = quick_split(g.sample_rate, &g.audio, |_| true).expect("not cancelled");
        let est = [&s.vocals, &s.drums, &s.bass];
        // Vocals and drums hold more of their own part than of any other. (The bass stem
        // also takes the low end of the kick drum: telling a kick's boom from a bass note
        // needs the trained model.)
        for (i, e) in est.iter().enumerate().take(2) {
            let own = overlap(e, &g.stems[i]);
            for (j, t) in g.stems.iter().enumerate() {
                if j != i {
                    let other = overlap(e, t);
                    assert!(own > other, "{} stem: own {own:.2}, {} {other:.2}", STEM_PARTS[i], STEM_PARTS[j]);
                }
            }
        }
        // And gets a fair share of it: rough, but clearly working. (The drums lose the
        // kick's boom to the bass, see above.)
        assert!(overlap(&s.drums, &g.stems[1]) > 0.4, "drums {:.2}", overlap(&s.drums, &g.stems[1]));
        assert!(overlap(&s.bass, &g.stems[2]) > 0.7, "bass {:.2}", overlap(&s.bass, &g.stems[2]));
        // Nothing of the chords and lead goes to the bass or drums to speak of.
        assert!(overlap(&s.bass, &g.stems[3]) < 0.1, "melody in bass {:.2}", overlap(&s.bass, &g.stems[3]));
        assert!(overlap(&s.vocals, &g.stems[0]) > 0.45, "vocals {:.2}", overlap(&s.vocals, &g.stems[0]));
    }

    #[test]
    fn stops_when_asked() {
        let x = vec![0.0f32; 2 * 48_000 * 50];
        let mut calls = 0;
        assert!(
            quick_split(48_000, &x, |_| {
                calls += 1;
                calls < 2
            })
            .is_none()
        );
    }
}
