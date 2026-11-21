//! Parameter smoothing.
//!
//! [`Smoothed`] ramps linearly to a new target over a fixed time, then holds exactly.
//! Linear ramps arrive exactly on time and are deterministic, which matters for
//! null tests between live and offline renders. [`OnePole`] is an exponential
//! smoother for meters and control signals that never need to arrive exactly.

/// A linearly smoothed parameter.
#[derive(Clone, Debug)]
pub struct Smoothed {
    current: f32,
    target: f32,
    step: f32,
    remaining: u32,
    ramp_frames: u32,
}

impl Smoothed {
    /// Creates a smoother at `value` that ramps over `ms` milliseconds.
    pub fn new(value: f32, ms: f32, sample_rate: f32) -> Smoothed {
        Smoothed {
            current: value,
            target: value,
            step: 0.0,
            remaining: 0,
            ramp_frames: ((ms * 0.001 * sample_rate).round() as u32).max(1),
        }
    }

    /// Changes the ramp time for future targets.
    pub fn set_time(&mut self, ms: f32, sample_rate: f32) {
        self.ramp_frames = ((ms * 0.001 * sample_rate).round() as u32).max(1);
    }

    /// Sets a new target; the value ramps there over the ramp time.
    #[inline]
    pub fn set(&mut self, target: f32) {
        let target = if target.is_finite() { target } else { self.target };
        if target == self.target && self.remaining == 0 {
            return;
        }
        self.target = target;
        self.remaining = self.ramp_frames;
        self.step = (self.target - self.current) / self.ramp_frames as f32;
    }

    /// Jumps to a value with no ramp (only when the output is silent or not yet running).
    pub fn reset(&mut self, value: f32) {
        self.current = value;
        self.target = value;
        self.remaining = 0;
        self.step = 0.0;
    }

    /// Advances one sample and returns the value.
    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            } else {
                self.current += self.step;
            }
        }
        self.current
    }

    /// Advances `n` samples at once (for control-rate updates).
    #[inline]
    pub fn advance(&mut self, n: u32) -> f32 {
        if self.remaining > 0 {
            if n >= self.remaining {
                self.remaining = 0;
                self.current = self.target;
            } else {
                self.remaining -= n;
                self.current += self.step * n as f32;
            }
        }
        self.current
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.current
    }

    #[inline]
    pub fn target(&self) -> f32 {
        self.target
    }

    #[inline]
    pub fn is_steady(&self) -> bool {
        self.remaining == 0
    }

    /// Fills `out` with successive values.
    pub fn fill(&mut self, out: &mut [f32]) {
        if self.is_steady() {
            out.fill(self.current);
        } else {
            for o in out {
                *o = self.next();
            }
        }
    }
}

/// An exponential one-pole smoother.
#[derive(Clone, Debug)]
pub struct OnePole {
    y: f32,
    a: f32,
}

impl OnePole {
    /// `seconds` is the time constant (63% of the way).
    pub fn new(value: f32, seconds: f32, sample_rate: f32) -> OnePole {
        OnePole { y: value, a: crate::util::one_pole_coeff(seconds, sample_rate) }
    }

    #[inline(always)]
    pub fn next(&mut self, x: f32) -> f32 {
        self.y = crate::util::flush(x + self.a * (self.y - x));
        self.y
    }

    pub fn value(&self) -> f32 {
        self.y
    }

    pub fn reset(&mut self, v: f32) {
        self.y = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrives_exactly_on_time() {
        let mut s = Smoothed::new(0.0, 10.0, 48_000.0);
        s.set(1.0);
        let mut last = 0.0;
        for i in 0..480 {
            let v = s.next();
            assert!(v >= last, "monotonic at {i}");
            last = v;
        }
        assert_eq!(s.value(), 1.0);
        assert!(s.is_steady());
        assert_eq!(s.next(), 1.0);
    }

    #[test]
    fn retarget_mid_ramp_is_continuous() {
        let mut s = Smoothed::new(0.0, 10.0, 48_000.0);
        s.set(1.0);
        for _ in 0..240 {
            s.next();
        }
        let mid = s.value();
        s.set(0.0);
        let after = s.next();
        assert!((after - mid).abs() < 0.01);
    }

    #[test]
    fn advance_matches_next() {
        let mut a = Smoothed::new(0.0, 5.0, 48_000.0);
        let mut b = a.clone();
        a.set(2.0);
        b.set(2.0);
        for _ in 0..100 {
            a.next();
        }
        b.advance(100);
        assert!((a.value() - b.value()).abs() < 1e-5);
    }

    #[test]
    fn ignores_nan() {
        let mut s = Smoothed::new(0.5, 10.0, 48_000.0);
        s.set(f32::NAN);
        assert_eq!(s.next(), 0.5);
    }

    #[test]
    fn one_pole_converges() {
        let mut p = OnePole::new(0.0, 0.01, 48_000.0);
        for _ in 0..48_000 {
            p.next(1.0);
        }
        // f32 one-poles stall within a few ulps·τ of the target; 1e-4 is far below audible.
        assert!((p.value() - 1.0).abs() < 1e-4);
    }
}
