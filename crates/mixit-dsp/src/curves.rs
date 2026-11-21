//! Crossfader, channel-fader and pan curves.

use std::f32::consts::FRAC_PI_2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CrossfaderCurve {
    /// Linear amplitude: −6 dB each at the centre. Good for long blends.
    SmoothBlend,
    /// cos/sin law: −3 dB each at the centre, constant power for unrelated material.
    #[default]
    ConstantPower,
    /// Both sides fully open except in the last few percent of travel (scratching, cuts).
    SharpCut,
}

/// Width of the cut region of the sharp curve, as a fraction of travel.
pub const SHARP_CUT_WIDTH: f32 = 0.04;

/// Gains (A, B) for crossfader position x in −1 (full A) … +1 (full B).
pub fn crossfader_gains(x: f32, curve: CrossfaderCurve, reverse: bool) -> (f32, f32) {
    let x = if reverse { -x } else { x };
    let t = ((x.clamp(-1.0, 1.0) + 1.0) * 0.5).clamp(0.0, 1.0);
    match curve {
        CrossfaderCurve::SmoothBlend => (1.0 - t, t),
        CrossfaderCurve::ConstantPower => ((t * FRAC_PI_2).cos(), (t * FRAC_PI_2).sin()),
        CrossfaderCurve::SharpCut => {
            let a = ((1.0 - t) / SHARP_CUT_WIDTH).min(1.0);
            let b = (t / SHARP_CUT_WIDTH).min(1.0);
            (a, b)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum FaderCurve {
    /// Gain equals travel.
    Linear,
    /// Gain is travel squared: more resolution at low levels.
    #[default]
    Smooth,
    /// Gets loud quickly: 1 − (1 − p)³.
    Steep,
}

/// Gain for channel-fader travel p in 0..1.
pub fn fader_gain(p: f32, curve: FaderCurve) -> f32 {
    let p = p.clamp(0.0, 1.0);
    match curve {
        FaderCurve::Linear => p,
        FaderCurve::Smooth => p * p,
        FaderCurve::Steep => 1.0 - (1.0 - p).powi(3),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PanLaw {
    /// Balance control: centre is 0 dB on both sides.
    ZeroDb,
    /// Constant power, −3 dB at centre.
    #[default]
    Minus3,
    /// Compromise, −4.5 dB at centre.
    Minus4_5,
    /// Linear, −6 dB at centre.
    Minus6,
}

/// Gains (L, R) for pan position −1 (left) … +1 (right).
pub fn pan_gains(pan: f32, law: PanLaw) -> (f32, f32) {
    let p = pan.clamp(-1.0, 1.0);
    let t = (p + 1.0) * 0.5;
    let lin = (1.0 - t, t);
    let pow = ((t * FRAC_PI_2).cos(), (t * FRAC_PI_2).sin());
    match law {
        PanLaw::ZeroDb => ((1.0 - p).min(1.0), (1.0 + p).min(1.0)),
        PanLaw::Minus3 => pow,
        PanLaw::Minus4_5 => ((lin.0 * pow.0).sqrt(), (lin.1 * pow.1).sqrt()),
        PanLaw::Minus6 => lin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(x: f32) -> f32 {
        20.0 * x.log10()
    }

    #[test]
    fn crossfader_ends_and_centre() {
        for c in [CrossfaderCurve::SmoothBlend, CrossfaderCurve::ConstantPower, CrossfaderCurve::SharpCut] {
            let (a, b) = crossfader_gains(-1.0, c, false);
            assert!((a - 1.0).abs() < 1e-6 && b.abs() < 1e-6, "{c:?}");
            let (a, b) = crossfader_gains(1.0, c, false);
            assert!(a.abs() < 1e-6 && (b - 1.0).abs() < 1e-6);
        }
        let (a, b) = crossfader_gains(0.0, CrossfaderCurve::ConstantPower, false);
        assert!((db(a) + 3.01).abs() < 0.01 && (db(b) + 3.01).abs() < 0.01);
        let (a, b) = crossfader_gains(0.0, CrossfaderCurve::SharpCut, false);
        assert_eq!((a, b), (1.0, 1.0));
        let (a, _) = crossfader_gains(-1.0, CrossfaderCurve::SmoothBlend, true);
        assert!(a.abs() < 1e-6);
    }

    #[test]
    fn constant_power_holds_power() {
        for i in 0..=100 {
            let x = i as f32 / 50.0 - 1.0;
            let (a, b) = crossfader_gains(x, CrossfaderCurve::ConstantPower, false);
            let p = db((a * a + b * b).sqrt());
            assert!(p.abs() < 0.5, "{x}: {p}");
        }
    }

    #[test]
    fn faders_monotonic() {
        for c in [FaderCurve::Linear, FaderCurve::Smooth, FaderCurve::Steep] {
            let mut last = -1.0;
            for i in 0..=100 {
                let g = fader_gain(i as f32 / 100.0, c);
                assert!(g >= last);
                last = g;
            }
            assert_eq!(fader_gain(0.0, c), 0.0);
            assert!((fader_gain(1.0, c) - 1.0).abs() < 1e-6);
        }
    }

    #[test]
    fn pan_laws_at_centre() {
        let (l, r) = pan_gains(0.0, PanLaw::Minus3);
        assert!((db(l) + 3.01).abs() < 0.01 && (db(r) + 3.01).abs() < 0.01);
        let (l, _) = pan_gains(0.0, PanLaw::Minus6);
        assert!((db(l) + 6.02).abs() < 0.01);
        let (l, _) = pan_gains(0.0, PanLaw::Minus4_5);
        assert!((db(l) + 4.52).abs() < 0.05);
        assert_eq!(pan_gains(0.0, PanLaw::ZeroDb), (1.0, 1.0));
        assert_eq!(pan_gains(-1.0, PanLaw::ZeroDb), (1.0, 0.0));
    }
}
