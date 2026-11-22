//! Lays out a whole set from analysed tracks.
//!
//! Each track enters on its mix-in point (start of its intro phrase) aligned to the
//! previous track's mix-out point (start of its outro), so phrases line up. The overlap
//! is the shorter of the outgoing outro and incoming intro (capped, a whole number of
//! bars). The master tempo either stays at the first track's tempo, follows each track
//! with a ramp during the overlap, or is fixed. With harmonic mixing on, incoming
//! tracks are pitch-shifted (keylock) by the smallest amount that makes them
//! compatible with what is playing.
//!
//! Two voices at once are hard to follow, so when both tracks sing during a blend the
//! overlap is shortened (two bars at a time, down to two bars) until they no longer do.
//! When no length avoids it, the outgoing track's mids are dipped while both sing.

use mixit_core::Key;
use serde::{Deserialize, Serialize};

use crate::transition::{self, TransitionKind};
use crate::{Clip, Curve, MixProject, Param, Point, ProjectError, TrackRef};

/// What automix needs to know about a track (from its analysis).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanTrack {
    pub track: TrackRef,
    /// Grid beats (the track's own beat numbers) of the first and last usable beats.
    pub first_beat: f64,
    pub last_beat: f64,
    /// Grid beat to start mixing in at (usually the first phrase).
    pub mix_in: f64,
    /// Grid beat to start mixing out at (usually the outro).
    pub mix_out: f64,
    /// Where the track sings, in its grid beats (from the vocal analysis).
    #[serde(default)]
    pub vocals: Vec<(f64, f64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum TempoPolicy {
    /// Keep the first track's tempo for the whole set.
    FirstTrack,
    /// Each track plays at its own tempo; the tempo ramps during transitions.
    Follow,
    Fixed(f64),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AutomixOptions {
    pub transition: TransitionKind,
    /// Longest overlap in beats.
    pub max_overlap: f64,
    /// Shortest overlap for blending transitions.
    pub min_overlap: f64,
    pub tempo: TempoPolicy,
    pub harmonic: bool,
    pub max_key_shift: i32,
}

impl Default for AutomixOptions {
    fn default() -> Self {
        AutomixOptions {
            transition: TransitionKind::BassSwap,
            max_overlap: 32.0,
            min_overlap: 16.0,
            tempo: TempoPolicy::FirstTrack,
            harmonic: true,
            max_key_shift: 2,
        }
    }
}

/// Allowed singing over singing in a blend (beats): a breath, a last word.
const VOCAL_SLACK: f64 = 1.0;
/// How far the outgoing track's mids dip when two voices cannot be kept apart (dB).
const VOCAL_DUCK_DB: f32 = -12.0;

/// Spans (beats from the start of the transition, within `beats`) where both the
/// outgoing track (from `out_at`) and the incoming one (from `in_at`) sing.
fn vocal_overlaps(out: &PlanTrack, out_at: f64, inc: &PlanTrack, in_at: f64, beats: f64) -> Vec<(f64, f64)> {
    let mut spans = Vec::new();
    for &(a1, b1) in &out.vocals {
        for &(a2, b2) in &inc.vocals {
            let s = (a1 - out_at).max(a2 - in_at).max(0.0);
            let e = (b1 - out_at).min(b2 - in_at).min(beats);
            if e > s {
                spans.push((s, e));
            }
        }
    }
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    spans
}

fn span_total(spans: &[(f64, f64)]) -> f64 {
    spans.iter().map(|s| s.1 - s.0).sum()
}

/// The blend length that keeps the voices apart: `beats` if it already does, otherwise
/// the longest shorter whole-two-bar overlap that does, otherwise the one with the least
/// clash. Returns the length and the spans where the voices still meet.
fn vocal_safe_overlap(out: &PlanTrack, out_at: f64, inc: &PlanTrack, in_at: f64, beats: f64) -> (f64, Vec<(f64, f64)>) {
    let mut best: Option<(f64, Vec<(f64, f64)>)> = None;
    let mut len = beats;
    loop {
        let spans = vocal_overlaps(out, out_at, inc, in_at, len);
        if span_total(&spans) <= VOCAL_SLACK {
            return (len, spans);
        }
        if best.as_ref().is_none_or(|(_, b)| span_total(&spans) < span_total(b)) {
            best = Some((len, spans));
        }
        if len <= 8.0 {
            break;
        }
        len = ((len - 8.0) / 8.0).ceil().max(1.0) * 8.0;
    }
    best.unwrap_or((beats, vec![]))
}

/// Overlap in beats: a multiple of 8 (two bars) within the limits.
fn overlap(outro: f64, intro: f64, opts: &AutomixOptions) -> f64 {
    let room = outro.min(intro).min(opts.max_overlap);
    let snapped = (room / 8.0).floor() * 8.0;
    snapped.max(opts.min_overlap).min(opts.max_overlap)
}

pub fn automix(name: &str, tracks: &[PlanTrack], opts: &AutomixOptions) -> Result<MixProject, ProjectError> {
    let Some(first) = tracks.first() else { return Err(ProjectError::Invalid("no tracks")) };
    let base_bpm = match opts.tempo {
        TempoPolicy::Fixed(b) => b,
        _ => first.track.bpm,
    };
    let mut p = MixProject::new(name, base_bpm);
    let mut prev: Option<(u64, f64, Option<Key>)> = None; // (clip id, timeline beat of mix-out, effective key)
    for (i, t) in tracks.iter().enumerate() {
        let source_start = if i == 0 { t.first_beat } else { t.mix_in };
        let mut clip = Clip {
            id: 0,
            track: t.track.clone(),
            lane: (i % 2) as u8,
            start: 0.0,
            length: (t.last_beat - source_start).max(4.0),
            source_start,
            key_shift: 0.0,
            keylock: true,
            gain_db: 0.0,
            lanes: vec![],
            fx: None,
            name: t.track.title.clone(),
            reverse: false,
        };
        let mut key = t.track.key;
        if let (true, Some((_, _, Some(pk))), Some(k)) = (opts.harmonic, prev, t.track.key) {
            if !k.is_compatible(pk) {
                if let Some(s) = k.best_shift_to(pk, opts.max_key_shift) {
                    clip.key_shift = s as f32;
                    key = Some(k.transposed(s));
                }
            }
        }
        match prev {
            None => {
                clip.start = 0.0;
                let id = p.add_clip(clip);
                let mix_out_tl = t.mix_out - source_start;
                prev = Some((id, mix_out_tl, key));
            }
            Some((pid, mix_out_tl, _)) => {
                let prev_t = &tracks[i - 1];
                let outro = prev_t.last_beat - prev_t.mix_out;
                let intro = t.mix_out.min(t.last_beat) - t.mix_in;
                let mut clash = vec![];
                let beats = match opts.transition {
                    TransitionKind::Cut => 0.0,
                    TransitionKind::EchoOut | TransitionKind::Brake => opts.transition.default_beats(),
                    _ => {
                        let (b, spans) =
                            vocal_safe_overlap(prev_t, prev_t.mix_out, t, t.mix_in, overlap(outro, intro, opts));
                        clash = spans;
                        b
                    }
                };
                // Hard transitions happen at the end of the outgoing outro's first phrase.
                let at = match opts.transition {
                    TransitionKind::Cut | TransitionKind::EchoOut | TransitionKind::Brake => {
                        mix_out_tl + overlap(outro, f64::MAX, opts)
                    }
                    _ => mix_out_tl,
                };
                clip.start = at;
                let id = p.add_clip(clip);
                transition::apply(&mut p, pid, id, opts.transition, beats, None)?;
                // Voices that could not be kept apart: dip the outgoing track's mids.
                if span_total(&clash) > VOCAL_SLACK {
                    let o = p.clip_mut(pid)?;
                    let first = clash[0].0;
                    let lane = o.lane_mut(Param::EqMid);
                    lane.set_point(Point { beat: at + (first - 1.0).max(0.0), value: 0.0, curve: Curve::Smooth });
                    lane.set_point(Point { beat: at + first.max(1.0), value: VOCAL_DUCK_DB, curve: Curve::Hold });
                }
                if opts.tempo == TempoPolicy::Follow && t.track.bpm > 0.0 {
                    let prev_bpm = prev_t.track.bpm;
                    p.tempo.insert_change(at, prev_bpm, false);
                    p.tempo.insert_change(at + beats.max(1.0), t.track.bpm, true);
                }
                let c = p.clip(id)?;
                prev = Some((id, c.start + (t.mix_out - c.source_start), key));
            }
        }
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Issue;
    use mixit_core::Mode;

    fn plan(title: &str, bpm: f64, key: Key) -> PlanTrack {
        PlanTrack {
            track: TrackRef { title: title.into(), bpm, key: Some(key), ..Default::default() },
            first_beat: 0.0,
            last_beat: 256.0,
            mix_in: 0.0,
            mix_out: 224.0,
            vocals: vec![],
        }
    }

    #[test]
    fn blends_are_shortened_so_two_voices_do_not_meet() {
        // A sings until beat 240 (16 beats into its outro); B starts singing 8 beats in.
        let mut a = plan("A", 124.0, Key::new(9, Mode::Minor));
        a.vocals = vec![(64.0, 128.0), (200.0, 240.0)];
        let mut b = plan("B", 124.0, Key::new(9, Mode::Minor));
        b.vocals = vec![(8.0, 48.0)];
        let p = automix("Set", &[a.clone(), b.clone()], &AutomixOptions::default()).unwrap();
        let (ca, cb) = (&p.clips[0], &p.clips[1]);
        assert_eq!(cb.start, 224.0);
        assert_eq!(ca.end(), 232.0, "a two-bar blend, over before B sings");
        assert!(ca.lane(Param::EqMid).is_none_or(|l| l.points.is_empty()), "no dip needed");

        // Without vocals the full 32-beat blend is kept.
        a.vocals.clear();
        let p = automix("Set", &[a.clone(), b.clone()], &AutomixOptions::default()).unwrap();
        assert_eq!(p.clips[0].end(), 256.0);
    }

    #[test]
    fn voices_that_cannot_be_kept_apart_get_a_mid_dip() {
        let mut a = plan("A", 124.0, Key::new(9, Mode::Minor));
        a.vocals = vec![(200.0, 256.0)];
        let mut b = plan("B", 124.0, Key::new(9, Mode::Minor));
        b.vocals = vec![(0.0, 64.0)];
        let p = automix("Set", &[a, b], &AutomixOptions::default()).unwrap();
        let ca = &p.clips[0];
        assert_eq!(ca.end(), 232.0, "the shortest blend keeps the clash short");
        assert_eq!(ca.value_at(Param::EqMid, 226.0), VOCAL_DUCK_DB);
        assert_eq!(ca.value_at(Param::EqMid, 200.0), 0.0);
    }

    #[test]
    fn vocal_overlaps_line_up_both_tracks() {
        let mut a = plan("A", 124.0, Key::new(0, Mode::Major));
        a.vocals = vec![(230.0, 250.0)];
        let mut b = plan("B", 124.0, Key::new(0, Mode::Major));
        b.vocals = vec![(10.0, 12.0), (20.0, 40.0)];
        // A sings 6..26 beats into the transition, B sings 10..12 and 20..40.
        assert_eq!(vocal_overlaps(&a, 224.0, &b, 0.0, 32.0), vec![(10.0, 12.0), (20.0, 26.0)]);
        assert_eq!(vocal_overlaps(&a, 224.0, &b, 0.0, 8.0), vec![]);
    }

    #[test]
    fn lays_out_phrase_aligned_transitions() {
        let tracks = vec![
            plan("A", 124.0, Key::new(9, Mode::Minor)),
            plan("B", 125.0, Key::new(4, Mode::Minor)),
            plan("C", 126.0, Key::new(10, Mode::Minor)), // clashes with Em: needs a shift
        ];
        let p = automix("Set", &tracks, &AutomixOptions::default()).unwrap();
        assert_eq!(p.clips.len(), 3);
        let (a, b, c) = (&p.clips[0], &p.clips[1], &p.clips[2]);
        assert_eq!(b.start, 224.0, "B starts at A's outro");
        assert_eq!(a.end(), 256.0, "A plays its whole outro");
        assert_eq!(b.start % 32.0, 0.0);
        assert_ne!(a.lane, b.lane);
        assert_ne!(c.key_shift, 0.0, "C is shifted to fit");
        let issues = p.check();
        assert!(!issues.iter().any(|i| matches!(i, Issue::KeyClash { .. } | Issue::LaneOverlap { .. })), "{issues:?}");
        assert_eq!(p.tempo.bpm_at_beat(400.0), 124.0);
    }

    #[test]
    fn follow_tempo_ramps_during_overlaps() {
        let tracks = vec![plan("A", 120.0, Key::new(0, Mode::Major)), plan("B", 128.0, Key::new(0, Mode::Major))];
        let opts = AutomixOptions { tempo: TempoPolicy::Follow, ..Default::default() };
        let p = automix("Set", &tracks, &opts).unwrap();
        assert_eq!(p.tempo.bpm_at_beat(100.0), 120.0);
        let mid = p.tempo.bpm_at_beat(240.0);
        assert!(mid > 120.0 && mid < 128.0, "{mid}");
        assert_eq!(p.tempo.bpm_at_beat(300.0), 128.0);
    }

    #[test]
    fn cut_transitions_land_on_a_phrase() {
        let tracks = vec![plan("A", 128.0, Key::new(0, Mode::Major)), plan("B", 128.0, Key::new(7, Mode::Major))];
        let opts = AutomixOptions { transition: TransitionKind::Cut, ..Default::default() };
        let p = automix("Set", &tracks, &opts).unwrap();
        assert_eq!(p.clips[1].start, 256.0);
        assert_eq!(p.clips[0].end(), 256.0);
    }
}
