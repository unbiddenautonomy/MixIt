//! Mix projects: a prepared or recorded DJ mix as an editable timeline.
//!
//! A project places [`Clip`]s (tracks) on a beat timeline governed by a master
//! [`TempoMap`]. Each clip plays a range of its track, beat-aligned through the track's
//! beatgrid, on one of up to four decks, with automation lanes for its fader, EQ,
//! filter and effect. [`transition`] writes the automation for classic DJ transitions
//! (blend, bass swap, filter fade, echo out, cut, brake), [`automix`] lays out a whole
//! set from analysed tracks (phrase-aligned, tempo ramps, key shifts for harmonic
//! mixing), and [`Editor`] adds undo and redo. Rendering to audio lives in the native
//! host (it drives the real engine), so the result sounds exactly like playing live.

pub mod automix;
pub mod transition;

use mixit_core::tempo_map::{TempoSegment, TimeSignature};
use mixit_core::{Key, TempoMap};
use serde::{Deserialize, Serialize};

pub use transition::TransitionKind;

pub const PROJECT_VERSION: u32 = 1;
pub const MAX_LANES: u8 = 4;
/// EQ value that counts as "killed" (the DJ EQ's floor).
pub const EQ_CUT_DB: f32 = -26.0;

/// Identifies a track independently of where its file is.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackRef {
    /// Content hash (hex) when known; preferred for finding the file.
    pub hash: Option<String>,
    /// Last known path.
    pub path: Option<String>,
    pub title: String,
    pub artist: String,
    pub bpm: f64,
    pub key: Option<Key>,
    pub duration: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Param {
    /// Channel fader position 0..1.
    Volume,
    /// EQ bands in dB (−26 … +6).
    EqLow,
    EqMid,
    EqHigh,
    /// DJ filter −1 (low-pass) … 0 (off) … +1 (high-pass).
    Filter,
    /// Effect wet/dry 0..1 (0 = effect off).
    FxMix,
}

impl Param {
    pub const ALL: [Param; 6] = [Param::Volume, Param::EqLow, Param::EqMid, Param::EqHigh, Param::Filter, Param::FxMix];

    pub fn default_value(self) -> f32 {
        match self {
            Param::Volume => 1.0,
            _ => 0.0,
        }
    }

    pub fn range(self) -> (f32, f32) {
        match self {
            Param::Volume | Param::FxMix => (0.0, 1.0),
            Param::EqLow | Param::EqMid | Param::EqHigh => (EQ_CUT_DB, 6.0),
            Param::Filter => (-1.0, 1.0),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Param::Volume => "Volume",
            Param::EqLow => "Low",
            Param::EqMid => "Mid",
            Param::EqHigh => "High",
            Param::Filter => "Filter",
            Param::FxMix => "Effect",
        }
    }
}

/// How the value moves from a point to the next one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Curve {
    #[default]
    Linear,
    /// S-shaped (smoothstep): eases in and out.
    Smooth,
    /// Equal-power fade shape (for volume crossfades).
    Power,
    /// Stays at this point's value until the next point (a step).
    Hold,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    /// Timeline beat.
    pub beat: f64,
    pub value: f32,
    pub curve: Curve,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lane {
    pub param: Param,
    /// Sorted by beat.
    pub points: Vec<Point>,
}

impl Lane {
    pub fn new(param: Param) -> Lane {
        Lane { param, points: vec![] }
    }

    pub fn value_at(&self, beat: f64) -> f32 {
        let p = &self.points;
        if p.is_empty() {
            return self.param.default_value();
        }
        let i = p.partition_point(|x| x.beat <= beat);
        if i == 0 {
            return p[0].value;
        }
        if i == p.len() {
            return p[i - 1].value;
        }
        let (a, b) = (p[i - 1], p[i]);
        let span = b.beat - a.beat;
        let t = if span > 0.0 { ((beat - a.beat) / span).clamp(0.0, 1.0) as f32 } else { 1.0 };
        let shaped = match a.curve {
            Curve::Linear => t,
            Curve::Smooth => t * t * (3.0 - 2.0 * t),
            Curve::Hold => 0.0,
            Curve::Power => {
                // Equal-power: fade-outs follow cos, fade-ins sin.
                let x = t * std::f32::consts::FRAC_PI_2;
                if b.value >= a.value { x.sin() } else { 1.0 - x.cos() }
            }
        };
        a.value + (b.value - a.value) * shaped
    }

    /// Inserts or replaces a point (same beat), keeping order.
    pub fn set_point(&mut self, pt: Point) {
        let (lo, hi) = self.param.range();
        let pt = Point { value: pt.value.clamp(lo, hi), ..pt };
        match self.points.iter().position(|p| (p.beat - pt.beat).abs() < 1e-9) {
            Some(i) => self.points[i] = pt,
            None => {
                let i = self.points.partition_point(|p| p.beat < pt.beat);
                self.points.insert(i, pt);
            }
        }
    }

    /// Removes points in [from, to].
    pub fn clear_range(&mut self, from: f64, to: f64) {
        self.points.retain(|p| p.beat < from - 1e-9 || p.beat > to + 1e-9);
    }

    pub fn shift(&mut self, beats: f64) {
        for p in &mut self.points {
            p.beat += beats;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClipFx {
    /// Index into `mixit_dsp::fx::FxKind::ALL`.
    pub kind: usize,
    /// Effect time in beats (echo length, gate rate…).
    pub beats: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    pub id: u64,
    pub track: TrackRef,
    /// Deck the clip plays on (0..4).
    pub lane: u8,
    /// Timeline beat where the clip starts.
    pub start: f64,
    /// Length on the timeline (beats).
    pub length: f64,
    /// The track's grid beat heard at `start`.
    pub source_start: f64,
    /// Pitch shift in semitones (keylock keeps tempo and key independent).
    pub key_shift: f32,
    pub keylock: bool,
    pub gain_db: f32,
    pub lanes: Vec<Lane>,
    pub fx: Option<ClipFx>,
    pub name: String,
}

impl Clip {
    pub fn end(&self) -> f64 {
        self.start + self.length
    }

    /// The track grid beat heard at a timeline beat.
    pub fn source_beat(&self, timeline_beat: f64) -> f64 {
        self.source_start + (timeline_beat - self.start)
    }

    pub fn lane(&self, p: Param) -> Option<&Lane> {
        self.lanes.iter().find(|l| l.param == p)
    }

    pub fn lane_mut(&mut self, p: Param) -> &mut Lane {
        if let Some(i) = self.lanes.iter().position(|l| l.param == p) {
            return &mut self.lanes[i];
        }
        self.lanes.push(Lane::new(p));
        self.lanes.last_mut().unwrap()
    }

    pub fn value_at(&self, p: Param, beat: f64) -> f32 {
        self.lane(p).map(|l| l.value_at(beat)).unwrap_or(p.default_value())
    }

    /// Whether the clip sounds at a timeline beat.
    pub fn is_active(&self, beat: f64) -> bool {
        beat >= self.start && beat < self.end()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub beat: f64,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MixProject {
    pub version: u32,
    pub name: String,
    pub tempo: TempoMap,
    pub clips: Vec<Clip>,
    pub markers: Vec<Marker>,
    pub master_gain_db: f32,
    next_id: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProjectError {
    NoSuchClip(u64),
    Invalid(&'static str),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::NoSuchClip(id) => write!(f, "no clip {id}"),
            ProjectError::Invalid(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for ProjectError {}

impl MixProject {
    pub fn new(name: &str, bpm: f64) -> MixProject {
        MixProject {
            version: PROJECT_VERSION,
            name: name.to_string(),
            tempo: TempoMap::constant(bpm),
            clips: vec![],
            markers: vec![],
            master_gain_db: 0.0,
            next_id: 1,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("projects always serialise")
    }

    pub fn from_json(s: &str) -> Result<MixProject, serde_json::Error> {
        let mut p: MixProject = serde_json::from_str(s)?;
        p.tempo.rebuild();
        p.next_id = p.next_id.max(p.clips.iter().map(|c| c.id + 1).max().unwrap_or(1));
        Ok(p)
    }

    /// The part of the project between two beats as a project of its own, starting at
    /// beat 0: clips cut to the window (their source start moved so they still play the
    /// same music), automation, markers and the tempo map shifted. Used to preview a
    /// passage without rendering the whole mix.
    pub fn excerpt(&self, from: f64, to: f64) -> MixProject {
        let from = from.max(0.0);
        let to = to.max(from + 1.0);
        let mut segs: Vec<TempoSegment> = Vec::new();
        let all = self.tempo.segments();
        for (i, s) in all.iter().enumerate() {
            let next_start = all.get(i + 1).map(|n| n.start_beat).unwrap_or(f64::INFINITY);
            if next_start <= from || s.start_beat >= to {
                continue;
            }
            let start = s.start_beat.max(from);
            segs.push(TempoSegment {
                start_beat: start - from,
                bpm: self.tempo.bpm_at_beat(start),
                end_bpm: s.end_bpm,
            });
        }
        let mut tempo = self.tempo.clone();
        tempo.set_segments(segs);
        let shift = from.floor() as i64;
        let mut sigs: Vec<TimeSignature> = Vec::new();
        for ts in &self.tempo.time_signatures {
            if (ts.start_beat as f64) <= from {
                sigs = vec![TimeSignature { start_beat: 0, ..*ts }];
            } else if (ts.start_beat as f64) < to {
                sigs.push(TimeSignature { start_beat: ts.start_beat - shift, ..*ts });
            }
        }
        tempo.time_signatures = sigs;
        tempo.rebuild();

        let clips = self
            .clips
            .iter()
            .filter(|c| c.start < to && c.end() > from)
            .map(|c| {
                let mut c = c.clone();
                if c.start < from {
                    c.source_start = c.source_beat(from);
                    c.length -= from - c.start;
                    c.start = from;
                }
                c.length = c.length.min(to - c.start);
                c.start -= from;
                for l in &mut c.lanes {
                    l.shift(-from);
                }
                c
            })
            .collect();
        let markers = self
            .markers
            .iter()
            .filter(|m| m.beat >= from && m.beat < to)
            .map(|m| Marker { beat: m.beat - from, label: m.label.clone() })
            .collect();
        MixProject {
            version: self.version,
            name: self.name.clone(),
            tempo,
            clips,
            markers,
            master_gain_db: self.master_gain_db,
            next_id: self.next_id,
        }
    }

    /// Adds a clip and returns its id.
    pub fn add_clip(&mut self, mut clip: Clip) -> u64 {
        clip.id = self.next_id;
        self.next_id += 1;
        clip.lane = clip.lane.min(MAX_LANES - 1);
        let id = clip.id;
        self.clips.push(clip);
        self.sort();
        id
    }

    fn sort(&mut self) {
        self.clips.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap().then(a.id.cmp(&b.id)));
    }

    pub fn clip(&self, id: u64) -> Result<&Clip, ProjectError> {
        self.clips.iter().find(|c| c.id == id).ok_or(ProjectError::NoSuchClip(id))
    }

    pub fn clip_mut(&mut self, id: u64) -> Result<&mut Clip, ProjectError> {
        self.clips.iter_mut().find(|c| c.id == id).ok_or(ProjectError::NoSuchClip(id))
    }

    pub fn remove_clip(&mut self, id: u64) -> Result<Clip, ProjectError> {
        let i = self.clips.iter().position(|c| c.id == id).ok_or(ProjectError::NoSuchClip(id))?;
        Ok(self.clips.remove(i))
    }

    /// Moves a clip on the timeline (its automation moves with it).
    pub fn move_clip(&mut self, id: u64, new_start: f64, lane: Option<u8>) -> Result<(), ProjectError> {
        let c = self.clip_mut(id)?;
        let d = new_start - c.start;
        c.start = new_start;
        for l in &mut c.lanes {
            l.shift(d);
        }
        if let Some(l) = lane {
            c.lane = l.min(MAX_LANES - 1);
        }
        self.sort();
        Ok(())
    }

    /// Trims the clip's start (keeping the audio in place) and/or end.
    pub fn trim_clip(&mut self, id: u64, new_start: Option<f64>, new_end: Option<f64>) -> Result<(), ProjectError> {
        let c = self.clip_mut(id)?;
        let end = new_end.unwrap_or(c.end());
        if let Some(s) = new_start {
            c.source_start += s - c.start;
            c.start = s;
        }
        if end <= c.start {
            return Err(ProjectError::Invalid("clip would have no length"));
        }
        c.length = end - c.start;
        self.sort();
        Ok(())
    }

    /// Splits a clip at a timeline beat; returns the id of the right half.
    pub fn split_clip(&mut self, id: u64, at: f64) -> Result<u64, ProjectError> {
        let c = self.clip(id)?.clone();
        if at <= c.start || at >= c.end() {
            return Err(ProjectError::Invalid("split point is outside the clip"));
        }
        let mut right = c.clone();
        right.source_start = c.source_beat(at);
        right.start = at;
        right.length = c.end() - at;
        for l in &mut right.lanes {
            let v = l.value_at(at);
            l.points.retain(|p| p.beat >= at);
            l.set_point(Point { beat: at, value: v, curve: Curve::Linear });
        }
        let left = self.clip_mut(id)?;
        left.length = at - left.start;
        for l in &mut left.lanes {
            let v = l.value_at(at);
            l.points.retain(|p| p.beat <= at);
            l.set_point(Point { beat: at, value: v, curve: Curve::Hold });
        }
        Ok(self.add_clip(right))
    }

    /// Clips sounding at a timeline beat.
    pub fn active_clips(&self, beat: f64) -> impl Iterator<Item = &Clip> {
        self.clips.iter().filter(move |c| c.is_active(beat))
    }

    /// Length of the mix in beats.
    pub fn length_beats(&self) -> f64 {
        self.clips.iter().map(|c| c.end()).fold(0.0, f64::max)
    }

    pub fn length_seconds(&self) -> f64 {
        self.tempo.seconds_at_beat(self.length_beats())
    }

    /// Problems worth showing the user: overlapping clips on one deck, too many decks
    /// at once, key clashes in overlaps, tempo stretched beyond what sounds natural.
    pub fn check(&self) -> Vec<Issue> {
        let mut out = Vec::new();
        for (i, a) in self.clips.iter().enumerate() {
            for b in self.clips.iter().skip(i + 1) {
                let (s, e) = (a.start.max(b.start), a.end().min(b.end()));
                if e <= s {
                    continue;
                }
                if a.lane == b.lane {
                    out.push(Issue::LaneOverlap { a: a.id, b: b.id });
                }
                if let (Some(ka), Some(kb)) = (a.track.key, b.track.key) {
                    let ka = ka.transposed(a.key_shift.round() as i32);
                    let kb = kb.transposed(b.key_shift.round() as i32);
                    if !ka.is_compatible(kb) {
                        out.push(Issue::KeyClash { a: a.id, b: b.id });
                    }
                }
            }
            if a.track.bpm > 0.0 {
                let mid = a.start + a.length * 0.5;
                let stretch = self.tempo.bpm_at_beat(mid) / a.track.bpm;
                if !(0.92..=1.08).contains(&stretch)
                    && !(0.46..=0.54).contains(&stretch)
                    && !(1.84..=2.16).contains(&stretch)
                {
                    out.push(Issue::TempoStretch { clip: a.id, percent: (stretch - 1.0) * 100.0 });
                }
            }
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Issue {
    LaneOverlap { a: u64, b: u64 },
    KeyClash { a: u64, b: u64 },
    TempoStretch { clip: u64, percent: f64 },
}

/// Undo/redo around a project. Edits are snapshots (projects are small), which makes
/// every operation undoable without writing inverse operations.
#[derive(Clone, Debug)]
pub struct Editor {
    pub doc: MixProject,
    undo: Vec<(String, MixProject)>,
    redo: Vec<(String, MixProject)>,
    /// Label of the last edit if it may be merged with the next (dragging a fader).
    open_gesture: Option<String>,
    pub max_history: usize,
    dirty: bool,
}

impl Editor {
    pub fn new(doc: MixProject) -> Editor {
        Editor { doc, undo: vec![], redo: vec![], open_gesture: None, max_history: 500, dirty: false }
    }

    /// Applies an edit. On error the document is left unchanged.
    pub fn edit<T>(
        &mut self,
        label: &str,
        f: impl FnOnce(&mut MixProject) -> Result<T, ProjectError>,
    ) -> Result<T, ProjectError> {
        let before = self.doc.clone();
        match f(&mut self.doc) {
            Ok(v) => {
                self.push(label, before, false);
                Ok(v)
            }
            Err(e) => {
                self.doc = before;
                Err(e)
            }
        }
    }

    /// Like [`Editor::edit`], but consecutive calls with the same label merge into one
    /// undo step until [`Editor::end_gesture`] (for drags and knob turns).
    pub fn gesture<T>(
        &mut self,
        label: &str,
        f: impl FnOnce(&mut MixProject) -> Result<T, ProjectError>,
    ) -> Result<T, ProjectError> {
        let before = self.doc.clone();
        match f(&mut self.doc) {
            Ok(v) => {
                self.push(label, before, true);
                Ok(v)
            }
            Err(e) => {
                self.doc = before;
                Err(e)
            }
        }
    }

    pub fn end_gesture(&mut self) {
        self.open_gesture = None;
    }

    fn push(&mut self, label: &str, before: MixProject, gesture: bool) {
        self.dirty = true;
        self.redo.clear();
        if gesture && self.open_gesture.as_deref() == Some(label) {
            return; // merged into the step already on the stack
        }
        self.open_gesture = gesture.then(|| label.to_string());
        self.undo.push((label.to_string(), before));
        if self.undo.len() > self.max_history {
            self.undo.remove(0);
        }
    }

    pub fn undo(&mut self) -> Option<String> {
        self.open_gesture = None;
        let (label, prev) = self.undo.pop()?;
        let cur = std::mem::replace(&mut self.doc, prev);
        self.redo.push((label.clone(), cur));
        self.dirty = true;
        Some(label)
    }

    pub fn redo(&mut self) -> Option<String> {
        self.open_gesture = None;
        let (label, next) = self.redo.pop()?;
        let cur = std::mem::replace(&mut self.doc, next);
        self.undo.push((label.clone(), cur));
        self.dirty = true;
        Some(label)
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|u| u.0.as_str())
    }

    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|u| u.0.as_str())
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn mark_saved(&mut self) {
        self.dirty = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn clip(start: f64, length: f64, lane: u8) -> Clip {
        Clip {
            id: 0,
            track: TrackRef { title: "t".into(), bpm: 124.0, ..Default::default() },
            lane,
            start,
            length,
            source_start: 0.0,
            key_shift: 0.0,
            keylock: true,
            gain_db: 0.0,
            lanes: vec![],
            fx: None,
            name: String::new(),
        }
    }

    #[test]
    fn excerpt_keeps_what_is_heard() {
        let mut p = MixProject::new("x", 120.0);
        p.tempo.set_segments(vec![
            TempoSegment { start_beat: 0.0, bpm: 120.0, end_bpm: 120.0 },
            TempoSegment { start_beat: 64.0, bpm: 120.0, end_bpm: 128.0 },
            TempoSegment { start_beat: 128.0, bpm: 128.0, end_bpm: 128.0 },
        ]);
        p.tempo.rebuild();
        let mut a = clip(0.0, 128.0, 0);
        a.source_start = 16.0;
        a.lane_mut(Param::Volume).set_point(Point { beat: 96.0, value: 1.0, curve: Curve::Linear });
        a.lane_mut(Param::Volume).set_point(Point { beat: 128.0, value: 0.0, curve: Curve::Linear });
        p.add_clip(a);
        p.add_clip(clip(96.0, 200.0, 1));
        p.add_clip(clip(400.0, 16.0, 0));
        p.markers.push(Marker { beat: 100.0, label: "drop".into() });

        let e = p.excerpt(80.0, 144.0);
        assert_eq!(e.clips.len(), 2, "the clip far later is left out");
        let a = &e.clips[0];
        assert_eq!((a.start, a.length), (0.0, 48.0));
        assert_eq!(a.source_start, 96.0, "same music at the window start");
        let b = &e.clips[1];
        assert_eq!((b.start, b.length, b.source_start), (16.0, 48.0, 0.0));
        // Automation keeps its shape: halfway through the fade-out is still 0.5.
        assert!((a.value_at(Param::Volume, 112.0 - 80.0) - 0.5).abs() < 1e-6);
        assert_eq!(e.markers, vec![Marker { beat: 20.0, label: "drop".into() }]);
        // Tempo: mid-ramp at the start, same seconds between any two beats.
        assert!((e.tempo.bpm_at_beat(0.0) - p.tempo.bpm_at_beat(80.0)).abs() < 1e-9);
        let d0 = p.tempo.seconds_at_beat(130.0) - p.tempo.seconds_at_beat(80.0);
        let d1 = e.tempo.seconds_at_beat(50.0) - e.tempo.seconds_at_beat(0.0);
        assert!((d0 - d1).abs() < 1e-9, "{d0} vs {d1}");
    }

    #[test]
    fn lanes_interpolate_with_curves() {
        let mut l = Lane::new(Param::Volume);
        assert_eq!(l.value_at(3.0), 1.0, "default before any point");
        l.set_point(Point { beat: 0.0, value: 0.0, curve: Curve::Linear });
        l.set_point(Point { beat: 8.0, value: 1.0, curve: Curve::Hold });
        l.set_point(Point { beat: 16.0, value: 0.0, curve: Curve::Smooth });
        assert_eq!(l.value_at(-1.0), 0.0);
        assert!((l.value_at(4.0) - 0.5).abs() < 1e-6);
        assert_eq!(l.value_at(12.0), 1.0, "hold keeps the value");
        assert_eq!(l.value_at(16.0), 0.0);
        l.set_point(Point { beat: 8.0, value: 5.0, curve: Curve::Linear });
        assert_eq!(l.points.len(), 3, "same beat replaces");
        assert_eq!(l.points[1].value, 1.0, "values are clamped to the range");
        let mut p = Lane::new(Param::Volume);
        p.set_point(Point { beat: 0.0, value: 1.0, curve: Curve::Power });
        p.set_point(Point { beat: 1.0, value: 0.0, curve: Curve::Linear });
        let mid = p.value_at(0.5);
        assert!((mid - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-3, "equal-power midpoint {mid}");
    }

    #[test]
    fn clip_editing_and_undo() {
        let mut ed = Editor::new(MixProject::new("Set", 124.0));
        let a = ed.edit("Add", |p| Ok(p.add_clip(clip(0.0, 64.0, 0)))).unwrap();
        let b = ed.edit("Add", |p| Ok(p.add_clip(clip(48.0, 64.0, 1)))).unwrap();
        assert_eq!(ed.doc.length_beats(), 112.0);
        ed.edit("Move", |p| p.move_clip(b, 56.0, None)).unwrap();
        assert_eq!(ed.doc.clip(b).unwrap().start, 56.0);
        let r = ed.edit("Split", |p| p.split_clip(a, 32.0)).unwrap();
        assert_eq!(ed.doc.clip(a).unwrap().length, 32.0);
        assert_eq!(ed.doc.clip(r).unwrap().source_start, 32.0);
        assert!(ed.edit("Bad split", |p| p.split_clip(a, 100.0)).is_err());
        assert_eq!(ed.undo_label(), Some("Split"));
        ed.undo();
        assert_eq!(ed.doc.clip(a).unwrap().length, 64.0);
        ed.undo();
        assert_eq!(ed.doc.clip(b).unwrap().start, 48.0);
        ed.redo();
        assert_eq!(ed.doc.clip(b).unwrap().start, 56.0);
        // Gestures merge.
        for x in 0..10 {
            ed.gesture("Drag", |p| p.move_clip(b, 56.0 + x as f64, None)).unwrap();
        }
        ed.end_gesture();
        ed.undo();
        assert_eq!(ed.doc.clip(b).unwrap().start, 56.0, "one undo reverts the whole drag");
    }

    #[test]
    fn checks_find_problems() {
        let mut p = MixProject::new("Set", 124.0);
        let mut a = clip(0.0, 64.0, 0);
        a.track.key = Key::parse("8A");
        let mut b = clip(32.0, 64.0, 0);
        b.track.key = Key::parse("2B");
        let mut c = clip(200.0, 16.0, 1);
        c.track.bpm = 100.0;
        p.add_clip(a);
        p.add_clip(b);
        p.add_clip(c);
        let issues = p.check();
        assert!(issues.iter().any(|i| matches!(i, Issue::LaneOverlap { .. })));
        assert!(issues.iter().any(|i| matches!(i, Issue::KeyClash { .. })));
        assert!(issues.iter().any(|i| matches!(i, Issue::TempoStretch { .. })));
    }

    #[test]
    fn json_round_trip() {
        let mut p = MixProject::new("Set", 126.0);
        p.tempo.insert_change(64.0, 128.0, true);
        p.add_clip(clip(0.0, 32.0, 0));
        let back = MixProject::from_json(&p.to_json()).unwrap();
        assert_eq!(back, p);
        assert!((back.tempo.seconds_at_beat(100.0) - p.tempo.seconds_at_beat(100.0)).abs() < 1e-12);
    }
}
