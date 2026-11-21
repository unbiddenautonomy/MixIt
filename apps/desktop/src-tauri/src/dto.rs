//! What crosses the bridge to the UI. Field names are camelCase for TypeScript; the
//! matching types live in `apps/desktop/src/backend/types.ts`.

use mixit_analysis::{Analysis, CueRole};
use mixit_core::Key;
use mixit_core::key::KeyNotation;
pub use mixit_engine::view::TelemetryDto;
use mixit_library::{Track, suggest::Suggestion};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyDto {
    /// 0..23 (C major = 0 … B minor = 23), stable for colouring.
    pub index: usize,
    pub camelot: String,
    pub open_key: String,
    pub name: String,
}

impl From<Key> for KeyDto {
    fn from(k: Key) -> Self {
        KeyDto {
            index: k.index(),
            camelot: k.display(KeyNotation::Camelot),
            open_key: k.display(KeyNotation::OpenKey),
            name: k.standard_name(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRow {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub label: String,
    pub year: Option<u32>,
    pub duration: f64,
    pub bpm: Option<f64>,
    pub key: Option<KeyDto>,
    pub energy: Option<u8>,
    pub lufs: Option<f64>,
    pub rating: u8,
    pub color: Option<u32>,
    pub play_count: u32,
    pub last_played: Option<i64>,
    pub added_at: i64,
    pub missing: bool,
    /// "pending" | "done" | "failed"
    pub analysis: &'static str,
    pub comment: String,
    /// The file has cover art ([`crate::commands::track_artwork`] reads it).
    pub has_art: bool,
}

impl From<&Track> for TrackRow {
    fn from(t: &Track) -> Self {
        TrackRow {
            id: t.id,
            path: t.path.to_string_lossy().into_owned(),
            title: t.display_title(),
            artist: t.artist.clone(),
            album: t.album.clone(),
            genre: t.genre.clone(),
            label: t.label.clone(),
            year: t.year,
            duration: t.duration,
            bpm: t.best_bpm(),
            key: t.best_key().map(KeyDto::from),
            energy: t.energy,
            lufs: t.lufs,
            rating: t.rating,
            color: t.color,
            play_count: t.play_count,
            last_played: t.last_played,
            added_at: t.added_at,
            missing: t.missing,
            analysis: match t.analysis_state {
                mixit_library::AnalysisState::Pending => "pending",
                mixit_library::AnalysisState::Done => "done",
                mixit_library::AnalysisState::Failed => "failed",
            },
            comment: t.comment.clone(),
            has_art: t.has_artwork,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionDto {
    pub start: f64,
    pub end: f64,
    pub bars: usize,
    pub label: String,
    pub energy: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueDto {
    /// "load" | "mixIn" | "mixOut" | "section" | "hot" | "memory" | "main"
    pub role: String,
    pub slot: Option<u8>,
    pub seconds: f64,
    pub loop_seconds: Option<f64>,
    pub label: String,
    pub color: Option<u32>,
}

/// Everything the deck and track views need about a track's analysis.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDetail {
    pub track: TrackRow,
    pub analysed: bool,
    pub bpm: Option<f64>,
    pub bpm_candidates: Vec<f64>,
    pub tempo_confidence: f32,
    pub drift_ms: f64,
    pub constant_grid: bool,
    /// A locked grid is kept by re-analysis and refuses edits until unlocked.
    pub grid_locked: bool,
    pub beats_per_bar: u32,
    /// Seconds of grid beat 0, and seconds per beat at the start (for drawing beat lines
    /// when the grid is constant; warped grids send `beats`).
    pub first_beat: f64,
    pub beat_period: f64,
    /// Beat times (seconds) for warped grids, every beat.
    pub beats: Vec<f64>,
    pub key: Option<KeyDto>,
    pub key_confidence: f32,
    pub key_second: Option<KeyDto>,
    pub tuning_cents: f32,
    pub lufs: Option<f64>,
    pub true_peak: Option<f32>,
    pub auto_gain_db: Option<f64>,
    pub energy: Option<u8>,
    pub energy_curve: Vec<f32>,
    pub energy_curve_start: f64,
    pub sections: Vec<SectionDto>,
    /// Analysis suggestions followed by the user's saved cues.
    pub cues: Vec<CueDto>,
    pub audible: (f64, f64),
}

impl TrackDetail {
    pub fn new(
        t: &Track,
        a: Option<&Analysis>,
        grid: Option<&mixit_core::Beatgrid>,
        saved: &[mixit_library::Cue],
    ) -> Self {
        let mut d = TrackDetail {
            track: TrackRow::from(t),
            analysed: a.is_some(),
            bpm: t.best_bpm(),
            bpm_candidates: vec![],
            tempo_confidence: 0.0,
            drift_ms: 0.0,
            constant_grid: true,
            grid_locked: false,
            beats_per_bar: 4,
            first_beat: 0.0,
            beat_period: 0.5,
            beats: vec![],
            key: t.best_key().map(KeyDto::from),
            key_confidence: 0.0,
            key_second: None,
            tuning_cents: 0.0,
            lufs: t.lufs,
            true_peak: None,
            auto_gain_db: t.auto_gain_db,
            energy: t.energy,
            energy_curve: vec![],
            energy_curve_start: 0.0,
            sections: vec![],
            cues: vec![],
            audible: (0.0, t.duration),
        };
        if let Some(a) = a {
            let g = grid.unwrap_or(&a.grid);
            let sr = g.sample_rate as f64;
            d.bpm_candidates = a.bpm_candidates.iter().map(|c| c.0).collect();
            d.tempo_confidence = a.tempo_confidence;
            d.drift_ms = a.drift_ms;
            d.constant_grid = g.is_constant();
            d.grid_locked = g.locked;
            d.beats_per_bar = g.beats_per_bar;
            d.first_beat = g.frame_at(0.0) / sr;
            d.beat_period = g.frames_per_beat_at(g.frame_at(0.0)) / sr;
            if !g.is_constant() {
                let b0 = g.beat_at(0.0).ceil() as i64;
                let b1 = g.beat_at(a.duration * sr).floor() as i64;
                d.beats = (b0..=b1).map(|b| g.frame_at(b as f64) / sr).collect();
            }
            if let Some(k) = &a.key {
                d.key_confidence = k.confidence;
                d.key_second = Some(k.second.into());
                d.tuning_cents = k.tuning_cents;
            }
            d.true_peak = Some(a.loudness.true_peak_dbtp);
            d.energy_curve = a.energy_curve.clone();
            d.energy_curve_start = a.energy_curve_start;
            d.sections = a
                .sections
                .iter()
                .map(|s| SectionDto {
                    start: s.start,
                    end: s.end,
                    bars: s.bars,
                    label: s.label.name().into(),
                    energy: s.energy,
                })
                .collect();
            d.audible = a.audible;
            for c in &a.cues {
                let role = match c.role {
                    CueRole::Load => "load",
                    CueRole::MixIn => "mixIn",
                    CueRole::MixOut => "mixOut",
                    CueRole::Section(_) => "section",
                };
                d.cues.push(CueDto {
                    role: role.into(),
                    slot: None,
                    seconds: c.seconds,
                    loop_seconds: c.loop_beats.map(|b| b * d.beat_period),
                    label: c.label.clone(),
                    color: Some(c.color),
                });
            }
        }
        for c in saved {
            let role = match c.kind {
                mixit_library::CueKind::Hot => "hot",
                mixit_library::CueKind::Memory => "memory",
                mixit_library::CueKind::Main => "main",
            };
            d.cues.push(CueDto {
                role: role.into(),
                slot: c.slot,
                seconds: c.seconds,
                loop_seconds: c.loop_seconds,
                label: c.label.clone(),
                color: c.color,
            });
        }
        d
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionRow {
    pub track: TrackRow,
    pub score: f64,
    pub tempo_change_pct: Option<f64>,
    pub key_shift: i32,
    pub reasons: Vec<String>,
    /// Reason codes for icons: "key" | "keyShift" | "clash" | "tempo" | "half" | "double" | "energy" | "genre" | "rating" | "sound"
    pub tags: Vec<&'static str>,
}

impl SuggestionRow {
    pub fn new(s: &Suggestion, t: &Track) -> Self {
        use mixit_library::suggest::Reason as R;
        let tags = s
            .reasons
            .iter()
            .map(|r| match r {
                R::SameKey | R::CompatibleKey | R::EnergyBoostKey => "key",
                R::KeyShift(_) => "keyShift",
                R::KeyClash => "clash",
                R::UnknownKey | R::UnknownTempo => "unknown",
                R::Tempo(_) => "tempo",
                R::HalfTime => "half",
                R::DoubleTime => "double",
                R::EnergyChange(_) => "energy",
                R::SameGenre => "genre",
                R::HighlyRated => "rating",
                R::SoundsAlike(_) => "sound",
            })
            .collect();
        SuggestionRow {
            track: TrackRow::from(t),
            score: s.score,
            tempo_change_pct: s.tempo_change_pct,
            key_shift: s.key_shift,
            reasons: s.reasons.iter().map(|r| r.describe()).collect(),
            tags,
        }
    }
}

/// The track on a deck, as the UI shows it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckInfo {
    pub deck: u8,
    pub token: u64,
    pub detail: TrackDetail,
    pub sample_rate: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub device: String,
    pub is_virtual: bool,
    pub sample_rate: u32,
    pub buffer_frames: Option<u32>,
    pub latency_ms: f32,
    /// Why the real device could not be used, when running virtually.
    pub warning: Option<String>,
}

/// The open input device behind the mic channel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicStatus {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub buffer_frames: Option<u32>,
    pub channel: u16,
    pub stereo: bool,
}

/// A finished mic recording.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicTake {
    pub path: String,
    pub seconds: f64,
}

/// A background job's progress, sent as the "job" event.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    /// "scan" | "analyze" | "render" | "import" | "copy"
    pub kind: &'static str,
    pub done: usize,
    pub total: usize,
    pub message: String,
    pub finished: bool,
    pub error: Option<String>,
}
