//! Studio strip settings as saved in projects and sent to the UI (camelCase JSON): a
//! gate, an eight-band parametric EQ, a compressor, saturation, stereo width and output
//! level. The engine converts them to its real-time `StudioSettings` (clamping every
//! value to a safe range), so a project made on one machine sounds the same on another.

use serde::{Deserialize, Serialize};

/// Bands in a strip's EQ.
pub const STRIP_BANDS: usize = 8;

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
#[serde(rename_all = "camelCase", default)]
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

impl Default for BandDto {
    fn default() -> Self {
        BandDto {
            enabled: false,
            shape: BandShapeDto::Bell,
            freq: 1_000.0,
            q: std::f32::consts::FRAC_1_SQRT_2,
            gain_db: 0.0,
            slope_db: 12,
        }
    }
}

impl Default for GateDto {
    fn default() -> Self {
        GateDto {
            threshold_db: -40.0,
            hysteresis_db: 4.0,
            attack_ms: 1.0,
            hold_ms: 30.0,
            release_ms: 100.0,
            range_db: -80.0,
        }
    }
}

impl CompDto {
    /// The one-knob "punch" compressor (the same mapping as the engine's).
    pub fn punch(amount: f32) -> CompDto {
        let a = amount.clamp(0.0, 1.0);
        CompDto {
            threshold_db: -6.0 - 24.0 * a,
            ratio: 1.5 + 4.5 * a,
            knee_db: 6.0,
            attack_ms: 15.0,
            release_ms: 120.0,
            makeup_db: 0.0,
            auto_makeup: true,
            sidechain_hpf_hz: 60.0,
            mix: 1.0,
        }
    }
}

impl Default for CompDto {
    fn default() -> Self {
        CompDto::punch(0.5)
    }
}

/// A transparent strip: EQ on but flat, everything else off.
impl Default for StudioDto {
    fn default() -> Self {
        StudioDto {
            gate_on: false,
            gate: GateDto::default(),
            eq_on: true,
            bands: vec![BandDto::default(); STRIP_BANDS],
            comp_on: false,
            comp: CompDto::default(),
            sat_on: false,
            drive_db: 6.0,
            width: 1.0,
            output_db: 0.0,
        }
    }
}

impl StudioDto {
    /// Whether the strip leaves the sound unchanged (nothing worth saving or sending).
    pub fn is_transparent(&self) -> bool {
        !self.gate_on
            && !self.comp_on
            && !self.sat_on
            && (!self.eq_on || self.bands.iter().all(|b| !b.enabled))
            && (self.width - 1.0).abs() < 1e-4
            && self.output_db.abs() < 1e-4
    }
}
