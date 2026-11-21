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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryDto {
    pub frame: u64,
    pub decks: Vec<DeckTele>,
    pub master: MasterTele,
    pub mic: MicTele,
    pub clock_bpm: f64,
    pub master_deck: Option<u8>,
    pub recording: bool,
    pub recorded_seconds: f64,
    pub load: f32,
    pub overruns: u64,
    /// Bit n set while pad n plays.
    pub sampler_playing: u32,
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
            clock_bpm: t.clock_bpm,
            master_deck: t.master_deck.map(|d| d.0),
            recording: t.recording,
            recorded_seconds: t.recorded_frames as f64 / sr as f64,
            load,
            overruns,
            sampler_playing: t.sampler_playing,
            spectrum: None,
        }
    }
}

// ------------------------------------------------------------------ studio settings

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BandShapeDto {
    Bell,
    LowShelf,
    HighShelf,
    LowCut,
    HighCut,
    Notch,
    BandPass,
}

impl From<BandShape> for BandShapeDto {
    fn from(s: BandShape) -> Self {
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
}

impl From<BandShapeDto> for BandShape {
    fn from(s: BandShapeDto) -> Self {
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
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BandDto {
    pub enabled: bool,
    pub shape: BandShapeDto,
    pub freq: f32,
    pub q: f32,
    pub gain_db: f32,
    pub slope_db: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompDto {
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub auto_makeup: bool,
    pub sidechain_hpf_hz: f32,
    pub mix: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateDto {
    pub threshold_db: f32,
    pub hysteresis_db: f32,
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub release_ms: f32,
    pub range_db: f32,
}

/// A studio strip's settings as the UI and saved projects see them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioDto {
    pub gate_on: bool,
    pub gate: GateDto,
    pub eq_on: bool,
    pub bands: Vec<BandDto>,
    pub comp_on: bool,
    pub comp: CompDto,
    pub sat_on: bool,
    pub drive_db: f32,
    pub width: f32,
    pub output_db: f32,
}

impl From<&StudioSettings> for StudioDto {
    fn from(s: &StudioSettings) -> Self {
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
                    shape: b.shape.into(),
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

impl From<&StudioDto> for StudioSettings {
    /// Out-of-range values are clamped; missing bands are off.
    fn from(d: &StudioDto) -> Self {
        let mut bands = [BandSettings::default(); MAX_BANDS];
        for (b, x) in bands.iter_mut().zip(&d.bands) {
            let f = |v: f32, lo: f32, hi: f32, def: f32| if v.is_finite() { v.clamp(lo, hi) } else { def };
            *b = BandSettings {
                enabled: x.enabled,
                shape: x.shape.into(),
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

impl Default for StudioDto {
    fn default() -> Self {
        (&StudioSettings::default()).into()
    }
}
