//! A tiny deterministic random number generator (xoshiro128** seeded by SplitMix64).
//! Used for noise effects, dither and the practice-track generator. Same seed, same
//! sequence, on every platform.

#[derive(Clone, Debug)]
pub struct Rng {
    s: [u32; 4],
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            x ^ (x >> 31)
        };
        let a = next();
        let b = next();
        let mut s = [a as u32, (a >> 32) as u32, b as u32, (b >> 32) as u32];
        if s == [0; 4] {
            s[0] = 1;
        }
        Rng { s }
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 9;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(11);
        result
    }

    /// Uniform in [0, 1).
    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Uniform in [−1, 1).
    #[inline]
    pub fn bipolar(&mut self) -> f32 {
        self.next_f32() * 2.0 - 1.0
    }

    /// Uniform integer in [0, n).
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as u64 * n as u64) >> 32) as u32
    }

    /// Triangular-PDF dither noise in [−1, 1).
    #[inline]
    pub fn tpdf(&mut self) -> f32 {
        self.next_f32() - self.next_f32()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_uniform() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);
        let mut sum = 0.0f64;
        for _ in 0..100_000 {
            let x = a.next_f32();
            assert_eq!(x, b.next_f32());
            assert!((0.0..1.0).contains(&x));
            sum += x as f64;
        }
        assert!((sum / 100_000.0 - 0.5).abs() < 0.01);
        assert_ne!(Rng::new(1).next_u32(), Rng::new(2).next_u32());
        let mut r = Rng::new(7);
        for _ in 0..1000 {
            assert!(r.below(10) < 10);
        }
    }
}
