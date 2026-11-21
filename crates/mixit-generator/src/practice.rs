//! The practice tracks the built-in labs use. Each is chosen to teach something: two
//! house tracks in neighbouring keys for blends and bass swaps, one in a clashing key,
//! a melodic track for key lock, and a "live drummer" track whose tempo drifts and whose
//! first downbeat comes late, for beatgrid work.

use mixit_core::Key;

use crate::{Section, SectionKind, Style, TrackSpec};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PracticeTrack {
    /// Stable id the labs refer to ("p1").
    pub id: &'static str,
    /// File name and title: "Practice 1 - Warm House".
    pub title: &'static str,
    /// What the track is for, shown in the guide.
    pub purpose: &'static str,
    pub style: Style,
    pub bpm: f64,
    pub end_bpm: Option<f64>,
    /// Camelot code.
    pub camelot: (u8, char),
    pub lead_in: f64,
    pub swing: f64,
}

pub const PRACTICE: &[PracticeTrack] = &[
    PracticeTrack {
        id: "p1",
        title: "Practice 1 - Warm House",
        purpose: "Your main track for the first labs: steady 124 BPM, clear 16-bar phrases.",
        style: Style::House,
        bpm: 124.0,
        end_bpm: None,
        camelot: (8, 'A'),
        lead_in: 0.0,
        swing: 0.0,
    },
    PracticeTrack {
        id: "p2",
        title: "Practice 2 - Deep House",
        purpose: "Mixes well with Practice 1: same tempo, neighbouring key (9A).",
        style: Style::House,
        bpm: 124.0,
        end_bpm: None,
        camelot: (9, 'A'),
        lead_in: 0.0,
        swing: 0.15,
    },
    PracticeTrack {
        id: "p3",
        title: "Practice 3 - Night Techno",
        purpose: "A heavier bassline at 128 BPM, for bass swaps and filter exits.",
        style: Style::Techno,
        bpm: 128.0,
        end_bpm: None,
        camelot: (8, 'A'),
        lead_in: 0.0,
        swing: 0.0,
    },
    PracticeTrack {
        id: "p4",
        title: "Practice 4 - Clashing Keys",
        purpose: "Deliberately in a key that clashes with Practice 1 (3B), so you can hear why keys matter.",
        style: Style::House,
        bpm: 124.0,
        end_bpm: None,
        camelot: (3, 'B'),
        lead_in: 0.0,
        swing: 0.0,
    },
    PracticeTrack {
        id: "p5",
        title: "Practice 5 - Melodic Trance",
        purpose: "Long chords and a lead, so tempo and pitch changes are easy to hear.",
        style: Style::Trance,
        bpm: 132.0,
        end_bpm: None,
        camelot: (5, 'A'),
        lead_in: 0.0,
        swing: 0.0,
    },
    PracticeTrack {
        id: "p6",
        title: "Practice 6 - Live Drummer",
        purpose: "Speeds up from 118 to 122 BPM and starts late, like a live band. For beatgrid work.",
        style: Style::House,
        bpm: 118.0,
        end_bpm: Some(122.0),
        camelot: (11, 'B'),
        lead_in: 0.42,
        swing: 0.25,
    },
];

impl PracticeTrack {
    pub fn key(&self) -> Key {
        Key::from_camelot(self.camelot.0, self.camelot.1).expect("valid camelot code")
    }

    /// About two and a half minutes: long enough for 16-bar phrases and full blends.
    pub fn spec(&self, sample_rate: u32) -> TrackSpec {
        use SectionKind::*;
        let s = |kind, bars| Section { kind, bars };
        TrackSpec {
            end_bpm: self.end_bpm,
            sample_rate,
            sections: vec![
                s(Intro, 16),
                s(Build, 8),
                s(Drop, 16),
                s(Breakdown, 8),
                s(Build, 8),
                s(Drop, 16),
                s(Outro, 16),
            ],
            lead_in: self.lead_in,
            swing: self.swing,
            seed: 0x9A11 + self.id.as_bytes()[1] as u64,
            ..TrackSpec::standard(self.style, self.bpm, self.key())
        }
    }
}

pub fn practice_track(id: &str) -> Option<&'static PracticeTrack> {
    PRACTICE.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_are_valid_and_distinct() {
        let mut titles = std::collections::HashSet::new();
        for p in PRACTICE {
            assert!(titles.insert(p.title));
            let s = p.spec(44_100);
            assert_eq!(s.total_beats(), 88 * 4);
            assert_eq!(s.key, p.key());
            assert!(p.title.starts_with("Practice "));
        }
        assert!(practice_track("p6").unwrap().end_bpm.is_some());
    }

    #[test]
    fn neighbouring_and_clashing_keys() {
        let a = practice_track("p1").unwrap().key();
        let b = practice_track("p2").unwrap().key();
        let c = practice_track("p4").unwrap().key();
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.camelot().0 + 1, b.camelot().0);
    }
}
