//! "What should I play next?": ranks candidate tracks against the one playing.
//!
//! The score blends what makes a transition work:
//!
//! * **Tempo**: how far the decks must be pushed to match (half and double time count),
//!   within a tolerance (6 % by default; beyond that a mix sounds unnatural).
//! * **Key**: same key or a Camelot neighbour is ideal; a key a small pitch shift away
//!   (with keylock) is offered with that shift; a "energy boost" (+2 on the wheel,
//!   a whole tone up) is allowed but scores lower.
//! * **Energy**: a gentle rise (or the direction the DJ asked for) beats a jump.
//! * **Sound**: tracks that sound alike (instruments, production, groove; see
//!   `mixit_analysis::timbre`) get a small lift, so a set keeps its character.
//! * Small extras for genre continuity and ratings; tracks played this session are out.
//!
//! Every suggestion carries plain-language reasons for the coach and explain mode.

use mixit_core::{Key, TrackId};
use serde::{Deserialize, Serialize};

/// What the suggester needs to know about a track.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: TrackId,
    pub bpm: Option<f64>,
    pub key: Option<Key>,
    pub energy: Option<u8>,
    pub genre: String,
    pub rating: u8,
    /// Sound profile in standard units (`timbre::Normaliser::apply`); empty when unknown.
    pub sound: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum EnergyDirection {
    /// Keep the energy about where it is (+0..+1).
    Steady,
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SuggestOptions {
    /// Largest tempo change allowed, percent.
    pub tempo_tolerance_pct: f64,
    pub allow_half_double: bool,
    /// Allow suggesting a key shift (needs keylock) of at most this many semitones.
    pub max_key_shift: i32,
    pub energy: EnergyDirection,
    /// Tracks to leave out (already played, already loaded).
    pub exclude: Vec<TrackId>,
    pub limit: usize,
}

impl Default for SuggestOptions {
    fn default() -> Self {
        SuggestOptions {
            tempo_tolerance_pct: 6.0,
            allow_half_double: true,
            max_key_shift: 2,
            energy: EnergyDirection::Steady,
            exclude: vec![],
            limit: 20,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Reason {
    SameKey,
    CompatibleKey,
    /// Compatible after shifting the new track by this many semitones (keylock on).
    KeyShift(i32),
    EnergyBoostKey,
    KeyClash,
    UnknownKey,
    /// Tempo change needed, percent (signed: + means speed the new track up).
    Tempo(f64),
    HalfTime,
    DoubleTime,
    UnknownTempo,
    EnergyChange(i8),
    SameGenre,
    HighlyRated,
    /// Sounds alike (0..1 similarity, only given when high).
    SoundsAlike(f64),
}

impl Reason {
    /// A short sentence for the UI.
    pub fn describe(&self) -> String {
        match self {
            Reason::SameKey => "Same key: the harmonies will blend perfectly.".into(),
            Reason::CompatibleKey => "Neighbouring key on the Camelot wheel: blends smoothly.".into(),
            Reason::KeyShift(s) => format!("Shift its key by {s:+} semitone(s) with keylock to make it fit."),
            Reason::EnergyBoostKey => "Two steps up the wheel: an energy boost that works if you mix quickly.".into(),
            Reason::KeyClash => "Keys clash: mix with bass and melody of one track cut, or mix fast.".into(),
            Reason::UnknownKey => "Key not analysed yet.".into(),
            Reason::Tempo(p) if p.abs() < 0.05 => "Same tempo.".into(),
            Reason::Tempo(p) => format!("Needs a {:+.1} % tempo change.", p),
            Reason::HalfTime => "Plays at half your tempo: it will feel half-time.".into(),
            Reason::DoubleTime => "Plays at double your tempo.".into(),
            Reason::UnknownTempo => "Tempo not analysed yet.".into(),
            Reason::EnergyChange(0) => "Keeps the energy level.".into(),
            Reason::EnergyChange(d) if *d > 0 => format!("Lifts the energy by {d}."),
            Reason::EnergyChange(d) => format!("Brings the energy down by {}.", -d),
            Reason::SameGenre => "Same genre.".into(),
            Reason::HighlyRated => "One of your highly rated tracks.".into(),
            Reason::SoundsAlike(s) => {
                format!("Sounds alike ({:.0} % match): similar instruments and groove.", s * 100.0)
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    pub id: TrackId,
    /// 0..1.
    pub score: f64,
    /// Tempo change to apply to the new track (percent) when synced to the current one.
    pub tempo_change_pct: Option<f64>,
    /// Recommended key shift in semitones (0 when not needed).
    pub key_shift: i32,
    pub reasons: Vec<Reason>,
}

/// Similarity from which two tracks are said to sound alike.
pub const SOUNDS_ALIKE: f64 = 0.7;

/// Ratio to multiply `bpm` by to reach `target`, allowing half/double time.
fn tempo_fit(bpm: f64, target: f64, half_double: bool) -> (f64, f64) {
    let mults: &[f64] = if half_double { &[1.0, 0.5, 2.0] } else { &[1.0] };
    let mut best = (f64::MAX, 1.0);
    for &m in mults {
        let eff = bpm / m; // e.g. 87 BPM played as 174 → m = 0.5
        let pct = (target / eff - 1.0) * 100.0;
        if pct.abs() < best.0.abs() {
            best = (pct, m);
        }
    }
    best
}

pub fn suggest(current: &Candidate, pool: &[Candidate], opts: &SuggestOptions) -> Vec<Suggestion> {
    let mut out: Vec<Suggestion> = Vec::new();
    for c in pool {
        if c.id == current.id || opts.exclude.contains(&c.id) {
            continue;
        }
        let mut reasons = Vec::new();
        // Tempo.
        let (tempo_score, tempo_change) = match (current.bpm, c.bpm) {
            (Some(target), Some(bpm)) if bpm > 0.0 => {
                let (pct, m) = tempo_fit(bpm, target, opts.allow_half_double);
                if pct.abs() > opts.tempo_tolerance_pct {
                    continue;
                }
                if m < 1.0 {
                    reasons.push(Reason::HalfTime);
                } else if m > 1.0 {
                    reasons.push(Reason::DoubleTime);
                }
                reasons.push(Reason::Tempo(pct));
                let s = 1.0 - (pct.abs() / opts.tempo_tolerance_pct).powf(1.5);
                (if m == 1.0 { s } else { s * 0.8 }, Some(pct))
            }
            _ => {
                reasons.push(Reason::UnknownTempo);
                (0.4, None)
            }
        };
        // Key.
        let mut key_shift = 0;
        let key_score = match (current.key, c.key) {
            (Some(a), Some(b)) => {
                let d = a.camelot_distance(b);
                if d == 0 {
                    reasons.push(Reason::SameKey);
                    1.0
                } else if d == 1 {
                    reasons.push(Reason::CompatibleKey);
                    0.9
                } else if let Some(s) = b.best_shift_to(a, opts.max_key_shift).filter(|s| *s != 0) {
                    key_shift = s;
                    reasons.push(Reason::KeyShift(s));
                    0.75 - 0.05 * (s.abs() - 1) as f64
                } else if d == 2 && a.mode == b.mode {
                    reasons.push(Reason::EnergyBoostKey);
                    0.5
                } else {
                    reasons.push(Reason::KeyClash);
                    0.1
                }
            }
            _ => {
                reasons.push(Reason::UnknownKey);
                0.4
            }
        };
        // Energy.
        let energy_score = match (current.energy, c.energy) {
            (Some(a), Some(b)) => {
                let d = b as i8 - a as i8;
                reasons.push(Reason::EnergyChange(d));
                let target = match opts.energy {
                    EnergyDirection::Steady => 0.5,
                    EnergyDirection::Up => 1.5,
                    EnergyDirection::Down => -1.5,
                };
                (1.0 - (d as f64 - target).abs() / 4.0).max(0.0)
            }
            _ => 0.5,
        };
        let mut score = 0.4 * tempo_score + 0.35 * key_score + 0.2 * energy_score;
        if !current.genre.is_empty() && current.genre.eq_ignore_ascii_case(&c.genre) {
            score += 0.04;
            reasons.push(Reason::SameGenre);
        }
        if let Some(alike) = mixit_analysis::timbre::similarity(&current.sound, &c.sound) {
            score += 0.08 * (alike - 0.5);
            if alike >= SOUNDS_ALIKE {
                reasons.push(Reason::SoundsAlike(alike));
            }
        }
        if c.rating >= 4 {
            score += 0.01 * c.rating as f64;
            reasons.push(Reason::HighlyRated);
        }
        out.push(Suggestion {
            id: c.id,
            score: score.clamp(0.0, 1.0),
            tempo_change_pct: tempo_change,
            key_shift,
            reasons,
        });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap().then(a.id.cmp(&b.id)));
    out.truncate(opts.limit);
    out
}

/// Orders tracks into a set: each next track is the best follow-up of the one before
/// (tempo, key, energy as in [`suggest`]). With no `start`, every track is tried as
/// the opener and the order with the best total transition score wins. Tracks that
/// fit nowhere (tempo too far) are appended at the end, closest tempo first.
pub fn order_set(tracks: &[Candidate], start: Option<usize>, energy: EnergyDirection) -> Vec<usize> {
    let n = tracks.len();
    if n <= 1 {
        return (0..n).collect();
    }
    let opts = SuggestOptions { energy, limit: usize::MAX, ..Default::default() };
    // Pairwise transition scores (None = not mixable).
    let mut score = vec![vec![None; n]; n];
    for i in 0..n {
        for s in suggest(&tracks[i], tracks, &opts) {
            if let Some(j) = tracks.iter().position(|t| t.id == s.id) {
                if j != i {
                    score[i][j] = Some(s.score);
                }
            }
        }
    }
    let chain = |first: usize| -> (Vec<usize>, f64) {
        let mut used = vec![false; n];
        let mut order = vec![first];
        used[first] = true;
        let mut total = 0.0;
        let mut cur = first;
        while order.len() < n {
            let best = (0..n)
                .filter(|&j| !used[j])
                .filter_map(|j| score[cur][j].map(|s| (j, s)))
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap().then(b.0.cmp(&a.0)));
            let Some((j, s)) = best else { break };
            total += s;
            used[j] = true;
            order.push(j);
            cur = j;
        }
        // Leftovers: closest tempo to the last track first.
        let last_bpm = tracks[cur].bpm.unwrap_or(0.0);
        let mut rest: Vec<usize> = (0..n).filter(|&j| !used[j]).collect();
        rest.sort_by(|&a, &b| {
            let d = |j: usize| (tracks[j].bpm.unwrap_or(0.0) - last_bpm).abs();
            d(a).partial_cmp(&d(b)).unwrap()
        });
        total -= rest.len() as f64; // unmixable joins cost a whole transition
        order.extend(rest);
        (order, total)
    };
    match start {
        Some(s) if s < n => chain(s).0,
        _ => {
            let mut best = chain(0);
            for i in 1..n {
                let c = chain(i);
                if c.1 > best.1 + 1e-9 {
                    best = c;
                }
            }
            best.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::Mode;

    fn cand(id: TrackId, bpm: f64, key: Key, energy: u8) -> Candidate {
        Candidate {
            id,
            bpm: Some(bpm),
            key: Some(key),
            energy: Some(energy),
            genre: "House".into(),
            rating: 0,
            sound: vec![],
        }
    }

    #[test]
    fn prefers_compatible_keys_and_close_tempos() {
        let am = Key::new(9, Mode::Minor); // 8A
        let cur = cand(1, 124.0, am, 6);
        let pool = vec![
            cand(2, 124.0, am, 6),                       // perfect
            cand(3, 125.0, Key::new(4, Mode::Minor), 7), // 9A, +1 energy
            cand(4, 124.0, Key::new(3, Mode::Major), 6), // clash
            cand(5, 140.0, am, 6),                       // too fast
            cand(6, 62.0, am, 6),                        // half time
        ];
        let s = suggest(&cur, &pool, &SuggestOptions::default());
        let ids: Vec<TrackId> = s.iter().map(|x| x.id).collect();
        assert_eq!(ids[0], 2);
        assert_eq!(ids[1], 3);
        assert!(!ids.contains(&5), "140 BPM is outside ±6 %");
        assert!(ids.contains(&6));
        assert!(s.iter().find(|x| x.id == 6).unwrap().reasons.contains(&Reason::HalfTime));
        assert_eq!(*ids.last().unwrap(), 4);
    }

    #[test]
    fn offers_key_shifts() {
        let cur = cand(1, 124.0, Key::new(9, Mode::Minor), 6); // Am
        let pool = vec![cand(2, 124.0, Key::new(10, Mode::Minor), 6)]; // Bbm: one semitone up
        let s = suggest(&cur, &pool, &SuggestOptions::default());
        assert_eq!(s[0].key_shift, -1);
        assert!(s[0].reasons.contains(&Reason::KeyShift(-1)));
        assert!(!s[0].reasons[0].describe().is_empty());
    }

    #[test]
    fn excludes_played_tracks() {
        let k = Key::new(0, Mode::Major);
        let cur = cand(1, 120.0, k, 5);
        let pool = vec![cand(2, 120.0, k, 5), cand(3, 120.0, k, 5)];
        let opts = SuggestOptions { exclude: vec![2], ..Default::default() };
        let s = suggest(&cur, &pool, &opts);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].id, 3);
    }

    #[test]
    fn orders_a_set_along_the_wheel() {
        // 8A, 9A, 10A, 11A with rising energy, shuffled: the set walks the wheel upwards.
        let k = |n: u8| Key::from_camelot(n, 'A').unwrap();
        let pool =
            vec![cand(1, 124.0, k(10), 7), cand(2, 124.0, k(8), 5), cand(3, 124.0, k(11), 8), cand(4, 124.0, k(9), 6)];
        let order = order_set(&pool, Some(1), EnergyDirection::Up);
        let ids: Vec<TrackId> = order.iter().map(|&i| pool[i].id).collect();
        assert_eq!(ids, vec![2, 4, 1, 3]);
        // A track at 170 BPM cannot be mixed in; it goes last.
        let mut pool2 = pool.clone();
        pool2.insert(0, cand(9, 170.0, k(8), 6));
        let order = order_set(&pool2, None, EnergyDirection::Up);
        assert_eq!(pool2[*order.last().unwrap()].id, 9);
        assert_eq!(order.len(), 5);
    }
}
