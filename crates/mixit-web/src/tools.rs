//! Work the page runs in a Web Worker: generating tracks and kit sounds, and analysing
//! audio. Results come back as the same camelCase shapes the desktop app sends.

use mixit_analysis::{Analysis, AnalysisOptions, CueRole};
use mixit_core::Key;
use mixit_core::key::KeyNotation;
use mixit_generator::practice::practice_track;
use mixit_generator::{Section, SectionKind, Style, TrackSpec};
use serde::{Deserialize, Serialize};

use crate::host::parse_camelot;

/// What to generate. Either a practice track by id, or a style, tempo and key.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GenerateRequest {
    pub practice: Option<String>,
    pub style: String,
    pub bpm: f64,
    pub end_bpm: Option<f64>,
    pub camelot: String,
    pub seed: u64,
    pub sample_rate: u32,
    /// About 40 seconds instead of a full arrangement.
    pub short: bool,
    pub lead_in: f64,
    pub swing: f64,
}

impl Default for GenerateRequest {
    fn default() -> Self {
        GenerateRequest {
            practice: None,
            style: "House".into(),
            bpm: 124.0,
            end_bpm: None,
            camelot: "8A".into(),
            seed: 1,
            sample_rate: 48_000,
            short: false,
            lead_in: 0.0,
            swing: 0.0,
        }
    }
}

pub fn style_from(name: &str) -> Style {
    match name.to_ascii_lowercase().as_str() {
        "techno" => Style::Techno,
        "trance" => Style::Trance,
        "dnb" | "drumandbass" | "drum and bass" | "drum & bass" => Style::DrumAndBass,
        "hiphop" | "hip-hop" | "hip hop" => Style::HipHop,
        _ => Style::House,
    }
}

impl GenerateRequest {
    pub fn spec(&self) -> Result<TrackSpec, String> {
        if let Some(id) = &self.practice {
            return practice_track(id)
                .map(|p| p.spec(self.sample_rate))
                .ok_or_else(|| format!("no practice track {id}"));
        }
        let key = parse_camelot(&self.camelot).unwrap_or_else(|| Key::from_camelot(8, 'A').expect("8A"));
        let bpm = if self.bpm.is_finite() { self.bpm.clamp(60.0, 200.0) } else { 124.0 };
        let mut spec = TrackSpec::standard(style_from(&self.style), bpm, key);
        if self.short {
            use SectionKind::*;
            let s = |kind, bars| Section { kind, bars };
            spec.sections = vec![s(Intro, 8), s(Drop, 8), s(Outro, 4)];
        }
        spec.sample_rate = self.sample_rate;
        spec.end_bpm = self.end_bpm;
        spec.lead_in = self.lead_in.max(0.0);
        spec.swing = self.swing.clamp(0.0, 0.6);
        spec.seed = self.seed;
        Ok(spec)
    }
}

/// Generates a track: interleaved stereo at the requested rate.
pub fn generate(req: &GenerateRequest) -> Result<Vec<f32>, String> {
    Ok(mixit_generator::generate(&req.spec()?).audio)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyView {
    pub index: usize,
    pub camelot: String,
    pub open_key: String,
    pub name: String,
}

impl From<Key> for KeyView {
    fn from(k: Key) -> Self {
        KeyView {
            index: k.index(),
            camelot: k.display(KeyNotation::Camelot),
            open_key: k.display(KeyNotation::OpenKey),
            name: k.standard_name(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionView {
    pub start: f64,
    pub end: f64,
    pub bars: usize,
    pub label: String,
    pub energy: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueView {
    pub role: String,
    pub slot: Option<u8>,
    pub seconds: f64,
    pub loop_seconds: Option<f64>,
    pub label: String,
    pub color: Option<u32>,
}

/// The beat grid as the UI's `TrackDetail` describes it, plus the grid itself.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridView {
    pub bpm: f64,
    pub constant_grid: bool,
    pub grid_locked: bool,
    pub beats_per_bar: u32,
    pub first_beat: f64,
    pub beat_period: f64,
    /// Every beat in seconds, only for a warped grid (a constant one is first beat and period).
    pub beats: Vec<f64>,
    /// The beat grid as the engine stores it (opaque to the UI).
    pub grid: mixit_core::Beatgrid,
}

impl GridView {
    pub fn new(g: &mixit_core::Beatgrid, duration: f64) -> GridView {
        let sr = g.sample_rate as f64;
        let beats = if g.is_constant() {
            vec![]
        } else {
            let b0 = g.beat_at(0.0).ceil() as i64;
            let b1 = g.beat_at(duration * sr).floor() as i64;
            (b0..=b1).map(|b| g.frame_at(b as f64) / sr).collect()
        };
        GridView {
            bpm: g.bpm,
            constant_grid: g.is_constant(),
            grid_locked: g.locked,
            beats_per_bar: g.beats_per_bar,
            first_beat: g.frame_at(0.0) / sr,
            beat_period: g.frames_per_beat_at(g.frame_at(0.0)) / sr,
            beats,
            grid: g.clone(),
        }
    }
}

/// The analysed fields of the UI's `TrackDetail`, plus the grid to load the deck with.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisView {
    pub duration: f64,
    #[serde(flatten)]
    pub grid: GridView,
    pub bpm_candidates: Vec<f64>,
    pub tempo_confidence: f32,
    pub drift_ms: f64,
    pub key: Option<KeyView>,
    pub key_confidence: f32,
    pub key_second: Option<KeyView>,
    pub tuning_cents: f32,
    pub lufs: f64,
    pub true_peak: f32,
    pub auto_gain_db: f64,
    pub energy: u8,
    pub energy_curve: Vec<f32>,
    pub energy_curve_start: f64,
    pub sections: Vec<SectionView>,
    pub cues: Vec<CueView>,
    pub audible: (f64, f64),
    /// Where the track has a voice, and the percent of it with one.
    pub vocals: Vec<(f64, f64)>,
    pub vocal_percent: u8,
}

impl AnalysisView {
    pub fn new(a: &Analysis, grid: &mixit_core::Beatgrid) -> AnalysisView {
        let grid = GridView::new(grid, a.duration);
        let beat_period = grid.beat_period;
        AnalysisView {
            duration: a.duration,
            grid,
            bpm_candidates: a.bpm_candidates.iter().map(|c| c.0).collect(),
            tempo_confidence: a.tempo_confidence,
            drift_ms: a.drift_ms,
            key: a.key.as_ref().map(|k| k.key.into()),
            key_confidence: a.key.as_ref().map(|k| k.confidence).unwrap_or(0.0),
            key_second: a.key.as_ref().map(|k| k.second.into()),
            tuning_cents: a.key.as_ref().map(|k| k.tuning_cents).unwrap_or(0.0),
            lufs: a.loudness.integrated_lufs,
            true_peak: a.loudness.true_peak_dbtp,
            auto_gain_db: a.loudness.auto_gain_db,
            energy: a.energy,
            energy_curve: a.energy_curve.clone(),
            energy_curve_start: a.energy_curve_start,
            sections: a
                .sections
                .iter()
                .map(|s| SectionView {
                    start: s.start,
                    end: s.end,
                    bars: s.bars,
                    label: s.label.name().into(),
                    energy: s.energy,
                })
                .collect(),
            cues: a
                .cues
                .iter()
                .map(|c| CueView {
                    role: match c.role {
                        CueRole::Load => "load",
                        CueRole::MixIn => "mixIn",
                        CueRole::MixOut => "mixOut",
                        CueRole::Section(_) => "section",
                    }
                    .into(),
                    slot: None,
                    seconds: c.seconds,
                    loop_seconds: c.loop_beats.map(|b| b * beat_period),
                    label: c.label.clone(),
                    color: Some(c.color),
                })
                .collect(),
            audible: a.audible,
            vocals: a.vocals.regions.clone(),
            vocal_percent: (a.vocals.share * 100.0).round() as u8,
        }
    }
}

/// Analyses interleaved stereo. Returns the view and the waveform in the desktop's
/// binary layout (`[u32 sample rate][u32 frames per column]` then 5 bytes per column).
pub fn analyse(audio: &[f32], sample_rate: u32) -> (AnalysisView, Vec<u8>) {
    let a = mixit_analysis::analyze(audio, sample_rate, &AnalysisOptions::default());
    let view = AnalysisView::new(&a, &a.grid);
    let mut wave = Vec::new();
    if let Some(w) = &a.waveform {
        wave.extend_from_slice(&w.sample_rate.to_le_bytes());
        wave.extend_from_slice(&(w.levels[0].frames_per_column as u32).to_le_bytes());
        wave.extend_from_slice(&w.base_bytes());
    }
    (view, wave)
}

/// A kit sound for a sampler pad, with the tempo it was made at and its suggested mode.
pub fn kit(id: &str, sample_rate: u32) -> Result<(Vec<f32>, Option<f64>, usize), String> {
    let info = mixit_generator::kit::kit_sound_info(id).ok_or_else(|| format!("no kit sound {id}"))?;
    let audio = mixit_generator::kit::kit_sound(id, sample_rate).ok_or_else(|| format!("no kit sound {id}"))?;
    Ok((audio, info.bpm, info.mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_track_analyses_to_its_spec() {
        let req = GenerateRequest {
            bpm: 128.0,
            camelot: "5A".into(),
            short: true,
            sample_rate: 44_100,
            ..Default::default()
        };
        let audio = generate(&req).unwrap();
        let (v, wave) = analyse(&audio, 44_100);
        assert!((v.grid.bpm - 128.0).abs() < 0.2, "bpm {}", v.grid.bpm);
        assert_eq!(v.key.as_ref().map(|k| k.camelot.as_str()), Some("5A"));
        assert!(wave.len() > 8 && (wave.len() - 8) % 5 == 0);
        let json = serde_json::to_value(&v).unwrap();
        // Field names the TypeScript side reads.
        for k in ["bpm", "firstBeat", "beatPeriod", "autoGainDb", "energyCurve", "grid", "keySecond"] {
            assert!(json.get(k).is_some(), "{k}");
        }
    }

    #[test]
    fn practice_tracks_and_kit_sounds_resolve() {
        let req = GenerateRequest { practice: Some("p6".into()), ..Default::default() };
        let spec = req.spec().unwrap();
        assert_eq!(spec.end_bpm, Some(122.0));
        assert!(GenerateRequest { practice: Some("nope".into()), ..Default::default() }.spec().is_err());
        let (a, _, mode) = kit("drum_loop", 48_000).unwrap();
        assert!(!a.is_empty() && mode == 2);
        assert!(kit("nope", 48_000).is_err());
        assert_eq!(style_from("Drum & Bass"), Style::DrumAndBass);
    }
}

#[cfg(test)]
mod practice_keys {
    use super::*;

    /// The guide's labs rely on the practice tracks reading as their listed tempo and key
    /// (Lab 4 is about a deliberate clash; the others must not show one).
    #[test]
    fn practice_tracks_analyse_to_their_listing() {
        for p in mixit_generator::practice::PRACTICE {
            let req = GenerateRequest { practice: Some(p.id.into()), sample_rate: 48_000, ..Default::default() };
            let (v, _) = analyse(&generate(&req).unwrap(), 48_000);
            let camelot = format!("{}{}", p.camelot.0, p.camelot.1);
            assert_eq!(v.key.as_ref().map(|k| k.camelot.as_str()), Some(camelot.as_str()), "{}", p.id);
            assert!((v.grid.bpm - p.bpm).abs() < 0.5 || p.end_bpm.is_some(), "{}: {} BPM", p.id, v.grid.bpm);
        }
    }
}
