//! "Build me a set": picks tracks from a pool to fill a length of time, following an
//! energy shape (warm-up, build to the peak, peak time, a journey up and down, cool-down),
//! with every change of track mixable (tempo, key, sound; see [`crate::suggest`]).
//!
//! A beam search keeps the few best partial sets at each step, so one greedy choice that
//! leads into a dead end (nothing in key at the right energy) does not spoil the set.

use mixit_core::TrackId;
use serde::{Deserialize, Serialize};

use crate::suggest::{self, Candidate, EnergyDirection, SuggestOptions};

/// How the energy should move through the set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetShape {
    /// Opening a night: calm, rising gently.
    WarmUp,
    /// From easy to the peak, holding it at the end.
    Build,
    /// High all the way, with a short breather in the middle.
    Peak,
    /// Up to a peak about two-thirds in, then down again.
    Journey,
    /// From high to calm, to close a night.
    CoolDown,
    /// About the same energy throughout.
    Steady,
}

impl SetShape {
    pub fn parse(s: &str) -> Option<SetShape> {
        Some(match s.to_ascii_lowercase().replace(['-', '_', ' '], "").as_str() {
            "warmup" => SetShape::WarmUp,
            "build" | "buildup" => SetShape::Build,
            "peak" | "peaktime" => SetShape::Peak,
            "journey" => SetShape::Journey,
            "cooldown" => SetShape::CoolDown,
            "steady" => SetShape::Steady,
            _ => return None,
        })
    }

    /// Target energy (1..10) at `t` (0 = start, 1 = end). `steady` is the level a steady
    /// set keeps.
    pub fn target(self, t: f64, steady: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        let lerp = |a: f64, b: f64, x: f64| a + (b - a) * x.clamp(0.0, 1.0);
        match self {
            SetShape::WarmUp => lerp(3.0, 6.0, t),
            SetShape::Build => lerp(4.0, 9.0, t / 0.85),
            SetShape::Peak => {
                if (0.45..0.6).contains(&t) {
                    7.0
                } else {
                    lerp(7.5, 9.0, t / 0.3)
                }
            }
            SetShape::Journey => {
                if t < 0.65 {
                    lerp(4.0, 9.0, t / 0.65)
                } else {
                    lerp(9.0, 5.0, (t - 0.65) / 0.35)
                }
            }
            SetShape::CoolDown => lerp(8.0, 3.0, t),
            SetShape::Steady => steady,
        }
    }
}

/// A track the builder may use.
#[derive(Clone, Debug)]
pub struct PoolTrack {
    pub candidate: Candidate,
    /// Seconds.
    pub duration: f64,
    pub artist: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BuildOptions {
    pub minutes: f64,
    pub shape: SetShape,
    /// The first track; otherwise the builder picks one that fits the start of the shape.
    pub seed: Option<TrackId>,
    /// Partial sets kept at each step.
    pub beam: usize,
    /// Largest tempo change between neighbours, percent.
    pub tempo_tolerance_pct: f64,
    /// How much of each track is heard in a mix (the rest overlaps its neighbours).
    pub heard: f64,
    /// 0 builds the best set; another number shakes the choices a little for a different
    /// set from the same tracks ("Try another").
    pub variety: u64,
}

impl Default for BuildOptions {
    fn default() -> Self {
        BuildOptions {
            minutes: 60.0,
            shape: SetShape::Build,
            seed: None,
            beam: 6,
            tempo_tolerance_pct: 6.0,
            heard: 0.8,
            variety: 0,
        }
    }
}

#[derive(Clone)]
struct Partial {
    seq: Vec<usize>,
    score: f64,
    seconds: f64,
}

impl Partial {
    fn mean(&self) -> f64 {
        self.score / self.seq.len().max(1) as f64
    }
}

/// A small, repeatable shake (−0.05..0.05) for track `j` under `variety`.
fn jitter(variety: u64, j: usize) -> f64 {
    if variety == 0 {
        return 0.0;
    }
    let mut x = variety.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (j as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 31;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 29;
    ((x >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 0.1
}

/// How well track `e` sits on the shape at `t`, 0..1.
fn energy_fit(e: Option<u8>, target: f64) -> f64 {
    match e {
        Some(e) => (1.0 - (e as f64 - target).abs() / 4.0).max(0.0),
        None => 0.4,
    }
}

/// Builds a set from `pool`. Returns indexes into `pool`, in playing order. Stops when
/// the heard time reaches the length, or when nothing more fits.
pub fn build_set(pool: &[PoolTrack], opts: &BuildOptions) -> Vec<usize> {
    if pool.is_empty() {
        return vec![];
    }
    let goal = (opts.minutes * 60.0).max(60.0);
    let heard = opts.heard.clamp(0.3, 1.0);
    let index_of: std::collections::HashMap<TrackId, usize> =
        pool.iter().enumerate().map(|(i, t)| (t.candidate.id, i)).collect();
    let cands: Vec<Candidate> = pool.iter().map(|t| t.candidate.clone()).collect();

    // The opener: the seed, or a track at the shape's starting energy near the pool's
    // usual tempo (so the set has somewhere to go), better rated first.
    let mut tempos: Vec<f64> = cands.iter().filter_map(|c| c.bpm).collect();
    tempos.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let usual = tempos.get(tempos.len() / 2).copied();
    let steady =
        opts.seed.and_then(|s| index_of.get(&s)).and_then(|&i| cands[i].energy).map(|e| e as f64).unwrap_or_else(
            || {
                let es: Vec<f64> = cands.iter().filter_map(|c| c.energy.map(|e| e as f64)).collect();
                if es.is_empty() { 6.0 } else { es.iter().sum::<f64>() / es.len() as f64 }
            },
        );
    let first = match opts.seed.and_then(|s| index_of.get(&s).copied()) {
        Some(i) => i,
        None => {
            let target = opts.shape.target(0.0, steady);
            (0..pool.len())
                .max_by(|&a, &b| {
                    let s = |i: usize| {
                        let c = &cands[i];
                        let tempo = match (c.bpm, usual) {
                            (Some(b), Some(u)) => (1.0 - ((b / u) - 1.0).abs() * 10.0).max(0.0),
                            _ => 0.2,
                        };
                        energy_fit(c.energy, target)
                            + 0.5 * tempo
                            + 0.02 * c.rating as f64
                            + 3.0 * jitter(opts.variety, i)
                    };
                    s(a).partial_cmp(&s(b)).unwrap().then(b.cmp(&a))
                })
                .unwrap()
        }
    };

    let sopts = SuggestOptions {
        energy: EnergyDirection::Steady,
        tempo_tolerance_pct: opts.tempo_tolerance_pct,
        limit: usize::MAX,
        ..Default::default()
    };
    let beam = opts.beam.max(1);
    let mut states = vec![Partial { seq: vec![first], score: 1.0, seconds: pool[first].duration * heard }];
    let mut done: Vec<Partial> = Vec::new();
    // Each step adds one track; a set never repeats one, so the pool bounds the steps.
    for _ in 0..pool.len() {
        let mut next: Vec<Partial> = Vec::new();
        for st in &states {
            if st.seconds >= goal {
                done.push(st.clone());
                continue;
            }
            let last = *st.seq.last().unwrap();
            let t = st.seconds / goal;
            let target = opts.shape.target(t, steady);
            let mut options: Vec<(usize, f64)> = suggest::suggest(&cands[last], &cands, &sopts)
                .into_iter()
                .filter_map(|s| {
                    let j = *index_of.get(&s.id)?;
                    if st.seq.contains(&j) {
                        return None;
                    }
                    let mut v = 0.6 * s.score + 0.4 * energy_fit(cands[j].energy, target) + jitter(opts.variety, j);
                    // The same artist twice in a row rarely makes a good set.
                    if !pool[j].artist.is_empty() && pool[j].artist.eq_ignore_ascii_case(&pool[last].artist) {
                        v -= 0.1;
                    }
                    Some((j, v))
                })
                .collect();
            options.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
            if options.is_empty() {
                // Nothing mixes after this: the set ends here.
                done.push(st.clone());
                continue;
            }
            for (j, v) in options.into_iter().take(beam + 2) {
                let mut seq = st.seq.clone();
                seq.push(j);
                next.push(Partial { seq, score: st.score + v, seconds: st.seconds + pool[j].duration * heard });
            }
        }
        if next.is_empty() {
            break;
        }
        next.sort_by(|a, b| b.mean().partial_cmp(&a.mean()).unwrap());
        // Keep different sets, not the same set with its last track swapped.
        let mut kept: Vec<Partial> = Vec::new();
        for p in next {
            let prefix = &p.seq[..p.seq.len() - 1];
            if kept.iter().filter(|k| &k.seq[..k.seq.len() - 1] == prefix).count() < 2 {
                kept.push(p);
            }
            if kept.len() == beam {
                break;
            }
        }
        states = kept;
    }
    done.extend(states);
    // Full-length sets beat short ones; then the smoothest.
    done.into_iter()
        .max_by(|a, b| {
            let full = |p: &Partial| (p.seconds >= goal * 0.95) as u8;
            full(a).cmp(&full(b)).then(a.mean().partial_cmp(&b.mean()).unwrap())
        })
        .map(|p| p.seq)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::{Key, Mode};

    fn pool() -> Vec<PoolTrack> {
        // 60 tracks around 120–130 BPM, keys round the wheel, energies 2..9.
        (0..60)
            .map(|i| PoolTrack {
                candidate: Candidate {
                    id: i as TrackId + 1,
                    bpm: Some(120.0 + (i % 11) as f64),
                    key: Some(Key::new(((i * 7) % 12) as u8, if i % 2 == 0 { Mode::Minor } else { Mode::Major })),
                    energy: Some(2 + (i % 8) as u8),
                    genre: String::new(),
                    rating: 0,
                    sound: vec![],
                },
                duration: 300.0,
                artist: format!("Artist {}", i % 9),
            })
            .collect()
    }

    #[test]
    fn fills_the_time_without_repeats() {
        let p = pool();
        let set = build_set(&p, &BuildOptions { minutes: 60.0, ..Default::default() });
        let heard: f64 = set.iter().map(|&i| p[i].duration * 0.8).sum();
        assert!((3_600.0..3_900.0).contains(&heard), "{heard} s");
        let mut ids = set.clone();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), set.len(), "no track twice");
    }

    #[test]
    fn follows_the_shape() {
        let p = pool();
        let e = |set: &[usize], i: usize| p[set[i]].candidate.energy.unwrap() as f64;
        let build = build_set(&p, &BuildOptions { minutes: 90.0, shape: SetShape::Build, ..Default::default() });
        let n = build.len();
        let start: f64 = (0..3).map(|i| e(&build, i)).sum::<f64>() / 3.0;
        let end: f64 = (n - 3..n).map(|i| e(&build, i)).sum::<f64>() / 3.0;
        assert!(end >= start + 3.0, "a build rises: {start} → {end}");

        let cool = build_set(&p, &BuildOptions { minutes: 90.0, shape: SetShape::CoolDown, ..Default::default() });
        let n = cool.len();
        let start: f64 = (0..3).map(|i| e(&cool, i)).sum::<f64>() / 3.0;
        let end: f64 = (n - 3..n).map(|i| e(&cool, i)).sum::<f64>() / 3.0;
        assert!(end <= start - 3.0, "a cool-down falls: {start} → {end}");
    }

    #[test]
    fn every_change_mixes_and_the_seed_opens() {
        let p = pool();
        let set = build_set(&p, &BuildOptions { minutes: 45.0, seed: Some(10), ..Default::default() });
        assert_eq!(p[set[0]].candidate.id, 10);
        for w in set.windows(2) {
            let (a, b) = (&p[w[0]].candidate, &p[w[1]].candidate);
            let pct = (a.bpm.unwrap() / b.bpm.unwrap() - 1.0).abs() * 100.0;
            assert!(pct <= 6.0 + 1e-9, "tempo jump {pct:.1} %");
            assert_ne!(p[w[0]].artist, p[w[1]].artist, "same artist back to back");
        }
    }

    #[test]
    fn variety_gives_another_set() {
        let p = pool();
        let a = build_set(&p, &BuildOptions::default());
        let b = build_set(&p, &BuildOptions { variety: 7, ..Default::default() });
        assert_eq!(a, build_set(&p, &BuildOptions::default()), "the same options give the same set");
        assert_ne!(a, b);
    }

    #[test]
    fn shapes_parse() {
        assert_eq!(SetShape::parse("warm-up"), Some(SetShape::WarmUp));
        assert_eq!(SetShape::parse("Cool down"), Some(SetShape::CoolDown));
        assert_eq!(SetShape::parse("nope"), None);
    }
}
