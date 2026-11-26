//! Track analysis: everything MixIt needs to know about a track before it is played.
//!
//! [`analyze`] takes decoded stereo audio and returns an [`Analysis`]:
//!
//! * **Tempo and beatgrid**: autocorrelation tempo estimate with a harmonic comb and a
//!   tempo prior, dynamic-programming beat tracking, a sub-millisecond constant grid
//!   fit with BPM snapping, and a warped grid when the tempo drifts.
//! * **Downbeats and phrases**: beat-synchronous harmonic change, kick, crash and
//!   loudness evidence picks beat "one" (and 3/4 vs 4/4); structural novelty aligns
//!   the grid to 8-bar phrases so phrase counters and quantised mixing line up.
//! * **Key**: HPCP chroma with tuning estimation, averaged over three key profiles, plus
//!   key regions for tracks that modulate.
//! * **Loudness**: EBU R128 integrated loudness, range, true peak and the auto-gain
//!   that levels tracks against each other.
//! * **Waveform**: a pyramid of peak/RMS/3-band columns for coloured waveforms.
//! * **Structure**: sections (intro, build-up, drop, breakdown, outro), an energy curve,
//!   an overall 1–10 energy rating and suggested cue points for mixing.
//! * **Sound profile**: tone colour, brightness, balance, punch and groove, for finding
//!   tracks that sound alike (see [`timbre`]).

pub mod finish;
pub mod grid;
pub mod heard;
pub mod key;
pub mod loudness;
pub mod onset;
pub mod prep;
pub mod sections;
pub mod stems;
pub mod stft;
pub mod tempo;
pub mod timbre;
pub mod vocals;
pub mod waveform;

use mixit_core::{Beatgrid, GridAnchor};
use serde::{Deserialize, Serialize};

pub use grid::{BeatModel, Downbeat};
pub use key::{KeyEstimate, KeySegment};
pub use loudness::Loudness;
pub use sections::{Section, SectionLabel};
pub use waveform::{Column, Waveform, WaveformLevel};

/// Bumped whenever results change, so libraries know to re-analyse.
pub const ANALYSIS_VERSION: u32 = 3;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnalysisOptions {
    /// BPM range the tempo must fall in. Wide by default; the tempo prior resolves
    /// half/double ambiguity towards 120.
    pub bpm_range: (f64, f64),
    /// Allow warped (variable tempo) grids for drifting recordings.
    pub allow_warp: bool,
    /// Loudness the auto-gain aims at.
    pub target_lufs: f64,
    pub phrase_bars: u32,
    /// Silence threshold for the audible span (dBFS RMS).
    pub silence_db: f32,
    pub key: bool,
    pub waveform: bool,
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        AnalysisOptions {
            bpm_range: (60.0, 200.0),
            allow_warp: true,
            target_lufs: loudness::DEFAULT_TARGET_LUFS,
            phrase_bars: 8,
            silence_db: -54.0,
            key: true,
            waveform: true,
        }
    }
}

/// What a cue suggestion marks, so the UI can explain it ("Mix in here: the intro is
/// 16 bars of drums only").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CueRole {
    /// Where the track is cued when loaded: its first downbeat.
    Load,
    /// A good point to start bringing this track in.
    MixIn,
    /// A section start.
    Section(SectionLabel),
    /// A good point to start mixing out of this track.
    MixOut,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CueSuggestion {
    /// Track frame at the analysis sample rate.
    pub frame: f64,
    pub seconds: f64,
    /// Loop length in beats for loop suggestions.
    pub loop_beats: Option<f64>,
    pub role: CueRole,
    pub label: String,
    /// 0xRRGGBB.
    pub color: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Analysis {
    pub version: u32,
    pub sample_rate: u32,
    pub duration: f64,
    pub bpm: f64,
    pub grid: Beatgrid,
    /// Other plausible tempos (BPM, relative score), best first.
    pub bpm_candidates: Vec<(f64, f32)>,
    pub tempo_confidence: f32,
    pub downbeat_confidence: f32,
    /// How far the beats wander from a constant tempo (ms); large for live drummers.
    pub drift_ms: f64,
    /// Onset strength on the beat relative to off the beat.
    pub beat_strength: f32,
    /// How strongly the onsets repeat at the beat period (0..1).
    pub pulse_clarity: f32,
    pub key: Option<KeyEstimate>,
    pub key_segments: Vec<KeySegment>,
    pub loudness: Loudness,
    pub waveform: Option<Waveform>,
    /// First and last audible moments (seconds).
    pub audible: (f64, f64),
    pub sections: Vec<Section>,
    /// Per-bar energy 0..1, starting at `energy_curve_start` seconds.
    pub energy_curve: Vec<f32>,
    pub energy_curve_start: f64,
    /// 1 (ambient) … 10 (peak time).
    pub energy: u8,
    pub cues: Vec<CueSuggestion>,
    /// Sound profile for "sounds like" (see [`timbre::profile`]); empty when there is too
    /// little sound, or for analyses made before profiles existed.
    #[serde(default)]
    pub sound: Vec<f32>,
    /// Where the track has singing or rapping (see [`vocals::detect`]).
    #[serde(default)]
    pub vocals: vocals::Vocals,
}

/// Where a track can be mixed, in its own grid beats.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MixPoints {
    /// First downbeat with sound.
    pub first_beat: f64,
    /// Last whole bar with sound ends here.
    pub last_beat: f64,
    /// Where the incoming track should start (its intro phrase).
    pub mix_in: f64,
    /// Where to start mixing out (its outro).
    pub mix_out: f64,
}

impl Analysis {
    /// Whether the track has a usable beat at all (spoken word, ambient, silence do not).
    pub fn is_rhythmic(&self) -> bool {
        self.pulse_clarity > 0.15
    }

    /// Mix points from the cue suggestions, snapped to bars of the grid.
    pub fn mix_points(&self) -> MixPoints {
        let bpb = self.grid.beats_per_bar.max(1) as f64;
        let beat = |seconds: f64| self.grid.beat_at(seconds * self.sample_rate as f64);
        let bar_round = |b: f64| (b / bpb).round() * bpb;
        let cue = |role: CueRole| self.cues.iter().find(|c| c.role == role).map(|c| beat(c.seconds));
        let first = cue(CueRole::Load).map(bar_round).unwrap_or_else(|| bar_round(beat(self.audible.0)).max(0.0));
        let last = ((beat(self.audible.1) / bpb).floor() * bpb).max(first + bpb);
        let mix_in = cue(CueRole::MixIn).map(bar_round).unwrap_or(first).clamp(first, last);
        let mix_out = cue(CueRole::MixOut).map(bar_round).unwrap_or(last).clamp(mix_in, last);
        MixPoints { first_beat: first, last_beat: last, mix_in, mix_out }
    }
}

fn color_for(role: CueRole) -> u32 {
    match role {
        CueRole::Load => 0x2E_CC_71,
        CueRole::MixIn => 0x1A_BC_9C,
        CueRole::MixOut => 0xE6_7E_22,
        CueRole::Section(l) => match l {
            SectionLabel::Intro => 0x34_98_DB,
            SectionLabel::Build => 0xF1_C4_0F,
            SectionLabel::Drop => 0xE7_4C_3C,
            SectionLabel::Breakdown => 0x9B_59_B6,
            SectionLabel::Main => 0x95_A5_A6,
            SectionLabel::Outro => 0x34_49_5E,
        },
    }
}

/// Analyses interleaved stereo audio.
pub fn analyze(interleaved: &[f32], sample_rate: u32, opts: &AnalysisOptions) -> Analysis {
    let sr = sample_rate as f64;
    let frames = interleaved.len() / 2;
    let duration = frames as f64 / sr;
    let loud = loudness::measure(interleaved, sample_rate, opts.target_lufs);
    let wave = opts.waveform.then(|| waveform::waveform(interleaved, sample_rate));
    let audible = waveform::audible_span(interleaved, sample_rate, opts.silence_db)
        .map(|(a, b)| (a as f64 / sr, b as f64 / sr))
        .unwrap_or((0.0, duration));

    let (mono, msr) = prep::analysis_mono(interleaved, sample_rate);
    let spec = stft::stft(&mono, msr, onset::ONSET_WINDOW, onset::ONSET_HOP);
    let ons = onset::onsets_from(&spec);
    let (low, lsr) = key::chroma_signal(&mono, msr);
    let key_chroma = opts.key.then(|| key::chromagram(&low, lsr));
    let beat_chroma = key::chromagram_with(&low, lsr, 2_048, 256, 100.0);

    let key_est = key_chroma.as_ref().map(key::estimate_key);
    let key_segments = match (&key_chroma, &key_est) {
        (Some(c), Some(k)) => key::key_segments(c, 30.0, k.key),
        _ => vec![],
    };

    let phrase_bars = opts.phrase_bars.max(1) as usize;
    let rhythm = grid::rhythm(&ons, opts.bpm_range, opts.allow_warp, audible);
    let Some(r) = rhythm else {
        // No usable pulse: a nominal 120 BPM grid from the start so the decks still work.
        let sound = timbre::profile(&spec, &ons, audible, 0.0, 1.0, loud.range_lu);
        let mut grid = Beatgrid::constant(sample_rate, 120.0, audible.0 * sr);
        grid.confidence = 0.0;
        return Analysis {
            version: ANALYSIS_VERSION,
            sample_rate,
            duration,
            bpm: 120.0,
            grid,
            bpm_candidates: vec![],
            tempo_confidence: 0.0,
            downbeat_confidence: 0.0,
            drift_ms: 0.0,
            beat_strength: 1.0,
            pulse_clarity: 0.0,
            key: key_est,
            key_segments,
            loudness: loud.clone(),
            waveform: wave,
            audible,
            sections: vec![],
            energy_curve: vec![],
            energy_curve_start: audible.0,
            energy: energy_rating(&loud, 0.0, 0.0, 0.0),
            cues: vec![CueSuggestion {
                frame: audible.0 * sr,
                seconds: audible.0,
                loop_beats: None,
                role: CueRole::Load,
                label: "Start".into(),
                color: color_for(CueRole::Load),
            }],
            sound,
            vocals: vocals::detect(&spec, audible),
        };
    };

    let feats = grid::beat_features(&r.model, &ons, &beat_chroma, audible);
    let db = grid::downbeat(&feats);
    let bpb = db.beats_per_bar as i64;
    // First downbeat at (or just before) the start of the music.
    let period = r.model.period_at(audible.0.max(0.0));
    let mut k = r.model.index(audible.0 - 0.25 * period).ceil() as i64;
    while (k - db.phase).rem_euclid(bpb) != 0 {
        k += 1;
    }
    let first_bar_k = k;
    let st =
        sections::structure(&r.model, first_bar_k, db.beats_per_bar, phrase_bars, &spec, &ons, &beat_chroma, audible);
    let k_ref = first_bar_k + st.phrase_offset as i64 * bpb;

    let mut grid = match &r.model {
        BeatModel::Constant { .. } => Beatgrid::constant(sample_rate, r.bpm, r.model.time(k_ref as f64) * sr),
        BeatModel::Warped { anchors } => {
            let mut g = Beatgrid::constant(sample_rate, r.bpm, 0.0);
            g.anchors = anchors.iter().map(|&(k, t)| GridAnchor { frame: t * sr, beat: k - k_ref as f64 }).collect();
            g
        }
    };
    grid.beats_per_bar = db.beats_per_bar;
    grid.phrase_bars = opts.phrase_bars.max(1);
    grid.confidence = r.confidence;

    // Cue suggestions.
    let mut cues = Vec::new();
    let mut cue = |t: f64, role: CueRole, label: &str, loop_beats: Option<f64>| {
        cues.push(CueSuggestion {
            frame: t * sr,
            seconds: t,
            loop_beats,
            role,
            label: label.to_string(),
            color: color_for(role),
        });
    };
    let t_first = r.model.time(first_bar_k as f64);
    cue(t_first, CueRole::Load, "Start", None);
    let phrase_beats = (phrase_bars as i64 * bpb) as f64;
    if let Some(first) = st.sections.first() {
        let intro_like = matches!(first.label, SectionLabel::Intro | SectionLabel::Main);
        if intro_like && first.bars >= 4 {
            cue(first.start, CueRole::MixIn, "Mix in", Some(phrase_beats.min((first.bars as i64 * bpb) as f64)));
        }
    }
    for s in st.sections.iter().skip(1) {
        cue(s.start, CueRole::Section(s.label), s.label.name(), None);
    }
    let last_end = r.model.time((first_bar_k + st.bars as i64 * bpb) as f64);
    let mix_out =
        st.sections.iter().rev().find(|s| s.label == SectionLabel::Outro).map(|s| s.start).unwrap_or_else(|| {
            // No outro found: start of the last section, kept between one and two phrases
            // from the end (long enough to blend, short enough not to cut the track).
            let end_k = r.model.index(last_end);
            let last_k = st.sections.last().map(|s| r.model.index(s.start)).unwrap_or(end_k);
            let k = last_k.clamp(end_k - 2.0 * phrase_beats, end_k - phrase_beats);
            r.model.time(k).max(t_first)
        });
    cue(mix_out, CueRole::MixOut, "Mix out", Some(phrase_beats));
    cues.sort_by(|a, b| a.seconds.partial_cmp(&b.seconds).unwrap());

    let density = {
        let a = (audible.0 * ons.rate) as usize;
        let b = ((audible.1 * ons.rate) as usize).min(ons.full.len());
        if b > a { ons.full[a..b].iter().sum::<f32>() / (b - a) as f32 } else { 0.0 }
    };
    let drop_share = {
        let total: f64 = st.sections.iter().map(|s| s.end - s.start).sum();
        let drops: f64 = st.sections.iter().filter(|s| s.label == SectionLabel::Drop).map(|s| s.end - s.start).sum();
        if total > 0.0 { drops / total } else { 0.0 }
    };
    let sound = timbre::profile(&spec, &ons, audible, r.pulse_clarity, r.beat_strength, loud.range_lu);
    Analysis {
        version: ANALYSIS_VERSION,
        sample_rate,
        duration,
        bpm: r.bpm,
        grid,
        bpm_candidates: r.tempo.candidates.clone(),
        tempo_confidence: r.confidence,
        downbeat_confidence: db.confidence,
        drift_ms: r.drift_ms,
        beat_strength: r.beat_strength,
        pulse_clarity: r.pulse_clarity,
        key: key_est,
        key_segments,
        energy: energy_rating(&loud, density as f64, r.bpm, drop_share),
        loudness: loud,
        waveform: wave,
        audible,
        sections: st.sections,
        energy_curve: st.energy,
        energy_curve_start: t_first,
        cues,
        sound,
        vocals: vocals::detect(&spec, audible),
    }
}

/// Overall energy 1–10 from loudness, onset density, tempo and how much of the track is
/// at full power.
fn energy_rating(l: &Loudness, density: f64, bpm: f64, drop_share: f64) -> u8 {
    let loud = ((l.integrated_lufs + 20.0) / 14.0).clamp(0.0, 1.0);
    let dens = (density / 0.35).clamp(0.0, 1.0);
    let tempo = ((bpm - 80.0) / 70.0).clamp(0.0, 1.0);
    let e = 0.35 * loud + 0.3 * dens + 0.2 * tempo + 0.15 * drop_share.clamp(0.0, 1.0);
    (1.0 + (9.0 * e).round()).clamp(1.0, 10.0) as u8
}
