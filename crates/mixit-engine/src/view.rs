//! The engine state the UI shows, in seconds and camelCase. The desktop app and the web
//! build send exactly this, so the TypeScript `Telemetry` type has one source.

use serde::Serialize;

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
        }
    }
}
