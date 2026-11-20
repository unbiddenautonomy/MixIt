//! Small numeric helpers used everywhere.

pub const PI: f32 = std::f32::consts::PI;
pub const TAU: f32 = std::f32::consts::TAU;

/// Values smaller than this in feedback paths are flushed to zero. Subnormal floats
/// can make some CPUs 100x slower; the host also sets flush-to-zero on the audio thread.
pub const DENORMAL_THRESHOLD: f32 = 1e-20;

/// Flushes tiny values to zero.
#[inline(always)]
pub fn flush(x: f32) -> f32 {
    if x.abs() < DENORMAL_THRESHOLD { 0.0 } else { x }
}

/// Flushes tiny f64 values to zero.
#[inline(always)]
pub fn flush64(x: f64) -> f64 {
    if x.abs() < 1e-30 { 0.0 } else { x }
}

/// Replaces NaN and infinities with zero.
#[inline(always)]
pub fn sanitize(x: f32) -> f32 {
    if x.is_finite() { x } else { 0.0 }
}

/// Converts decibels to linear gain. At or below −120 dB the result is exactly 0.
#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    if db <= -120.0 { 0.0 } else { 10f32.powf(db * 0.05) }
}

/// Converts linear gain to decibels, floored at −120 dB.
#[inline]
pub fn gain_to_db(g: f32) -> f32 {
    if g <= 1e-6 { -120.0 } else { 20.0 * g.log10() }
}

/// Linear interpolation.
#[inline(always)]
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Peak absolute value of a slice.
pub fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

/// Root mean square of a slice.
pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    let s: f64 = x.iter().map(|v| (*v as f64) * (*v as f64)).sum();
    (s / x.len() as f64).sqrt() as f32
}

/// Seconds to a one-pole coefficient: y += (1 − a)(x − y) reaches 63% in `seconds`.
#[inline]
pub fn one_pole_coeff(seconds: f32, sample_rate: f32) -> f32 {
    if seconds <= 0.0 { 0.0 } else { (-1.0 / (seconds * sample_rate)).exp() }
}

/// Equal-power crossfade gains for t in 0..1: (fade-out gain, fade-in gain).
#[inline]
pub fn equal_power(t: f32) -> (f32, f32) {
    let t = t.clamp(0.0, 1.0);
    let a = t * std::f32::consts::FRAC_PI_2;
    (a.cos(), a.sin())
}

/// Raised-cosine fade shape for t in 0..1 (0 → 0, 1 → 1, zero slope at both ends).
#[inline]
pub fn raised_cosine(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    0.5 - 0.5 * (PI * t).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(flush(1e-25), 0.0);
        assert_eq!(flush(0.5), 0.5);
        assert_eq!(sanitize(f32::NAN), 0.0);
        assert_eq!(sanitize(f32::INFINITY), 0.0);
        assert!((db_to_gain(6.0206) - 2.0).abs() < 1e-4);
        assert_eq!(db_to_gain(-130.0), 0.0);
        assert!((gain_to_db(0.1) + 20.0).abs() < 1e-4);
        assert_eq!(peak(&[0.1, -0.7, 0.3]), 0.7);
        assert!((rms(&[1.0, -1.0, 1.0, -1.0]) - 1.0).abs() < 1e-6);
        let (a, b) = equal_power(0.5);
        assert!((a * a + b * b - 1.0).abs() < 1e-6);
        assert_eq!(raised_cosine(0.0), 0.0);
        assert!((raised_cosine(1.0) - 1.0).abs() < 1e-7);
    }
}
