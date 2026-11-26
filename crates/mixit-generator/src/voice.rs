//! A synthesised singer: a glottal source made of harmonics, shaped by vowel formants,
//! with vibrato, glides between notes, syllables and a little breath. It is there so the
//! vocal detector can be tested against exact ground truth (where the singing is). The
//! same voice also talks ([`talk`]), for testing the mic cleaner.
use crate::Rng;

/// One sung syllable.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Syllable {
    /// Start, seconds from the phrase start.
    pub at: f64,
    pub len: f64,
    pub midi: f64,
    pub vowel: usize,
}

/// Formant frequencies (Hz) of a, e, i, o, u.
const VOWELS: [[f64; 3]; 5] = [
    [730.0, 1_090.0, 2_440.0],
    [530.0, 1_840.0, 2_480.0],
    [300.0, 2_250.0, 3_000.0],
    [570.0, 840.0, 2_410.0],
    [320.0, 870.0, 2_240.0],
];
const BANDWIDTH: [f64; 3] = [90.0, 110.0, 160.0];
const FORMANT_GAIN: [f64; 3] = [1.0, 0.7, 0.35];

fn formant_gain(f: f64, formants: &[f64; 3]) -> f64 {
    let mut g = 0.04;
    for i in 0..3 {
        let x = (f - formants[i]) / (0.5 * BANDWIDTH[i]);
        g += FORMANT_GAIN[i] / (1.0 + x * x);
    }
    g
}

/// Renders a phrase of syllables (mono, peak about 1). `vibrato` is its depth in
/// semitones (0 for talking).
pub(crate) fn sing(sr: f64, syllables: &[Syllable], vibrato: f64, rng: &mut Rng) -> Vec<f32> {
    let Some(last) = syllables.last() else { return vec![] };
    let n = ((last.at + last.len + 0.15) * sr) as usize;
    let mut out = vec![0.0f32; n];
    let tau = std::f64::consts::TAU;
    let mut phase = 0.0f64;
    let mut pitch = syllables[0].midi;
    let mut formants = VOWELS[syllables[0].vowel];
    let mut amps = [0.0f64; 40];
    let vib_rate = 5.2 + rng.next_f32() as f64 * 0.8;
    let mut vib_phase = 0.0f64;
    let mut hp_prev = 0.0f32;
    let mut s_idx = 0usize;
    let glide = 1.0 - (-1.0 / (0.035 * sr)).exp();
    let morph = 1.0 - (-1.0 / (0.04 * sr)).exp();
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f64 / sr;
        while s_idx + 1 < syllables.len() && t >= syllables[s_idx + 1].at - 0.01 {
            s_idx += 1;
        }
        let s = syllables[s_idx];
        let into = t - s.at;
        // Glide towards the note, vibrato fading in after the attack.
        pitch += (s.midi - pitch) * glide;
        let target = VOWELS[s.vowel];
        for k in 0..3 {
            formants[k] += (target[k] - formants[k]) * morph;
        }
        let depth = vibrato * ((into - 0.12) / 0.2).clamp(0.0, 1.0);
        vib_phase += vib_rate / sr;
        let f0 = 440.0 * 2f64.powf((pitch + depth * (tau * vib_phase).sin() - 69.0) / 12.0);
        phase = (phase + f0 / sr).fract();
        // Syllable envelope: quick attack, held, released before the next consonant.
        let env = if into < 0.0 {
            0.0
        } else if into < 0.03 {
            into / 0.03
        } else if into < s.len - 0.06 {
            1.0
        } else {
            ((s.len - into) / 0.06).max(0.0)
        };
        if i % 32 == 0 {
            let top = ((5_000.0 / f0) as usize).min(amps.len());
            for (k, a) in amps.iter_mut().enumerate() {
                let h = (k + 1) as f64;
                *a = if k < top { h.powf(-0.6) * formant_gain(h * f0, &formants) } else { 0.0 };
            }
        }
        // Harmonics by the Chebyshev recurrence: sin(kx) = 2cos(x)sin((k-1)x) - sin((k-2)x).
        let x = tau * phase;
        let (s1, c1) = x.sin_cos();
        let (mut prev, mut cur) = (0.0f64, s1);
        let mut v = 0.0;
        for &a in amps.iter() {
            if a == 0.0 {
                break;
            }
            v += a * cur;
            let next = 2.0 * c1 * cur - prev;
            prev = cur;
            cur = next;
        }
        // A consonant at each syllable start, and a little breath throughout.
        let noise = rng.bipolar();
        let hp = noise - hp_prev;
        hp_prev = noise;
        let consonant = if (0.0..0.025).contains(&into) { 0.25 * (1.0 - into / 0.025) as f32 * hp } else { 0.0 };
        *o = (0.35 * v * env) as f32 + consonant + 0.01 * hp * env as f32;
    }
    let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs())).max(1e-6);
    out.iter_mut().for_each(|x| *x /= peak);
    out
}

/// Someone talking: phrases of quick syllables on a pitch that wanders around a
/// speaking voice and falls at the end of each phrase, with pauses between.
pub struct Talk {
    pub sample_rate: u32,
    /// Mono, peak about 0.5.
    pub audio: Vec<f32>,
    /// Where each phrase starts and ends, in seconds.
    pub phrases: Vec<(f64, f64)>,
}

/// About `seconds` of talking (it ends with a pause) from `seed`.
pub fn talk(sample_rate: u32, seconds: f64, seed: u64) -> Talk {
    let sr = sample_rate as f64;
    let mut rng = Rng::new(seed);
    let mut audio = vec![0.0f32; (seconds * sr) as usize];
    let mut phrases = Vec::new();
    let base = 48.0 + rng.next_f32() as f64 * 8.0; // 130–210 Hz
    let mut t = 0.4 + rng.next_f32() as f64 * 0.6;
    loop {
        let words = 4 + rng.below(8) as usize;
        let mut syl = Vec::new();
        let mut at = 0.0;
        for k in 0..words {
            let len = 0.12 + rng.next_f32() as f64 * 0.16;
            let fall = 3.0 * k as f64 / words as f64;
            let midi = base + rng.bipolar() as f64 * 2.5 - fall;
            syl.push(Syllable { at, len, midi, vowel: rng.below(5) as usize });
            at += len + if rng.below(4) == 0 { 0.05 + rng.next_f32() as f64 * 0.1 } else { 0.0 };
        }
        let v = sing(sr, &syl, 0.0, &mut rng);
        let start = (t * sr) as usize;
        if start + v.len() + (0.3 * sr) as usize > audio.len() {
            break;
        }
        for (o, &x) in audio[start..].iter_mut().zip(&v) {
            *o += 0.5 * x;
        }
        phrases.push((t, t + v.len() as f64 / sr));
        t += v.len() as f64 / sr + 0.5 + rng.next_f32() as f64 * 1.2;
    }
    Talk { sample_rate, audio, phrases }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phrase_has_sound_and_silence_after() {
        let mut rng = Rng::new(3);
        let syl = [
            Syllable { at: 0.0, len: 0.4, midi: 62.0, vowel: 0 },
            Syllable { at: 0.4, len: 0.4, midi: 65.0, vowel: 2 },
        ];
        let v = sing(44_100.0, &syl, 0.35, &mut rng);
        let peak = v.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak - 1.0).abs() < 1e-3, "peak {peak}");
        let tail = &v[(0.85 * 44_100.0) as usize..];
        assert!(tail.iter().all(|x| x.abs() < 0.05));
    }

    #[test]
    fn talking_has_phrases_with_pauses_between() {
        let t = talk(48_000, 20.0, 5);
        assert_eq!(t.audio.len(), 960_000);
        assert!(t.phrases.len() >= 4, "{:?}", t.phrases);
        for w in t.phrases.windows(2) {
            let (a, b) = ((w[0].1 * 48_000.0) as usize, (w[1].0 * 48_000.0) as usize);
            assert!(b > a + 20_000);
            assert!(t.audio[a + 100..b - 100].iter().all(|x| x.abs() < 1e-6));
        }
        let peak = t.audio.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((0.3..=0.6).contains(&peak), "{peak}");
    }
}
