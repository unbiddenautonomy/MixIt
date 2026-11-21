//! A built-in performance kit for the sampler pads: drum hits, DJ effects (air horn,
//! siren, riser, impact) and a tempo-locked drum loop.
//!
//! Every sound is synthesised, so the app ships with pads that work out of the box and
//! no copyrighted samples. Output is interleaved stereo, peak-normalised to -1 dBFS.

use std::f64::consts::TAU;

use mixit_dsp::rng::Rng;
use mixit_dsp::svf::{Svf, SvfCoeffs, SvfMode};

/// One sound in the kit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KitSound {
    pub id: &'static str,
    pub name: &'static str,
    /// Tempo the sound was made at, for sounds that should follow the master tempo.
    pub bpm: Option<f64>,
    /// Suggested pad mode: 0 one-shot, 1 gate (plays while held), 2 loop.
    pub mode: usize,
    /// Pad colour (0xRRGGBB).
    pub color: u32,
}

/// Tempo of the tempo-locked sounds.
pub const KIT_BPM: f64 = 124.0;

pub const KIT: &[KitSound] = &[
    KitSound { id: "kick", name: "Kick", bpm: None, mode: 0, color: 0xEF4444 },
    KitSound { id: "clap", name: "Clap", bpm: None, mode: 0, color: 0xF97316 },
    KitSound { id: "air_horn", name: "Air horn", bpm: None, mode: 0, color: 0xEAB308 },
    KitSound { id: "siren", name: "Siren", bpm: None, mode: 1, color: 0x22C55E },
    KitSound { id: "riser", name: "Riser", bpm: Some(KIT_BPM), mode: 0, color: 0x06B6D4 },
    KitSound { id: "impact", name: "Impact", bpm: None, mode: 0, color: 0x3B82F6 },
    KitSound { id: "laser", name: "Laser", bpm: None, mode: 0, color: 0xA855F7 },
    KitSound { id: "drum_loop", name: "Drum loop", bpm: Some(KIT_BPM), mode: 2, color: 0xEC4899 },
    KitSound { id: "snare_build", name: "Snare build", bpm: Some(KIT_BPM), mode: 0, color: 0x14B8A6 },
    KitSound { id: "scratch", name: "Scratch", bpm: None, mode: 0, color: 0x84CC16 },
    KitSound { id: "hat_loop", name: "Hi-hat loop", bpm: Some(KIT_BPM), mode: 2, color: 0x8B5CF6 },
    KitSound { id: "sub_drop", name: "Sub drop", bpm: None, mode: 0, color: 0x64748B },
];

pub fn kit_sound_info(id: &str) -> Option<&'static KitSound> {
    KIT.iter().find(|k| k.id == id)
}

/// Renders a kit sound as interleaved stereo at `sample_rate`.
pub fn kit_sound(id: &str, sample_rate: u32) -> Option<Vec<f32>> {
    let sr = sample_rate as f64;
    let mut rng = Rng::new(0x5A3B_1E00 ^ id.bytes().fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64)));
    let (l, r) = match id {
        "kick" => mono(kick(sr)),
        "clap" => mono(clap(sr, &mut rng)),
        "air_horn" => air_horn(sr),
        "siren" => mono(siren(sr)),
        "riser" => riser(sr, &mut rng),
        "impact" => impact(sr, &mut rng),
        "laser" => mono(laser(sr)),
        "drum_loop" => mono(drum_loop(sr, &mut rng)),
        "snare_build" => mono(snare_build(sr, &mut rng)),
        "scratch" => mono(scratch(sr, &mut rng)),
        "hat_loop" => hat_loop(sr, &mut rng),
        "sub_drop" => mono(sub_drop(sr)),
        _ => return None,
    };
    Some(normalise(interleave(&l, &r), -1.0))
}

fn mono(x: Vec<f32>) -> (Vec<f32>, Vec<f32>) {
    (x.clone(), x)
}

fn interleave(l: &[f32], r: &[f32]) -> Vec<f32> {
    let n = l.len().min(r.len());
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        out.push(l[i]);
        out.push(r[i]);
    }
    out
}

fn normalise(mut x: Vec<f32>, peak_db: f32) -> Vec<f32> {
    let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > 1e-9 {
        let g = 10f32.powf(peak_db / 20.0) / peak;
        x.iter_mut().for_each(|v| *v *= g);
    }
    x
}

fn beat_s() -> f64 {
    60.0 / KIT_BPM
}

/// Adds `src` into `dst` at frame `at`, growing `dst` if needed.
fn mix_at(dst: &mut Vec<f32>, src: &[f32], at: usize, gain: f32) {
    if dst.len() < at + src.len() {
        dst.resize(at + src.len(), 0.0);
    }
    for (i, v) in src.iter().enumerate() {
        dst[at + i] += v * gain;
    }
}

/// Short fades at both ends so pads never click.
fn fade_edges(x: &mut [f32], sr: f64) {
    let n = ((0.003 * sr) as usize).min(x.len() / 2);
    let len = x.len();
    for i in 0..n {
        let g = i as f32 / n as f32;
        x[i] *= g;
        x[len - 1 - i] *= g;
    }
}

fn noise(sr: f64, rng: &mut Rng, len_s: f64, decay: f64, mode: SvfMode, freq: f32, q: f32) -> Vec<f32> {
    let n = (len_s * sr) as usize;
    let c = SvfCoeffs::design(mode, freq, q, 0.0, sr as f32);
    let mut f = Svf::default();
    (0..n).map(|i| f.process(&c, rng.bipolar()) * (-(i as f64 / sr) * decay).exp() as f32).collect()
}

fn kick(sr: f64) -> Vec<f32> {
    let n = (0.5 * sr) as usize;
    let mut phase = 0.0f64;
    (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            phase += (48.0 + 140.0 * (-t * 32.0).exp()) / sr;
            let body = (TAU * phase).sin() * (-t * 6.5).exp();
            let click = if i < 80 { (1.0 - i as f64 / 80.0) * 0.5 } else { 0.0 };
            ((body + click) * 1.2).tanh() as f32
        })
        .collect()
}

fn clap(sr: f64, rng: &mut Rng) -> Vec<f32> {
    let mut out = Vec::new();
    for k in 0..4 {
        let b = noise(sr, rng, 0.35, if k == 3 { 11.0 } else { 70.0 }, SvfMode::Bandpass, 1_300.0, 1.1);
        mix_at(&mut out, &b, (k as f64 * 0.010 * sr) as usize, 1.0);
    }
    out
}

fn snare(sr: f64, rng: &mut Rng, len_s: f64) -> Vec<f32> {
    let mut s = noise(sr, rng, len_s, 18.0, SvfMode::Bandpass, 2_800.0, 0.7);
    for (i, v) in s.iter_mut().enumerate() {
        let t = i as f64 / sr;
        *v = *v * 2.0 + ((TAU * 185.0 * t).sin() * (-t * 28.0).exp() * 0.7) as f32;
    }
    s
}

/// The classic three-blast horn: a detuned brass-like chord with a little pitch scoop.
fn air_horn(sr: f64) -> (Vec<f32>, Vec<f32>) {
    let blasts = [(0.0, 0.16), (0.2, 0.16), (0.4, 0.75)];
    let total = ((1.15 + 0.2) * sr) as usize;
    let freqs = [233.08, 293.66, 349.23, 466.16];
    let c = SvfCoeffs::design(SvfMode::Lowpass, 3_200.0, 1.4, 0.0, sr as f32);
    let (mut fl, mut fr) = (Svf::default(), Svf::default());
    let mut phases = [[0.0f64; 4]; 2];
    let mut l = vec![0.0f32; total];
    let mut r = vec![0.0f32; total];
    for i in 0..total {
        let t = i as f64 / sr;
        let mut env = 0.0;
        let mut since = 0.0;
        for &(s, d) in &blasts {
            if t >= s && t < s + d + 0.04 {
                since = t - s;
                let a = (since / 0.015).min(1.0);
                let rel = if since > d { 1.0 - (since - d) / 0.04 } else { 1.0 };
                env = a * rel.max(0.0);
            }
        }
        let scoop = 1.0 - 0.06 * (-since * 30.0).exp();
        let vib = 1.0 + 0.004 * (TAU * 6.0 * t).sin();
        for (ch, out) in [&mut l, &mut r].into_iter().enumerate() {
            let mut s = 0.0;
            for (k, f) in freqs.iter().enumerate() {
                let det = 1.0 + (ch as f64 - 0.5) * 0.006 + k as f64 * 0.0007;
                let p = &mut phases[ch][k];
                *p = (*p + f * det * scoop * vib / sr).fract();
                // A pulse wave sounds brassier than a saw.
                s += if *p < 0.32 { 1.0 } else { -0.45 };
            }
            out[i] = (s * env * 0.4).tanh() as f32;
        }
        l[i] = fl.process(&c, l[i]);
        r[i] = fr.process(&c, r[i]);
    }
    (l, r)
}

/// A dub siren: a square wave whose pitch wobbles up and down.
fn siren(sr: f64) -> Vec<f32> {
    let n = (2.4 * sr) as usize;
    let mut phase = 0.0;
    let c = SvfCoeffs::design(SvfMode::Lowpass, 2_500.0, 0.9, 0.0, sr as f32);
    let mut f = Svf::default();
    let mut out: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            let lfo = (TAU * 3.2 * t).sin();
            phase = (phase + (620.0 + 280.0 * lfo) / sr).fract();
            let sq = if phase < 0.5 { 0.6 } else { -0.6 };
            f.process(&c, sq as f32)
        })
        .collect();
    fade_edges(&mut out, sr);
    out
}

/// Eight beats of rising filtered noise and a rising tone, ending at full brightness.
fn riser(sr: f64, rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let len = 8.0 * beat_s();
    let n = (len * sr) as usize;
    let (mut fl, mut fr) = (Svf::default(), Svf::default());
    let mut phase = 0.0;
    let mut l = vec![0.0; n];
    let mut r = vec![0.0; n];
    for i in 0..n {
        let x = i as f64 / n as f64;
        let cutoff = 250.0 * (8_000.0f64 / 250.0).powf(x);
        let c = SvfCoeffs::design(SvfMode::Bandpass, cutoff as f32, 1.6, 0.0, sr as f32);
        let env = x * x;
        phase = (phase + (110.0 * 8f64.powf(x)) / sr).fract();
        let tone = (2.0 * phase - 1.0) * 0.18 * env;
        l[i] = (fl.process(&c, rng.bipolar()) as f64 * env * 1.4 + tone) as f32;
        r[i] = (fr.process(&c, rng.bipolar()) as f64 * env * 1.4 + tone) as f32;
    }
    fade_edges(&mut l, sr);
    fade_edges(&mut r, sr);
    (l, r)
}

/// A boom and crash for the first beat of a drop.
fn impact(sr: f64, rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let n = (2.8 * sr) as usize;
    let mut phase = 0.0;
    let boom: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            phase += (32.0 + 90.0 * (-t * 9.0).exp()) / sr;
            ((TAU * phase).sin() * (-t * 1.6).exp() * 1.4).tanh() as f32
        })
        .collect();
    let crash_l = noise(sr, rng, 2.8, 1.5, SvfMode::Highpass, 3_000.0, 0.5);
    let crash_r = noise(sr, rng, 2.8, 1.5, SvfMode::Highpass, 3_000.0, 0.5);
    let mut l: Vec<f32> = boom.iter().zip(&crash_l).map(|(b, c)| b + c * 0.5).collect();
    let mut r: Vec<f32> = boom.iter().zip(&crash_r).map(|(b, c)| b + c * 0.5).collect();
    fade_edges(&mut l, sr);
    fade_edges(&mut r, sr);
    (l, r)
}

fn laser(sr: f64) -> Vec<f32> {
    let mut out = Vec::new();
    for k in 0..3 {
        let n = (0.22 * sr) as usize;
        let mut phase = 0.0;
        let zap: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                phase = (phase + (3_200.0 * (-t * 18.0).exp() + 120.0) / sr).fract();
                ((TAU * phase).sin() * (-t * 9.0).exp()) as f32
            })
            .collect();
        mix_at(&mut out, &zap, (k as f64 * 0.12 * sr) as usize, 1.0 - k as f32 * 0.25);
    }
    fade_edges(&mut out, sr);
    out
}

/// One bar of kick, clap and hats, exactly four beats long so it loops seamlessly.
fn drum_loop(sr: f64, rng: &mut Rng) -> Vec<f32> {
    let n = (4.0 * beat_s() * sr).round() as usize;
    let k = kick(sr);
    let c = clap(sr, rng);
    let h = noise(sr, rng, 0.05, 80.0, SvfMode::Highpass, 8_500.0, 0.7);
    let oh = noise(sr, rng, 0.22, 14.0, SvfMode::Highpass, 7_000.0, 0.7);
    let mut out = vec![0.0; n];
    let at = |b: f64| (b * beat_s() * sr).round() as usize;
    for b in 0..4 {
        mix_at(&mut out, &k, at(b as f64), 1.0);
        mix_at(&mut out, &oh, at(b as f64 + 0.5), 0.35);
        if b % 2 == 1 {
            mix_at(&mut out, &c, at(b as f64), 0.6);
        }
        for q in [0.25, 0.75] {
            mix_at(&mut out, &h, at(b as f64 + q), 0.3);
        }
    }
    // Tails that run past the bar wrap to the start, so the loop point is seamless.
    let tail: Vec<f32> = out.drain(n..).collect();
    for (i, v) in tail.into_iter().enumerate() {
        out[i % n] += v;
    }
    out
}

/// Eight beats of snare hits getting faster and louder.
fn snare_build(sr: f64, rng: &mut Rng) -> Vec<f32> {
    let s = snare(sr, rng, 0.18);
    let mut out = vec![0.0; (8.0 * beat_s() * sr) as usize];
    let mut beat = 0.0;
    while beat < 8.0 {
        let step = match beat {
            b if b < 4.0 => 1.0,
            b if b < 6.0 => 0.5,
            b if b < 7.0 => 0.25,
            _ => 0.125,
        };
        let g = 0.35 + 0.65 * (beat / 8.0) as f32;
        mix_at(&mut out, &s, (beat * beat_s() * sr) as usize, g);
        beat += step;
    }
    out.truncate((8.0 * beat_s() * sr) as usize);
    fade_edges(&mut out, sr);
    out
}

/// A "wicka" baby scratch: a tone pushed forward and back.
fn scratch(sr: f64, rng: &mut Rng) -> Vec<f32> {
    let n = (0.6 * sr) as usize;
    let c = SvfCoeffs::design(SvfMode::Bandpass, 900.0, 0.8, 0.0, sr as f32);
    let mut f = Svf::default();
    let mut phase = 0.0;
    let mut out: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            // Two strokes: forward then back, speed follows a sine.
            let speed = (TAU * t / 0.3).sin();
            phase = (phase + 330.0 * speed.abs() * 2.0 / sr).fract();
            let x = (TAU * phase).sin() * 0.6 + rng.bipolar() as f64 * 0.4;
            f.process(&c, (x * speed.abs().sqrt()) as f32) * 2.0
        })
        .collect();
    fade_edges(&mut out, sr);
    out
}

/// One bar of sixteenth-note hats with an open hat on the off-beats, slightly wide.
fn hat_loop(sr: f64, rng: &mut Rng) -> (Vec<f32>, Vec<f32>) {
    let n = (4.0 * beat_s() * sr).round() as usize;
    let mut l = vec![0.0; n];
    let mut r = vec![0.0; n];
    for step in 0..16 {
        let at = (step as f64 * 0.25 * beat_s() * sr).round() as usize;
        let open = step % 4 == 2;
        let h = if open {
            noise(sr, rng, 0.2, 14.0, SvfMode::Highpass, 7_000.0, 0.7)
        } else {
            noise(sr, rng, 0.045, 85.0, SvfMode::Highpass, 9_000.0, 0.7)
        };
        let g = if open {
            0.7
        } else if step % 2 == 0 {
            0.5
        } else {
            0.32
        };
        let pan = if step % 2 == 0 { 0.85 } else { 1.0 };
        mix_at(&mut l, &h, at, g * pan);
        mix_at(&mut r, &h, at, g * (1.85 - pan));
    }
    for ch in [&mut l, &mut r] {
        let tail: Vec<f32> = ch.drain(n..).collect();
        for (i, v) in tail.into_iter().enumerate() {
            ch[i % n] += v;
        }
    }
    (l, r)
}

fn sub_drop(sr: f64) -> Vec<f32> {
    let n = (2.0 * sr) as usize;
    let mut phase = 0.0;
    let mut out: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            phase += (30.0 + 70.0 * (-t * 2.2).exp()) / sr;
            ((TAU * phase).sin() * (t / 0.005).min(1.0) * (-t * 1.2).exp()) as f32
        })
        .collect();
    fade_edges(&mut out, sr);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sound_renders_cleanly() {
        for k in KIT {
            let x = kit_sound(k.id, 48_000).unwrap();
            assert!(x.len() > 2_000, "{} is too short", k.id);
            assert_eq!(x.len() % 2, 0);
            assert!(x.iter().all(|v| v.is_finite()), "{} has NaN", k.id);
            let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
            assert!((peak - 0.891).abs() < 0.01, "{} peak {peak}", k.id);
        }
        assert!(kit_sound("nope", 48_000).is_none());
    }

    #[test]
    fn loops_are_whole_bars() {
        for (id, beats) in [("drum_loop", 4.0), ("hat_loop", 4.0), ("riser", 8.0), ("snare_build", 8.0)] {
            let frames = kit_sound(id, 44_100).unwrap().len() / 2;
            let want = beats * 60.0 / KIT_BPM * 44_100.0;
            assert!((frames as f64 - want).abs() <= 1.0, "{id}: {frames} frames, want {want}");
        }
    }

    #[test]
    fn deterministic() {
        assert_eq!(kit_sound("clap", 48_000), kit_sound("clap", 48_000));
    }
}
