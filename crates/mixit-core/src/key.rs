//! Musical keys, the Camelot wheel and Open Key notation.
//!
//! Harmonic mixing in plain terms: songs in "neighbouring" keys sound good together.
//! The Camelot wheel numbers the 24 keys 1–12 with A (minor) or B (major) so that
//! neighbours are one step apart: same number (relative major/minor), or ±1 with the
//! same letter (a fifth up or down).

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Mode {
    Major,
    Minor,
}

/// A key: tonic pitch class (0 = C … 11 = B) and mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Key {
    pub tonic: u8,
    pub mode: Mode,
}

const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_NAMES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/// How a key is shown to the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum KeyNotation {
    #[default]
    Camelot,
    OpenKey,
    Standard,
}

impl Key {
    pub fn new(tonic: u8, mode: Mode) -> Key {
        Key { tonic: tonic % 12, mode }
    }

    /// Index 0..24: majors 0..12, minors 12..24 (used by key detectors).
    pub fn index(self) -> usize {
        self.tonic as usize + if self.mode == Mode::Minor { 12 } else { 0 }
    }

    pub fn from_index(i: usize) -> Key {
        if i < 12 { Key::new(i as u8, Mode::Major) } else { Key::new((i - 12) as u8, Mode::Minor) }
    }

    /// Camelot number 1..=12 and letter ('A' minor, 'B' major).
    pub fn camelot(self) -> (u8, char) {
        let major_tonic = match self.mode {
            Mode::Major => self.tonic,
            Mode::Minor => (self.tonic + 3) % 12,
        };
        let n = ((major_tonic as u32 * 7) % 12 + 7) % 12 + 1;
        (n as u8, if self.mode == Mode::Major { 'B' } else { 'A' })
    }

    pub fn from_camelot(number: u8, letter: char) -> Option<Key> {
        if !(1..=12).contains(&number) {
            return None;
        }
        // Inverse of n = (7·t + 7) mod 12 + 1: t = 7·(n − 8) mod 12 (7 is its own inverse mod 12).
        let t = ((7 * (number as i32 - 8)).rem_euclid(12)) as u8;
        match letter.to_ascii_uppercase() {
            'B' => Some(Key::new(t, Mode::Major)),
            'A' => Some(Key::new((t + 9) % 12, Mode::Minor)),
            _ => None,
        }
    }

    /// Open Key number 1..=12 and letter ('d' major, 'm' minor).
    pub fn open_key(self) -> (u8, char) {
        let (n, _) = self.camelot();
        ((n + 4) % 12 + 1, if self.mode == Mode::Major { 'd' } else { 'm' })
    }

    pub fn standard_name(self) -> String {
        match self.mode {
            Mode::Major => MAJOR_NAMES[self.tonic as usize].to_string(),
            Mode::Minor => format!("{}m", MINOR_NAMES[self.tonic as usize]),
        }
    }

    pub fn display(self, notation: KeyNotation) -> String {
        match notation {
            KeyNotation::Camelot => {
                let (n, l) = self.camelot();
                format!("{n}{l}")
            }
            KeyNotation::OpenKey => {
                let (n, l) = self.open_key();
                format!("{n}{l}")
            }
            KeyNotation::Standard => self.standard_name(),
        }
    }

    /// Parses "8A", "11B", "1d", "6m", "C#m", "Ab", "F# minor" and similar.
    pub fn parse(s: &str) -> Option<Key> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            let n: u8 = digits.parse().ok()?;
            let letter = t[digits.len()..].trim().chars().next()?;
            return match letter {
                'A' | 'a' | 'B' | 'b' => Key::from_camelot(n, letter),
                'd' | 'm' => {
                    // Open Key: n = (camelot + 4) mod 12 + 1  →  camelot = (n + 6) mod 12 + 1
                    let c = (n + 6) % 12 + 1;
                    Key::from_camelot(c, if letter == 'd' { 'B' } else { 'A' })
                }
                _ => None,
            };
        }
        let mut chars = t.chars();
        let base: i32 = match chars.next()?.to_ascii_uppercase() {
            'C' => 0,
            'D' => 2,
            'E' => 4,
            'F' => 5,
            'G' => 7,
            'A' => 9,
            'B' => 11,
            _ => return None,
        };
        let rest: String = chars.collect();
        let mut rest = rest.trim().to_string();
        let mut tonic = base;
        if rest.starts_with('#') || rest.starts_with('♯') {
            tonic += 1;
            rest = rest[rest.chars().next().unwrap().len_utf8()..].to_string();
        } else if rest.starts_with('b') || rest.starts_with('♭') {
            tonic -= 1;
            rest = rest[rest.chars().next().unwrap().len_utf8()..].to_string();
        }
        let rest = rest.trim().to_ascii_lowercase();
        let mode = if rest.starts_with('m') && !rest.starts_with("maj") { Mode::Minor } else { Mode::Major };
        Some(Key::new(tonic.rem_euclid(12) as u8, mode))
    }

    /// Steps around the Camelot wheel between two keys (0 = same key).
    pub fn camelot_distance(self, other: Key) -> u8 {
        let (n1, l1) = self.camelot();
        let (n2, l2) = other.camelot();
        let d = (n1 as i32 - n2 as i32).rem_euclid(12);
        let dn = d.min(12 - d) as u8;
        if l1 == l2 {
            dn
        } else if dn == 0 {
            1
        } else {
            dn + 1
        }
    }

    /// Whether two keys mix well (distance 0 or 1).
    pub fn is_compatible(self, other: Key) -> bool {
        self.camelot_distance(other) <= 1
    }

    /// The key after shifting pitch by `semitones`.
    pub fn transposed(self, semitones: i32) -> Key {
        Key::new((self.tonic as i32 + semitones).rem_euclid(12) as u8, self.mode)
    }

    /// The smallest pitch shift (in semitones, |s| ≤ max) that makes `self` compatible
    /// with `target`, preferring an exact match on ties. `None` if no shift works.
    pub fn best_shift_to(self, target: Key, max: i32) -> Option<i32> {
        let mut best: Option<(i32, u8)> = None;
        for mag in 0..=max {
            for s in if mag == 0 { vec![0] } else { vec![mag, -mag] } {
                let d = self.transposed(s).camelot_distance(target);
                if d <= 1 {
                    match best {
                        None => best = Some((s, d)),
                        Some((bs, bd)) if bs.abs() == s.abs() && d < bd => best = Some((s, d)),
                        _ => {}
                    }
                }
            }
            if best.is_some() {
                break;
            }
        }
        best.map(|(s, _)| s)
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.display(KeyNotation::Camelot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camelot_table() {
        assert_eq!(Key::new(0, Mode::Major).camelot(), (8, 'B'));
        assert_eq!(Key::new(9, Mode::Minor).camelot(), (8, 'A'));
        assert_eq!(Key::new(7, Mode::Major).camelot(), (9, 'B'));
        assert_eq!(Key::new(5, Mode::Major).camelot(), (7, 'B'));
        assert_eq!(Key::new(11, Mode::Major).camelot(), (1, 'B'));
        assert_eq!(Key::new(8, Mode::Minor).camelot(), (1, 'A')); // G#m = 1A
        assert_eq!(Key::new(4, Mode::Minor).camelot(), (9, 'A')); // Em = 9A
    }

    #[test]
    fn camelot_round_trip_all_keys() {
        for i in 0..24 {
            let k = Key::from_index(i);
            let (n, l) = k.camelot();
            assert_eq!(Key::from_camelot(n, l), Some(k), "{k:?}");
            assert_eq!(Key::parse(&k.display(KeyNotation::OpenKey)), Some(k));
            assert_eq!(Key::parse(&k.display(KeyNotation::Camelot)), Some(k));
            assert_eq!(Key::parse(&k.standard_name()), Some(k));
        }
    }

    #[test]
    fn open_key() {
        assert_eq!(Key::new(0, Mode::Major).open_key(), (1, 'd'));
        assert_eq!(Key::new(9, Mode::Minor).open_key(), (1, 'm'));
        assert_eq!(Key::new(11, Mode::Major).open_key(), (6, 'd'));
    }

    #[test]
    fn distances() {
        let c = Key::new(0, Mode::Major);
        assert_eq!(c.camelot_distance(c), 0);
        assert_eq!(c.camelot_distance(Key::new(9, Mode::Minor)), 1);
        assert_eq!(c.camelot_distance(Key::new(7, Mode::Major)), 1);
        assert_eq!(c.camelot_distance(Key::new(2, Mode::Major)), 2);
        assert!(!c.is_compatible(Key::new(6, Mode::Major)));
    }

    #[test]
    fn best_shift() {
        let c = Key::new(0, Mode::Major);
        let d = Key::new(2, Mode::Major);
        let s = c.best_shift_to(d, 6).unwrap();
        assert!(c.transposed(s).is_compatible(d));
        assert!(s.abs() <= 2);
        assert_eq!(c.best_shift_to(c, 6), Some(0));
    }

    #[test]
    fn parses_names() {
        assert_eq!(Key::parse("F# minor"), Some(Key::new(6, Mode::Minor)));
        assert_eq!(Key::parse("Bbm"), Some(Key::new(10, Mode::Minor)));
        assert_eq!(Key::parse("Ab"), Some(Key::new(8, Mode::Major)));
        assert_eq!(Key::parse("12B"), Some(Key::new(4, Mode::Major)));
        assert_eq!(Key::parse("x"), None);
    }
}
