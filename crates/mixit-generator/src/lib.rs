//! Practice tracks with known answers.
//!
//! Synthesises full arrangements (intro, build, drop, breakdown, outro) in several dance
//! styles at a chosen tempo and key, and returns the exact ground truth: every beat and
//! downbeat time, the key and the section boundaries. Uses:
//!
//! * a beginner can practise beatmatching and phrasing without owning any music;
//! * the analysis crate is tested against tracks whose BPM, grid and key are known
//!   exactly, including tempo drift and leading silence;
//! * demos and screenshots never need copyrighted audio.
//!
//! Everything is deterministic for a given [`TrackSpec`] (seeded noise, no clocks).

pub mod kit;
pub mod practice;
mod voice;

use mixit_core::{Key, Mode};
pub(crate) use mixit_dsp::rng::Rng;
use mixit_dsp::svf::{Svf, SvfCoeffs, SvfMode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Style {
    /// Four-on-the-floor, off-beat bass, open hats.
    House,
    /// Driving kick, rumble bass, ride and claps.
    Techno,
    /// Supersaw chords, rolling bass, long builds.
    Trance,
    /// Breakbeat at 160–180 BPM with a sub bass.
    DrumAndBass,
    /// Half-time boom-bap at 80–100 BPM.
    HipHop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SectionKind {
    Intro,
    Build,
    Drop,
    Breakdown,
    Outro,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub kind: SectionKind,
    pub bars: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackSpec {
    pub style: Style,
    pub bpm: f64,
    /// When set, the tempo glides linearly from `bpm` to this over the whole track.
    pub end_bpm: Option<f64>,
    pub key: Key,
    pub sample_rate: u32,
    pub sections: Vec<Section>,
    /// Silence before the first downbeat (seconds).
    pub lead_in: f64,
    /// 0 = straight, 0.6 = heavy swing on sixteenths.
    pub swing: f64,
    pub seed: u64,
    /// A singer in the drops and breakdowns: two bars sung in every four.
    #[serde(default)]
    pub vocals: bool,
}

impl TrackSpec {
    /// A typical DJ-friendly arrangement: 16 intro, 8 build, 16 drop, 16 breakdown,
    /// 8 build, 16 drop, 16 outro bars.
    pub fn standard(style: Style, bpm: f64, key: Key) -> TrackSpec {
        use SectionKind::*;
        let s = |kind, bars| Section { kind, bars };
        TrackSpec {
            style,
            bpm,
            end_bpm: None,
            key,
            sample_rate: 44_100,
            sections: vec![
                s(Intro, 16),
                s(Build, 8),
                s(Drop, 16),
                s(Breakdown, 16),
                s(Build, 8),
                s(Drop, 16),
                s(Outro, 16),
            ],
            lead_in: 0.0,
            swing: 0.0,
            seed: 1,
            vocals: false,
        }
    }

    /// A short arrangement for tests (about 30–40 s at house tempo).
    pub fn short(style: Style, bpm: f64, key: Key) -> TrackSpec {
        use SectionKind::*;
        let s = |kind, bars| Section { kind, bars };
        TrackSpec {
            sections: vec![s(Intro, 4), s(Build, 4), s(Drop, 8), s(Breakdown, 4), s(Outro, 4)],
            ..Self::standard(style, bpm, key)
        }
    }

    pub fn total_beats(&self) -> u32 {
        self.sections.iter().map(|s| s.bars * 4).sum()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GroundTruth {
    pub bpm: f64,
    pub end_bpm: f64,
    pub key: Key,
    /// Every beat (seconds), starting with the first downbeat.
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    /// (start seconds, kind).
    pub sections: Vec<(f64, SectionKind)>,
    pub duration: f64,
    /// Where the singer sings: (start, end) seconds.
    #[serde(default)]
    pub vocals: Vec<(f64, f64)>,
}

pub struct Generated {
    pub sample_rate: u32,
    /// Interleaved stereo.
    pub audio: Vec<f32>,
    pub truth: GroundTruth,
}

impl Generated {
    pub fn frames(&self) -> usize {
        self.audio.len() / 2
    }
    pub fn mono(&self) -> Vec<f32> {
        self.audio.chunks(2).map(|c| 0.5 * (c[0] + c[1])).collect()
    }
}

// -------------------------------------------------------------------------------------
// Music theory helpers
// -------------------------------------------------------------------------------------

fn midi_hz(m: f64) -> f64 {
    440.0 * 2f64.powf((m - 69.0) / 12.0)
}

/// Scale degrees (semitones from the tonic).
fn scale(mode: Mode) -> [i32; 7] {
    match mode {
        Mode::Major => [0, 2, 4, 5, 7, 9, 11],
        Mode::Minor => [0, 2, 3, 5, 7, 8, 10],
    }
}

/// A four-chord progression as scale-degree roots; the tonic chord comes first and is
/// repeated so the key is unambiguous.
fn progression(mode: Mode) -> [usize; 4] {
    match mode {
        Mode::Minor => [0, 5, 0, 6], // i – VI – i – VII
        Mode::Major => [0, 4, 0, 3], // I – V – I – IV
    }
}

/// MIDI notes of the triad on scale degree `deg` with the tonic at `root_midi`.
fn triad(root_midi: i32, mode: Mode, deg: usize) -> [i32; 3] {
    let sc = scale(mode);
    let at = |d: usize| {
        let oct = (d / 7) as i32;
        root_midi + sc[d % 7] + 12 * oct
    };
    [at(deg), at(deg + 2), at(deg + 4)]
}

// -------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------

struct Mix {
    sr: f64,
    l: Vec<f32>,
    r: Vec<f32>,
}

impl Mix {
    fn add(&mut self, at: f64, pan: f32, gain: f32, voice: &[f32]) {
        let start = (at * self.sr).round() as i64;
        let (gl, gr) = ((1.0 - pan) * 0.5 + 0.5 * (1.0 - pan.abs()), (1.0 + pan) * 0.5 + 0.5 * (1.0 - pan.abs()));
        for (i, &v) in voice.iter().enumerate() {
            let idx = start + i as i64;
            if idx < 0 || idx as usize >= self.l.len() {
                continue;
            }
            self.l[idx as usize] += v * gain * gl;
            self.r[idx as usize] += v * gain * gr;
        }
    }
}

struct Kit {
    kick: Vec<f32>,
    snare: Vec<f32>,
    clap: Vec<f32>,
    hat: Vec<f32>,
    open_hat: Vec<f32>,
    ride: Vec<f32>,
    crash: Vec<f32>,
}

fn kick(sr: f64, pitch: f64, len_s: f64) -> Vec<f32> {
    let n = (len_s * sr) as usize;
    let mut phase = 0.0f64;
    (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            let f = pitch + 110.0 * (-t * 38.0).exp();
            phase += f / sr;
            let body = (std::f64::consts::TAU * phase).sin() * (-t * 7.0).exp();
            let click = if i < 64 { (1.0 - i as f64 / 64.0) * 0.4 } else { 0.0 };
            ((body + click) * 0.95).tanh() as f32
        })
        .collect()
}

fn noise_burst(sr: f64, rng: &mut Rng, len_s: f64, decay: f64, mode: SvfMode, freq: f32, q: f32) -> Vec<f32> {
    let n = (len_s * sr) as usize;
    let c = SvfCoeffs::design(mode, freq, q, 0.0, sr as f32);
    let mut f = Svf::default();
    (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            f.process(&c, rng.bipolar()) * (-t * decay).exp() as f32
        })
        .collect()
}

fn make_kit(sr: f64, style: Style, rng: &mut Rng) -> Kit {
    let kick_pitch = match style {
        Style::Techno => 48.0,
        Style::HipHop => 52.0,
        Style::DrumAndBass => 55.0,
        _ => 50.0,
    };
    let mut snare = noise_burst(sr, rng, 0.25, 18.0, SvfMode::Bandpass, 2_500.0, 0.8);
    for (i, v) in snare.iter_mut().enumerate() {
        let t = i as f64 / sr;
        *v = *v * 2.0 + ((std::f64::consts::TAU * 190.0 * t).sin() * (-t * 25.0).exp() * 0.6) as f32;
    }
    let mut clap = Vec::new();
    for k in 0..4 {
        let b = noise_burst(sr, rng, 0.2, if k == 3 { 14.0 } else { 60.0 }, SvfMode::Bandpass, 1_400.0, 1.2);
        let off = (k as f64 * 0.011 * sr) as usize;
        if clap.len() < off + b.len() {
            clap.resize(off + b.len(), 0.0);
        }
        for (i, v) in b.iter().enumerate() {
            clap[off + i] += v * 2.5;
        }
    }
    Kit {
        kick: kick(sr, kick_pitch, 0.45),
        snare,
        clap,
        hat: noise_burst(sr, rng, 0.06, 70.0, SvfMode::Highpass, 8_000.0, 0.7),
        open_hat: noise_burst(sr, rng, 0.3, 11.0, SvfMode::Highpass, 7_000.0, 0.7),
        ride: noise_burst(sr, rng, 0.5, 6.0, SvfMode::Bandpass, 6_500.0, 2.0),
        crash: noise_burst(sr, rng, 2.0, 1.8, SvfMode::Highpass, 4_000.0, 0.5),
    }
}

/// A detuned saw (supersaw) note with an amplitude envelope and low-pass filter.
fn saw_note(
    sr: f64,
    freq: f64,
    len_s: f64,
    voices: usize,
    cutoff: f32,
    attack: f64,
    release: f64,
    rng: &mut Rng,
) -> Vec<f32> {
    let n = ((len_s + release) * sr) as usize;
    let mut phases: Vec<f64> = (0..voices).map(|_| rng.next_f32() as f64).collect();
    let det: Vec<f64> = (0..voices)
        .map(|v| if voices == 1 { 1.0 } else { 1.0 + (v as f64 / (voices - 1) as f64 - 0.5) * 0.012 })
        .collect();
    let c = SvfCoeffs::design(SvfMode::Lowpass, cutoff, 0.9, 0.0, sr as f32);
    let mut f = Svf::default();
    (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            let mut s = 0.0;
            for (p, d) in phases.iter_mut().zip(&det) {
                *p = (*p + freq * d / sr).fract();
                s += 2.0 * *p - 1.0;
            }
            s /= voices as f64;
            let env = if t < attack {
                t / attack
            } else if t < len_s {
                1.0
            } else {
                (1.0 - (t - len_s) / release).max(0.0)
            };
            f.process(&c, (s * env) as f32)
        })
        .collect()
}

fn sine_bass(sr: f64, freq: f64, len_s: f64) -> Vec<f32> {
    let n = (len_s * sr) as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 / sr;
            let env = (t / 0.004).min(1.0) * ((len_s - t) / 0.01).clamp(0.0, 1.0);
            let x = (std::f64::consts::TAU * freq * t).sin() + 0.25 * (std::f64::consts::TAU * freq * 2.0 * t).sin();
            (x * env * 0.8) as f32
        })
        .collect()
}

/// Beat times (seconds) with an optional linear tempo glide.
fn beat_times(spec: &TrackSpec) -> Vec<f64> {
    let total = spec.total_beats() as usize;
    let end = spec.end_bpm.unwrap_or(spec.bpm);
    let mut t = spec.lead_in;
    let mut out = Vec::with_capacity(total + 1);
    for b in 0..=total {
        out.push(t);
        let bpm = spec.bpm + (end - spec.bpm) * b as f64 / total.max(1) as f64;
        t += 60.0 / bpm;
    }
    out
}

/// Renders a track and its ground truth.
pub fn generate(spec: &TrackSpec) -> Generated {
    let sr = spec.sample_rate as f64;
    let mut rng = Rng::new(spec.seed);
    let beats = beat_times(spec);
    let total_beats = spec.total_beats() as usize;
    let duration = beats[total_beats] + 2.5;
    let n = (duration * sr) as usize;
    let mut mix = Mix { sr, l: vec![0.0; n], r: vec![0.0; n] };
    let kit = make_kit(sr, spec.style, &mut rng);

    // Time of a fractional beat (linear between beat times), with swing on odd 16ths.
    let time_at = |b: f64| -> f64 {
        let i = (b.floor() as usize).min(total_beats - 1);
        let frac = b - i as f64;
        beats[i] + (beats[i + 1] - beats[i]) * frac
    };
    let swung = |b: f64| -> f64 {
        let sixteenth = (b * 4.0).round() as i64;
        if sixteenth % 2 == 1 { time_at(b + spec.swing * 0.125) } else { time_at(b) }
    };

    let tonic_midi = 36 + spec.key.tonic as i32; // bass octave (C2 …)
    let prog = progression(spec.key.mode);
    let mut sections = Vec::new();
    let mut bar0 = 0u32;
    for (si, sec) in spec.sections.iter().enumerate() {
        let start_beat = (bar0 * 4) as f64;
        sections.push((time_at(start_beat), sec.kind));
        let drums = !matches!(sec.kind, SectionKind::Breakdown);
        let full = matches!(sec.kind, SectionKind::Drop);
        let harmony = !matches!(sec.kind, SectionKind::Intro | SectionKind::Outro);
        if matches!(sec.kind, SectionKind::Drop | SectionKind::Breakdown)
            || (si > 0 && matches!(sec.kind, SectionKind::Outro))
        {
            mix.add(time_at(start_beat), 0.0, 0.35, &kit.crash);
        }
        for bar in 0..sec.bars {
            let gbar = bar0 + bar;
            let chord_deg = prog[(gbar as usize / 2) % 4];
            for beat in 0..4u32 {
                let b = (gbar * 4 + beat) as f64;
                let t = time_at(b);
                // Drums.
                if drums {
                    match spec.style {
                        Style::DrumAndBass => {
                            // Two-step: kick on 1 and the "and" of 3, snare on 2 and 4.
                            if beat == 0 {
                                mix.add(t, 0.0, 0.9, &kit.kick);
                            }
                            if beat == 2 {
                                mix.add(time_at(b + 0.5), 0.0, 0.8, &kit.kick);
                            }
                            if beat % 2 == 1 {
                                mix.add(t, 0.0, 0.7, &kit.snare);
                            }
                        }
                        Style::HipHop => {
                            if beat == 0 || (beat == 2 && bar % 2 == 1) {
                                mix.add(t, 0.0, 0.9, &kit.kick);
                            }
                            if beat == 2 && bar % 2 == 0 {
                                mix.add(time_at(b + 0.75), 0.0, 0.6, &kit.kick);
                            }
                            if beat % 2 == 1 {
                                mix.add(t, 0.0, 0.75, &kit.snare);
                            }
                        }
                        _ => {
                            mix.add(t, 0.0, 0.9, &kit.kick);
                            if beat % 2 == 1 && sec.kind != SectionKind::Intro {
                                mix.add(t, 0.0, 0.5, &kit.clap);
                            }
                        }
                    }
                    // Hats.
                    for s in 0..4 {
                        let sb = b + s as f64 * 0.25;
                        let ht = swung(sb);
                        match (spec.style, s) {
                            (Style::House, 2) => mix.add(ht, 0.3, 0.25, &kit.open_hat),
                            (Style::Techno, 2) => mix.add(ht, -0.2, 0.2, &kit.ride),
                            (Style::Trance, 2) => mix.add(ht, 0.2, 0.22, &kit.open_hat),
                            (_, _) => mix.add(ht, 0.25, if s % 2 == 0 { 0.14 } else { 0.09 }, &kit.hat),
                        }
                    }
                }
                // Build: snare roll that doubles in density.
                if sec.kind == SectionKind::Build {
                    let density = if bar >= sec.bars * 3 / 4 {
                        4
                    } else if bar >= sec.bars / 2 {
                        2
                    } else {
                        1
                    };
                    for k in 0..density {
                        let rb = b + k as f64 / density as f64;
                        let g = 0.15 + 0.4 * (bar as f32 / sec.bars as f32);
                        mix.add(time_at(rb), 0.0, g, &kit.snare);
                    }
                }
                // Bass.
                if drums && sec.kind != SectionKind::Intro || full {
                    let root = tonic_midi + scale(spec.key.mode)[chord_deg];
                    let f = midi_hz(root as f64);
                    let beat_len = beats[(b as usize + 1).min(total_beats)] - t;
                    match spec.style {
                        Style::House | Style::Trance => {
                            let note = sine_bass(sr, f, beat_len * 0.4);
                            mix.add(time_at(b + 0.5), 0.0, 0.45, &note);
                        }
                        Style::Techno => {
                            for s in 1..4 {
                                let note = sine_bass(sr, f, beat_len * 0.18);
                                mix.add(time_at(b + s as f64 * 0.25), 0.0, 0.35, &note);
                            }
                        }
                        Style::DrumAndBass | Style::HipHop => {
                            if beat == 0 {
                                let note = sine_bass(sr, f, beat_len * 1.8);
                                mix.add(t, 0.0, 0.55, &note);
                            }
                        }
                    }
                }
            }
            // Chords: one per bar, on the downbeat.
            if harmony || full {
                let t = time_at((gbar * 4) as f64);
                let bar_len = time_at((gbar * 4 + 4).min(total_beats as u32) as f64) - t;
                let tri = triad(tonic_midi + 24, spec.key.mode, chord_deg);
                let cutoff = match sec.kind {
                    SectionKind::Build => 600.0 + 3_000.0 * bar as f32 / sec.bars as f32,
                    SectionKind::Drop => 4_000.0,
                    _ => 1_800.0,
                };
                for (k, &m) in tri.iter().enumerate() {
                    let voices = if spec.style == Style::Trance { 5 } else { 3 };
                    let note = saw_note(sr, midi_hz(m as f64), bar_len * 0.95, voices, cutoff, 0.02, 0.15, &mut rng);
                    mix.add(t, (k as f32 - 1.0) * 0.4, 0.12, &note);
                }
                // Lead arpeggio over the drop and breakdown.
                if matches!(sec.kind, SectionKind::Drop | SectionKind::Breakdown) {
                    let sc = scale(spec.key.mode);
                    for s in 0..8 {
                        let deg = chord_deg + [0, 2, 4, 2, 0, 4, 2, 4][s];
                        let m = tonic_midi + 36 + sc[deg % 7] + 12 * (deg / 7) as i32;
                        let at = time_at((gbar * 4) as f64 + s as f64 * 0.5);
                        let len = (time_at((gbar * 4) as f64 + s as f64 * 0.5 + 0.5) - at) * 0.6;
                        let note = saw_note(sr, midi_hz(m as f64), len, 1, 3_500.0, 0.003, 0.05, &mut rng);
                        mix.add(at, if s % 2 == 0 { -0.3 } else { 0.3 }, 0.07, &note);
                    }
                }
            }
        }
        bar0 += sec.bars;
    }

    // The singer: two bars sung in every four of each drop and breakdown, on its own
    // random stream so the rest of the track is the same with or without vocals.
    let mut vocals = Vec::new();
    if spec.vocals {
        let mut vrng = Rng::new(spec.seed ^ 0x0051_06E7);
        let sc = scale(spec.key.mode);
        const RHYTHM: [f64; 9] = [1.0, 0.5, 0.5, 1.0, 1.0, 0.5, 0.5, 1.0, 2.0];
        const MELODY: [usize; 9] = [0, 2, 4, 2, 1, 0, 2, 4, 0];
        let mut bar0 = 0u32;
        for sec in &spec.sections {
            if matches!(sec.kind, SectionKind::Drop | SectionKind::Breakdown) {
                for block in (0..sec.bars.saturating_sub(1)).step_by(4) {
                    let gbar = bar0 + block;
                    let chord_deg = prog[(gbar as usize / 2) % 4];
                    let b0 = (gbar * 4) as f64;
                    let t0 = time_at(b0);
                    let mut syl = Vec::new();
                    let mut b = b0;
                    for (k, &len) in RHYTHM.iter().enumerate() {
                        let deg = chord_deg + MELODY[k];
                        let midi = (tonic_midi + 24 + sc[deg % 7] + 12 * (deg / 7) as i32) as f64;
                        let at = time_at(b) - t0;
                        let dur = time_at((b + len).min(total_beats as f64)) - t0 - at;
                        syl.push(voice::Syllable { at, len: dur, midi, vowel: (vrng.next_f32() * 5.0) as usize % 5 });
                        b += len;
                    }
                    let end = syl.last().map(|s| s.at + s.len).unwrap_or(0.0);
                    let v = voice::sing(sr, &syl, &mut vrng);
                    mix.add(t0, 0.0, 0.5, &v);
                    vocals.push((t0, t0 + end));
                }
            }
            bar0 += sec.bars;
        }
    }

    // Normalise to a −1 dBFS peak.
    let peak = mix.l.iter().chain(mix.r.iter()).fold(0.0f32, |m, v| m.max(v.abs())).max(1e-6);
    let g = 10f32.powf(-1.0 / 20.0) / peak;
    let audio: Vec<f32> = mix.l.iter().zip(&mix.r).flat_map(|(a, b)| [a * g, b * g]).collect();
    let beat_list: Vec<f64> = beats[..total_beats].to_vec();
    let downbeats = beat_list.iter().step_by(4).copied().collect();
    Generated {
        sample_rate: spec.sample_rate,
        audio,
        truth: GroundTruth {
            bpm: spec.bpm,
            end_bpm: spec.end_bpm.unwrap_or(spec.bpm),
            key: spec.key,
            beats: beat_list,
            downbeats,
            sections,
            duration,
            vocals,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truth_matches_the_spec() {
        let spec = TrackSpec::short(Style::House, 124.0, Key::new(9, Mode::Minor));
        let g = generate(&spec);
        assert_eq!(g.truth.beats.len(), spec.total_beats() as usize);
        let period = g.truth.beats[1] - g.truth.beats[0];
        assert!((period - 60.0 / 124.0).abs() < 1e-12);
        assert_eq!(g.truth.downbeats.len() * 4, g.truth.beats.len());
        let peak = g.audio.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.891).abs() < 0.01);
    }

    #[test]
    fn is_deterministic() {
        let spec = TrackSpec::short(Style::Techno, 130.0, Key::new(2, Mode::Minor));
        assert_eq!(generate(&spec).audio, generate(&spec).audio);
    }

    #[test]
    fn tempo_glide_is_reflected_in_the_beats() {
        let mut spec = TrackSpec::short(Style::House, 120.0, Key::new(0, Mode::Major));
        spec.end_bpm = Some(126.0);
        let g = generate(&spec);
        let first = g.truth.beats[1] - g.truth.beats[0];
        let n = g.truth.beats.len();
        let last = g.truth.beats[n - 1] - g.truth.beats[n - 2];
        assert!(last < first);
    }
}
