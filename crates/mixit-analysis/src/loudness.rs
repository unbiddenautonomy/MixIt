//! Loudness (EBU R128 / ITU-R BS.1770), true peak and the gain that levels tracks.

use mixit_dsp::meters::{LoudnessMeter, TruePeakMeter};
use serde::{Deserialize, Serialize};

/// Loudness the auto-gain brings tracks to (LUFS). Club-ready masters sit near −8 to
/// −6 LUFS, so −12 leaves the mixer and limiter headroom without sounding quiet.
pub const DEFAULT_TARGET_LUFS: f64 = -12.0;
/// Auto-gain never moves a track by more than this (dB).
pub const MAX_AUTO_GAIN_DB: f64 = 12.0;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Loudness {
    /// Gated integrated loudness (LUFS); −70 for silence.
    pub integrated_lufs: f64,
    /// Loudness range (LU).
    pub range_lu: f64,
    /// Maximum short-term (3 s) loudness (LUFS).
    pub max_short_term_lufs: f64,
    /// 4× oversampled true peak (dBTP).
    pub true_peak_dbtp: f32,
    /// Largest sample (dBFS).
    pub sample_peak_dbfs: f32,
    /// Peak-to-loudness ratio (dB): low values mean heavy limiting.
    pub plr_db: f64,
    /// Gain that brings the track to the target, limited by its peak headroom (dB).
    pub auto_gain_db: f64,
    /// Short-term loudness every `curve_step` seconds, for energy and mix planning.
    pub curve: Vec<f32>,
    pub curve_step: f64,
}

/// Measures an interleaved stereo signal.
pub fn measure(interleaved: &[f32], sample_rate: u32, target_lufs: f64) -> Loudness {
    let sr = sample_rate as f32;
    let mut meter = LoudnessMeter::new(sr);
    let mut tp = TruePeakMeter::new();
    let block = (sample_rate as usize / 10).max(1); // 100 ms
    let step_blocks = 5; // curve point every 0.5 s
    let mut l = vec![0.0f32; block];
    let mut r = vec![0.0f32; block];
    let mut curve = Vec::new();
    let mut max_st = -f64::INFINITY;
    let mut peak = 0.0f32;
    let frames = interleaved.len() / 2;
    let mut pos = 0;
    let mut blocks = 0;
    while pos < frames {
        let n = block.min(frames - pos);
        for i in 0..n {
            l[i] = interleaved[2 * (pos + i)];
            r[i] = interleaved[2 * (pos + i) + 1];
            peak = peak.max(l[i].abs()).max(r[i].abs());
        }
        meter.process(&l[..n], &r[..n]);
        tp.process(&l[..n], &r[..n]);
        pos += n;
        blocks += 1;
        let st = meter.short_term();
        if blocks >= 30 {
            max_st = max_st.max(st);
        }
        if blocks % step_blocks == 0 {
            curve.push(st.max(-70.0) as f32);
        }
    }
    let integrated = meter.integrated();
    let integrated = if integrated.is_finite() { integrated } else { -70.0 };
    let true_peak = tp.max_dbtp().max(-120.0);
    let sample_peak = if peak > 0.0 { 20.0 * peak.log10() } else { -120.0 };
    // Do not raise a quiet track so far that its peaks would hit the limiter hard:
    // allow peaks up to +3 dBTP before the master limiter (which catches the rest).
    let wanted = target_lufs - integrated;
    let headroom = 3.0 - true_peak as f64;
    let auto_gain = if integrated <= -69.0 {
        0.0
    } else if wanted <= 0.0 {
        wanted
    } else {
        wanted.min(headroom.max(0.0))
    };
    Loudness {
        integrated_lufs: integrated,
        range_lu: meter.loudness_range(),
        max_short_term_lufs: if max_st.is_finite() { max_st } else { integrated },
        true_peak_dbtp: true_peak,
        sample_peak_dbfs: sample_peak,
        plr_db: true_peak as f64 - integrated,
        auto_gain_db: auto_gain.clamp(-MAX_AUTO_GAIN_DB, MAX_AUTO_GAIN_DB),
        curve,
        curve_step: 0.5,
    }
}
