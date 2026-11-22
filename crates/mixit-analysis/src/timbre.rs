//! "Sounds like": a compact sound profile of a track, and how alike two profiles are.
//!
//! The profile describes the sound rather than the tempo or key, so a track can be
//! matched with others that share its instruments, production and feel:
//!
//! * **Tone colour**: mel-frequency cepstral coefficients (the shape of the spectrum,
//!   level removed), their mean and how much they move through the track.
//! * **Brightness**: spectral centroid and roll-off, on a log-frequency scale.
//! * **Noisiness**: spectral flatness (hats, noise and distortion against pure tones).
//! * **Balance**: the share of energy in the bass, the mids and the highs.
//! * **Punch**: spectral flux, how sharply the sound changes frame to frame.
//! * **Groove**: how many hits a second land in the lows (kicks), mids (snares, claps)
//!   and highs (hats), with pulse clarity and beat strength from the rhythm analysis.
//! * **Dynamics**: loudness range.
//!
//! Profiles are compared after each feature is standardised over the library being
//! searched ([`Normaliser`]), so no feature drowns the others because of its units.

use crate::onset::Onsets;
use crate::stft::Spectrogram;

/// Length of a profile.
pub const PROFILE_LEN: usize = 34;
/// Profile layout version; profiles of another version are not compared.
pub const PROFILE_VERSION: u32 = 1;

const MEL_BANDS: usize = 26;
const MFCC_MEANS: usize = 12;
const MFCC_SPREADS: usize = 8;
/// About 20 frames a second is plenty for the averages and keeps this cheap.
const FRAME_STEP: usize = 4;

/// How much each feature counts when comparing profiles.
fn weight(i: usize) -> f32 {
    match i {
        0..MFCC_MEANS => 1.0,
        // Spreads of the tone colour say less on their own.
        i if i < MFCC_MEANS + MFCC_SPREADS => 0.6,
        _ => 1.0,
    }
}

fn hz_to_mel(f: f32) -> f32 {
    2595.0 * (1.0 + f / 700.0).log10()
}

fn mel_to_hz(m: f32) -> f32 {
    700.0 * (10f32.powf(m / 2595.0) - 1.0)
}

/// Triangular mel filters over the spectrogram's bins.
struct MelBank {
    /// For each band: (first bin, weights).
    bands: Vec<(usize, Vec<f32>)>,
}

impl MelBank {
    fn new(spec: &Spectrogram, fmin: f32, fmax: f32) -> MelBank {
        let fmax = fmax.min(spec.sample_rate * 0.5);
        let (m0, m1) = (hz_to_mel(fmin), hz_to_mel(fmax));
        let edges: Vec<f32> =
            (0..MEL_BANDS + 2).map(|i| mel_to_hz(m0 + (m1 - m0) * i as f32 / (MEL_BANDS + 1) as f32)).collect();
        let bin_of = |f: f32| f * spec.size as f32 / spec.sample_rate;
        let mut bands = Vec::with_capacity(MEL_BANDS);
        for b in 0..MEL_BANDS {
            let (lo, mid, hi) = (bin_of(edges[b]), bin_of(edges[b + 1]), bin_of(edges[b + 2]));
            let first = lo.floor().max(0.0) as usize;
            let last = (hi.ceil() as usize).min(spec.bins - 1);
            let mut w = Vec::with_capacity(last + 1 - first);
            for k in first..=last {
                let x = k as f32;
                let v = if x <= mid { (x - lo) / (mid - lo).max(1e-6) } else { (hi - x) / (hi - mid).max(1e-6) };
                w.push(v.max(0.0));
            }
            // Narrow low bands may fall between bins: give them their nearest bin.
            if w.iter().all(|&v| v == 0.0) {
                let k = (mid.round() as usize).clamp(first, last);
                w[k - first] = 1.0;
            }
            bands.push((first, w));
        }
        MelBank { bands }
    }

    fn apply(&self, power: &[f32], out: &mut [f32; MEL_BANDS]) {
        for (o, (first, w)) in out.iter_mut().zip(&self.bands) {
            *o = w.iter().zip(&power[*first..]).map(|(a, b)| a * b).sum();
        }
    }
}

/// DCT-II of the log mel energies, coefficients 1..=n (0, the level, is left out).
fn cepstrum(logmel: &[f32; MEL_BANDS], out: &mut [f32; MFCC_MEANS]) {
    let n = MEL_BANDS as f32;
    for (c, o) in out.iter_mut().enumerate() {
        let k = (c + 1) as f32;
        *o = logmel
            .iter()
            .enumerate()
            .map(|(i, &v)| v * (std::f32::consts::PI * k * (i as f32 + 0.5) / n).cos())
            .sum::<f32>()
            * (2.0 / n).sqrt();
    }
}

/// Running mean and variance.
#[derive(Clone, Copy, Default)]
struct Stat {
    n: f64,
    mean: f64,
    m2: f64,
}

impl Stat {
    fn push(&mut self, x: f64) {
        self.n += 1.0;
        let d = x - self.mean;
        self.mean += d / self.n;
        self.m2 += d * (x - self.mean);
    }
    fn std(&self) -> f64 {
        if self.n > 1.0 { (self.m2 / (self.n - 1.0)).sqrt() } else { 0.0 }
    }
}

/// Hits a second in an onset curve: local peaks clearly above the curve's running level.
fn hit_rate(curve: &[f32], rate: f64, audible: (f64, f64)) -> f32 {
    let a = ((audible.0 * rate).max(0.0) as usize).min(curve.len());
    let b = ((audible.1 * rate) as usize).min(curve.len());
    if b < a + 3 {
        return 0.0;
    }
    let c = &curve[a..b];
    let mean = c.iter().sum::<f32>() / c.len() as f32;
    let sd = (c.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / c.len() as f32).sqrt();
    let thr = mean + 0.5 * sd;
    let peaks = (1..c.len() - 1).filter(|&i| c[i] > thr && c[i] >= c[i - 1] && c[i] > c[i + 1]).count();
    (peaks as f64 / ((b - a) as f64 / rate)) as f32
}

/// The sound profile of a track from its analysis spectrogram and onsets, over the
/// audible span (seconds). `pulse_clarity`, `beat_strength` and `range_lu` come from the
/// rhythm and loudness analysis. Empty when there is too little sound to describe.
pub fn profile(
    spec: &Spectrogram,
    ons: &Onsets,
    audible: (f64, f64),
    pulse_clarity: f32,
    beat_strength: f32,
    range_lu: f64,
) -> Vec<f32> {
    if spec.frames == 0 || spec.bins < 8 {
        return vec![];
    }
    let rate = spec.frame_rate();
    let a = ((audible.0 * rate).floor().max(0.0) as usize).min(spec.frames);
    let b = ((audible.1 * rate).ceil() as usize).min(spec.frames);
    if b <= a + 8 {
        return vec![];
    }
    let mel = MelBank::new(spec, 30.0, 10_000.0);
    let nyq = spec.sample_rate * 0.5;
    // Bass notes reach about 250 Hz; a lower split would move with the key.
    let (sub_hi, mid_hi, high_lo) = (250.0, 2_000.0, 4_000.0);

    // Frames quieter than 50 dB under the loudest are silence or fades: left out.
    let mut energies = Vec::with_capacity((b - a) / FRAME_STEP + 1);
    let mut i = a;
    while i < b {
        energies.push((i, spec.frame(i).iter().map(|m| m * m).sum::<f32>()));
        i += FRAME_STEP;
    }
    let peak = energies.iter().map(|e| e.1).fold(0.0f32, f32::max);
    if peak <= 0.0 {
        return vec![];
    }
    let floor = peak * 1e-5;

    let mut means = [Stat::default(); MFCC_MEANS];
    let (mut centroid, mut rolloff, mut flat, mut flux) =
        (Stat::default(), Stat::default(), Stat::default(), Stat::default());
    let (mut sub, mut lowmid, mut high, mut total) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut power = vec![0.0f32; spec.bins];
    let mut prev: Option<Vec<f32>> = None;
    let mut melv = [0.0f32; MEL_BANDS];
    let mut cep = [0.0f32; MFCC_MEANS];
    for &(i, e) in &energies {
        if e < floor {
            prev = None;
            continue;
        }
        let frame = spec.frame(i);
        for (p, m) in power.iter_mut().zip(frame) {
            *p = m * m;
        }
        // Tone colour.
        mel.apply(&power, &mut melv);
        let mut logmel = [0.0f32; MEL_BANDS];
        for (l, m) in logmel.iter_mut().zip(&melv) {
            *l = (m + peak * 1e-9).ln();
        }
        cepstrum(&logmel, &mut cep);
        for (s, c) in means.iter_mut().zip(&cep) {
            s.push(*c as f64);
        }
        // Brightness and noisiness.
        let (mut num, mut sum, mut logsum, mut count) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for (k, &p) in power.iter().enumerate().skip(1) {
            let f = spec.bin_hz(k) as f64;
            num += f * p as f64;
            sum += p as f64;
            logsum += (p as f64 + 1e-12).ln();
            count += 1.0;
            if f < sub_hi {
                sub += p as f64;
            } else if f < mid_hi {
                lowmid += p as f64;
            } else if f >= high_lo {
                high += p as f64;
            }
        }
        total += sum;
        if sum > 0.0 {
            centroid.push(((num / sum).max(20.0)).log2());
            flat.push((logsum / count).exp() / (sum / count));
            let target = 0.85 * sum;
            let mut acc = 0.0;
            let mut ro = nyq as f64;
            for (k, &p) in power.iter().enumerate().skip(1) {
                acc += p as f64;
                if acc >= target {
                    ro = spec.bin_hz(k) as f64;
                    break;
                }
            }
            rolloff.push(ro.max(20.0).log2());
        }
        // Punch: positive change of the level-normalised spectrum.
        let norm = (e.sqrt() as f64).max(1e-9);
        let cur: Vec<f32> = frame.iter().map(|m| (*m as f64 / norm) as f32).collect();
        if let Some(p) = &prev {
            let d: f32 = cur.iter().zip(p).map(|(a, b)| (a - b).max(0.0)).sum();
            flux.push(d as f64);
        }
        prev = Some(cur);
    }
    if means[0].n < 8.0 {
        return vec![];
    }
    let share = |x: f64| ((x / total.max(1e-12)).max(1e-6)).log10();

    // Spreads of the first coefficients come from a second pass would cost a lot; the
    // running statistics already hold them.
    let mut v = Vec::with_capacity(PROFILE_LEN);
    v.extend(means.iter().map(|s| s.mean as f32));
    v.extend(means.iter().take(MFCC_SPREADS).map(|s| s.std() as f32));
    v.push(centroid.mean as f32);
    v.push(centroid.std() as f32);
    v.push(flat.mean as f32);
    v.push(rolloff.mean as f32);
    v.push(share(sub) as f32);
    v.push(share(lowmid) as f32);
    v.push(share(high) as f32);
    v.push(flux.mean as f32);
    for curve in [&ons.low, &ons.mid, &ons.high] {
        v.push((1.0 + hit_rate(curve, ons.rate, audible)).ln());
    }
    v.push(pulse_clarity);
    v.push(beat_strength.ln().clamp(-2.0, 3.0));
    v.push(range_lu.clamp(0.0, 30.0) as f32);
    debug_assert_eq!(v.len(), PROFILE_LEN);
    if v.iter().any(|x| !x.is_finite()) {
        return vec![];
    }
    v
}

/// Standardises profiles over a set of tracks so each feature counts the same.
#[derive(Clone, Debug, PartialEq)]
pub struct Normaliser {
    mean: [f32; PROFILE_LEN],
    scale: [f32; PROFILE_LEN],
}

impl Normaliser {
    /// From the profiles of the tracks being searched (empty or short profiles are
    /// ignored). With fewer than three, features are only centred.
    pub fn fit<'a>(profiles: impl IntoIterator<Item = &'a [f32]>) -> Normaliser {
        let mut st = [Stat::default(); PROFILE_LEN];
        for p in profiles.into_iter().filter(|p| p.len() == PROFILE_LEN) {
            for (s, x) in st.iter_mut().zip(p) {
                s.push(*x as f64);
            }
        }
        let mut mean = [0.0; PROFILE_LEN];
        let mut scale = [1.0; PROFILE_LEN];
        for i in 0..PROFILE_LEN {
            mean[i] = st[i].mean as f32;
            if st[i].n >= 3.0 {
                // A floor keeps a feature that barely varies from blowing up.
                let floor = 0.05 * (st[i].mean.abs() + 0.1);
                scale[i] = st[i].std().max(floor) as f32;
            }
        }
        Normaliser { mean, scale }
    }

    /// The profile in standard units, weighted, ready for [`similarity`]. Empty when the
    /// profile is missing.
    pub fn apply(&self, p: &[f32]) -> Vec<f32> {
        if p.len() != PROFILE_LEN {
            return vec![];
        }
        (0..PROFILE_LEN).map(|i| (p[i] - self.mean[i]) / self.scale[i] * weight(i).sqrt()).collect()
    }
}

/// How alike two standardised profiles sound, 0 (nothing alike) to 1 (the same).
/// `None` when either is missing.
pub fn similarity(a: &[f32], b: &[f32]) -> Option<f64> {
    if a.len() != PROFILE_LEN || b.len() != PROFILE_LEN {
        return None;
    }
    let wsum: f32 = (0..PROFILE_LEN).map(weight).sum();
    let d2: f32 = a.iter().zip(b).map(|(x, y)| (x - y) * (x - y)).sum::<f32>() / wsum;
    // Two tracks picked at random sit about √2 apart in standard units (≈ 0.37);
    // near neighbours well under 1.
    Some((-0.5 * d2 as f64).exp())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::onset::onsets_from;
    use crate::stft::stft;

    fn tone(f: f32, sr: f32, secs: f32, noise: f32) -> Vec<f32> {
        let mut seed = 1u32;
        (0..(sr * secs) as usize)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let n = (seed >> 9) as f32 / (1u32 << 23) as f32 * 2.0 - 1.0;
                0.5 * (std::f32::consts::TAU * f * i as f32 / sr).sin() + noise * n
            })
            .collect()
    }

    fn prof(x: &[f32]) -> Vec<f32> {
        let s = stft(x, 22_050.0, 1_024, 256);
        profile(&s, &onsets_from(&s), (0.0, x.len() as f64 / 22_050.0), 0.5, 2.0, 5.0)
    }

    #[test]
    fn brighter_and_noisier_sounds_read_that_way() {
        let low = prof(&tone(110.0, 22_050.0, 4.0, 0.0));
        let high = prof(&tone(3_000.0, 22_050.0, 4.0, 0.0));
        let noisy = prof(&tone(110.0, 22_050.0, 4.0, 0.4));
        assert_eq!(low.len(), PROFILE_LEN);
        let centroid = MFCC_MEANS + MFCC_SPREADS;
        assert!(high[centroid] > low[centroid] + 3.0, "{} vs {}", high[centroid], low[centroid]);
        assert!(
            noisy[centroid + 2] > low[centroid + 2] * 10.0,
            "flatness {} vs {}",
            noisy[centroid + 2],
            low[centroid + 2]
        );
        // Level does not change the sound (the hit rates of a steady tone are noise, so
        // only the spectral part is compared).
        let quiet: Vec<f32> = tone(110.0, 22_050.0, 4.0, 0.0).iter().map(|x| x * 0.1).collect();
        let q = prof(&quiet);
        for (a, b) in low.iter().zip(&q).take(centroid + 8) {
            assert!((a - b).abs() < 0.05 * (a.abs() + 1.0), "{a} vs {b}");
        }
    }

    #[test]
    fn silence_has_no_profile() {
        assert!(prof(&vec![0.0; 22_050 * 2]).is_empty());
    }

    #[test]
    fn similarity_is_one_for_the_same_and_falls_with_distance() {
        let a = prof(&tone(110.0, 22_050.0, 3.0, 0.05));
        let b = prof(&tone(120.0, 22_050.0, 3.0, 0.05));
        let c = prof(&tone(4_000.0, 22_050.0, 3.0, 0.5));
        let n = Normaliser::fit([a.as_slice(), b.as_slice(), c.as_slice()]);
        let (na, nb, nc) = (n.apply(&a), n.apply(&b), n.apply(&c));
        assert!((similarity(&na, &na).unwrap() - 1.0).abs() < 1e-9);
        assert!(similarity(&na, &nb).unwrap() > similarity(&na, &nc).unwrap());
        assert!(similarity(&na, &[]).is_none());
    }
}
