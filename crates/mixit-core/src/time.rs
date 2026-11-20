//! Sample-frame time and conversions.

/// An integer position or length in sample frames (one frame = one sample per channel).
pub type Frame = i64;

/// The engine's preferred sample rate when the device lets us choose.
pub const DEFAULT_SAMPLE_RATE: u32 = 48_000;

/// Converts a frame count to seconds.
#[inline]
pub fn frames_to_seconds(frames: f64, sample_rate: u32) -> f64 {
    frames / sample_rate as f64
}

/// Converts seconds to a (fractional) frame count.
#[inline]
pub fn seconds_to_frames(seconds: f64, sample_rate: u32) -> f64 {
    seconds * sample_rate as f64
}

/// Converts milliseconds to a whole number of frames, rounding to nearest, at least 1.
#[inline]
pub fn ms_to_frames(ms: f32, sample_rate: f32) -> usize {
    ((ms * 0.001 * sample_rate).round() as usize).max(1)
}

/// Formats a position as `m:ss.mmm` for readouts and logs.
pub fn format_time(seconds: f64) -> String {
    let negative = seconds < 0.0;
    let s = seconds.abs();
    let minutes = (s / 60.0).floor() as u64;
    let rest = s - minutes as f64 * 60.0;
    format!("{}{}:{:06.3}", if negative { "-" } else { "" }, minutes, rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_round_trip() {
        let f = seconds_to_frames(12.5, 48_000);
        assert_eq!(f, 600_000.0);
        assert_eq!(frames_to_seconds(f, 48_000), 12.5);
        assert_eq!(ms_to_frames(10.0, 48_000.0), 480);
        assert_eq!(ms_to_frames(0.0, 48_000.0), 1);
    }

    #[test]
    fn f64_resolves_single_samples_after_hours() {
        // Two hours at 192 kHz is still exact to a fraction of a sample in f64.
        let p = 2.0 * 3600.0 * 192_000.0_f64;
        assert_ne!(p + 0.25, p);
    }

    #[test]
    fn formats_time() {
        assert_eq!(format_time(65.25), "1:05.250");
        assert_eq!(format_time(-1.5), "-0:01.500");
    }
}
