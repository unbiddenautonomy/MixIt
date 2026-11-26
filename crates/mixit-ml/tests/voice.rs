//! Cleans a "DJ talking over the music" recording whose parts are known exactly: a
//! voice (the near end), the track's music played through a simulated room into the
//! mic (the echo) and steady background noise.
//!
//! The voice is generated ([`mixit_generator::talk`]). DeepFilterNet learned real
//! voices, so it is harder on the generated one than on a person; to check against a
//! real recording of someone talking (any file, no music), name it:
//!
//! ```sh
//! MIXIT_SPEECH=/path/to/speech.wav cargo test -p mixit-ml --release --test voice -- --nocapture
//! ```

#![cfg(feature = "voice")]

use mixit_core::{Key, Mode};
use mixit_generator::{Style, TrackSpec, generate, talk};
use mixit_ml::voice::{Denoise, VoiceCleaner, VoiceSettings};

const SR: u32 = 48_000;

struct Scene {
    /// The voice alone (what a perfect cleaner gives back).
    voice: Vec<f32>,
    /// The music as the speakers play it (the reference).
    music: Vec<f32>,
    /// The music as the mic hears it.
    echo: Vec<f32>,
    noise: Vec<f32>,
    /// Sample ranges where the voice is silent.
    quiet: Vec<(usize, usize)>,
    /// A real recording rather than the generated voice.
    real: bool,
}

fn xorshift(s: &mut u32) -> f32 {
    *s ^= *s << 13;
    *s ^= *s >> 17;
    *s ^= *s << 5;
    *s as f32 / u32::MAX as f32 * 2.0 - 1.0
}

fn scene() -> Scene {
    let mut spec = TrackSpec::short(Style::House, 124.0, Key::new(9, Mode::Minor));
    spec.sample_rate = SR;
    let g = generate(&spec);
    let n = g.audio.len() / 2;
    let music: Vec<f32> = (0..n).map(|i| 0.5 * (g.audio[2 * i] + g.audio[2 * i + 1])).collect();
    let (voice, real) = match std::env::var("MIXIT_SPEECH") {
        Ok(path) => {
            let t = mixit_io::load_track(path.as_ref(), SR, None).expect("the speech file loads");
            let a = &t.data;
            let sp: Vec<f32> = (0..a.len() / 2).map(|i| 0.5 * (a[2 * i] + a[2 * i + 1])).collect();
            // Seven seconds of talking in every twenty, so there are pauses to measure.
            let v = (0..n).map(|i| if (i / SR as usize) % 20 > 12 { sp[i % sp.len()] } else { 0.0 }).collect();
            (v, true)
        }
        Err(_) => (talk(SR, n as f64 / SR as f64, 3).audio, false),
    };
    // The room: the direct sound 25 ms late, two reflections and a short decaying tail,
    // all a bit duller than the speakers (a one-pole low-pass).
    let mut ir = vec![0.0f32; SR as usize / 5];
    ir[1_200] = 0.25;
    ir[2_100] = -0.1;
    ir[3_400] = 0.06;
    let mut s = 7u32;
    for (i, v) in ir.iter_mut().enumerate().skip(3_500) {
        *v += xorshift(&mut s) * 0.01 * (-(i as f32) / 2_000.0).exp();
    }
    let taps: Vec<(usize, f32)> = ir.iter().enumerate().filter(|(_, v)| v.abs() > 1e-5).map(|(i, &v)| (i, v)).collect();
    let mut echo = vec![0.0f32; n];
    for (k, &m) in music.iter().enumerate() {
        if m != 0.0 {
            for &(i, h) in taps.iter().take_while(|&&(i, _)| k + i < n) {
                echo[k + i] += m * h;
            }
        }
    }
    let mut lp = 0.0f32;
    for v in &mut echo {
        lp += 0.5 * (*v - lp);
        *v = lp;
    }
    let mut s = 11u32;
    let noise: Vec<f32> = (0..n).map(|_| xorshift(&mut s) * 0.02).collect();
    // Quiet stretches: where the voice is silent, less a margin either side.
    let margin = (0.3 * SR as f64) as usize;
    let mut quiet = Vec::new();
    let mut start = None;
    for i in 0..=n {
        let silent = i < n && voice[i].abs() < 1e-6;
        match (silent, start) {
            (true, None) => start = Some(i),
            (false, Some(a)) => {
                if i > a + 2 * margin {
                    quiet.push((a + margin, i - margin));
                }
                start = None;
            }
            _ => {}
        }
    }
    Scene { voice, music, echo, noise, quiet, real }
}

/// Runs the cleaner the way the app does: what the speakers play first, then the mic,
/// in 256-sample device blocks. Returns the cleaned mic and the delay added.
fn run(settings: VoiceSettings, mic: &[f32], reference: &[f32]) -> (Vec<f32>, usize) {
    let mut c = VoiceCleaner::new(settings, SR, SR).unwrap();
    let mut out = Vec::with_capacity(mic.len());
    for (m, r) in mic.chunks(256).zip(reference.chunks(256)) {
        c.reference(r);
        c.process(m, &mut out);
    }
    (out, c.delay())
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| v as f64 * v as f64).sum::<f64>()
}

fn db(x: &[f32]) -> f64 {
    10.0 * (energy(x) / x.len().max(1) as f64).max(1e-20).log10()
}

/// Level of `x` over the quiet stretches past `from`, shifted by `lag`, in dB.
fn quiet_db(x: &[f32], quiet: &[(usize, usize)], from: usize, lag: usize) -> f64 {
    let mut e = 0.0;
    let mut n = 0usize;
    for &(a, b) in quiet {
        let (a, b) = (a.max(from) + lag, (b + lag).min(x.len()));
        if b > a {
            e += energy(&x[a..b]);
            n += b - a;
        }
    }
    10.0 * (e / n.max(1) as f64).max(1e-20).log10()
}

/// How the voice's level comes through, in dB (0 = untouched): the mean difference
/// between `out` (shifted by `lag`) and the voice over the half seconds past `from`
/// where someone is talking.
fn kept_db(out: &[f32], voice: &[f32], from: usize, lag: usize) -> f64 {
    let w = SR as usize / 2;
    let mut diffs = Vec::new();
    let mut at = from;
    while at + w + lag <= out.len().min(voice.len()) {
        let v = db(&voice[at..at + w]);
        if v > -40.0 {
            diffs.push(db(&out[at + lag..at + lag + w]) - v);
        }
        at += w;
    }
    assert!(diffs.len() > 10);
    diffs.iter().sum::<f64>() / diffs.len() as f64
}

#[test]
fn takes_the_music_out_of_the_mic_and_keeps_the_voice() {
    let s = scene();
    let mic: Vec<f32> = s.voice.iter().zip(&s.echo).map(|(v, e)| v + e).collect();
    let (out, lag) = run(VoiceSettings { echo: true, denoise: Denoise::Off }, &mic, &s.music);
    let from = 5 * SR as usize; // once the canceller has settled
    let (before, after) = (quiet_db(&mic, &s.quiet, from, 0), quiet_db(&out, &s.quiet, from, lag));
    let kept = kept_db(&out, &s.voice, from, lag);
    eprintln!("echo between words {before:.1} -> {after:.1} dB; the voice comes through at {kept:+.1} dB");
    assert!(before - after > 12.0, "{before:.1} -> {after:.1}");
    assert!(kept > -4.0 && kept < 1.5, "voice {kept:+.1} dB");
}

#[test]
fn takes_the_noise_out_of_the_mic() {
    let s = scene();
    let mic: Vec<f32> = s.voice.iter().zip(&s.noise).map(|(v, e)| v + e).collect();
    let silence = vec![0.0f32; mic.len()];
    let from = SR as usize;
    let before = quiet_db(&mic, &s.quiet, from, 0);
    for (denoise, want, keep) in [(Denoise::Strong, 30.0, -5.0), (Denoise::Light, 6.0, -3.0)] {
        let t = std::time::Instant::now();
        let (out, lag) = run(VoiceSettings { echo: false, denoise }, &mic, &silence);
        let after = quiet_db(&out, &s.quiet, from, lag);
        let kept = kept_db(&out, &s.voice, from, lag);
        eprintln!(
            "{denoise:?}: noise {before:.1} -> {after:.1} dB, voice {kept:+.1} dB, {:.2} s for {:.0} s, {:.0} ms delay",
            t.elapsed().as_secs_f64(),
            mic.len() as f64 / SR as f64,
            lag as f64 * 1000.0 / SR as f64
        );
        assert!(before - after > want, "{denoise:?}: {before:.1} -> {after:.1}");
        assert!(kept > keep && kept < 1.5, "{denoise:?}: voice {kept:+.1} dB");
    }
}

#[test]
fn cleans_echo_and_noise_together() {
    let s = scene();
    let mic: Vec<f32> = (0..s.voice.len()).map(|i| s.voice[i] + s.echo[i] + s.noise[i]).collect();
    let (out, lag) = run(VoiceSettings::default(), &mic, &s.music);
    let from = 5 * SR as usize;
    let (before, after) = (quiet_db(&mic, &s.quiet, from, 0), quiet_db(&out, &s.quiet, from, lag));
    let kept = kept_db(&out, &s.voice, from, lag);
    eprintln!("echo and noise between words {before:.1} -> {after:.1} dB; voice {kept:+.1} dB");
    assert!(before - after > 25.0, "{before:.1} -> {after:.1}");
    // DeepFilterNet keeps a real voice (about -2 dB here) better than the generated one.
    let keep = if s.real { -4.0 } else { -14.0 };
    assert!(kept > keep && kept < 1.5, "voice {kept:+.1} dB");
}
