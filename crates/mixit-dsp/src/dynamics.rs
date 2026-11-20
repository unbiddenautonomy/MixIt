//! Dynamics: envelope followers, compressor, gate/expander and a look-ahead
//! true-peak limiter.
//!
//! The compressor follows Giannoulis, Massberg and Reiss, "Digital Dynamic Range
//! Compressor Design — A Tutorial and Analysis" (JAES 2012): a log-domain soft-knee
//! gain computer feeding a smooth branching peak detector on the gain reduction.

use crate::oversample::TruePeakDetector;
use crate::svf::{Svf, SvfCoeffs, SvfMode};
use crate::util::{db_to_gain, flush, one_pole_coeff};
use std::f32::consts::FRAC_1_SQRT_2;

/// Attack/release envelope follower on a rectified signal.
#[derive(Clone, Debug)]
pub struct EnvelopeFollower {
    env: f32,
    att: f32,
    rel: f32,
}

impl EnvelopeFollower {
    pub fn new(attack_s: f32, release_s: f32, sr: f32) -> EnvelopeFollower {
        EnvelopeFollower { env: 0.0, att: one_pole_coeff(attack_s, sr), rel: one_pole_coeff(release_s, sr) }
    }

    pub fn set_times(&mut self, attack_s: f32, release_s: f32, sr: f32) {
        self.att = one_pole_coeff(attack_s, sr);
        self.rel = one_pole_coeff(release_s, sr);
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let a = if x > self.env { self.att } else { self.rel };
        self.env = flush(x + a * (self.env - x));
        self.env
    }

    pub fn value(&self) -> f32 {
        self.env
    }

    pub fn reset(&mut self) {
        self.env = 0.0;
    }
}

/// Soft-knee static curve: output level (dB) for input level `x` (dB).
#[inline]
pub fn gain_computer(x: f32, threshold: f32, ratio: f32, knee: f32) -> f32 {
    let over = x - threshold;
    if knee > 0.0 && 2.0 * over.abs() <= knee {
        x + (1.0 / ratio - 1.0) * (over + knee / 2.0).powi(2) / (2.0 * knee)
    } else if 2.0 * over > knee {
        threshold + over / ratio
    } else {
        x
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CompressorSettings {
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub auto_makeup: bool,
    /// High-pass on the detector (0 = off), so bass does not pump the whole mix.
    pub sidechain_hpf_hz: f32,
    /// Dry/wet for parallel compression (1 = fully compressed).
    pub mix: f32,
}

impl Default for CompressorSettings {
    fn default() -> Self {
        CompressorSettings {
            threshold_db: -18.0,
            ratio: 4.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 120.0,
            makeup_db: 0.0,
            auto_makeup: false,
            sidechain_hpf_hz: 0.0,
            mix: 1.0,
        }
    }
}

/// Stereo-linked feed-forward compressor with optional external sidechain.
#[derive(Clone, Debug)]
pub struct Compressor {
    sr: f32,
    s: CompressorSettings,
    att: f32,
    rel: f32,
    gr_db: f32,
    hpf: [Svf; 2],
    hpf_c: SvfCoeffs,
    /// Last block's maximum gain reduction (positive dB), for meters.
    pub meter_gr_db: f32,
}

impl Compressor {
    pub fn new(sr: f32, s: CompressorSettings) -> Compressor {
        let mut c = Compressor {
            sr,
            s,
            att: 0.0,
            rel: 0.0,
            gr_db: 0.0,
            hpf: [Svf::default(); 2],
            hpf_c: SvfCoeffs::design(SvfMode::Highpass, 20.0, FRAC_1_SQRT_2, 0.0, sr),
            meter_gr_db: 0.0,
        };
        c.set(s);
        c
    }

    pub fn set(&mut self, s: CompressorSettings) {
        self.s = s;
        self.att = one_pole_coeff(s.attack_ms.max(0.01) * 0.001, self.sr);
        self.rel = one_pole_coeff(s.release_ms.max(1.0) * 0.001, self.sr);
        if s.sidechain_hpf_hz > 0.0 {
            self.hpf_c = SvfCoeffs::design(SvfMode::Highpass, s.sidechain_hpf_hz, FRAC_1_SQRT_2, 0.0, self.sr);
        }
    }

    pub fn settings(&self) -> CompressorSettings {
        self.s
    }

    fn makeup(&self) -> f32 {
        let auto = if self.s.auto_makeup {
            -gain_computer(0.0, self.s.threshold_db, self.s.ratio, self.s.knee_db) * 0.5
        } else {
            0.0
        };
        self.s.makeup_db + auto
    }

    pub fn reset(&mut self) {
        self.gr_db = 0.0;
        for h in &mut self.hpf {
            h.reset();
        }
    }

    /// Processes in place; `sidechain` (if given) drives the detector instead of the input.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sidechain: Option<(&[f32], &[f32])>) {
        let makeup = self.makeup();
        let mut max_gr = 0.0f32;
        let n = l.len().min(r.len());
        for i in 0..n {
            let (mut dl, mut dr) = match sidechain {
                Some((a, b)) => (a[i], b[i]),
                None => (l[i], r[i]),
            };
            if self.s.sidechain_hpf_hz > 0.0 {
                dl = self.hpf[0].process(&self.hpf_c, dl);
                dr = self.hpf[1].process(&self.hpf_c, dr);
            }
            let level = dl.abs().max(dr.abs());
            let x_db = if level > 1e-6 { 20.0 * level.log10() } else { -120.0 };
            let target_gr = x_db - gain_computer(x_db, self.s.threshold_db, self.s.ratio, self.s.knee_db);
            let a = if target_gr > self.gr_db { self.att } else { self.rel };
            self.gr_db = flush(target_gr + a * (self.gr_db - target_gr));
            max_gr = max_gr.max(self.gr_db);
            let g = db_to_gain(makeup - self.gr_db);
            let wet = self.s.mix;
            let k = 1.0 - wet + wet * g;
            l[i] *= k;
            r[i] *= k;
        }
        self.meter_gr_db = max_gr;
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GateSettings {
    pub threshold_db: f32,
    /// The gate closes this many dB below the open threshold.
    pub hysteresis_db: f32,
    pub attack_ms: f32,
    pub hold_ms: f32,
    pub release_ms: f32,
    /// Attenuation when closed (dB, negative). −80 or lower is a full gate.
    pub range_db: f32,
}

impl Default for GateSettings {
    fn default() -> Self {
        GateSettings {
            threshold_db: -40.0,
            hysteresis_db: 4.0,
            attack_ms: 1.0,
            hold_ms: 30.0,
            release_ms: 100.0,
            range_db: -80.0,
        }
    }
}

/// Noise gate / downward expander with hysteresis and hold.
#[derive(Clone, Debug)]
pub struct Gate {
    sr: f32,
    s: GateSettings,
    open: bool,
    hold_left: u32,
    gain: f32,
    det: EnvelopeFollower,
    att: f32,
    rel: f32,
}

impl Gate {
    pub fn new(sr: f32, s: GateSettings) -> Gate {
        let mut g = Gate {
            sr,
            s,
            open: false,
            hold_left: 0,
            gain: db_to_gain(s.range_db),
            det: EnvelopeFollower::new(0.0005, 0.02, sr),
            att: 0.0,
            rel: 0.0,
        };
        g.set(s);
        g
    }

    pub fn set(&mut self, s: GateSettings) {
        self.s = s;
        self.att = one_pole_coeff(s.attack_ms.max(0.05) * 0.001, self.sr);
        self.rel = one_pole_coeff(s.release_ms.max(1.0) * 0.001, self.sr);
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let open_lin = db_to_gain(self.s.threshold_db);
        let close_lin = db_to_gain(self.s.threshold_db - self.s.hysteresis_db);
        let floor = db_to_gain(self.s.range_db);
        let hold = (self.s.hold_ms * 0.001 * self.sr) as u32;
        let n = l.len().min(r.len());
        for i in 0..n {
            let e = self.det.process(l[i].abs().max(r[i].abs()));
            if e >= open_lin {
                self.open = true;
                self.hold_left = hold;
            } else if e < close_lin {
                if self.hold_left > 0 {
                    self.hold_left -= 1;
                } else {
                    self.open = false;
                }
            }
            let target = if self.open { 1.0 } else { floor };
            let a = if target > self.gain { self.att } else { self.rel };
            self.gain = flush(target + a * (self.gain - target));
            l[i] *= self.gain;
            r[i] *= self.gain;
        }
    }
}

/// Look-ahead brick-wall limiter with true-peak detection.
///
/// For each sample it computes the gain that would bring the (4x oversampled) peak
/// down to the ceiling, takes the minimum over the look-ahead window, applies release,
/// then a moving average of the same length. Because the moving average only spans
/// values that are already at or below each peak's required gain, the delayed signal
/// never exceeds the ceiling, and gain changes are smooth (no distortion from steps).
pub struct Limiter {
    ceiling: f32,
    look: usize,
    // Delay line for the audio (stereo interleaved ring): look-ahead plus detector latency.
    delay: Vec<f32>,
    delay_len: usize,
    dpos: usize,
    // Sliding-minimum of required gain: monotonic deque in a ring of (index, value).
    dq_idx: Vec<u64>,
    dq_val: Vec<f32>,
    dq_head: usize,
    dq_len: usize,
    t: u64,
    rel_state: f32,
    rel_coeff: f32,
    // Box filter over the release output.
    box_buf: Vec<f32>,
    box_pos: usize,
    box_sum: f64,
    recompute_in: u32,
    tp: [TruePeakDetector; 2],
    enabled: bool,
    /// Maximum gain reduction of the last block (positive dB).
    pub meter_gr_db: f32,
}

impl Limiter {
    /// `lookahead_ms` adds that much latency; 1.5–5 ms is typical.
    pub fn new(sr: f32, ceiling_db: f32, lookahead_ms: f32, release_ms: f32) -> Limiter {
        let look = ((lookahead_ms * 0.001 * sr).round() as usize).max(16);
        let tp = [TruePeakDetector::new(), TruePeakDetector::new()];
        let delay_len = look + tp[0].latency().round() as usize;
        Limiter {
            ceiling: db_to_gain(ceiling_db),
            look,
            delay: vec![0.0; delay_len * 2],
            delay_len,
            dpos: 0,
            dq_idx: vec![0; look + 6],
            dq_val: vec![1.0; look + 6],
            dq_head: 0,
            dq_len: 0,
            t: 0,
            rel_state: 1.0,
            rel_coeff: one_pole_coeff(release_ms * 0.001, sr),
            box_buf: vec![1.0; look],
            box_pos: 0,
            box_sum: look as f64,
            recompute_in: 4096,
            tp,
            enabled: true,
            meter_gr_db: 0.0,
        }
    }

    /// Latency in frames.
    pub fn latency(&self) -> usize {
        self.delay_len
    }

    pub fn set_ceiling_db(&mut self, db: f32) {
        self.ceiling = db_to_gain(db);
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
    }

    fn push_min(&mut self, v: f32) -> f32 {
        let cap = self.dq_idx.len();
        // Pop values from the back that are >= v.
        while self.dq_len > 0 {
            let back = (self.dq_head + self.dq_len - 1) % cap;
            if self.dq_val[back] >= v {
                self.dq_len -= 1;
            } else {
                break;
            }
        }
        let slot = (self.dq_head + self.dq_len) % cap;
        self.dq_idx[slot] = self.t;
        self.dq_val[slot] = v;
        self.dq_len += 1;
        // Drop expired values from the front. The window is a few samples wider than the
        // look-ahead to cover the detector's fractional latency.
        while self.dq_len > 0 && self.dq_idx[self.dq_head] + (self.look as u64) + 2 < self.t {
            self.dq_head = (self.dq_head + 1) % cap;
            self.dq_len -= 1;
        }
        self.t += 1;
        self.dq_val[self.dq_head]
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        let mut min_g = 1.0f32;
        for i in 0..n {
            let (xl, xr) = (l[i], r[i]);
            let pk = self.tp[0].process(xl).max(self.tp[1].process(xr));
            let need = if self.enabled && pk > self.ceiling { self.ceiling / pk } else { 1.0 };
            let held = self.push_min(need);
            // Instant attack to the held minimum, exponential release towards it.
            self.rel_state = if held < self.rel_state { held } else { held + self.rel_coeff * (self.rel_state - held) };
            // Moving average.
            let old = self.box_buf[self.box_pos];
            self.box_buf[self.box_pos] = self.rel_state;
            self.box_pos = (self.box_pos + 1) % self.look;
            self.box_sum += self.rel_state as f64 - old as f64;
            self.recompute_in -= 1;
            if self.recompute_in == 0 {
                self.box_sum = self.box_buf.iter().map(|&v| v as f64).sum();
                self.recompute_in = 4096;
            }
            let g = (self.box_sum / self.look as f64) as f32;
            // Delay audio by the look-ahead.
            let dl = self.delay[self.dpos * 2];
            let dr = self.delay[self.dpos * 2 + 1];
            self.delay[self.dpos * 2] = xl;
            self.delay[self.dpos * 2 + 1] = xr;
            self.dpos = (self.dpos + 1) % self.delay_len;
            min_g = min_g.min(g);
            // Final safety clamp at the sample-peak ceiling (inaudible in practice).
            l[i] = (dl * g).clamp(-self.ceiling, self.ceiling);
            r[i] = (dr * g).clamp(-self.ceiling, self.ceiling);
        }
        self.meter_gr_db = -20.0 * min_g.max(1e-6).log10();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oversample::TruePeakDetector;

    #[test]
    fn static_curve() {
        assert_eq!(gain_computer(-30.0, -20.0, 4.0, 0.0), -30.0);
        assert_eq!(gain_computer(-10.0, -20.0, 4.0, 0.0), -17.5);
        // Knee is continuous at its edges.
        let a = gain_computer(-23.0 + 1e-4, -20.0, 4.0, 6.0);
        assert!((a - (-23.0)).abs() < 1e-3);
        let b = gain_computer(-17.0, -20.0, 4.0, 6.0);
        assert!((b - (-20.0 + 3.0 / 4.0)).abs() < 1e-3);
    }

    #[test]
    fn compressor_reduces_loud_tone() {
        let sr = 48_000.0;
        let mut c = Compressor::new(
            sr,
            CompressorSettings { threshold_db: -20.0, ratio: 4.0, knee_db: 0.0, ..Default::default() },
        );
        let n = 48_000;
        let mut l: Vec<f32> = (0..n).map(|i| (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.5).collect();
        let mut r = l.clone();
        c.process(&mut l, &mut r, None);
        let peak = l[n / 2..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        // Input peak −6 dB, threshold −20, ratio 4 → output peak about −16.5 dB.
        let db = 20.0 * peak.log10();
        // Release ripple between peaks lets a little more through; within 1.5 dB.
        assert!((db + 16.5).abs() < 1.5, "{db}");
        assert!(c.meter_gr_db > 9.0);
    }

    #[test]
    fn gate_closes_on_quiet_input() {
        let mut g = Gate::new(48_000.0, GateSettings::default());
        let mut l = vec![0.001f32; 48_000];
        let mut r = l.clone();
        g.process(&mut l, &mut r);
        assert!(l[47_999].abs() < 1e-6);
        let mut l = vec![0.5f32; 4_800];
        let mut r = l.clone();
        g.process(&mut l, &mut r);
        assert!(g.is_open());
        assert!(l[4_799] > 0.49);
    }

    #[test]
    fn limiter_holds_the_true_peak_ceiling() {
        let sr = 48_000.0;
        let mut lim = Limiter::new(sr, -1.0, 2.0, 50.0);
        let mut meter = [TruePeakDetector::new(), TruePeakDetector::new()];
        let mut rng = crate::rng::Rng::new(3);
        let mut worst = 0.0f32;
        for block in 0..200 {
            // Torture: loud noise bursts, full-scale fs/4 sines and silence.
            let mut l: Vec<f32> = (0..256)
                .map(|i| {
                    let t = block * 256 + i;
                    match (block / 20) % 3 {
                        0 => rng.bipolar() * 2.5,
                        1 => 2.0 * (std::f32::consts::FRAC_PI_2 * t as f32 + 0.785).sin(),
                        _ => 0.0,
                    }
                })
                .collect();
            let mut r = l.clone();
            lim.process(&mut l, &mut r);
            for (&a, &b) in l.iter().zip(&r) {
                worst = worst.max(meter[0].process(a)).max(meter[1].process(b));
            }
        }
        let db = 20.0 * worst.log10();
        assert!(db <= -0.8, "true peak {db} dBTP");
    }

    #[test]
    fn limiter_passes_quiet_audio_unchanged_after_latency() {
        let mut lim = Limiter::new(48_000.0, -1.0, 2.0, 50.0);
        let x: Vec<f32> = (0..2_000).map(|i| (i as f32 * 0.01).sin() * 0.3).collect();
        let mut l = x.clone();
        let mut r = x.clone();
        lim.process(&mut l, &mut r);
        let lat = lim.latency();
        for i in lat..2_000 {
            assert!((l[i] - x[i - lat]).abs() < 1e-6);
        }
    }
}
