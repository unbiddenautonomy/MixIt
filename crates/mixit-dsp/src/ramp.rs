//! Micro-fades: short gain ramps that hide discontinuities (start, stop, jumps,
//! switches). The shape is a raised cosine so the gain has zero slope at both ends.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Silent,
    FadingIn,
    Open,
    FadingOut,
}

/// A gain envelope that is either fully closed, fully open, or fading between them.
#[derive(Clone, Debug)]
pub struct MicroFade {
    state: State,
    pos: u32,
    len: u32,
}

impl MicroFade {
    /// `frames` is the fade length (5–15 ms is typical).
    pub fn new(frames: u32, open: bool) -> MicroFade {
        MicroFade { state: if open { State::Open } else { State::Silent }, pos: 0, len: frames.max(1) }
    }

    pub fn set_length(&mut self, frames: u32) {
        self.len = frames.max(1);
    }

    pub fn length(&self) -> u32 {
        self.len
    }

    /// Starts opening from the current gain.
    pub fn fade_in(&mut self) {
        match self.state {
            State::Open | State::FadingIn => {}
            State::Silent => {
                self.state = State::FadingIn;
                self.pos = 0;
            }
            State::FadingOut => {
                // Reverse from the current point so the gain stays continuous.
                self.state = State::FadingIn;
                self.pos = self.len - self.pos;
            }
        }
    }

    /// Starts closing from the current gain.
    pub fn fade_out(&mut self) {
        match self.state {
            State::Silent | State::FadingOut => {}
            State::Open => {
                self.state = State::FadingOut;
                self.pos = 0;
            }
            State::FadingIn => {
                self.state = State::FadingOut;
                self.pos = self.len - self.pos;
            }
        }
    }

    pub fn set_open(&mut self, open: bool) {
        self.state = if open { State::Open } else { State::Silent };
        self.pos = 0;
    }

    /// Gain for the next sample.
    #[inline(always)]
    pub fn next(&mut self) -> f32 {
        match self.state {
            State::Open => 1.0,
            State::Silent => 0.0,
            State::FadingIn => {
                self.pos += 1;
                let g = crate::util::raised_cosine(self.pos as f32 / self.len as f32);
                if self.pos >= self.len {
                    self.state = State::Open;
                }
                g
            }
            State::FadingOut => {
                self.pos += 1;
                let g = 1.0 - crate::util::raised_cosine(self.pos as f32 / self.len as f32);
                if self.pos >= self.len {
                    self.state = State::Silent;
                }
                g
            }
        }
    }

    /// Current gain without advancing.
    pub fn gain(&self) -> f32 {
        match self.state {
            State::Open => 1.0,
            State::Silent => 0.0,
            State::FadingIn => crate::util::raised_cosine(self.pos as f32 / self.len as f32),
            State::FadingOut => 1.0 - crate::util::raised_cosine(self.pos as f32 / self.len as f32),
        }
    }

    pub fn is_silent(&self) -> bool {
        self.state == State::Silent
    }

    pub fn is_open(&self) -> bool {
        self.state == State::Open
    }

    pub fn is_fading(&self) -> bool {
        matches!(self.state, State::FadingIn | State::FadingOut)
    }

    /// True once a fade-out has completed or the envelope was never opened.
    pub fn is_closing_or_closed(&self) -> bool {
        matches!(self.state, State::FadingOut | State::Silent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fades_in_and_out() {
        let mut f = MicroFade::new(100, false);
        assert_eq!(f.next(), 0.0);
        f.fade_in();
        let mut last = 0.0;
        for _ in 0..100 {
            let g = f.next();
            assert!(g >= last);
            last = g;
        }
        assert!(f.is_open());
        assert_eq!(f.next(), 1.0);
        f.fade_out();
        for _ in 0..100 {
            f.next();
        }
        assert!(f.is_silent());
    }

    #[test]
    fn reversal_is_continuous() {
        let mut f = MicroFade::new(100, false);
        f.fade_in();
        for _ in 0..30 {
            f.next();
        }
        let before = f.gain();
        f.fade_out();
        let after = f.next();
        assert!((after - before).abs() < 0.05, "{before} -> {after}");
    }
}
