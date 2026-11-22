//! The engine state the UI shows, in seconds and camelCase. The desktop app and the web
//! build send exactly this, so the TypeScript `Telemetry` type has one source.

use mixit_dsp::dynamics::{CompressorSettings, GateSettings};
use mixit_dsp::peq::{BandSettings, BandShape, MAX_BANDS};
use mixit_dsp::studio::StudioSettings;
use serde::{Deserialize, Serialize};

use crate::{DeckTelemetry, MasterTelemetry, MicTelemetry, Telemetry};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopDto {
    pub start: f64,
    pub end: f64,
    pub active: bool,
    pub beats: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTele {
    pub loaded: bool,
    pub token: u64,
    pub playing: bool,
    /// Seconds.
    pub position: f64,
    pub duration: f64,
    pub remaining: f64,
    pub bpm: f64,
    pub base_bpm: f64,
    pub rate: f64,
    pub tempo: f64,
    pub tempo_range: f64,
    pub beat: f64,
    pub beats_per_bar: u32,
    pub keylock: bool,
    pub key_shift: f32,
    pub sync: bool,
    pub master: bool,
    pub phase: f64,
    pub slip: bool,
    pub slip_position: f64,
    pub reverse: bool,
    pub cue: f64,
    pub looping: LoopDto,
    pub peak: [f32; 2],
    pub rms: f32,
    pub low_rms: f32,
    pub comp_gr_db: f32,
    pub duck_db: f32,
    pub gate_open: bool,
    pub safety_loop: bool,
}

impl DeckTele {
    pub fn new(d: &DeckTelemetry, sr: f64) -> Self {
        let s = |f: f64| f / sr;
        DeckTele {
            loaded: d.loaded,
            token: d.token,
            playing: d.playing,
            position: s(d.position),
            duration: s(d.duration),
            remaining: d.remaining,
            bpm: d.bpm,
            base_bpm: d.base_bpm,
            rate: d.rate,
            tempo: d.tempo,
            tempo_range: d.tempo_range,
            beat: d.beat,
            beats_per_bar: d.beats_per_bar,
            keylock: d.keylock,
            key_shift: d.key_shift,
            sync: d.sync,
            master: d.master,
            phase: d.phase_offset,
            slip: d.slip,
            slip_position: s(d.slip_position),
            reverse: d.reverse,
            cue: s(d.cue),
            looping: LoopDto {
                start: s(d.looping.start),
                end: s(d.looping.end),
                active: d.looping.active,
                beats: d.looping.beats,
            },
            peak: d.peak,
            rms: d.rms,
            low_rms: d.low_rms,
            comp_gr_db: d.comp_gr_db,
            duck_db: d.duck_db,
            gate_open: d.gate_open,
            safety_loop: d.safety_loop,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterTele {
    pub peak: [f32; 2],
    pub true_peak_db: f32,
    pub momentary_lufs: f32,
    pub short_term_lufs: f32,
    pub correlation: f32,
    pub limiter_gr_db: f32,
    pub glue_gr_db: f32,
    pub cue_peak: [f32; 2],
    pub clipped: bool,
}

impl From<&MasterTelemetry> for MasterTele {
    fn from(m: &MasterTelemetry) -> Self {
        MasterTele {
            peak: m.peak,
            true_peak_db: m.true_peak_db,
            momentary_lufs: m.momentary_lufs,
            short_term_lufs: m.short_term_lufs,
            correlation: m.correlation,
            limiter_gr_db: m.limiter_gr_db,
            glue_gr_db: m.glue_gr_db,
            cue_peak: m.cue_peak,
            clipped: m.clipped,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicTele {
    pub connected: bool,
    pub live: bool,
    pub on_air: bool,
    pub peak: [f32; 2],
    pub rms: f32,
    pub duck_db: f32,
    pub gate_open: bool,
    pub latency_ms: f32,
    pub drift_ppm: f32,
    pub underruns: u32,
    pub capturing: bool,
    pub captured_seconds: f64,
}

impl MicTele {
    pub fn new(m: &MicTelemetry, sr: u32) -> Self {
        MicTele {
            connected: m.connected,
            live: m.live,
            on_air: m.on_air,
            peak: m.peak,
            rms: m.rms,
            duck_db: m.duck_db,
            gate_open: m.gate_open,
            latency_ms: m.latency_ms,
            drift_ppm: m.drift_ppm,
            underruns: m.underruns,
            capturing: m.capturing,
            captured_seconds: m.captured_frames as f64 / sr.max(1) as f64,
        }
    }
}

/// The library preview player.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTele {
    pub loaded: bool,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub ended: bool,
    pub synced: bool,
    pub rate: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryDto {
    pub frame: u64,
    pub decks: Vec<DeckTele>,
    pub master: MasterTele,
    pub mic: MicTele,
    pub preview: PreviewTele,
    pub clock_bpm: f64,
    pub master_deck: Option<u8>,
    pub recording: bool,
    pub recorded_seconds: f64,
    pub load: f32,
    pub overruns: u64,
    /// Bit n set while pad n plays.
    pub sampler_playing: u32,
    /// Step the sampler's sequencer is on, or -1 when it is off.
    pub sequencer_step: i16,
    /// Spectrum-analyser bands (dB, see `mixit_dsp::studio::Spectrum`) while one is open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectrum: Option<Vec<f32>>,
}

impl TelemetryDto {
    pub fn new(t: &Telemetry, decks: usize, sr: u32, load: f32, overruns: u64) -> Self {
        TelemetryDto {
            frame: t.frame,
            decks: t.decks.iter().take(decks).map(|d| DeckTele::new(d, sr as f64)).collect(),
            master: (&t.master).into(),
            mic: MicTele::new(&t.mic, sr),
            preview: PreviewTele {
                loaded: t.preview.loaded,
                playing: t.preview.playing,
                position: t.preview.position_frames / sr.max(1) as f64,
                duration: t.preview.frames / sr.max(1) as f64,
                ended: t.preview.ended,
                synced: t.preview.synced,
                rate: t.preview.rate,
            },
            clock_bpm: t.clock_bpm,
            master_deck: t.master_deck.map(|d| d.0),
            recording: t.recording,
            recorded_seconds: t.recorded_frames as f64 / sr as f64,
            load,
            overruns,
            sampler_playing: t.sampler_playing,
            sequencer_step: t.sequencer_step,
            spectrum: None,
        }
    }
}

// ------------------------------------------------------------------ studio settings

pub use mixit_project::strip::{BandDto, BandShapeDto, CompDto, GateDto, StudioDto};

fn shape_dto(s: BandShape) -> BandShapeDto {
    match s {
        BandShape::Bell => BandShapeDto::Bell,
        BandShape::LowShelf => BandShapeDto::LowShelf,
        BandShape::HighShelf => BandShapeDto::HighShelf,
        BandShape::LowCut => BandShapeDto::LowCut,
        BandShape::HighCut => BandShapeDto::HighCut,
        BandShape::Notch => BandShapeDto::Notch,
        BandShape::BandPass => BandShapeDto::BandPass,
    }
}

fn shape_from_dto(s: BandShapeDto) -> BandShape {
    match s {
        BandShapeDto::Bell => BandShape::Bell,
        BandShapeDto::LowShelf => BandShape::LowShelf,
        BandShapeDto::HighShelf => BandShape::HighShelf,
        BandShapeDto::LowCut => BandShape::LowCut,
        BandShapeDto::HighCut => BandShape::HighCut,
        BandShapeDto::Notch => BandShape::Notch,
        BandShapeDto::BandPass => BandShape::BandPass,
    }
}

/// The UI and project form of an engine strip.
pub fn studio_dto(s: &StudioSettings) -> StudioDto {
    {
        let c = &s.comp;
        let g = &s.gate;
        StudioDto {
            gate_on: s.gate_on,
            gate: GateDto {
                threshold_db: g.threshold_db,
                hysteresis_db: g.hysteresis_db,
                attack_ms: g.attack_ms,
                hold_ms: g.hold_ms,
                release_ms: g.release_ms,
                range_db: g.range_db,
            },
            eq_on: s.eq_on,
            bands: s
                .bands
                .iter()
                .map(|b| BandDto {
                    enabled: b.enabled,
                    shape: shape_dto(b.shape),
                    freq: b.freq,
                    q: b.q,
                    gain_db: b.gain_db,
                    slope_db: b.slope_db,
                })
                .collect(),
            comp_on: s.comp_on,
            comp: CompDto {
                threshold_db: c.threshold_db,
                ratio: c.ratio,
                knee_db: c.knee_db,
                attack_ms: c.attack_ms,
                release_ms: c.release_ms,
                makeup_db: c.makeup_db,
                auto_makeup: c.auto_makeup,
                sidechain_hpf_hz: c.sidechain_hpf_hz,
                mix: c.mix,
            },
            sat_on: s.sat_on,
            drive_db: s.drive_db,
            width: s.width,
            output_db: s.output_db,
        }
    }
}

/// The engine form of a strip from the UI or a project. Out-of-range values are clamped;
/// missing bands are off.
pub fn studio_settings(d: &StudioDto) -> StudioSettings {
    {
        let mut bands = [BandSettings::default(); MAX_BANDS];
        for (b, x) in bands.iter_mut().zip(&d.bands) {
            let f = |v: f32, lo: f32, hi: f32, def: f32| if v.is_finite() { v.clamp(lo, hi) } else { def };
            *b = BandSettings {
                enabled: x.enabled,
                shape: shape_from_dto(x.shape),
                freq: f(x.freq, 10.0, 22_000.0, 1_000.0),
                q: f(x.q, 0.1, 30.0, 0.707),
                gain_db: f(x.gain_db, -30.0, 30.0, 0.0),
                slope_db: (x.slope_db / 12).clamp(1, 4) * 12,
            };
        }
        let c = &d.comp;
        let g = &d.gate;
        StudioSettings {
            gate_on: d.gate_on,
            gate: GateSettings {
                threshold_db: g.threshold_db.clamp(-90.0, 0.0),
                hysteresis_db: g.hysteresis_db.clamp(0.0, 20.0),
                attack_ms: g.attack_ms.clamp(0.05, 100.0),
                hold_ms: g.hold_ms.clamp(0.0, 2_000.0),
                release_ms: g.release_ms.clamp(1.0, 5_000.0),
                range_db: g.range_db.clamp(-120.0, 0.0),
            },
            eq_on: d.eq_on,
            bands,
            comp_on: d.comp_on,
            comp: CompressorSettings {
                threshold_db: c.threshold_db.clamp(-60.0, 0.0),
                ratio: c.ratio.clamp(1.0, 30.0),
                knee_db: c.knee_db.clamp(0.0, 24.0),
                attack_ms: c.attack_ms.clamp(0.05, 300.0),
                release_ms: c.release_ms.clamp(5.0, 3_000.0),
                makeup_db: c.makeup_db.clamp(-12.0, 24.0),
                auto_makeup: c.auto_makeup,
                sidechain_hpf_hz: c.sidechain_hpf_hz.clamp(0.0, 500.0),
                mix: c.mix.clamp(0.0, 1.0),
            },
            sat_on: d.sat_on,
            drive_db: d.drive_db.clamp(0.0, 30.0),
            width: d.width.clamp(0.0, 2.0),
            output_db: d.output_db.clamp(-24.0, 24.0),
        }
    }
}

// ------------------------------------------------------------------ sound editing

/// One step of a non-destructive sound edit, as the UI sends it (`{"op": "fade", ...}`).
/// Times are seconds in the sound as it is at that step.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditOpDto {
    Trim {
        start: f64,
        end: f64,
    },
    Delete {
        start: f64,
        end: f64,
    },
    Copy {
        start: f64,
        end: f64,
    },
    Paste {
        at: f64,
    },
    Silence {
        start: f64,
        end: f64,
    },
    InsertSilence {
        at: f64,
        seconds: f64,
    },
    Fade {
        start: f64,
        end: f64,
        fade_in: bool,
        shape: FadeShapeDto,
    },
    Gain {
        start: f64,
        end: f64,
        db: f32,
    },
    /// `to`: "peak" (level in dBFS) or "loudness" (level in LUFS).
    Normalize {
        to: NormalizeKind,
        level: f32,
    },
    Reverse {
        start: f64,
        end: f64,
    },
    TrimSilence {
        threshold_db: f32,
    },
    RemoveDc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FadeShapeDto {
    Linear,
    Smooth,
    Power,
    Exponential,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizeKind {
    Peak,
    Loudness,
}

/// The engine form of an edit list.
pub fn edit_ops(ops: &[EditOpDto]) -> Vec<mixit_dsp::edit::EditOp> {
    use mixit_dsp::edit::{EditOp as E, FadeShape, NormalizeTo};
    ops.iter()
        .map(|o| match *o {
            EditOpDto::Trim { start, end } => E::Trim { start, end },
            EditOpDto::Delete { start, end } => E::Delete { start, end },
            EditOpDto::Copy { start, end } => E::Copy { start, end },
            EditOpDto::Paste { at } => E::Paste { at },
            EditOpDto::Silence { start, end } => E::Silence { start, end },
            EditOpDto::InsertSilence { at, seconds } => E::InsertSilence { at, seconds },
            EditOpDto::Fade { start, end, fade_in, shape } => E::Fade {
                start,
                end,
                fade_in,
                shape: match shape {
                    FadeShapeDto::Linear => FadeShape::Linear,
                    FadeShapeDto::Smooth => FadeShape::Smooth,
                    FadeShapeDto::Power => FadeShape::Power,
                    FadeShapeDto::Exponential => FadeShape::Exponential,
                },
            },
            EditOpDto::Gain { start, end, db } => E::Gain { start, end, db },
            EditOpDto::Normalize { to: NormalizeKind::Peak, level } => E::Normalize(NormalizeTo::Peak(level.min(0.0))),
            EditOpDto::Normalize { to: NormalizeKind::Loudness, level } => E::Normalize(NormalizeTo::Loudness(level)),
            EditOpDto::Reverse { start, end } => E::Reverse { start, end },
            EditOpDto::TrimSilence { threshold_db } => E::TrimSilence { threshold_db },
            EditOpDto::RemoveDc => E::RemoveDc,
        })
        .collect()
}

/// An edited sound summarised for drawing: its length and min/max pairs per bin.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundViewDto {
    pub seconds: f64,
    pub sample_rate: u32,
    /// `[min, max]` per bin, over the whole sound.
    pub peaks: Vec<[f32; 2]>,
    /// Integrated loudness (LUFS; very low when too short to measure) and peak (dBFS).
    pub lufs: f64,
    pub peak_db: f32,
}

impl SoundViewDto {
    pub fn new(audio: &[f32], sample_rate: u32, bins: usize) -> SoundViewDto {
        let (lufs, peak_db) = mixit_dsp::edit::measure(audio, sample_rate);
        SoundViewDto {
            seconds: audio.len() as f64 / 2.0 / sample_rate as f64,
            sample_rate,
            peaks: mixit_dsp::edit::peaks(audio, bins.clamp(16, 20_000)),
            lufs: if lufs.is_finite() { lufs } else { -99.0 },
            peak_db: if peak_db.is_finite() { peak_db } else { -99.0 },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_defaults_agree_with_the_engine() {
        assert_eq!(studio_dto(&StudioSettings::default()), StudioDto::default());
        assert!(studio_settings(&StudioDto::default()) == StudioSettings::default());
        assert_eq!(
            CompDto::punch(0.3),
            studio_dto(&StudioSettings { comp: CompressorSettings::punch(0.3), ..Default::default() }).comp
        );
    }

    #[test]
    fn edit_steps_parse_from_the_ui() {
        let ops: Vec<EditOpDto> = serde_json::from_str(
            r#"[{"op":"fade","start":0,"end":1,"fadeIn":true,"shape":"power"},
                {"op":"normalize","to":"loudness","level":-14},
                {"op":"insertSilence","at":1,"seconds":0.5},
                {"op":"trimSilence","thresholdDb":-48},
                {"op":"removeDc"}]"#,
        )
        .unwrap();
        assert_eq!(edit_ops(&ops).len(), 5);
        assert_eq!(ops[2], EditOpDto::InsertSilence { at: 1.0, seconds: 0.5 });
        let v = SoundViewDto::new(&[0.5, -0.5, -0.25, 0.25], 48_000, 2);
        assert_eq!(v.peaks.len(), 16);
    }
}

/// The sampler's step sequencer as the UI edits it: one row of steps per pad.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SequencerDto {
    pub on: bool,
    /// Steps in the pattern (1 to 64).
    pub steps: u8,
    /// Length of one step in beats (0.25 = sixteenth notes).
    pub step_beats: f64,
    /// 0 = straight, 0.5 = full triplet feel.
    pub swing: f32,
    /// `pads[p][s]`: whether pad `p` plays on step `s`.
    pub pads: Vec<Vec<bool>>,
}

/// The commands that put a sequencer state on the engine (patterns first, then the
/// settings, so a pattern that starts running is complete on its first step).
pub fn sequencer_commands(d: &SequencerDto, pads: usize) -> Vec<crate::SamplerCommand> {
    let mut out = Vec::with_capacity(pads + 1);
    for pad in 0..pads {
        let mut bits = 0u64;
        if let Some(row) = d.pads.get(pad) {
            for (s, on) in row.iter().enumerate().take(64) {
                if *on {
                    bits |= 1 << s;
                }
            }
        }
        out.push(crate::SamplerCommand::SeqPattern { pad, steps: bits });
    }
    out.push(crate::SamplerCommand::SeqSettings {
        on: d.on,
        steps: if d.steps == 0 { 16 } else { d.steps.min(64) },
        step_beats: if d.step_beats > 0.0 { d.step_beats } else { 0.25 },
        swing: d.swing,
    });
    out
}

#[cfg(test)]
mod sequencer_tests {
    use super::*;
    use crate::SamplerCommand;

    #[test]
    fn a_pattern_becomes_bits_then_settings() {
        let d = SequencerDto {
            on: true,
            steps: 16,
            step_beats: 0.25,
            swing: 0.2,
            pads: vec![vec![true, false, false, false, true], vec![], vec![false, true]],
        };
        let cmds = sequencer_commands(&d, 4);
        assert_eq!(cmds.len(), 5);
        assert!(matches!(cmds[0], SamplerCommand::SeqPattern { pad: 0, steps: 0b10001 }));
        assert!(matches!(cmds[1], SamplerCommand::SeqPattern { pad: 1, steps: 0 }));
        assert!(matches!(cmds[2], SamplerCommand::SeqPattern { pad: 2, steps: 0b10 }));
        assert!(matches!(cmds[4], SamplerCommand::SeqSettings { on: true, steps: 16, .. }));
        let json: SequencerDto = serde_json::from_str(r#"{"on":false,"pads":[[true]]}"#).unwrap();
        assert!(
            matches!(sequencer_commands(&json, 1)[1], SamplerCommand::SeqSettings { steps: 16, step_beats, .. } if step_beats == 0.25)
        );
    }
}
