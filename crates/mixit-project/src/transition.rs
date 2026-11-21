//! Classic DJ transitions, written as automation so they can be edited afterwards.
//!
//! The overlap is the time both tracks play: from the incoming clip's start to the
//! outgoing clip's end. Each preset clears the automation inside the overlap and writes
//! its own moves.

use serde::{Deserialize, Serialize};

use crate::{Clip, ClipFx, Curve, EQ_CUT_DB, MixProject, Param, Point, ProjectError};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TransitionKind {
    /// Volume crossfade (equal power).
    Blend,
    /// The incoming track starts with its bass cut; halfway through the basslines swap
    /// in one beat (the most common club transition: two basslines never clash).
    BassSwap,
    /// The outgoing track is high-passed away while the incoming one opens from a
    /// low-pass.
    FilterFade,
    /// The outgoing track's echo carries over the cut; the incoming track drops in.
    EchoOut,
    /// A hard cut on the first downbeat of the incoming track.
    Cut,
    /// The outgoing track stops like a turntable losing power (rendered as a fast
    /// pitch-down fade); the incoming track starts on the next downbeat.
    Brake,
}

impl TransitionKind {
    pub const ALL: [TransitionKind; 6] = [
        TransitionKind::Blend,
        TransitionKind::BassSwap,
        TransitionKind::FilterFade,
        TransitionKind::EchoOut,
        TransitionKind::Cut,
        TransitionKind::Brake,
    ];

    pub fn name(self) -> &'static str {
        match self {
            TransitionKind::Blend => "Blend",
            TransitionKind::BassSwap => "Bass swap",
            TransitionKind::FilterFade => "Filter fade",
            TransitionKind::EchoOut => "Echo out",
            TransitionKind::Cut => "Cut",
            TransitionKind::Brake => "Brake",
        }
    }

    /// What it does, for beginners.
    pub fn explain(self) -> &'static str {
        match self {
            TransitionKind::Blend => "Fades one track out while the other fades in. Smooth and safe for most music.",
            TransitionKind::BassSwap => {
                "Brings the new track in without its bass, then swaps the basslines on a downbeat so they never clash."
            }
            TransitionKind::FilterFade => "Thins the old track out with a filter while the new one opens up.",
            TransitionKind::EchoOut => "The old track ends in an echo that rings over the start of the new one.",
            TransitionKind::Cut => "Switches instantly on a downbeat. Punchy, great into a drop.",
            TransitionKind::Brake => "Stops the old track like a turntable, then the new one slams in.",
        }
    }

    /// Typical overlap in beats.
    pub fn default_beats(self) -> f64 {
        match self {
            TransitionKind::Blend | TransitionKind::BassSwap | TransitionKind::FilterFade => 32.0,
            TransitionKind::EchoOut => 8.0,
            TransitionKind::Cut => 0.0,
            TransitionKind::Brake => 4.0,
        }
    }
}

fn pt(beat: f64, value: f32, curve: Curve) -> Point {
    Point { beat, value, curve }
}

fn clear(c: &mut Clip, from: f64, to: f64) {
    for l in &mut c.lanes {
        l.clear_range(from, to);
    }
}

/// Echo effect index in `FxKind::ALL` (kept in sync with mixit-dsp).
pub const FX_ECHO: usize = 1;

/// Writes a transition from clip `out_id` into clip `in_id`. The incoming clip starts
/// at `at` (its position is kept if `None`); the outgoing clip is trimmed to end after
/// `beats` of overlap.
pub fn apply(
    p: &mut MixProject,
    out_id: u64,
    in_id: u64,
    kind: TransitionKind,
    beats: f64,
    at: Option<f64>,
) -> Result<(), ProjectError> {
    if out_id == in_id {
        return Err(ProjectError::Invalid("a transition needs two different clips"));
    }
    if let Some(s) = at {
        p.move_clip(in_id, s, None)?;
    }
    let start = p.clip(in_id)?.start;
    let beats = beats.max(0.0);
    let end = start + beats;
    // Lanes: put the incoming clip on a different deck from the outgoing one.
    let out_lane = p.clip(out_id)?.lane;
    {
        let c = p.clip_mut(in_id)?;
        if c.lane == out_lane {
            c.lane = (out_lane + 1) % crate::MAX_LANES;
        }
    }
    {
        let o = p.clip_mut(out_id)?;
        if o.start >= start {
            return Err(ProjectError::Invalid("the outgoing clip must start before the incoming one"));
        }
        let tail = match kind {
            TransitionKind::EchoOut => beats.max(1.0),
            TransitionKind::Cut => 0.0,
            _ => beats,
        };
        o.length = (start + tail - o.start).max(1.0);
        clear(o, start - 1e-6, o.end() + 1e-6);
        let half = start + (beats * 0.5).round();
        match kind {
            TransitionKind::Blend => {
                o.lane_mut(Param::Volume).set_point(pt(start, 1.0, Curve::Power));
                o.lane_mut(Param::Volume).set_point(pt(end, 0.0, Curve::Linear));
            }
            TransitionKind::BassSwap => {
                o.lane_mut(Param::EqLow).set_point(pt(half - 0.001, 0.0, Curve::Hold));
                o.lane_mut(Param::EqLow).set_point(pt(half, EQ_CUT_DB, Curve::Hold));
                o.lane_mut(Param::Volume).set_point(pt(half, 1.0, Curve::Smooth));
                o.lane_mut(Param::Volume).set_point(pt(end, 0.0, Curve::Linear));
            }
            TransitionKind::FilterFade => {
                o.lane_mut(Param::Filter).set_point(pt(start, 0.0, Curve::Smooth));
                o.lane_mut(Param::Filter).set_point(pt(end, 0.85, Curve::Linear));
                o.lane_mut(Param::Volume).set_point(pt(half, 1.0, Curve::Smooth));
                o.lane_mut(Param::Volume).set_point(pt(end, 0.0, Curve::Linear));
            }
            TransitionKind::EchoOut => {
                o.fx = Some(ClipFx { kind: FX_ECHO, beats: 0.75 });
                let cut = start;
                o.lane_mut(Param::FxMix).set_point(pt(cut - 2.0, 0.0, Curve::Linear));
                o.lane_mut(Param::FxMix).set_point(pt(cut - 0.01, 0.7, Curve::Hold));
                // Pre-fader cut: the echo tail keeps ringing after the fader closes,
                // so the dry signal is cut with the mids and highs, not the fader.
                for band in [Param::EqLow, Param::EqMid, Param::EqHigh] {
                    o.lane_mut(band).set_point(pt(cut - 0.01, 0.0, Curve::Hold));
                    o.lane_mut(band).set_point(pt(cut, EQ_CUT_DB, Curve::Hold));
                }
            }
            TransitionKind::Cut => {}
            TransitionKind::Brake => {
                o.lane_mut(Param::Volume).set_point(pt(start - beats, 1.0, Curve::Smooth));
                o.lane_mut(Param::Volume).set_point(pt(start, 0.0, Curve::Hold));
                o.lane_mut(Param::Filter).set_point(pt(start - beats, 0.0, Curve::Smooth));
                o.lane_mut(Param::Filter).set_point(pt(start, -0.9, Curve::Hold));
                o.length = (start - o.start).max(1.0);
            }
        }
    }
    let i = p.clip_mut(in_id)?;
    clear(i, start - 1e-6, end + 1e-6);
    let half = start + (beats * 0.5).round();
    match kind {
        TransitionKind::Blend => {
            i.lane_mut(Param::Volume).set_point(pt(start, 0.0, Curve::Power));
            i.lane_mut(Param::Volume).set_point(pt(end, 1.0, Curve::Linear));
        }
        TransitionKind::BassSwap => {
            i.lane_mut(Param::EqLow).set_point(pt(start, EQ_CUT_DB, Curve::Hold));
            i.lane_mut(Param::EqLow).set_point(pt(half, 0.0, Curve::Hold));
            i.lane_mut(Param::Volume).set_point(pt(start, 0.0, Curve::Smooth));
            i.lane_mut(Param::Volume).set_point(pt(half, 1.0, Curve::Linear));
        }
        TransitionKind::FilterFade => {
            i.lane_mut(Param::Filter).set_point(pt(start, -0.85, Curve::Smooth));
            i.lane_mut(Param::Filter).set_point(pt(end, 0.0, Curve::Linear));
            i.lane_mut(Param::Volume).set_point(pt(start, 0.0, Curve::Smooth));
            i.lane_mut(Param::Volume).set_point(pt(half, 1.0, Curve::Linear));
        }
        TransitionKind::EchoOut | TransitionKind::Cut | TransitionKind::Brake => {
            i.lane_mut(Param::Volume).set_point(pt(start, 1.0, Curve::Linear));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::clip;

    fn two() -> (MixProject, u64, u64) {
        let mut p = MixProject::new("Set", 124.0);
        let a = p.add_clip(clip(0.0, 128.0, 0));
        let b = p.add_clip(clip(96.0, 128.0, 0));
        (p, a, b)
    }

    #[test]
    fn blend_crossfades_over_the_overlap() {
        let (mut p, a, b) = two();
        apply(&mut p, a, b, TransitionKind::Blend, 32.0, None).unwrap();
        let (ca, cb) = (p.clip(a).unwrap(), p.clip(b).unwrap());
        assert_eq!(ca.end(), 128.0);
        assert_ne!(ca.lane, cb.lane);
        assert_eq!(ca.value_at(Param::Volume, 90.0), 1.0);
        assert_eq!(cb.value_at(Param::Volume, 96.0), 0.0);
        let mid_a = ca.value_at(Param::Volume, 112.0);
        let mid_b = cb.value_at(Param::Volume, 112.0);
        assert!((mid_a * mid_a + mid_b * mid_b - 1.0).abs() < 0.01, "equal power: {mid_a} {mid_b}");
        assert_eq!(cb.value_at(Param::Volume, 130.0), 1.0);
    }

    #[test]
    fn bass_swap_never_plays_two_basslines() {
        let (mut p, a, b) = two();
        apply(&mut p, a, b, TransitionKind::BassSwap, 32.0, None).unwrap();
        let (ca, cb) = (p.clip(a).unwrap(), p.clip(b).unwrap());
        for x in 0..64 {
            let beat = 96.0 + x as f64 * 0.5;
            let a_bass = ca.value_at(Param::EqLow, beat) > -6.0 && ca.is_active(beat);
            let b_bass = cb.value_at(Param::EqLow, beat) > -6.0 && cb.is_active(beat);
            assert!(!(a_bass && b_bass), "both basslines at beat {beat}");
        }
        assert!(cb.value_at(Param::EqLow, 120.0) > -1.0, "incoming bass is back after the swap");
    }

    #[test]
    fn echo_out_and_cut() {
        let (mut p, a, b) = two();
        apply(&mut p, a, b, TransitionKind::EchoOut, 8.0, None).unwrap();
        let ca = p.clip(a).unwrap();
        assert!(ca.fx.is_some());
        assert!(ca.value_at(Param::FxMix, 95.9) > 0.5);
        assert_eq!(ca.value_at(Param::EqMid, 97.0), EQ_CUT_DB);
        let (mut p, a, b) = two();
        apply(&mut p, a, b, TransitionKind::Cut, 0.0, Some(100.0)).unwrap();
        assert_eq!(p.clip(a).unwrap().end(), 100.0);
        assert_eq!(p.clip(b).unwrap().start, 100.0);
        assert!(apply(&mut p, b, a, TransitionKind::Blend, 16.0, None).is_err());
    }
}
