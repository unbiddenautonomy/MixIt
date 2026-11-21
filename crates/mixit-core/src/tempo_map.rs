//! Tempo maps for arrangements: tempo over beats, with steps, linear ramps and
//! time-signature changes.
//!
//! A ramp is linear in beats: bpm(x) = b0 + k·x over the segment, where x is beats
//! since the segment start. Elapsed time is the integral of 60/bpm, which has the
//! closed form t(x) = (60/k)·ln(1 + k·x/b0) (or 60·x/b0 when k = 0), and the inverse
//! x(t) = (b0/k)·(exp(k·t/60) − 1). Both directions are exact, so seconds↔beats
//! round-trips do not drift over long projects.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct TempoSegment {
    /// Beat at which this segment starts.
    pub start_beat: f64,
    /// Tempo at the start of the segment.
    pub bpm: f64,
    /// Tempo reached at the start of the next segment (equal to `bpm` for a step).
    /// Ignored for the last segment, which is always constant.
    pub end_bpm: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSignature {
    /// Beat at which the signature starts.
    pub start_beat: i64,
    pub numerator: u8,
    pub denominator: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TempoMap {
    segments: Vec<TempoSegment>,
    pub time_signatures: Vec<TimeSignature>,
    #[serde(skip)]
    start_seconds: Vec<f64>,
}

impl TempoMap {
    pub fn constant(bpm: f64) -> TempoMap {
        let mut m = TempoMap {
            segments: vec![TempoSegment { start_beat: 0.0, bpm, end_bpm: bpm }],
            time_signatures: vec![TimeSignature { start_beat: 0, numerator: 4, denominator: 4 }],
            start_seconds: vec![],
        };
        m.rebuild();
        m
    }

    pub fn segments(&self) -> &[TempoSegment] {
        &self.segments
    }

    /// Replaces all segments. They are sorted by start beat; the first must start at 0.
    pub fn set_segments(&mut self, mut segments: Vec<TempoSegment>) {
        segments.sort_by(|a, b| a.start_beat.partial_cmp(&b.start_beat).unwrap());
        assert!(!segments.is_empty() && segments[0].start_beat == 0.0);
        self.segments = segments;
        self.rebuild();
    }

    /// Inserts a tempo change at `beat`; `ramp` makes the previous segment ramp into it.
    pub fn insert_change(&mut self, beat: f64, bpm: f64, ramp: bool) {
        let mut segs = self.segments.clone();
        segs.retain(|s| s.start_beat != beat);
        let idx = segs.partition_point(|s| s.start_beat < beat);
        if idx > 0 {
            let prev = &mut segs[idx - 1];
            prev.end_bpm = if ramp { bpm } else { prev.bpm };
        }
        segs.insert(idx, TempoSegment { start_beat: beat, bpm, end_bpm: bpm });
        self.set_segments(segs);
    }

    /// Recomputes cached segment start times. Call after deserialising.
    pub fn rebuild(&mut self) {
        self.start_seconds.clear();
        let mut t = 0.0;
        for i in 0..self.segments.len() {
            self.start_seconds.push(t);
            if i + 1 < self.segments.len() {
                let len = self.segments[i + 1].start_beat - self.segments[i].start_beat;
                let seg = &self.segments[i];
                t += Self::seconds_in(seg.bpm, Self::seg_slope(seg, len), len);
            }
        }
    }

    fn seg_slope(s: &TempoSegment, len: f64) -> f64 {
        if len > 0.0 { (s.end_bpm - s.bpm) / len } else { 0.0 }
    }

    fn seg_len(&self, i: usize) -> f64 {
        if i + 1 < self.segments.len() {
            self.segments[i + 1].start_beat - self.segments[i].start_beat
        } else {
            f64::INFINITY
        }
    }

    #[inline]
    fn seconds_in(b0: f64, k: f64, x: f64) -> f64 {
        if k.abs() < 1e-12 { 60.0 * x / b0 } else { 60.0 / k * (1.0 + k * x / b0).ln() }
    }

    #[inline]
    fn beats_in(b0: f64, k: f64, t: f64) -> f64 {
        if k.abs() < 1e-12 { t * b0 / 60.0 } else { b0 / k * ((k * t / 60.0).exp() - 1.0) }
    }

    fn slope(&self, i: usize) -> f64 {
        let len = self.seg_len(i);
        if len.is_finite() { Self::seg_slope(&self.segments[i], len) } else { 0.0 }
    }

    fn seg_for_beat(&self, beat: f64) -> usize {
        self.segments.partition_point(|s| s.start_beat <= beat).saturating_sub(1)
    }

    fn seg_for_seconds(&self, t: f64) -> usize {
        self.start_seconds.partition_point(|&s| s <= t).saturating_sub(1)
    }

    pub fn seconds_at_beat(&self, beat: f64) -> f64 {
        if beat < 0.0 {
            return 60.0 * beat / self.segments[0].bpm;
        }
        let i = self.seg_for_beat(beat);
        let s = &self.segments[i];
        self.start_seconds[i] + Self::seconds_in(s.bpm, self.slope(i), beat - s.start_beat)
    }

    pub fn beat_at_seconds(&self, t: f64) -> f64 {
        if t < 0.0 {
            return t * self.segments[0].bpm / 60.0;
        }
        let i = self.seg_for_seconds(t);
        let s = &self.segments[i];
        s.start_beat + Self::beats_in(s.bpm, self.slope(i), t - self.start_seconds[i])
    }

    pub fn bpm_at_beat(&self, beat: f64) -> f64 {
        let i = self.seg_for_beat(beat.max(0.0));
        let s = &self.segments[i];
        s.bpm + self.slope(i) * (beat.max(0.0) - s.start_beat)
    }

    pub fn frame_at_beat(&self, beat: f64, sample_rate: u32) -> f64 {
        self.seconds_at_beat(beat) * sample_rate as f64
    }

    pub fn beat_at_frame(&self, frame: f64, sample_rate: u32) -> f64 {
        self.beat_at_seconds(frame / sample_rate as f64)
    }

    /// Beats per bar at a beat.
    pub fn beats_per_bar_at(&self, beat: f64) -> u8 {
        let mut n = 4;
        for ts in &self.time_signatures {
            if (ts.start_beat as f64) <= beat {
                n = ts.numerator;
            }
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_map() {
        let m = TempoMap::constant(120.0);
        assert_eq!(m.seconds_at_beat(4.0), 2.0);
        assert_eq!(m.beat_at_seconds(3.0), 6.0);
        assert_eq!(m.frame_at_beat(1.0, 48_000), 24_000.0);
    }

    #[test]
    fn steps_and_ramps() {
        let mut m = TempoMap::constant(120.0);
        m.insert_change(8.0, 140.0, false);
        // 8 beats at 120 = 4 s, then 140 BPM.
        assert!((m.seconds_at_beat(8.0) - 4.0).abs() < 1e-12);
        assert!((m.seconds_at_beat(15.0) - (4.0 + 7.0 * 60.0 / 140.0)).abs() < 1e-12);

        let mut r = TempoMap::constant(120.0);
        r.insert_change(16.0, 128.0, true);
        // During the ramp the tempo rises linearly.
        assert!((r.bpm_at_beat(8.0) - 124.0).abs() < 1e-12);
        // Ramp duration lies between the two constant-tempo durations.
        let t = r.seconds_at_beat(16.0);
        assert!(t < 16.0 * 60.0 / 120.0 && t > 16.0 * 60.0 / 128.0);
        // Exact closed form: (60/k) ln(b1/b0), k = 8/16.
        assert!((t - 120.0 * (128.0f64 / 120.0).ln()).abs() < 1e-9);
    }

    #[test]
    fn round_trip_over_long_project() {
        let mut m = TempoMap::constant(122.0);
        m.insert_change(64.0, 126.0, true);
        m.insert_change(256.0, 124.0, false);
        m.insert_change(1_024.0, 174.0, true);
        m.insert_change(2_048.0, 87.0, false);
        for i in 0..4_000 {
            let b = i as f64 * 0.73;
            let back = m.beat_at_seconds(m.seconds_at_beat(b));
            assert!((back - b).abs() < 1e-8, "beat {b} -> {back}");
        }
    }

    #[test]
    fn serde_round_trip_rebuilds() {
        let mut m = TempoMap::constant(100.0);
        m.insert_change(4.0, 110.0, true);
        let json = serde_json::to_string(&m).unwrap();
        let mut back: TempoMap = serde_json::from_str(&json).unwrap();
        back.rebuild();
        assert_eq!(back.seconds_at_beat(10.0), m.seconds_at_beat(10.0));
    }
}
