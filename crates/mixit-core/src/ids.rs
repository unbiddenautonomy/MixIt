//! Identifiers.

use serde::{Deserialize, Serialize};
use std::fmt;

/// A deck index: 0 = A, 1 = B, 2 = C, 3 = D.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct DeckId(pub u8);

impl DeckId {
    pub const A: DeckId = DeckId(0);
    pub const B: DeckId = DeckId(1);
    pub const C: DeckId = DeckId(2);
    pub const D: DeckId = DeckId(3);
    pub const MAX: usize = 4;

    pub fn letter(self) -> char {
        (b'A' + self.0) as char
    }

    pub fn index(self) -> usize {
        self.0 as usize
    }

    pub fn from_letter(c: char) -> Option<DeckId> {
        let c = c.to_ascii_uppercase();
        if ('A'..='D').contains(&c) { Some(DeckId(c as u8 - b'A')) } else { None }
    }
}

impl fmt::Display for DeckId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.letter())
    }
}

/// Library row id of a track.
pub type TrackId = i64;

/// A content hash of the decoded audio (BLAKE3, 32 bytes). Tracks are identified by
/// this hash so that cues, grids and projects survive moves, renames and other machines.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ContentHash(pub [u8; 32]);

impl ContentHash {
    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(64);
        for b in self.0 {
            s.push_str(&format!("{b:02x}"));
        }
        s
    }

    pub fn from_hex(s: &str) -> Option<ContentHash> {
        if s.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, chunk) in s.as_bytes().chunks(2).enumerate() {
            let hex = std::str::from_utf8(chunk).ok()?;
            out[i] = u8::from_str_radix(hex, 16).ok()?;
        }
        Some(ContentHash(out))
    }

    /// The first 8 bytes as an integer, handy as a compact runtime id.
    pub fn short(&self) -> u64 {
        u64::from_le_bytes(self.0[..8].try_into().unwrap())
    }
}

impl fmt::Debug for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ContentHash({})", &self.to_hex()[..16])
    }
}

impl fmt::Display for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_hex())
    }
}

impl Serialize for ContentHash {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for ContentHash {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        ContentHash::from_hex(&s).ok_or_else(|| serde::de::Error::custom("invalid content hash"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_letters() {
        assert_eq!(DeckId::B.letter(), 'B');
        assert_eq!(DeckId::from_letter('c'), Some(DeckId::C));
        assert_eq!(DeckId::from_letter('E'), None);
    }

    #[test]
    fn hash_hex_round_trip() {
        let mut b = [0u8; 32];
        for (i, x) in b.iter_mut().enumerate() {
            *x = (i * 7) as u8;
        }
        let h = ContentHash(b);
        assert_eq!(ContentHash::from_hex(&h.to_hex()), Some(h));
        let json = serde_json::to_string(&h).unwrap();
        let back: ContentHash = serde_json::from_str(&json).unwrap();
        assert_eq!(back, h);
    }
}
