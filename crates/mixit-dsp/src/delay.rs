//! Delay lines with fractional (cubic Hermite) reads. Capacity is fixed at
//! construction; reads beyond it are clamped.

/// A single-channel circular delay line.
#[derive(Clone, Debug)]
pub struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    write: usize,
}

impl DelayLine {
    /// Holds at least `max_frames` of history.
    pub fn new(max_frames: usize) -> DelayLine {
        let cap = (max_frames + 4).next_power_of_two();
        DelayLine { buf: vec![0.0; cap], mask: cap - 1, write: 0 }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len() - 4
    }

    pub fn clear(&mut self) {
        self.buf.fill(0.0);
    }

    #[inline(always)]
    pub fn push(&mut self, x: f32) {
        self.buf[self.write] = x;
        self.write = (self.write + 1) & self.mask;
    }

    /// Sample written `d` pushes ago (d = 1 is the most recent).
    #[inline(always)]
    pub fn tap(&self, d: usize) -> f32 {
        let d = d.min(self.capacity());
        self.buf[(self.write.wrapping_sub(d)) & self.mask]
    }

    /// Fractional delay read with cubic Hermite interpolation (d ≥ 1).
    #[inline(always)]
    pub fn read(&self, d: f32) -> f32 {
        let d = d.clamp(1.0, (self.capacity() - 2) as f32);
        let di = d.floor() as usize;
        let f = d - di as f32;
        let xm1 = self.tap(di - 1 + if di > 1 { 0 } else { 1 });
        let x0 = self.tap(di);
        let x1 = self.tap(di + 1);
        let x2 = self.tap(di + 2);
        hermite(xm1, x0, x1, x2, f)
    }
}

/// Cubic Hermite (Catmull-Rom) interpolation between x0 and x1 at fraction t.
#[inline(always)]
pub fn hermite(xm1: f32, x0: f32, x1: f32, x2: f32, t: f32) -> f32 {
    let c0 = x0;
    let c1 = 0.5 * (x1 - xm1);
    let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    ((c3 * t + c2) * t + c1) * t + c0
}

/// A stereo delay line.
#[derive(Clone, Debug)]
pub struct StereoDelay {
    pub l: DelayLine,
    pub r: DelayLine,
}

impl StereoDelay {
    pub fn new(max_frames: usize) -> StereoDelay {
        StereoDelay { l: DelayLine::new(max_frames), r: DelayLine::new(max_frames) }
    }

    pub fn clear(&mut self) {
        self.l.clear();
        self.r.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_and_fractional_reads() {
        let mut d = DelayLine::new(100);
        for i in 0..50 {
            d.push(i as f32);
        }
        assert_eq!(d.tap(1), 49.0);
        assert_eq!(d.tap(10), 40.0);
        // Hermite on a straight line is exact.
        assert!((d.read(10.5) - 39.5).abs() < 1e-5);
        assert!((d.read(3.25) - 46.75).abs() < 1e-5);
    }

    #[test]
    fn hermite_endpoints() {
        assert_eq!(hermite(0.0, 1.0, 2.0, 3.0, 0.0), 1.0);
        assert_eq!(hermite(0.0, 1.0, 2.0, 3.0, 1.0), 2.0);
    }
}
