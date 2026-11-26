//! Sound to notes: Basic Pitch (Bittner et al., Spotify; Apache-2.0 code and weights),
//! a small trained note tracker, hears which notes a sound plays and when, so a hummed
//! or played melody can become a pattern on the pads (or a MIDI file).
//!
//! The model reads 2 s of 22.05 kHz mono audio (43 844 samples: it does its own
//! constant-Q transform inside) and says, for each of the 88 piano keys in each frame of
//! 256 samples, how likely the key is sounding and how likely a note starts there. A
//! longer sound is read in windows that overlap by 30 frames, half of which are thrown
//! away at each end ([`windows`]), as the authors' own code does; here every kept frame
//! keeps its exact time instead of being laid end to end.
//!
//! Turning those likelihoods into notes is our own ([`notes_from`]): a note starts on a
//! clear onset peak, or where a key comes on strongly with no onset (a hummed or slurred
//! note), lasts while the key stays on (a two-frame gap is forgiven), and ends at the
//! next onset of the same key. Very short notes and the overtones of a clearer note below
//! are dropped.

use std::path::Path;

use crate::beats::mono_22k;
use crate::{MlError, Result};

/// The model's sample rate.
pub const RATE: u32 = 22_050;
/// Samples the model reads at once.
pub const WINDOW: usize = 43_844;
/// Samples between two frames.
pub const HOP: usize = 256;
/// Frames the model answers for one window.
pub const FRAMES: usize = 172;
/// Frames thrown away at each end of a window.
const EDGE: usize = 15;
/// Samples between the starts of two windows.
const STEP: usize = WINDOW - 2 * EDGE * HOP;
/// Keys: the piano's 88, from A0 (MIDI 21).
pub const KEYS: usize = 88;
pub const LOWEST_MIDI: u8 = 21;

/// A note starts on an onset at least this likely…
const ONSET: f32 = 0.5;
/// …or where a key comes on at least this strongly without one.
const STRONG: f32 = 0.6;
/// A key is on while it is at least this likely.
const ON: f32 = 0.3;
/// Frames a key may drop out inside a note.
const GAP: usize = 2;
/// Shortest note kept (s).
const MIN_SECONDS: f64 = 0.06;

/// A note heard: when (s), how long (s), which key (MIDI number) and how clearly (0–1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Note {
    pub start: f64,
    pub length: f64,
    pub pitch: u8,
    pub strength: f32,
}

/// What the model says about a sound, frame by frame.
#[derive(Clone, Debug, Default)]
pub struct Heard {
    /// Each frame's time (s).
    pub times: Vec<f64>,
    /// `times.len()` × [`KEYS`]: how likely each key is sounding.
    pub on: Vec<f32>,
    /// `times.len()` × [`KEYS`]: how likely a note of each key starts.
    pub onset: Vec<f32>,
}

/// Reads 2 s of sound ([`WINDOW`] samples) and says how likely each key is sounding and
/// starting in each of its [`FRAMES`] frames (each `FRAMES × KEYS`).
pub trait NoteNet {
    fn read(&mut self, window: &[f32]) -> Result<(Vec<f32>, Vec<f32>)>;
}

/// Where each window starts (in samples of the sound) and which of its frames are kept:
/// frames `EDGE..` until the next window takes over, so every stretch of the sound is
/// heard away from a window's edge. The first window starts `EDGE` frames before the
/// sound so its first kept frame is the sound's first.
pub fn windows(samples: usize) -> Vec<(isize, std::ops::Range<usize>)> {
    let first = -((EDGE * HOP) as isize);
    let mut out = Vec::new();
    let mut start = first;
    loop {
        let kept_from = start + (EDGE * HOP) as isize;
        if kept_from >= samples as isize && !out.is_empty() {
            break;
        }
        // Kept frames: from EDGE up to where the next window's kept frames begin.
        let next = kept_from + STEP as isize;
        let until = ((next - start) as usize).div_ceil(HOP).min(FRAMES - EDGE);
        out.push((start, EDGE..until));
        start += STEP as isize;
    }
    out
}

/// Reads a whole sound (mono, [`RATE`]) window by window.
pub fn read_all(model: &mut dyn NoteNet, mono: &[f32], mut progress: impl FnMut(f32) -> bool) -> Result<Heard> {
    let plan = windows(mono.len());
    let mut heard = Heard::default();
    let mut buf = vec![0.0f32; WINDOW];
    for (i, (start, keep)) in plan.iter().enumerate() {
        for (k, v) in buf.iter_mut().enumerate() {
            let at = start + k as isize;
            *v = if at >= 0 && (at as usize) < mono.len() { mono[at as usize] } else { 0.0 };
        }
        let (on, onset) = model.read(&buf)?;
        for f in keep.clone() {
            let t = (start + (f * HOP) as isize) as f64 / RATE as f64;
            if t < 0.0 || t * RATE as f64 >= mono.len() as f64 {
                continue;
            }
            heard.times.push(t);
            heard.on.extend_from_slice(&on[f * KEYS..(f + 1) * KEYS]);
            heard.onset.extend_from_slice(&onset[f * KEYS..(f + 1) * KEYS]);
        }
        if !progress((i + 1) as f32 / plan.len() as f32) {
            return Err(MlError::Cancelled);
        }
    }
    Ok(heard)
}

/// The notes in what the model heard (see the module notes), in order of start.
pub fn notes_from(h: &Heard) -> Vec<Note> {
    let n = h.times.len();
    let on = |t: usize, k: usize| h.on[t * KEYS + k];
    let onset = |t: usize, k: usize| h.onset[t * KEYS + k];
    let peak = |t: usize, k: usize| {
        let o = onset(t, k);
        o >= ONSET && (t == 0 || o >= onset(t - 1, k)) && (t + 1 >= n || o > onset(t + 1, k))
    };
    let end_time = |t: usize| if t + 1 < n { h.times[t + 1] } else { h.times[t] + HOP as f64 / RATE as f64 };
    let mut notes = Vec::new();
    for k in 0..KEYS {
        let mut t = 0;
        while t < n {
            // A start: an onset peak, or the key coming on strongly from off.
            let soft = on(t, k) >= STRONG && (t == 0 || on(t - 1, k) < ON);
            if !(peak(t, k) || soft) {
                t += 1;
                continue;
            }
            let start = t;
            let mut last = t;
            let mut sum = on(t, k);
            let mut u = t + 1;
            let mut again = false;
            while u < n {
                if u > start + 2 && peak(u, k) {
                    again = true;
                    break;
                }
                if on(u, k) >= ON {
                    last = u;
                    sum += on(u, k);
                } else if u - last > GAP {
                    break;
                }
                u += 1;
            }
            let length = end_time(last) - h.times[start];
            let frames = (last - start + 1) as f32;
            if length >= MIN_SECONDS {
                notes.push(Note {
                    start: h.times[start],
                    length,
                    pitch: LOWEST_MIDI + k as u8,
                    strength: (sum / frames).min(1.0),
                });
            }
            // The same key struck again starts the next note there.
            t = if again { u } else { last + 1 };
        }
    }
    drop_overtones(&mut notes);
    notes.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.pitch.cmp(&b.pitch)));
    notes
}

/// Overtones of a note, in semitones above it (the 2nd to 8th harmonics, rounded).
const OVERTONES: [i32; 7] = [12, 19, 24, 28, 31, 34, 36];

/// Drops a note that is mostly an overtone of a clearer note below it sounding at the
/// same time.
fn drop_overtones(notes: &mut Vec<Note>) {
    let overlap = |a: &Note, b: &Note| (a.start + a.length).min(b.start + b.length) - a.start.max(b.start);
    let keep: Vec<bool> = notes
        .iter()
        .map(|n| {
            !notes.iter().any(|low| {
                OVERTONES.contains(&(n.pitch as i32 - low.pitch as i32))
                    && low.strength >= 1.5 * n.strength
                    && overlap(n, low) >= 0.8 * n.length
            })
        })
        .collect();
    let mut i = 0;
    notes.retain(|_| {
        i += 1;
        keep[i - 1]
    });
}

/// The notes in interleaved stereo `audio` at `sample_rate`.
pub fn hear(
    model: &mut dyn NoteNet,
    sample_rate: u32,
    audio: &[f32],
    progress: impl FnMut(f32) -> bool,
) -> Result<Vec<Note>> {
    let mono = mono_22k(sample_rate, audio)?;
    if mono.iter().all(|v| v.abs() < 1e-6) {
        return Ok(Vec::new());
    }
    Ok(notes_from(&read_all(model, &mono, progress)?))
}

/// Basic Pitch loaded.
pub struct BasicPitch {
    #[cfg(feature = "onnx")]
    session: ort::session::Session,
}

impl BasicPitch {
    #[cfg(feature = "onnx")]
    pub fn load(path: &Path) -> Result<BasicPitch> {
        use ort::session::Session;
        if !path.is_file() {
            return Err(MlError::Missing);
        }
        let e = |e: ort::Error| MlError::Run(e.to_string());
        // Small and quick: two threads are plenty.
        let session =
            Session::builder().map_err(e)?.with_intra_threads(2).map_err(e)?.commit_from_file(path).map_err(e)?;
        Ok(BasicPitch { session })
    }

    #[cfg(not(feature = "onnx"))]
    pub fn load(_path: &Path) -> Result<BasicPitch> {
        Err(MlError::NoRuntime)
    }
}

impl NoteNet for BasicPitch {
    #[cfg(feature = "onnx")]
    fn read(&mut self, window: &[f32]) -> Result<(Vec<f32>, Vec<f32>)> {
        use ort::value::Tensor;
        let e = |e: ort::Error| MlError::Run(e.to_string());
        let name = self.session.inputs[0].name.clone();
        let input = Tensor::from_array(([1usize, WINDOW, 1], window.to_vec())).map_err(e)?;
        let out = self.session.run(ort::inputs![name => input]).map_err(e)?;
        // The export's outputs: :0 the pitch contour (unused), :1 notes, :2 onsets.
        let (_, on) = out["StatefulPartitionedCall:1"].try_extract_tensor::<f32>().map_err(e)?;
        let (_, onset) = out["StatefulPartitionedCall:2"].try_extract_tensor::<f32>().map_err(e)?;
        Ok((on[..FRAMES * KEYS].to_vec(), onset[..FRAMES * KEYS].to_vec()))
    }

    #[cfg(not(feature = "onnx"))]
    fn read(&mut self, _window: &[f32]) -> Result<(Vec<f32>, Vec<f32>)> {
        Err(MlError::NoRuntime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cover_every_frame_once_away_from_their_edges() {
        for samples in [1_000, WINDOW, 3 * STEP + 77, 500_000] {
            let plan = windows(samples);
            let mut times: Vec<isize> = Vec::new();
            for (start, keep) in &plan {
                assert!(keep.start >= EDGE && keep.end <= FRAMES - EDGE);
                times.extend(keep.clone().map(|f| start + (f * HOP) as isize));
            }
            assert_eq!(times[0], 0);
            assert!(times.windows(2).all(|w| w[1] > w[0]), "times go forward");
            // No gap longer than a frame.
            assert!(times.windows(2).all(|w| w[1] - w[0] <= HOP as isize));
            assert!(
                *times.last().unwrap() >= samples as isize - HOP as isize,
                "{samples}: ends at {}",
                times.last().unwrap()
            );
        }
    }

    /// What a model that hears `notes` exactly would say: the key on over each note and
    /// an onset at its start (and, with `ghost`, a weaker key that many semitones up).
    fn heard_from(notes: &[(f64, f64, u8)], seconds: f64, ghost: Option<(u8, f32)>) -> Heard {
        let frames = (seconds * RATE as f64 / HOP as f64) as usize;
        let mut h =
            Heard { times: (0..frames).map(|f| (f * HOP) as f64 / RATE as f64).collect(), ..Default::default() };
        h.on = vec![0.0; frames * KEYS];
        h.onset = vec![0.0; frames * KEYS];
        for &(s, len, pitch) in notes {
            let k = (pitch - LOWEST_MIDI) as usize;
            for (f, t) in h.times.iter().enumerate() {
                if *t >= s && *t < s + len {
                    h.on[f * KEYS + k] = 0.9;
                    if let Some((up, level)) = ghost {
                        h.on[f * KEYS + k + up as usize] = level;
                    }
                }
                if (*t - s).abs() < 0.5 * HOP as f64 / RATE as f64 {
                    h.onset[f * KEYS + k] = 0.8;
                }
            }
        }
        h
    }

    #[test]
    fn notes_come_from_onsets_and_repeat_on_new_onsets() {
        // C D E, then E again straight after (only its onset separates it).
        let truth = [(0.1, 0.4, 60), (0.5, 0.3, 62), (0.8, 0.3, 64), (1.1, 0.3, 64)];
        let notes = notes_from(&heard_from(&truth, 2.0, None));
        assert_eq!(notes.len(), 4, "{notes:?}");
        for (n, (s, len, p)) in notes.iter().zip(truth) {
            assert_eq!(n.pitch, p);
            assert!((n.start - s).abs() < 0.015, "{n:?}");
            assert!((n.length - len).abs() < 0.03, "{n:?}");
        }
    }

    #[test]
    fn a_weak_octave_above_is_an_overtone_and_too_short_is_noise() {
        let mut h = heard_from(&[(0.2, 0.5, 48)], 1.0, Some((12, 0.4)));
        // A 20 ms blip elsewhere.
        let k = (70 - LOWEST_MIDI) as usize;
        h.on[60 * KEYS + k] = 0.9;
        h.onset[60 * KEYS + k] = 0.9;
        let notes = notes_from(&h);
        assert_eq!(notes.iter().map(|n| n.pitch).collect::<Vec<_>>(), vec![48], "{notes:?}");
    }

    #[test]
    fn a_hummed_note_without_an_onset_still_counts() {
        let mut h = heard_from(&[(0.3, 0.4, 57)], 1.0, None);
        h.onset.iter_mut().for_each(|v| *v = 0.0);
        let notes = notes_from(&h);
        assert_eq!(notes.len(), 1);
        assert!((notes[0].start - 0.3).abs() < 0.015);
    }
}
