//! Non-destructive sound editing: a list of [`EditOp`]s applied in order to the original
//! audio (interleaved stereo). The original is never changed, so any step can be undone
//! or taken out later, and the same list gives the same sound on every machine.
//!
//! Splices are click-free: a cut crossfades the audio either side of it over a few
//! milliseconds, and pasted, trimmed or silenced edges get short ramps.

use crate::meters::LoudnessMeter;

/// Ramp at the edges of pasted, trimmed and silenced audio (seconds).
const EDGE_S: f64 = 0.002;
/// Crossfade across a cut (seconds).
const SPLICE_S: f64 = 0.005;

/// How a fade moves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FadeShape {
    Linear,
    /// S-curve: eases in and out.
    Smooth,
    /// Equal power: sounds even when two fades overlap.
    Power,
    /// Logarithmic feel: fast at first (fade out) or slow at first (fade in), like a
    /// volume knob turned evenly.
    Exponential,
}

impl FadeShape {
    /// Gain at `t` (0..1) of a fade in.
    fn gain(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            FadeShape::Linear => t,
            FadeShape::Smooth => t * t * (3.0 - 2.0 * t),
            FadeShape::Power => (t * std::f32::consts::FRAC_PI_2).sin(),
            // 60 dB of range, so the start is effectively silent.
            FadeShape::Exponential => {
                if t <= 0.0 {
                    0.0
                } else {
                    10f32.powf(3.0 * (t - 1.0))
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum NormalizeTo {
    /// Loudest sample at this level (dBFS).
    Peak(f32),
    /// Integrated loudness (LUFS), never past −1 dBFS peak. Sounds too short to measure
    /// (under about half a second) are peak-normalised to −1 dBFS instead.
    Loudness(f32),
}

/// One step. Times are seconds in the sound as it is at that step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EditOp {
    /// Keeps only `start..end`.
    Trim { start: f64, end: f64 },
    /// Removes `start..end`; what follows moves up.
    Delete { start: f64, end: f64 },
    /// Puts a copy of `start..end` on the clipboard (no change to the sound).
    Copy { start: f64, end: f64 },
    /// Inserts the clipboard at `at`.
    Paste { at: f64 },
    /// Replaces `start..end` with silence (the length stays).
    Silence { start: f64, end: f64 },
    /// Inserts `seconds` of silence at `at`.
    InsertSilence { at: f64, seconds: f64 },
    /// Fades `start..end` in (from silence) or out (to silence).
    Fade { start: f64, end: f64, fade_in: bool, shape: FadeShape },
    /// Turns `start..end` up or down.
    Gain { start: f64, end: f64, db: f32 },
    /// Turns the whole sound to a level.
    Normalize(NormalizeTo),
    /// Plays `start..end` backwards.
    Reverse { start: f64, end: f64 },
    /// Cuts the quiet before the first and after the last sound louder than `threshold_db`.
    TrimSilence { threshold_db: f32 },
    /// Removes a constant offset (a mic or interface that sits off zero).
    RemoveDc,
}

/// Applies `ops` in order to interleaved stereo `audio` and returns the result.
pub fn apply(audio: &[f32], sample_rate: u32, ops: &[EditOp]) -> Vec<f32> {
    let mut e = Editor { a: audio.to_vec(), clip: Vec::new(), sr: sample_rate as f64 };
    for op in ops {
        e.run(*op);
    }
    e.a
}

/// Loudness (LUFS, integrated) and sample peak (dBFS) of interleaved stereo.
pub fn measure(audio: &[f32], sample_rate: u32) -> (f64, f32) {
    let mut m = LoudnessMeter::new(sample_rate as f32);
    let mut l = vec![0.0f32; 4096];
    let mut r = vec![0.0f32; 4096];
    let mut peak = 0.0f32;
    for chunk in audio.chunks(8192) {
        let n = chunk.len() / 2;
        for i in 0..n {
            l[i] = chunk[i * 2];
            r[i] = chunk[i * 2 + 1];
            peak = peak.max(l[i].abs()).max(r[i].abs());
        }
        m.process(&l[..n], &r[..n]);
    }
    (m.integrated(), if peak > 0.0 { 20.0 * peak.log10() } else { f32::NEG_INFINITY })
}

/// Min and max per bin over `bins` equal slices (mono, the louder channel), for drawing.
pub fn peaks(audio: &[f32], bins: usize) -> Vec<[f32; 2]> {
    let frames = audio.len() / 2;
    let bins = bins.max(1);
    (0..bins)
        .map(|b| {
            let (s, e) = (b * frames / bins, ((b + 1) * frames / bins).max(b * frames / bins + 1).min(frames));
            let mut lo = 0.0f32;
            let mut hi = 0.0f32;
            for i in s..e {
                let (l, r) = (audio[i * 2], audio[i * 2 + 1]);
                let v = if l.abs() >= r.abs() { l } else { r };
                lo = lo.min(v);
                hi = hi.max(v);
            }
            [lo, hi]
        })
        .collect()
}

struct Editor {
    a: Vec<f32>,
    clip: Vec<f32>,
    sr: f64,
}

impl Editor {
    fn frames(&self) -> usize {
        self.a.len() / 2
    }

    fn at(&self, t: f64) -> usize {
        if !t.is_finite() {
            return if t > 0.0 { self.frames() } else { 0 };
        }
        ((t * self.sr).round().max(0.0) as usize).min(self.frames())
    }

    fn range(&self, start: f64, end: f64) -> (usize, usize) {
        let (a, b) = (self.at(start), self.at(end));
        (a.min(b), a.max(b))
    }

    fn edge(&self) -> usize {
        (EDGE_S * self.sr).round() as usize
    }

    fn run(&mut self, op: EditOp) {
        match op {
            EditOp::Trim { start, end } => {
                let (s, e) = self.range(start, end);
                if e > s {
                    self.a = self.a[s * 2..e * 2].to_vec();
                    let n = self.edge();
                    ramp_edges(&mut self.a, n);
                }
            }
            EditOp::Delete { start, end } => {
                let (s, e) = self.range(start, end);
                if e > s {
                    self.splice_out(s, e);
                }
            }
            EditOp::Copy { start, end } => {
                let (s, e) = self.range(start, end);
                self.clip = self.a[s * 2..e * 2].to_vec();
                let n = self.edge();
                ramp_edges(&mut self.clip, n);
            }
            EditOp::Paste { at } => {
                let p = self.at(at);
                let clip = std::mem::take(&mut self.clip);
                self.a.splice(p * 2..p * 2, clip.iter().copied());
                self.clip = clip;
            }
            EditOp::Silence { start, end } => {
                let (s, e) = self.range(start, end);
                let n = self.edge();
                // Ramp down into the silence and up out of it.
                for i in 0..n.min(s) {
                    let g = i as f32 / n as f32;
                    let f = s - 1 - i;
                    self.a[f * 2] *= g;
                    self.a[f * 2 + 1] *= g;
                }
                self.a[s * 2..e * 2].fill(0.0);
                for i in 0..n.min(self.frames() - e) {
                    let g = i as f32 / n as f32;
                    self.a[(e + i) * 2] *= g;
                    self.a[(e + i) * 2 + 1] *= g;
                }
            }
            EditOp::InsertSilence { at, seconds } => {
                let p = self.at(at);
                let n = ((seconds.max(0.0) * self.sr).round() as usize).min(self.sr as usize * 600);
                self.a.splice(p * 2..p * 2, std::iter::repeat_n(0.0, n * 2));
            }
            EditOp::Fade { start, end, fade_in, shape } => {
                let (s, e) = self.range(start, end);
                let len = (e - s).max(1) as f32;
                for i in s..e {
                    let t = (i - s) as f32 / len;
                    let g = if fade_in { shape.gain(t) } else { shape.gain(1.0 - t) };
                    self.a[i * 2] *= g;
                    self.a[i * 2 + 1] *= g;
                }
                // Past the end of a fade-out (or before a fade-in) stays as it is: the fade
                // reaches silence at its edge, and the rest is left to the person.
            }
            EditOp::Gain { start, end, db } => {
                let (s, e) = self.range(start, end);
                let g = 10f32.powf(db.clamp(-96.0, 48.0) / 20.0);
                let n = self.edge().min((e - s) / 2);
                for i in s..e {
                    // Ease into and out of the change, so a boosted passage does not click.
                    let k = (i - s).min(e - 1 - i);
                    let w = if n > 0 && k < n { k as f32 / n as f32 } else { 1.0 };
                    let gi = 1.0 + (g - 1.0) * w;
                    self.a[i * 2] *= gi;
                    self.a[i * 2 + 1] *= gi;
                }
            }
            EditOp::Normalize(to) => {
                let sr = self.sr as u32;
                let (lufs, peak) = measure(&self.a, sr);
                if !peak.is_finite() {
                    return;
                }
                let gain_db = match to {
                    NormalizeTo::Peak(db) => db - peak,
                    NormalizeTo::Loudness(target) if lufs.is_finite() && lufs > -70.0 => {
                        ((target as f64 - lufs) as f32).min(-1.0 - peak)
                    }
                    NormalizeTo::Loudness(_) => -1.0 - peak,
                };
                let g = 10f32.powf(gain_db / 20.0);
                for x in &mut self.a {
                    *x *= g;
                }
            }
            EditOp::Reverse { start, end } => {
                let (s, e) = self.range(start, end);
                let (mut i, mut j) = (s, e);
                while i + 1 < j {
                    j -= 1;
                    self.a.swap(i * 2, j * 2);
                    self.a.swap(i * 2 + 1, j * 2 + 1);
                    i += 1;
                }
                if e > s {
                    // The reversed audio meets its neighbours at different points now.
                    let n = self.edge();
                    let mut mid = self.a[s * 2..e * 2].to_vec();
                    ramp_edges(&mut mid, n.min((e - s) / 2));
                    self.a[s * 2..e * 2].copy_from_slice(&mid);
                }
            }
            EditOp::TrimSilence { threshold_db } => {
                let th = 10f32.powf(threshold_db / 20.0);
                let f = self.frames();
                let loud = |i: usize| self.a[2 * i].abs().max(self.a[2 * i + 1].abs()) > th;
                if let Some(first) = (0..f).find(|&i| loud(i)) {
                    let last = (0..f).rev().find(|&i| loud(i)).unwrap_or(first);
                    // Keep a little air either side.
                    let pad = (0.01 * self.sr) as usize;
                    let s = first.saturating_sub(pad);
                    let e = (last + 1 + pad).min(f);
                    self.a = self.a[s * 2..e * 2].to_vec();
                    let n = self.edge();
                    ramp_edges(&mut self.a, n);
                }
            }
            EditOp::RemoveDc => {
                let f = self.frames().max(1) as f64;
                let (mut l, mut r) = (0.0f64, 0.0f64);
                for i in 0..self.frames() {
                    l += self.a[i * 2] as f64;
                    r += self.a[i * 2 + 1] as f64;
                }
                let (l, r) = ((l / f) as f32, (r / f) as f32);
                for i in 0..self.frames() {
                    self.a[i * 2] -= l;
                    self.a[i * 2 + 1] -= r;
                }
            }
        }
    }

    /// Removes frames `s..e`, crossfading the audio before `s` into the audio before `e`
    /// so the join is seamless and the result is exactly `e - s` frames shorter.
    fn splice_out(&mut self, s: usize, e: usize) {
        let n = ((SPLICE_S * self.sr).round() as usize).min(s).min(e);
        let mut out = Vec::with_capacity(self.a.len() - (e - s) * 2);
        out.extend_from_slice(&self.a[..(s - n) * 2]);
        for i in 0..n {
            let t = (i as f32 + 0.5) / n as f32;
            let (go, gi) = ((t * std::f32::consts::FRAC_PI_2).cos(), (t * std::f32::consts::FRAC_PI_2).sin());
            let (a, b) = (s - n + i, e - n + i);
            out.push(self.a[a * 2] * go + self.a[b * 2] * gi);
            out.push(self.a[a * 2 + 1] * go + self.a[b * 2 + 1] * gi);
        }
        out.extend_from_slice(&self.a[e * 2..]);
        self.a = out;
    }
}

/// Short linear ramps at both ends of interleaved stereo.
fn ramp_edges(a: &mut [f32], n: usize) {
    let f = a.len() / 2;
    let n = n.min(f / 2);
    for i in 0..n {
        let g = i as f32 / n as f32;
        a[i * 2] *= g;
        a[i * 2 + 1] *= g;
        a[(f - 1 - i) * 2] *= g;
        a[(f - 1 - i) * 2 + 1] *= g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    /// A stereo sine whose left channel is `amp` and right `amp / 2`.
    fn tone(seconds: f64, hz: f32, amp: f32) -> Vec<f32> {
        let n = (seconds * SR as f64) as usize;
        (0..n)
            .flat_map(|i| {
                let v = amp * (std::f32::consts::TAU * hz * i as f32 / SR as f32).sin();
                [v, v * 0.5]
            })
            .collect()
    }

    fn secs(a: &[f32]) -> f64 {
        a.len() as f64 / 2.0 / SR as f64
    }

    fn rms(a: &[f32], from: f64, to: f64) -> f32 {
        let (s, e) = ((from * SR as f64) as usize, (to * SR as f64) as usize);
        (a[s * 2..e * 2].iter().step_by(2).map(|x| x * x).sum::<f32>() / (e - s) as f32).sqrt()
    }

    /// Largest jump between neighbouring samples (a click shows as a big one).
    fn max_step(a: &[f32]) -> f32 {
        a.chunks(2).zip(a.chunks(2).skip(1)).map(|(x, y)| (y[0] - x[0]).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn the_original_is_untouched_and_an_empty_list_changes_nothing() {
        let a = tone(1.0, 440.0, 0.5);
        assert_eq!(apply(&a, SR, &[]), a);
        let _ = apply(&a, SR, &[EditOp::Reverse { start: 0.0, end: 1.0 }]);
        assert_eq!(a, tone(1.0, 440.0, 0.5));
    }

    #[test]
    fn trim_delete_and_insert_silence_change_the_length_exactly() {
        let a = tone(2.0, 440.0, 0.5);
        assert!((secs(&apply(&a, SR, &[EditOp::Trim { start: 0.5, end: 1.25 }])) - 0.75).abs() < 1e-4);
        assert!((secs(&apply(&a, SR, &[EditOp::Delete { start: 0.5, end: 1.25 }])) - 1.25).abs() < 1e-4);
        assert!((secs(&apply(&a, SR, &[EditOp::InsertSilence { at: 1.0, seconds: 0.5 }])) - 2.5).abs() < 1e-4);
        // Out-of-range times are clamped, never panic.
        assert!((secs(&apply(&a, SR, &[EditOp::Delete { start: 1.5, end: 99.0 }])) - 1.5).abs() < 1e-4);
        assert_eq!(apply(&a, SR, &[EditOp::Trim { start: 3.0, end: 4.0 }]), a);
    }

    #[test]
    fn a_cut_is_click_free() {
        // Cutting a sine at an arbitrary point would jump; the crossfade keeps it smooth.
        let a = tone(2.0, 220.0, 0.8);
        let out = apply(&a, SR, &[EditOp::Delete { start: 0.5003, end: 1.2171 }]);
        let natural = max_step(&a);
        assert!(max_step(&out) < natural * 1.5, "{} vs {}", max_step(&out), natural);
    }

    #[test]
    fn copy_and_paste_duplicate_a_passage() {
        let mut a = tone(1.0, 440.0, 0.1);
        a.extend(tone(1.0, 440.0, 0.8));
        let out = apply(&a, SR, &[EditOp::Copy { start: 1.0, end: 2.0 }, EditOp::Paste { at: 0.0 }]);
        assert!((secs(&out) - 3.0).abs() < 1e-4);
        assert!(rms(&out, 0.2, 0.8) > 0.5, "the loud second is now first");
        assert!(rms(&out, 1.2, 1.8) < 0.1);
        // Cut then paste moves it: copy, delete, paste.
        let moved = apply(
            &a,
            SR,
            &[
                EditOp::Copy { start: 1.0, end: 2.0 },
                EditOp::Delete { start: 1.0, end: 2.0 },
                EditOp::Paste { at: 0.0 },
            ],
        );
        assert!((secs(&moved) - 2.0).abs() < 1e-4);
        assert!(rms(&moved, 0.2, 0.8) > 0.5 && rms(&moved, 1.2, 1.8) < 0.1);
    }

    #[test]
    fn silence_fade_gain_and_reverse_shape_the_right_part() {
        let a = tone(2.0, 440.0, 0.5);
        let s = apply(&a, SR, &[EditOp::Silence { start: 0.5, end: 1.0 }]);
        assert!(rms(&s, 0.55, 0.95) == 0.0 && rms(&s, 1.1, 1.9) > 0.3);
        let f = apply(&a, SR, &[EditOp::Fade { start: 1.0, end: 2.0, fade_in: false, shape: FadeShape::Linear }]);
        assert!(rms(&f, 1.05, 1.15) > 3.0 * rms(&f, 1.85, 1.95));
        assert!((rms(&f, 0.2, 0.8) - rms(&a, 0.2, 0.8)).abs() < 1e-6);
        let g = apply(&a, SR, &[EditOp::Gain { start: 0.0, end: 2.0, db: -6.0 }]);
        assert!((rms(&g, 0.5, 1.5) / rms(&a, 0.5, 1.5) - 0.501).abs() < 0.01);
        let mut ramp: Vec<f32> = (0..SR as usize).flat_map(|i| [i as f32 / SR as f32, 0.0]).collect();
        ramp = apply(&ramp, SR, &[EditOp::Reverse { start: 0.0, end: 1.0 }]);
        assert!(ramp[2000] > 0.9 && ramp[(SR as usize - 1000) * 2] < 0.1);
        for shape in [FadeShape::Linear, FadeShape::Smooth, FadeShape::Power, FadeShape::Exponential] {
            assert!(shape.gain(0.0) < 1e-3 && (shape.gain(1.0) - 1.0).abs() < 1e-6, "{shape:?}");
        }
    }

    #[test]
    fn normalising_reaches_the_peak_or_the_loudness() {
        let a = tone(3.0, 1000.0, 0.1);
        let p = apply(&a, SR, &[EditOp::Normalize(NormalizeTo::Peak(-1.0))]);
        assert!((measure(&p, SR).1 + 1.0).abs() < 0.01);
        let l = apply(&a, SR, &[EditOp::Normalize(NormalizeTo::Loudness(-20.0))]);
        assert!((measure(&l, SR).0 + 20.0).abs() < 0.3, "{:?}", measure(&l, SR));
        // A loud target stops at −1 dBFS peak.
        let loud = apply(&a, SR, &[EditOp::Normalize(NormalizeTo::Loudness(0.0))]);
        assert!((measure(&loud, SR).1 + 1.0).abs() < 0.01);
        // A blip too short to measure falls back to the peak.
        let blip = apply(&tone(0.1, 1000.0, 0.1), SR, &[EditOp::Normalize(NormalizeTo::Loudness(-14.0))]);
        assert!((measure(&blip, SR).1 + 1.0).abs() < 0.01);
        assert_eq!(apply(&vec![0.0; 1000], SR, &[EditOp::Normalize(NormalizeTo::Peak(0.0))]), vec![0.0; 1000]);
    }

    #[test]
    fn trim_silence_and_dc_removal_clean_a_take() {
        let mut take = vec![0.0f32; SR as usize]; // 0.5 s of silence
        take.extend(tone(1.0, 440.0, 0.5));
        take.extend(vec![0.0f32; SR as usize]);
        let t = apply(&take, SR, &[EditOp::TrimSilence { threshold_db: -48.0 }]);
        assert!((secs(&t) - 1.02).abs() < 0.01, "{}", secs(&t));
        let dc: Vec<f32> = tone(1.0, 440.0, 0.2).iter().map(|x| x + 0.1).collect();
        let fixed = apply(&dc, SR, &[EditOp::RemoveDc]);
        let mean = fixed.iter().step_by(2).sum::<f32>() / (fixed.len() / 2) as f32;
        assert!(mean.abs() < 1e-3);
    }

    #[test]
    fn peaks_cover_the_sound() {
        // 20 bins of 50 ms, each holding several cycles of 100 Hz.
        let a = tone(1.0, 100.0, 0.5);
        let p = peaks(&a, 20);
        assert_eq!(p.len(), 20);
        assert!(p.iter().all(|[lo, hi]| *lo < -0.4 && *hi > 0.4));
        assert_eq!(peaks(&[], 10).len(), 10);
    }
}
