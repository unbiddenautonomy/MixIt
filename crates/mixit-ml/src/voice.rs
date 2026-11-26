//! Cleans the mic: takes out the music the mic picks up from the speakers (echo) and
//! the noise around the person talking.
//!
//! * **Echo**: WebRTC's echo canceller (AEC3, the one video calls use) through
//!   `sonora`, a pure Rust port. It is told what the speakers are playing (the
//!   *reference*: the master output without the mic) and learns how that sound reaches
//!   the mic, then subtracts it. It finds the delay by itself.
//! * **Noise**: DeepFilterNet3 (`Strong`, a small trained model built into the app, about
//!   40 ms of delay) or RNNoise (`Light`, about 10 ms). Both work on 48 kHz audio; at
//!   another rate WebRTC's classic noise suppressor stands in.
//!
//! Everything works on mono 10 ms frames, off the audio thread. Feed what the speakers
//! play with [`VoiceCleaner::reference`] and the mic with [`VoiceCleaner::process`],
//! in any amounts: the cleaner keeps the leftovers for the next call.

use crate::{MlError, Result};

/// The rate the trained noise removers work at.
pub const CLEAN_RATE: u32 = 48_000;

/// How hard to remove background noise.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Denoise {
    Off,
    /// RNNoise: lighter, lowest delay.
    Light,
    /// DeepFilterNet3: the cleanest voice.
    #[default]
    Strong,
}

/// What the cleaner does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceSettings {
    /// Remove the music the mic hears from the speakers.
    pub echo: bool,
    pub denoise: Denoise,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        VoiceSettings { echo: true, denoise: Denoise::Strong }
    }
}

impl VoiceSettings {
    /// True when the cleaner would change nothing.
    pub fn is_off(&self) -> bool {
        !self.echo && self.denoise == Denoise::Off
    }
}

#[cfg(feature = "voice")]
enum Remover {
    None,
    Rn(Box<nnnoiseless::DenoiseState<'static>>),
    Df(Box<df::tract::DfTract>),
}

/// The echo canceller, tuned for someone talking over music rather than a video call.
/// On a call, cutting the voice while the far end talks is fine; over a set it is not.
/// So the suppressor only steps in where the echo clearly outweighs the voice: the
/// adaptive filter still takes out most of the echo (about 16 dB on the test recording),
/// the voice stays at full level, and the noise remover after it takes much of the rest.
#[cfg(feature = "voice")]
fn aec_config() -> sonora::config::EchoCanceller3Config {
    let mut c = sonora::config::EchoCanceller3Config::default();
    let s = &mut c.suppressor;
    for t in [&mut s.normal_tuning, &mut s.nearend_tuning] {
        for m in [&mut t.mask_lf, &mut t.mask_hf] {
            m.enr_transparent = 8.0;
            m.enr_suppress = 16.0;
        }
    }
    s.dominant_nearend_detection.enr_threshold = 4.0;
    c
}

/// The mic cleaner for one mic stream.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub struct VoiceCleaner {
    #[cfg(feature = "voice")]
    apm: Option<sonora::AudioProcessing>,
    #[cfg(feature = "voice")]
    remover: Remover,
    /// Mic samples per 10 ms frame.
    frame: usize,
    /// Reference samples per 10 ms frame.
    ref_frame: usize,
    cap: Vec<f32>,
    refs: Vec<f32>,
    ref_out: Vec<f32>,
    buf: Vec<f32>,
    buf2: Vec<f32>,
    delay: usize,
    what: String,
}

impl VoiceCleaner {
    /// A cleaner for a mic at `capture_rate` while the speakers play at
    /// `reference_rate` (both 8–384 kHz).
    #[cfg(feature = "voice")]
    pub fn new(settings: VoiceSettings, capture_rate: u32, reference_rate: u32) -> Result<VoiceCleaner> {
        use sonora::config::{EchoCanceller, NoiseSuppression, NoiseSuppressionLevel};
        use sonora::{AudioProcessing, Config, StreamConfig};
        if !(8_000..=384_000).contains(&capture_rate) || !(8_000..=384_000).contains(&reference_rate) {
            return Err(MlError::Run(format!("unsupported rates {capture_rate} / {reference_rate} Hz")));
        }
        let frame = capture_rate as usize / 100;
        let trained = capture_rate == CLEAN_RATE;
        let mut what = Vec::new();
        let mut delay = 0;
        let remover = match settings.denoise {
            Denoise::Strong if trained => {
                let params = df::tract::DfParams::default();
                let rp = df::tract::RuntimeParams::default_with_ch(1);
                let m = df::tract::DfTract::new(params, &rp).map_err(|e| MlError::Run(e.to_string()))?;
                if m.hop_size != frame {
                    return Err(MlError::Run(format!("DeepFilterNet works in {} samples, not {frame}", m.hop_size)));
                }
                delay += m.fft_size - m.hop_size + m.lookahead * m.hop_size;
                what.push("noise removed (DeepFilterNet3)");
                Remover::Df(Box::new(m))
            }
            Denoise::Light if trained => {
                delay += nnnoiseless::FRAME_SIZE;
                what.push("noise removed (RNNoise)");
                Remover::Rn(nnnoiseless::DenoiseState::new())
            }
            _ => Remover::None,
        };
        // At a rate the trained models cannot take, WebRTC's own suppressor stands in.
        let classic = match settings.denoise {
            Denoise::Off => None,
            _ if trained => None,
            Denoise::Light => Some(NoiseSuppressionLevel::Moderate),
            Denoise::Strong => Some(NoiseSuppressionLevel::High),
        };
        if classic.is_some() {
            what.push("noise removed (WebRTC)");
        }
        let apm = (settings.echo || classic.is_some()).then(|| {
            let config = Config {
                echo_canceller: settings.echo.then(EchoCanceller::default),
                noise_suppression: classic.map(|level| NoiseSuppression { level, ..Default::default() }),
                ..Default::default()
            };
            AudioProcessing::builder()
                .config(config)
                .echo_canceller3_config(aec_config())
                .capture_config(StreamConfig::new(capture_rate, 1))
                .render_config(StreamConfig::new(reference_rate, 1))
                .build()
        });
        if settings.echo {
            what.insert(0, "echo cancelled");
        }
        Ok(VoiceCleaner {
            apm,
            remover,
            frame,
            ref_frame: reference_rate as usize / 100,
            cap: Vec::with_capacity(4 * frame),
            refs: Vec::new(),
            ref_out: vec![0.0; reference_rate as usize / 100],
            buf: vec![0.0; frame],
            buf2: vec![0.0; frame],
            delay,
            what: if what.is_empty() { "off".into() } else { what.join(", ") },
        })
    }

    #[cfg(not(feature = "voice"))]
    pub fn new(_settings: VoiceSettings, _capture_rate: u32, _reference_rate: u32) -> Result<VoiceCleaner> {
        Err(MlError::NoRuntime)
    }

    /// What the cleaner does, in plain words.
    pub fn describe(&self) -> &str {
        &self.what
    }

    /// The delay the cleaner adds, in mic samples.
    pub fn delay(&self) -> usize {
        self.delay
    }

    /// Mic samples per 10 ms frame: [`VoiceCleaner::process`] gives out whole frames.
    pub fn frame(&self) -> usize {
        self.frame
    }

    /// What the speakers just played (mono, at the reference rate). Give it before the
    /// mic audio recorded at the same time.
    pub fn reference(&mut self, mono: &[f32]) {
        #[cfg(feature = "voice")]
        {
            let Some(apm) = self.apm.as_mut() else { return };
            self.refs.extend_from_slice(mono);
            let n = self.ref_frame;
            let mut used = 0;
            while self.refs.len() - used >= n {
                let src = &self.refs[used..used + n];
                let _ = apm.process_render_f32(&[src], &mut [&mut self.ref_out]);
                used += n;
            }
            self.refs.drain(..used);
        }
        #[cfg(not(feature = "voice"))]
        let _ = mono;
    }

    /// Cleans mic audio (mono, at the capture rate) and appends the cleaned audio to
    /// `out`, a whole 10 ms frame at a time.
    pub fn process(&mut self, mono: &[f32], out: &mut Vec<f32>) {
        self.cap.extend_from_slice(mono);
        let n = self.frame;
        let mut used = 0;
        while self.cap.len() - used >= n {
            self.buf.copy_from_slice(&self.cap[used..used + n]);
            self.clean_frame();
            out.extend_from_slice(&self.buf);
            used += n;
        }
        self.cap.drain(..used);
    }

    /// Cleans the frame in `buf`, in place.
    fn clean_frame(&mut self) {
        #[cfg(feature = "voice")]
        {
            if let Some(apm) = self.apm.as_mut() {
                if apm.process_capture_f32(&[&self.buf], &mut [&mut self.buf2]).is_ok() {
                    std::mem::swap(&mut self.buf, &mut self.buf2);
                }
            }
            match &mut self.remover {
                Remover::None => {}
                Remover::Rn(rn) => {
                    // RNNoise works in 16-bit sample units.
                    for v in &mut self.buf {
                        *v *= 32_768.0;
                    }
                    rn.process_frame(&mut self.buf2, &self.buf);
                    for (o, &v) in self.buf.iter_mut().zip(&self.buf2) {
                        *o = v / 32_768.0;
                    }
                }
                Remover::Df(m) => {
                    let n = self.buf.len();
                    let noisy = ndarray::ArrayView2::from_shape((1, n), &self.buf[..]).expect("one channel");
                    let enh = ndarray::ArrayViewMut2::from_shape((1, n), &mut self.buf2[..]).expect("one channel");
                    if m.process(noisy, enh).is_ok() {
                        std::mem::swap(&mut self.buf, &mut self.buf2);
                    }
                }
            }
        }
    }
}

#[cfg(all(test, feature = "voice"))]
mod tests {
    use super::*;

    /// A noise source that is the same on every run.
    fn noise(n: usize, seed: u32, level: f32) -> Vec<f32> {
        let mut s = seed.max(1);
        (0..n)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                (s as f32 / u32::MAX as f32 * 2.0 - 1.0) * level
            })
            .collect()
    }

    #[test]
    fn hands_back_whole_frames_whatever_it_is_given() {
        let mut c = VoiceCleaner::new(VoiceSettings::default(), 44_100, 48_000).unwrap();
        assert_eq!(c.frame(), 441);
        // At 44.1 kHz the trained removers cannot run: the classic one stands in.
        assert!(c.describe().contains("WebRTC"), "{}", c.describe());
        let x = noise(1_000, 3, 0.1);
        let mut out = Vec::new();
        c.reference(&x[..700]);
        c.process(&x[..300], &mut out);
        assert!(out.is_empty());
        c.process(&x[300..], &mut out);
        assert_eq!(out.len(), 882);
        assert!(out.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn describes_what_it_does() {
        let c = VoiceCleaner::new(VoiceSettings { echo: true, denoise: Denoise::Strong }, 48_000, 44_100).unwrap();
        assert_eq!(c.describe(), "echo cancelled, noise removed (DeepFilterNet3)");
        assert!(c.delay() > 0);
        let c = VoiceCleaner::new(VoiceSettings { echo: false, denoise: Denoise::Light }, 48_000, 48_000).unwrap();
        assert_eq!(c.describe(), "noise removed (RNNoise)");
        let c = VoiceCleaner::new(VoiceSettings { echo: false, denoise: Denoise::Off }, 48_000, 48_000).unwrap();
        assert_eq!((c.describe(), c.delay()), ("off", 0));
        assert!(VoiceSettings { echo: false, denoise: Denoise::Off }.is_off());
    }
}
