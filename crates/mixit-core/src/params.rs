//! Parameter specifications: range, unit, taper, default and smoothing.
//!
//! Every continuous control in MixIt is described by a [`ParamSpec`]. The UI maps
//! knob and fader travel through the taper ("normalised" 0..1 ↔ plain value), the
//! engine smooths changes over `smoothing_ms`, and explain mode and screen readers
//! format values with [`ParamSpec::format`].

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Unit {
    None,
    Decibels,
    Hertz,
    Percent,
    Milliseconds,
    Seconds,
    Beats,
    Semitones,
    Ratio,
    Bpm,
    Pan,
}

/// How normalised travel (0..1) maps to the plain value.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Taper {
    /// Straight line from min to max.
    Linear,
    /// Exponential (equal ratio per unit of travel); for frequencies and times. min > 0.
    Logarithmic,
    /// Plain = min + (max − min)·n^exponent.
    Power(f32),
    /// Two linear halves around the default at n = 0.5 (EQ gains, pan, bipolar filter).
    Centered,
    /// Channel and master faders: n = 0 is silence (−∞ dB), then a dB curve up to max.
    Fader,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ParamSpec {
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: Unit,
    pub taper: Taper,
    /// Smoothing applied by the engine to changes of this parameter.
    pub smoothing_ms: f32,
    /// Snap step for keyboard and fine adjustment (plain units); 0 = continuous.
    pub step: f32,
}

impl ParamSpec {
    pub const fn new(min: f32, max: f32, default: f32, unit: Unit, taper: Taper) -> ParamSpec {
        ParamSpec { min, max, default, unit, taper, smoothing_ms: 20.0, step: 0.0 }
    }

    pub const fn smoothing(mut self, ms: f32) -> ParamSpec {
        self.smoothing_ms = ms;
        self
    }

    pub const fn step(mut self, step: f32) -> ParamSpec {
        self.step = step;
        self
    }

    pub fn clamp(&self, v: f32) -> f32 {
        if v.is_nan() { self.default } else { v.clamp(self.min, self.max) }
    }

    /// Plain value → normalised travel 0..1.
    pub fn to_normalized(&self, value: f32) -> f32 {
        let v = self.clamp(value);
        let n = match self.taper {
            Taper::Linear => (v - self.min) / (self.max - self.min),
            Taper::Logarithmic => (v / self.min).ln() / (self.max / self.min).ln(),
            Taper::Power(e) => ((v - self.min) / (self.max - self.min)).powf(1.0 / e),
            Taper::Centered => {
                if v >= self.default {
                    0.5 + 0.5 * (v - self.default) / (self.max - self.default)
                } else {
                    0.5 - 0.5 * (self.default - v) / (self.default - self.min)
                }
            }
            Taper::Fader => fader_db_to_norm(v, self.min, self.max),
        };
        n.clamp(0.0, 1.0)
    }

    /// Normalised travel 0..1 → plain value.
    pub fn from_normalized(&self, n: f32) -> f32 {
        let n = if n.is_nan() { self.to_normalized(self.default) } else { n.clamp(0.0, 1.0) };
        let v = match self.taper {
            Taper::Linear => self.min + n * (self.max - self.min),
            Taper::Logarithmic => self.min * (self.max / self.min).powf(n),
            Taper::Power(e) => self.min + (self.max - self.min) * n.powf(e),
            Taper::Centered => {
                if n >= 0.5 {
                    self.default + (n - 0.5) * 2.0 * (self.max - self.default)
                } else {
                    self.default - (0.5 - n) * 2.0 * (self.default - self.min)
                }
            }
            Taper::Fader => fader_norm_to_db(n, self.min, self.max),
        };
        let v = if self.step > 0.0 { (v / self.step).round() * self.step } else { v };
        self.clamp(v)
    }

    /// Formats a value for readouts, tooltips and screen readers.
    pub fn format(&self, v: f32) -> String {
        match self.unit {
            Unit::Decibels => {
                if v <= self.min && matches!(self.taper, Taper::Fader) || v <= -120.0 {
                    "-inf dB".to_string()
                } else {
                    format!("{:+.1} dB", v)
                }
            }
            Unit::Hertz => {
                if v >= 1000.0 {
                    format!("{:.2} kHz", v / 1000.0)
                } else {
                    format!("{:.0} Hz", v)
                }
            }
            Unit::Percent => format!("{:+.2}%", v),
            Unit::Milliseconds => format!("{:.1} ms", v),
            Unit::Seconds => format!("{:.2} s", v),
            Unit::Beats => format_beats(v),
            Unit::Semitones => format!("{:+.2} st", v),
            Unit::Ratio => format!("{:.2}:1", v),
            Unit::Bpm => format!("{:.2} BPM", v),
            Unit::Pan => {
                if v.abs() < 0.005 {
                    "C".to_string()
                } else if v < 0.0 {
                    format!("L{:.0}", -v * 100.0)
                } else {
                    format!("R{:.0}", v * 100.0)
                }
            }
            Unit::None => format!("{:.2}", v),
        }
    }
}

/// Formats a beat length as "1/4", "1", "16".
pub fn format_beats(v: f32) -> String {
    if v >= 1.0 || v <= 0.0 { format!("{}", v) } else { format!("1/{}", (1.0 / v).round()) }
}

// Fader law: the top 75% of travel covers max..−30 dB linearly in dB, the bottom 25%
// covers −30 dB..−∞ with a gentle curve (so the last few millimetres still fade out).
const FADER_KNEE_N: f32 = 0.25;
const FADER_KNEE_DB: f32 = -30.0;

fn fader_norm_to_db(n: f32, min: f32, max: f32) -> f32 {
    if n <= 0.0 {
        return min;
    }
    if n >= FADER_KNEE_N {
        FADER_KNEE_DB + (n - FADER_KNEE_N) / (1.0 - FADER_KNEE_N) * (max - FADER_KNEE_DB)
    } else {
        // Below the knee: amplitude rises with the square of travel up to the knee level.
        let knee_amp = 10f32.powf(FADER_KNEE_DB / 20.0);
        let amp = knee_amp * (n / FADER_KNEE_N).powi(2);
        (20.0 * amp.log10()).max(min)
    }
}

fn fader_db_to_norm(db: f32, min: f32, max: f32) -> f32 {
    if db <= min {
        return 0.0;
    }
    if db >= FADER_KNEE_DB {
        FADER_KNEE_N + (db - FADER_KNEE_DB) / (max - FADER_KNEE_DB) * (1.0 - FADER_KNEE_N)
    } else {
        let knee_amp = 10f32.powf(FADER_KNEE_DB / 20.0);
        let amp = 10f32.powf(db / 20.0);
        FADER_KNEE_N * (amp / knee_amp).sqrt()
    }
}

/// Converts decibels to linear gain. Anything at or below −120 dB is silence.
#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    if db <= -120.0 { 0.0 } else { 10f32.powf(db * 0.05) }
}

/// Converts linear gain to decibels, flooring at −120 dB.
#[inline]
pub fn gain_to_db(g: f32) -> f32 {
    if g <= 1e-6 { -120.0 } else { 20.0 * g.log10() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_and_log() {
        let p = ParamSpec::new(0.0, 10.0, 5.0, Unit::None, Taper::Linear);
        assert_eq!(p.to_normalized(2.5), 0.25);
        assert_eq!(p.from_normalized(0.25), 2.5);
        let f = ParamSpec::new(20.0, 20_000.0, 1_000.0, Unit::Hertz, Taper::Logarithmic);
        assert!((f.from_normalized(0.5) - 632.4555).abs() < 0.01);
        assert!((f.to_normalized(f.from_normalized(0.3)) - 0.3).abs() < 1e-5);
        assert_eq!(f.format(1_500.0), "1.50 kHz");
    }

    #[test]
    fn centered_eq() {
        let eq = ParamSpec::new(-26.0, 6.0, 0.0, Unit::Decibels, Taper::Centered);
        assert_eq!(eq.from_normalized(0.5), 0.0);
        assert_eq!(eq.from_normalized(0.0), -26.0);
        assert_eq!(eq.from_normalized(1.0), 6.0);
        assert_eq!(eq.to_normalized(-13.0), 0.25);
        assert_eq!(eq.format(-6.0), "-6.0 dB");
    }

    #[test]
    fn fader_law_is_monotonic_and_invertible() {
        let fader = ParamSpec::new(-120.0, 0.0, 0.0, Unit::Decibels, Taper::Fader);
        let mut last = -1000.0;
        for i in 0..=100 {
            let n = i as f32 / 100.0;
            let db = fader.from_normalized(n);
            assert!(db >= last, "not monotonic at {n}");
            last = db;
            if n > 0.0 {
                assert!((fader.to_normalized(db) - n).abs() < 1e-3);
            }
        }
        assert_eq!(fader.from_normalized(0.0), -120.0);
        assert_eq!(fader.from_normalized(1.0), 0.0);
        assert_eq!(fader.format(-120.0), "-inf dB");
    }

    #[test]
    fn steps_and_nan() {
        let p = ParamSpec::new(-12.0, 12.0, 0.0, Unit::Semitones, Taper::Linear).step(1.0);
        assert_eq!(p.from_normalized(0.52), 0.0);
        assert_eq!(p.from_normalized(f32::NAN), 0.0);
        assert_eq!(p.clamp(f32::NAN), 0.0);
    }

    #[test]
    fn db_gain() {
        assert!((db_to_gain(-6.0) - 0.501_187).abs() < 1e-5);
        assert_eq!(db_to_gain(-200.0), 0.0);
        assert!((gain_to_db(0.5) + 6.0206).abs() < 1e-3);
        assert_eq!(format_beats(0.25), "1/4");
        assert_eq!(format_beats(4.0), "4");
    }
}
