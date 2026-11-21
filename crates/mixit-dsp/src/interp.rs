//! Band-limited interpolation for variable-speed playback.
//!
//! [`SincTable`] is a polyphase Kaiser-windowed sinc kernel. Decks read tracks through
//! it whenever the playback rate is not exactly 1, so speed changes do not add the
//! metallic aliasing of linear interpolation. Scratching uses cubic Hermite, which is
//! cheaper and good enough at the extreme rates involved.

/// Zeroth-order modified Bessel function (series), for Kaiser windows.
pub fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..64 {
        term *= q / (k as f64 * k as f64);
        sum += term;
        if term < sum * 1e-16 {
            break;
        }
    }
    sum
}

/// Kaiser window value at x in −1..1.
pub fn kaiser(x: f64, beta: f64) -> f64 {
    if x.abs() > 1.0 {
        return 0.0;
    }
    bessel_i0(beta * (1.0 - x * x).sqrt()) / bessel_i0(beta)
}

#[inline]
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// A polyphase windowed-sinc interpolation kernel.
#[derive(Clone, Debug)]
pub struct SincTable {
    taps: usize,
    phases: usize,
    table: Vec<f32>,
}

impl SincTable {
    /// `taps` (even) per output sample, `phases` table resolution, `cutoff` as a fraction
    /// of Nyquist (0.9–0.97), `beta` Kaiser shape (8–10).
    pub fn new(taps: usize, phases: usize, cutoff: f64, beta: f64) -> SincTable {
        assert!(taps % 2 == 0 && taps >= 4);
        let half = (taps / 2) as f64;
        let mut table = vec![0.0f32; (phases + 1) * taps];
        for p in 0..=phases {
            let frac = p as f64 / phases as f64;
            let mut row = vec![0.0f64; taps];
            for (k, r) in row.iter_mut().enumerate() {
                let x = k as f64 - (half - 1.0) - frac;
                *r = cutoff * sinc(cutoff * x) * kaiser(x / half, beta);
            }
            let sum: f64 = row.iter().sum();
            for k in 0..taps {
                table[p * taps + k] = (row[k] / sum) as f32;
            }
        }
        SincTable { taps, phases, table }
    }

    /// The default playback kernel: 16 taps, 512 phases.
    pub fn playback() -> SincTable {
        SincTable::new(16, 512, 0.94, 9.0)
    }

    pub fn taps(&self) -> usize {
        self.taps
    }

    /// Latency in frames (half the kernel).
    pub fn latency(&self) -> f64 {
        (self.taps / 2 - 1) as f64
    }

    /// Interpolates an interleaved stereo buffer at fractional frame `pos`.
    /// Positions outside the buffer read as silence.
    #[inline]
    pub fn read_stereo(&self, data: &[f32], frames: usize, pos: f64) -> (f32, f32) {
        let base = pos.floor();
        let frac = (pos - base) as f32;
        let i0 = base as i64;
        let fp = frac * self.phases as f32;
        let p = (fp as usize).min(self.phases - 1);
        let t = fp - p as f32;
        let row0 = &self.table[p * self.taps..(p + 1) * self.taps];
        let row1 = &self.table[(p + 1) * self.taps..(p + 2) * self.taps];
        let start = i0 - (self.taps as i64 / 2 - 1);
        let mut l = 0.0f32;
        let mut r = 0.0f32;
        if start >= 0 && (start as usize + self.taps) <= frames {
            let s = start as usize;
            for k in 0..self.taps {
                let h = row0[k] + (row1[k] - row0[k]) * t;
                l += data[(s + k) * 2] * h;
                r += data[(s + k) * 2 + 1] * h;
            }
        } else {
            for k in 0..self.taps {
                let idx = start + k as i64;
                if idx >= 0 && (idx as usize) < frames {
                    let h = row0[k] + (row1[k] - row0[k]) * t;
                    l += data[idx as usize * 2] * h;
                    r += data[idx as usize * 2 + 1] * h;
                }
            }
        }
        (l, r)
    }
}

/// Cubic Hermite read of an interleaved stereo buffer at fractional frame `pos`.
#[inline]
pub fn hermite_stereo(data: &[f32], frames: usize, pos: f64) -> (f32, f32) {
    let base = pos.floor();
    let t = (pos - base) as f32;
    let i = base as i64;
    let get =
        |k: i64, c: usize| -> f32 { if k >= 0 && (k as usize) < frames { data[k as usize * 2 + c] } else { 0.0 } };
    let l = crate::delay::hermite(get(i - 1, 0), get(i, 0), get(i + 1, 0), get(i + 2, 0), t);
    let r = crate::delay::hermite(get(i - 1, 1), get(i, 1), get(i + 1, 1), get(i + 2, 1), t);
    (l, r)
}

/// Direct read of an interleaved stereo frame (silence outside the buffer).
#[inline(always)]
pub fn frame_at(data: &[f32], frames: usize, idx: i64) -> (f32, f32) {
    if idx >= 0 && (idx as usize) < frames {
        let i = idx as usize * 2;
        (data[i], data[i + 1])
    } else {
        (0.0, 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_positions_are_near_exact() {
        let t = SincTable::playback();
        let frames = 1000;
        let data: Vec<f32> = (0..frames * 2).map(|i| ((i / 2) as f32 * 0.01).sin()).collect();
        for p in [100usize, 400, 777] {
            let (l, _) = t.read_stereo(&data, frames, p as f64);
            assert!((l - data[p * 2]).abs() < 1e-3, "{l} vs {}", data[p * 2]);
        }
    }

    #[test]
    fn fractional_sine_is_accurate() {
        let t = SincTable::playback();
        let frames = 4000;
        let w = 0.05f64;
        let data: Vec<f32> = (0..frames * 2).map(|i| ((i / 2) as f64 * w).sin() as f32).collect();
        let mut max_err = 0.0f32;
        for k in 0..500 {
            let pos = 1000.0 + k as f64 * 3.37;
            let (l, _) = t.read_stereo(&data, frames, pos);
            max_err = max_err.max((l - (pos * w).sin() as f32).abs());
        }
        assert!(max_err < 2e-3, "max error {max_err}");
    }

    #[test]
    fn out_of_range_is_silent() {
        let t = SincTable::playback();
        let data = vec![1.0f32; 200];
        assert_eq!(t.read_stereo(&data, 100, -50.0), (0.0, 0.0));
        assert_eq!(t.read_stereo(&data, 100, 500.0), (0.0, 0.0));
        assert_eq!(frame_at(&data, 100, 100), (0.0, 0.0));
    }

    #[test]
    fn bessel() {
        assert!((bessel_i0(0.0) - 1.0).abs() < 1e-12);
        assert!((bessel_i0(1.0) - 1.266_065_877_752_008).abs() < 1e-12);
    }
}
