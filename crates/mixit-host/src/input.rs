//! Input devices: a microphone or a line-in feeding the engine's mic channel.
//!
//! The input runs on its own stream (and, with another device, its own clock). Its
//! callback converts whatever the driver delivers into interleaved stereo f32 and pushes
//! it into an [`InputFeed`] ring; the engine resamples it to the output clock. Nothing in
//! the callback allocates or locks.
//!
//! A mono mic can be cleaned on the way (echo cancelling and noise removal, see
//! [`crate::voice`], with the `voice-clean` feature): the callback then writes into a
//! ring the cleaner thread reads, and the cleaner feeds the engine.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use mixit_engine::{InputFeed, push_input};
use serde::{Deserialize, Serialize};

use crate::{DeviceInfo, HostError, describe_dir};

/// All input devices on all available audio APIs.
pub fn list_inputs() -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    for hid in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(hid) else { continue };
        let default_id = host.default_input_device().and_then(|d| d.id().ok());
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                let is_default = d.id().ok() == default_id && default_id.is_some();
                if let Some(info) = describe_dir(&d, &host, is_default, true) {
                    out.push(info);
                }
            }
        }
    }
    out
}

/// How hard the mic cleaner removes background noise.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MicDenoise {
    Off,
    /// Lighter, the least delay (about 10 ms).
    Light,
    /// The cleanest voice (about 30 ms).
    #[default]
    Strong,
}

/// What the mic cleaner does to a mono mic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MicClean {
    /// Takes out the music the mic picks up from the speakers.
    pub echo: bool,
    pub denoise: MicDenoise,
}

impl Default for MicClean {
    fn default() -> Self {
        MicClean { echo: true, denoise: MicDenoise::Strong }
    }
}

impl MicClean {
    pub const OFF: MicClean = MicClean { echo: false, denoise: MicDenoise::Off };

    pub fn is_off(&self) -> bool {
        !self.echo && self.denoise == MicDenoise::Off
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputConfig {
    /// Device id from [`list_inputs`]; `None` = the system's default input.
    pub device: Option<String>,
    /// First channel (0-based) to use. With `stereo`, this one and the next.
    pub channel: u16,
    /// Take a stereo pair (a turntable or mixer) instead of one mic channel.
    pub stereo: bool,
    /// Requested buffer in frames (`None` = the driver's choice).
    pub buffer_frames: Option<u32>,
    /// Cleaning for a mono mic (a stereo line-in is never cleaned). Needs the
    /// `voice-clean` feature; without it the mic comes through as it is.
    #[serde(default)]
    pub clean: MicClean,
}

impl Default for InputConfig {
    fn default() -> Self {
        InputConfig { device: None, channel: 0, stereo: false, buffer_frames: Some(256), clean: MicClean::default() }
    }
}

/// Live statistics from the input callback.
#[derive(Debug, Default)]
pub struct InputStats {
    pub callbacks: AtomicU64,
    pub frames: AtomicU64,
    /// Frames that did not fit in the ring (the engine is not reading: output stalled).
    pub dropped: AtomicU64,
    pub errors: AtomicU64,
    pub device_lost: AtomicBool,
}

/// A running input stream. Dropping it stops the input.
pub struct InputHost {
    // Dropped first: the stream stops before its cleaner does.
    _stream: cpal::Stream,
    #[cfg(feature = "voice-clean")]
    _cleaner: Option<crate::voice::CleanerThread>,
    pub stats: Arc<InputStats>,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_name: String,
    pub buffer_frames: Option<u32>,
    /// What the cleaner does to the mic, in plain words (`None`: the mic comes through
    /// as it is).
    pub cleaning: Option<String>,
    /// Why the mic is not cleaned although cleaning was asked for.
    pub cleaning_problem: Option<String>,
    /// The delay the cleaner adds, in frames.
    pub clean_delay_frames: usize,
}

/// The rate the trained noise removers need; a mic that is cleaned opens at it if it can.
#[cfg(feature = "voice-clean")]
const CLEAN_RATE: u32 = mixit_ml::voice::CLEAN_RATE;
#[cfg(not(feature = "voice-clean"))]
const CLEAN_RATE: u32 = 48_000;

fn find_input(cfg: &InputConfig) -> Result<cpal::Device, HostError> {
    match &cfg.device {
        None => cpal::default_host().default_input_device().ok_or(HostError::NoInput),
        Some(id) => {
            let parsed: cpal::DeviceId = id.parse().map_err(|_| HostError::DeviceNotFound(id.clone()))?;
            let host = cpal::host_from_id(parsed.host()).map_err(|e| HostError::Device(e.to_string()))?;
            host.device_by_id(&parsed).ok_or_else(|| HostError::DeviceNotFound(id.clone()))
        }
    }
}

const SCRATCH: usize = 8_192;

impl InputHost {
    /// Opens the input and starts it. `output_rate` is the engine's rate: the input opens
    /// at the same rate when the device allows it (no conversion), otherwise at its own
    /// and the engine converts. Returns the feed to send to the engine with
    /// `MicCommand::SetFeed`.
    pub fn start(cfg: &InputConfig, output_rate: u32) -> Result<(InputHost, InputFeed), HostError> {
        let device = find_input(cfg)?;
        let default = device.default_input_config().map_err(|e| HostError::Device(e.to_string()))?;
        let needed = cfg.channel + if cfg.stereo { 2 } else { 1 };
        let mut chosen = None;
        if let Ok(cfgs) = device.supported_input_configs() {
            let mut list: Vec<_> = cfgs.filter(|c| c.channels() >= needed).collect();
            list.sort_by_key(|c| (c.sample_format() != SampleFormat::F32, c.channels()));
            let clean = !cfg.stereo && !cfg.clean.is_off() && cfg!(feature = "voice-clean");
            let first = if clean { CLEAN_RATE } else { output_rate };
            for rate in [first, output_rate, default.sample_rate()] {
                if let Some(c) = list.iter().find_map(|c| c.try_with_sample_rate(rate)) {
                    chosen = Some(c);
                    break;
                }
            }
        }
        let supported = match chosen {
            Some(c) => c,
            None if default.channels() >= needed => default,
            None => return Err(HostError::Routing(needed, default.channels())),
        };
        let mut stream_cfg: cpal::StreamConfig = supported.config();
        let mut fixed = None;
        if let Some(b) = cfg.buffer_frames {
            let ok = match supported.buffer_size() {
                cpal::SupportedBufferSize::Range { min, max } => (*min..=*max).contains(&b),
                cpal::SupportedBufferSize::Unknown => false,
            };
            if ok {
                stream_cfg.buffer_size = cpal::BufferSize::Fixed(b);
                fixed = Some(b);
            }
        }
        let rate = stream_cfg.sample_rate;
        // Shared-mode drivers usually call back every 10 ms; the engine grows its buffer
        // by itself if the device turns out to be slower.
        let device_frames = fixed.unwrap_or(rate / 100);
        let (tx, feed, cleaner, problem) = feed_for(cfg, rate, output_rate, device_frames);
        let stats = Arc::new(InputStats::default());
        let route = Route { channels: stream_cfg.channels as usize, first: cfg.channel as usize, stereo: cfg.stereo };
        let stream = match supported.sample_format() {
            SampleFormat::F32 => build::<f32>(&device, &stream_cfg, tx, route, stats.clone()),
            SampleFormat::I16 => build::<i16>(&device, &stream_cfg, tx, route, stats.clone()),
            SampleFormat::I32 => build::<i32>(&device, &stream_cfg, tx, route, stats.clone()),
            SampleFormat::U16 => build::<u16>(&device, &stream_cfg, tx, route, stats.clone()),
            SampleFormat::U8 => build::<u8>(&device, &stream_cfg, tx, route, stats.clone()),
            other => return Err(HostError::Device(format!("unsupported input format {other:?}"))),
        }?;
        stream.play().map_err(|e| HostError::Device(e.to_string()))?;
        #[cfg(feature = "voice-clean")]
        let (cleaning, clean_delay_frames) =
            cleaner.as_ref().map_or((None, 0), |c| (Some(c.describe.clone()), c.delay_frames));
        #[cfg(not(feature = "voice-clean"))]
        let (cleaning, clean_delay_frames) = {
            let _: Option<()> = cleaner;
            (None, 0)
        };
        Ok((
            InputHost {
                _stream: stream,
                #[cfg(feature = "voice-clean")]
                _cleaner: cleaner,
                stats,
                sample_rate: rate,
                channels: stream_cfg.channels,
                device_name: device.to_string(),
                buffer_frames: fixed,
                cleaning,
                cleaning_problem: problem,
                clean_delay_frames,
            },
            feed,
        ))
    }
}

#[cfg(feature = "voice-clean")]
type Cleaner = crate::voice::CleanerThread;
#[cfg(not(feature = "voice-clean"))]
type Cleaner = ();

/// The ring the device callback writes into and the feed for the engine: straight
/// through, or through the cleaner when it is asked for and starts.
fn feed_for(
    cfg: &InputConfig,
    rate: u32,
    output_rate: u32,
    device_frames: u32,
) -> (rtrb::Producer<f32>, InputFeed, Option<Cleaner>, Option<String>) {
    let plain = || {
        let (tx, feed) = InputFeed::new(rate, output_rate, device_frames);
        (tx, feed)
    };
    if cfg.stereo || cfg.clean.is_off() {
        let (tx, feed) = plain();
        return (tx, feed, None, None);
    }
    #[cfg(feature = "voice-clean")]
    {
        // The cleaner hands over whole 10 ms frames, so the engine keeps one more.
        let (out_tx, mut feed) = InputFeed::new(rate, output_rate, device_frames + rate / 100);
        let reference = feed.echo_tap(output_rate as usize / 2);
        let (raw_tx, raw_rx) = rtrb::RingBuffer::new((rate as usize / 2).max(8 * device_frames as usize) * 2);
        match crate::voice::CleanerThread::start(cfg.clean.into(), rate, output_rate, raw_rx, reference, out_tx) {
            Ok(c) => (raw_tx, feed, Some(c), None),
            Err(e) => {
                let (tx, feed) = plain();
                (tx, feed, None, Some(format!("the mic cleaner could not start: {e}")))
            }
        }
    }
    #[cfg(not(feature = "voice-clean"))]
    {
        let (tx, feed) = plain();
        (tx, feed, None, Some("this build has no mic cleaner".into()))
    }
}

#[derive(Clone, Copy)]
struct Route {
    channels: usize,
    first: usize,
    stereo: bool,
}

/// Copies the routed channels of `data` into interleaved stereo `out` (a mono source on
/// both sides). Returns the frames converted.
fn route_frames<T: Sample>(data: &[T], route: Route, out: &mut [f32]) -> usize
where
    f32: FromSample<T>,
{
    let ch = route.channels.max(1);
    let frames = (data.len() / ch).min(out.len() / 2);
    let left = route.first.min(ch - 1);
    let right = if route.stereo { (route.first + 1).min(ch - 1) } else { left };
    for i in 0..frames {
        let f = &data[i * ch..(i + 1) * ch];
        out[2 * i] = f32::from_sample(f[left]);
        out[2 * i + 1] = f32::from_sample(f[right]);
    }
    frames
}

fn build<T>(
    device: &cpal::Device,
    cfg: &cpal::StreamConfig,
    mut tx: rtrb::Producer<f32>,
    route: Route,
    stats: Arc<InputStats>,
) -> Result<cpal::Stream, HostError>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let mut scratch = vec![0.0f32; SCRATCH * 2];
    let mut first = true;
    let err_stats = stats.clone();
    let ch = route.channels.max(1);
    let data_cb = move |data: &[T], _info: &cpal::InputCallbackInfo| {
        if first {
            crate::denormals::disable_denormals();
            first = false;
        }
        for part in data.chunks(SCRATCH * ch) {
            let n = route_frames(part, route, &mut scratch);
            let pushed = push_input(&mut tx, &scratch[..n * 2]);
            stats.frames.fetch_add(n as u64, Ordering::Relaxed);
            if pushed < n {
                stats.dropped.fetch_add((n - pushed) as u64, Ordering::Relaxed);
            }
        }
        stats.callbacks.fetch_add(1, Ordering::Relaxed);
    };
    let err_cb = move |e: cpal::Error| {
        err_stats.errors.fetch_add(1, Ordering::Relaxed);
        if matches!(e.kind(), cpal::ErrorKind::DeviceNotAvailable) {
            err_stats.device_lost.store(true, Ordering::Relaxed);
        }
    };
    device.build_input_stream::<T, _, _>(*cfg, data_cb, err_cb, None).map_err(|e| HostError::Device(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_mono_and_stereo_channels() {
        let data: Vec<i16> = vec![100, 200, 300, -100, -200, -300];
        let mut out = vec![0.0f32; 8];
        let n = route_frames(&data, Route { channels: 3, first: 1, stereo: false }, &mut out);
        assert_eq!(n, 2);
        let s = |v: i16| f32::from_sample(v);
        assert_eq!(&out[..4], &[s(200), s(200), s(-200), s(-200)]);
        let n = route_frames(&data, Route { channels: 3, first: 1, stereo: true }, &mut out);
        assert_eq!(n, 2);
        assert_eq!(&out[..4], &[s(200), s(300), s(-200), s(-300)]);
        // A stereo request on a mono device uses the one channel on both sides.
        let mono: Vec<f32> = vec![0.5, -0.5];
        let n = route_frames(&mono, Route { channels: 1, first: 0, stereo: true }, &mut out);
        assert_eq!((n, out[0], out[1], out[2]), (2, 0.5, 0.5, -0.5));
    }
}
