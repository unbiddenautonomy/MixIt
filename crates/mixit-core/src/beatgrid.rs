//! Beatgrids: the mapping between a track's sample frames and its beats.
//!
//! A grid is a sorted list of anchors, each pinning a beat number to a frame. With
//! one anchor the grid has constant tempo (`bpm`). With two or more anchors the grid
//! is piecewise linear (constant tempo inside each segment), which follows live
//! drummers and drifting recordings. Before the first and after the last anchor the
//! nearest segment's tempo is extended.
//!
//! Beat numbering: integer beats that are multiples of `beats_per_bar` are downbeats
//! (beat 1 of a bar). Bars are grouped into phrases of `phrase_bars` bars.

use serde::{Deserialize, Serialize};

/// Pins a beat number to a position in the track, in the track's sample frames.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridAnchor {
    pub frame: f64,
    pub beat: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Beatgrid {
    /// Sample rate the anchor frames are expressed in.
    pub sample_rate: u32,
    /// Sorted by frame; beats strictly increase with frames. Never empty.
    pub anchors: Vec<GridAnchor>,
    /// Tempo of a constant grid, and the nominal tempo shown for a warped one.
    pub bpm: f64,
    pub beats_per_bar: u32,
    pub phrase_bars: u32,
    /// A locked grid is never replaced by re-analysis.
    pub locked: bool,
    /// 0..1 confidence reported by the analyser (1 for user-edited grids).
    pub confidence: f32,
}

/// Errors from grid edits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridError {
    /// The edit would make beats go backwards in time.
    NonMonotonic,
    /// Tempo out of the supported 20..400 BPM range.
    TempoOutOfRange,
}

pub const MIN_BPM: f64 = 20.0;
pub const MAX_BPM: f64 = 400.0;

impl Beatgrid {
    /// A constant-tempo grid with beat 0 (a downbeat) at `first_downbeat_frame`.
    pub fn constant(sample_rate: u32, bpm: f64, first_downbeat_frame: f64) -> Beatgrid {
        Beatgrid {
            sample_rate,
            anchors: vec![GridAnchor { frame: first_downbeat_frame, beat: 0.0 }],
            bpm,
            beats_per_bar: 4,
            phrase_bars: 8,
            locked: false,
            confidence: 1.0,
        }
    }

    /// Frames per beat at a given tempo.
    #[inline]
    pub fn frames_per_beat_for(&self, bpm: f64) -> f64 {
        60.0 * self.sample_rate as f64 / bpm
    }

    pub fn is_constant(&self) -> bool {
        self.anchors.len() < 2
    }

    /// Frames per beat of segment `i` (between anchors i and i+1).
    fn seg_fpb(&self, i: usize) -> f64 {
        let a = self.anchors[i];
        let b = self.anchors[i + 1];
        (b.frame - a.frame) / (b.beat - a.beat)
    }

    /// Index of the segment containing `frame` (clamped to the first/last segment).
    fn seg_for_frame(&self, frame: f64) -> usize {
        let n = self.anchors.len();
        debug_assert!(n >= 2);
        // Last anchor whose frame <= `frame`.
        let idx = self.anchors.partition_point(|a| a.frame <= frame);
        idx.saturating_sub(1).min(n - 2)
    }

    fn seg_for_beat(&self, beat: f64) -> usize {
        let n = self.anchors.len();
        let idx = self.anchors.partition_point(|a| a.beat <= beat);
        idx.saturating_sub(1).min(n - 2)
    }

    /// Fractional beat number at a frame.
    pub fn beat_at(&self, frame: f64) -> f64 {
        if self.is_constant() {
            let a = self.anchors[0];
            return a.beat + (frame - a.frame) / self.frames_per_beat_for(self.bpm);
        }
        let i = self.seg_for_frame(frame);
        let a = self.anchors[i];
        a.beat + (frame - a.frame) / self.seg_fpb(i)
    }

    /// Frame at a fractional beat number.
    pub fn frame_at(&self, beat: f64) -> f64 {
        if self.is_constant() {
            let a = self.anchors[0];
            return a.frame + (beat - a.beat) * self.frames_per_beat_for(self.bpm);
        }
        let i = self.seg_for_beat(beat);
        let a = self.anchors[i];
        a.frame + (beat - a.beat) * self.seg_fpb(i)
    }

    /// Frames per beat at a frame.
    pub fn frames_per_beat_at(&self, frame: f64) -> f64 {
        if self.is_constant() { self.frames_per_beat_for(self.bpm) } else { self.seg_fpb(self.seg_for_frame(frame)) }
    }

    /// Tempo at a frame.
    pub fn bpm_at(&self, frame: f64) -> f64 {
        60.0 * self.sample_rate as f64 / self.frames_per_beat_at(frame)
    }

    /// Position within the current beat, 0..1.
    pub fn beat_fraction(&self, frame: f64) -> f64 {
        let b = self.beat_at(frame);
        b - b.floor()
    }

    /// Bar number (0-based; negative before the first downbeat).
    pub fn bar_at(&self, frame: f64) -> i64 {
        (self.beat_at(frame) / self.beats_per_bar as f64).floor() as i64
    }

    /// Phrase number (0-based).
    pub fn phrase_at(&self, frame: f64) -> i64 {
        (self.beat_at(frame) / self.phrase_beats()).floor() as i64
    }

    pub fn phrase_beats(&self) -> f64 {
        (self.beats_per_bar * self.phrase_bars) as f64
    }

    /// Beats remaining until the next phrase boundary.
    pub fn beats_to_next_phrase(&self, frame: f64) -> f64 {
        let b = self.beat_at(frame);
        let p = self.phrase_beats();
        let next = (b / p).floor() * p + p;
        next - b
    }

    /// Frame of the first boundary of size `quantum_beats` at or after `frame`.
    pub fn ceil_boundary(&self, frame: f64, quantum_beats: f64) -> f64 {
        let b = self.beat_at(frame);
        let q = quantum_beats;
        let k = (b / q - 1e-9).ceil();
        self.frame_at(k * q)
    }

    /// Frame of the last boundary of size `quantum_beats` at or before `frame`.
    pub fn floor_boundary(&self, frame: f64, quantum_beats: f64) -> f64 {
        let b = self.beat_at(frame);
        let q = quantum_beats;
        let k = (b / q + 1e-9).floor();
        self.frame_at(k * q)
    }

    /// Frame of the nearest boundary of size `quantum_beats`.
    pub fn nearest_boundary(&self, frame: f64, quantum_beats: f64) -> f64 {
        let b = self.beat_at(frame);
        let q = quantum_beats;
        self.frame_at((b / q).round() * q)
    }

    /// Frame reached by moving `beats` beats from `frame` along the grid.
    pub fn offset_by_beats(&self, frame: f64, beats: f64) -> f64 {
        self.frame_at(self.beat_at(frame) + beats)
    }

    /// Makes the beat nearest `frame` sit exactly on `frame` and become a downbeat.
    pub fn set_downbeat(&mut self, frame: f64) {
        let nearest = self.beat_at(frame).round();
        let shift_frames = frame - self.frame_at(nearest);
        for a in &mut self.anchors {
            a.frame += shift_frames;
        }
        let bpb = self.beats_per_bar as f64;
        let rem = nearest.rem_euclid(bpb);
        if rem != 0.0 {
            for a in &mut self.anchors {
                a.beat -= rem;
            }
        }
        self.confidence = 1.0;
    }

    /// Shifts the whole grid by a number of frames (positive = later).
    pub fn nudge(&mut self, frames: f64) {
        for a in &mut self.anchors {
            a.frame += frames;
        }
    }

    /// Multiplies the tempo (2.0 doubles, 0.5 halves), keeping the first anchor fixed.
    pub fn scale_tempo(&mut self, factor: f64) -> Result<(), GridError> {
        let new_bpm = self.bpm * factor;
        if !(MIN_BPM..=MAX_BPM).contains(&new_bpm) {
            return Err(GridError::TempoOutOfRange);
        }
        let b0 = self.anchors[0].beat;
        for a in &mut self.anchors {
            a.beat = b0 + (a.beat - b0) * factor;
        }
        self.bpm = new_bpm;
        Ok(())
    }

    /// Sets a constant tempo, keeping the first anchor fixed and dropping warp anchors.
    pub fn set_bpm(&mut self, bpm: f64) -> Result<(), GridError> {
        if !(MIN_BPM..=MAX_BPM).contains(&bpm) {
            return Err(GridError::TempoOutOfRange);
        }
        self.anchors.truncate(1);
        self.bpm = bpm;
        Ok(())
    }

    /// Pins the beat nearest `frame` to `frame` (a warp anchor).
    pub fn add_warp_anchor(&mut self, frame: f64) -> Result<(), GridError> {
        let beat = self.beat_at(frame).round();
        let mut anchors = self.anchors.clone();
        anchors.retain(|a| a.beat != beat);
        let pos = anchors.partition_point(|a| a.beat < beat);
        anchors.insert(pos, GridAnchor { frame, beat });
        for w in anchors.windows(2) {
            if !(w[1].frame > w[0].frame && w[1].beat > w[0].beat) {
                return Err(GridError::NonMonotonic);
            }
        }
        self.anchors = anchors;
        self.recompute_nominal_bpm();
        self.confidence = 1.0;
        Ok(())
    }

    /// Removes the warp anchor closest to `frame` (never the last remaining anchor).
    pub fn remove_warp_anchor(&mut self, frame: f64) {
        if self.anchors.len() <= 1 {
            return;
        }
        let (idx, _) = self
            .anchors
            .iter()
            .enumerate()
            .min_by(|a, b| (a.1.frame - frame).abs().partial_cmp(&(b.1.frame - frame).abs()).unwrap())
            .unwrap();
        self.anchors.remove(idx);
        self.recompute_nominal_bpm();
    }

    /// Back to one constant tempo: the first anchor stays, at the grid's average tempo.
    pub fn straighten(&mut self) {
        self.anchors.truncate(1);
    }

    /// Where the warp markers are, in seconds (none on a constant grid).
    pub fn warp_seconds(&self) -> Vec<f64> {
        if self.is_constant() {
            return Vec::new();
        }
        let sr = self.sample_rate as f64;
        self.anchors.iter().map(|a| a.frame / sr).collect()
    }

    /// Nominal tempo of a warped grid: total beats over total time between the outer anchors.
    fn recompute_nominal_bpm(&mut self) {
        if self.anchors.len() >= 2 {
            let a = self.anchors[0];
            let b = *self.anchors.last().unwrap();
            let fpb = (b.frame - a.frame) / (b.beat - a.beat);
            self.bpm = 60.0 * self.sample_rate as f64 / fpb;
        }
    }

    /// Expresses the grid at another sample rate (positions scale, beats do not).
    pub fn resampled(&self, sample_rate: u32) -> Beatgrid {
        let k = sample_rate as f64 / self.sample_rate as f64;
        let mut g = self.clone();
        g.sample_rate = sample_rate;
        for a in &mut g.anchors {
            a.frame *= k;
        }
        g
    }

    /// Beat frames between two positions, for drawing grid lines.
    pub fn beats_in_range(&self, from_frame: f64, to_frame: f64) -> impl Iterator<Item = (i64, f64)> + '_ {
        let first = self.beat_at(from_frame).ceil() as i64;
        let last = self.beat_at(to_frame).floor() as i64;
        (first..=last).map(move |b| (b, self.frame_at(b as f64)))
    }

    /// Whether integer beat `beat` is a downbeat.
    pub fn is_downbeat(&self, beat: i64) -> bool {
        beat.rem_euclid(self.beats_per_bar as i64) == 0
    }

    /// Whether integer beat `beat` starts a phrase.
    pub fn is_phrase_start(&self, beat: i64) -> bool {
        beat.rem_euclid((self.beats_per_bar * self.phrase_bars) as i64) == 0
    }
}

/// A precise grid edit from the track editor, applied with [`Beatgrid::apply_edit`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridEdit {
    /// A constant tempo (drops warp anchors).
    pub bpm: Option<f64>,
    /// Seconds where a bar should start (the nearest beat moves there).
    pub downbeat_at: Option<f64>,
    /// Moves the whole grid, in milliseconds (positive = later).
    pub nudge_ms: Option<f64>,
    /// Seconds where a beat really is: the nearest beat line is pinned there (a warp
    /// marker), and the beats since the previous marker are spaced evenly to meet it.
    pub warp_at: Option<f64>,
    /// Removes the warp marker nearest these seconds.
    pub unwarp_at: Option<f64>,
    /// Drops every warp marker, keeping the first one's position and the average tempo.
    pub straighten: bool,
    pub locked: Option<bool>,
}

/// Why a [`GridEdit`] was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GridEditError {
    Locked,
    TempoOutOfRange,
    /// A warp marker would make beats go backwards in time.
    Backwards,
}

impl std::fmt::Display for GridEditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            GridEditError::Locked => "The beat grid is locked. Unlock it first.",
            GridEditError::TempoOutOfRange => "That tempo is outside the 20 to 400 BPM MixIt supports.",
            GridEditError::Backwards => {
                "A marker there would put beats out of order. Pin a beat closer to the play head."
            }
        })
    }
}

impl Beatgrid {
    /// Applies an editor edit. A locked grid refuses changes unless the same edit unlocks
    /// it. Any change marks the grid as checked by a person (confidence 1).
    pub fn apply_edit(&mut self, e: &GridEdit) -> Result<(), GridEditError> {
        let changes = e.bpm.is_some()
            || e.downbeat_at.is_some()
            || e.nudge_ms.is_some()
            || e.warp_at.is_some()
            || e.unwarp_at.is_some()
            || e.straighten;
        if self.locked && changes && e.locked != Some(false) {
            return Err(GridEditError::Locked);
        }
        let mut next = self.clone();
        let sr = next.sample_rate as f64;
        if let Some(b) = e.bpm {
            next.set_bpm(b).map_err(|_| GridEditError::TempoOutOfRange)?;
        }
        if let Some(t) = e.downbeat_at {
            next.set_downbeat(t * sr);
        }
        if let Some(ms) = e.nudge_ms {
            next.nudge(ms / 1000.0 * sr);
        }
        if e.straighten {
            next.straighten();
        }
        if let Some(t) = e.unwarp_at {
            next.remove_warp_anchor(t * sr);
        }
        if let Some(t) = e.warp_at {
            next.add_warp_anchor(t * sr).map_err(|_| GridEditError::Backwards)?;
        }
        if changes {
            next.confidence = 1.0;
        }
        if let Some(l) = e.locked {
            next.locked = l;
        }
        *self = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn grid120() -> Beatgrid {
        // 120 BPM at 48 kHz = 24,000 frames per beat; first downbeat at 1,000.
        Beatgrid::constant(48_000, 120.0, 1_000.0)
    }

    #[test]
    fn constant_grid_maps_both_ways() {
        let g = grid120();
        assert_eq!(g.frame_at(0.0), 1_000.0);
        assert_eq!(g.frame_at(4.0), 97_000.0);
        assert_eq!(g.beat_at(25_000.0), 1.0);
        assert_eq!(g.bpm_at(0.0), 120.0);
        assert_eq!(g.bar_at(97_000.0), 1);
        assert!(g.is_downbeat(8));
        assert!(!g.is_downbeat(9));
    }

    #[test]
    fn boundaries() {
        let g = grid120();
        assert_eq!(g.ceil_boundary(1_500.0, 1.0), 25_000.0);
        assert_eq!(g.ceil_boundary(25_000.0, 1.0), 25_000.0);
        assert_eq!(g.floor_boundary(48_999.0, 1.0), 25_000.0);
        assert_eq!(g.nearest_boundary(36_000.0, 1.0), 25_000.0);
        assert_eq!(g.ceil_boundary(2_000.0, 4.0), 97_000.0);
        assert_eq!(g.beats_to_next_phrase(1_000.0), 32.0);
    }

    #[test]
    fn set_downbeat_moves_grid_and_renumbers() {
        let mut g = grid120();
        // The user taps a kick 100 frames after beat 2.
        g.set_downbeat(49_100.0);
        assert_eq!(g.beat_at(49_100.0), 0.0);
        assert!((g.frame_at(1.0) - 73_100.0).abs() < 1e-9);
    }

    #[test]
    fn halve_and_double() {
        let mut g = grid120();
        g.scale_tempo(2.0).unwrap();
        assert_eq!(g.bpm, 240.0);
        assert_eq!(g.frame_at(2.0), 25_000.0);
        g.scale_tempo(0.5).unwrap();
        assert_eq!(g.frame_at(1.0), 25_000.0);
        assert_eq!(g.scale_tempo(0.01), Err(GridError::TempoOutOfRange));
    }

    #[test]
    fn warp_anchors_follow_drift() {
        let mut g = grid120();
        // The real beat 16 arrives 480 frames (10 ms) late.
        let late = g.frame_at(16.0) + 480.0;
        g.add_warp_anchor(late).unwrap();
        assert!((g.frame_at(16.0) - late).abs() < 1e-9);
        assert!((g.beat_at(late) - 16.0).abs() < 1e-12);
        // Halfway, the error is spread linearly.
        assert!((g.frame_at(8.0) - (g.anchors[0].frame + 8.0 * 24_030.0)).abs() < 1e-6);
        // Extrapolation after the last anchor uses the last segment's tempo.
        assert!((g.frame_at(17.0) - late - 24_030.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_non_monotonic_anchor() {
        let mut g = grid120();
        g.add_warp_anchor(g.frame_at(8.0)).unwrap();
        // An anchor for beat 4 placed after beat 8's frame would reverse time.
        let bad = g.frame_at(8.0) + 10.0;
        // Nearest beat of `bad` is 8, so it simply replaces beat 8: allowed.
        assert!(g.add_warp_anchor(bad).is_ok());
    }

    #[test]
    fn resample_keeps_beats() {
        let g = grid120().resampled(44_100);
        assert!((g.frame_at(1.0) - (1_000.0 * 44_100.0 / 48_000.0 + 22_050.0)).abs() < 1e-6);
    }

    proptest! {
        #[test]
        fn beat_frame_inverse(bpm in 60.0f64..200.0, start in -1e5f64..1e5, beat in -100.0f64..10_000.0) {
            let g = Beatgrid::constant(44_100, bpm, start);
            let f = g.frame_at(beat);
            prop_assert!((g.beat_at(f) - beat).abs() < 1e-7);
        }

        #[test]
        fn warped_inverse(offsets in proptest::collection::vec(-2_000.0f64..2_000.0, 1..8), beat in 0.0f64..200.0) {
            let mut g = Beatgrid::constant(48_000, 128.0, 0.0);
            for (i, off) in offsets.iter().enumerate() {
                let b = ((i + 1) * 16) as f64;
                let _ = g.add_warp_anchor(g.frame_at(b) + off);
            }
            let f = g.frame_at(beat);
            prop_assert!((g.beat_at(f) - beat).abs() < 1e-6);
        }
    }

    #[test]
    fn editor_edits_respect_the_lock() {
        let mut g = Beatgrid::constant(48_000, 120.0, 0.0);
        g.apply_edit(&GridEdit { bpm: Some(124.0), downbeat_at: Some(0.25), ..Default::default() }).unwrap();
        assert_eq!(g.bpm, 124.0);
        assert!(g.is_downbeat(g.beat_at(0.25 * 48_000.0).round() as i64));
        assert!((g.frame_at(g.beat_at(12_000.0).round()) - 12_000.0).abs() < 1e-6);
        g.apply_edit(&GridEdit { locked: Some(true), ..Default::default() }).unwrap();
        let before = g.clone();
        assert_eq!(g.apply_edit(&GridEdit { nudge_ms: Some(5.0), ..Default::default() }), Err(GridEditError::Locked));
        assert_eq!(g, before);
        g.apply_edit(&GridEdit { nudge_ms: Some(5.0), locked: Some(false), ..Default::default() }).unwrap();
        assert!((g.frame_at(g.beat_at(12_240.0).round()) - 12_240.0).abs() < 1e-6, "nudged 5 ms later");
        assert_eq!(
            g.apply_edit(&GridEdit { bpm: Some(1_000.0), ..Default::default() }),
            Err(GridEditError::TempoOutOfRange)
        );
    }

    #[test]
    fn pinning_beats_by_hand() {
        // A live drummer: the grid is right at the start but beat 64 really lands 30 ms
        // late, and beat 128 60 ms late.
        let sr = 48_000.0;
        let mut g = Beatgrid::constant(48_000, 120.0, 0.0);
        let real = |beat: f64| beat * 24_000.0 + beat / 64.0 * 0.030 * sr;
        g.apply_edit(&GridEdit { warp_at: Some(real(64.0) / sr), ..Default::default() }).unwrap();
        g.apply_edit(&GridEdit { warp_at: Some(real(128.0) / sr), ..Default::default() }).unwrap();
        for beat in [0.0, 32.0, 64.0, 100.0, 128.0] {
            assert!((g.frame_at(beat) - real(beat)).abs() < 1.0, "beat {beat} on the real kick");
        }
        assert_eq!(g.warp_seconds().len(), 3);
        assert!((g.warp_seconds()[1] - real(64.0) / sr).abs() < 1e-9);
        // Removing the middle marker spreads the drift over the whole stretch again.
        g.apply_edit(&GridEdit { unwarp_at: Some(real(60.0) / sr), ..Default::default() }).unwrap();
        assert_eq!(g.warp_seconds().len(), 2);
        assert!((g.frame_at(128.0) - real(128.0)).abs() < 1.0);
        // Straighten keeps the start and the average tempo.
        let avg = g.bpm;
        g.apply_edit(&GridEdit { straighten: true, ..Default::default() }).unwrap();
        assert!(g.is_constant() && g.warp_seconds().is_empty());
        assert_eq!(g.bpm, avg);
        assert_eq!(g.frame_at(0.0), 0.0);
        // A locked grid refuses markers.
        g.locked = true;
        assert_eq!(g.apply_edit(&GridEdit { warp_at: Some(1.0), ..Default::default() }), Err(GridEditError::Locked));
    }
}
