//! Runs the engine on a real audio device.
//!
//! * Lists output devices with their channel counts, sample rates and buffer ranges
//!   (CoreAudio on macOS, WASAPI on Windows, ALSA/PipeWire/JACK on Linux).
//! * Opens a stream at the requested rate and buffer size (falling back to the
//!   device default), routes the master pair and, on interfaces with four or more
//!   outputs, the headphone cue pair to chosen channels.
//! * Measures callback load and counts likely dropouts so the UI can warn before the
//!   audience hears them.
//! * Switches off denormals on the audio thread.

pub mod denormals;
pub mod offline;
pub mod recorder;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use mixit_engine::{Controller, Engine, EngineConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("no audio output device found")]
    NoDevice,
    #[error("audio device \"{0}\" not found")]
    DeviceNotFound(String),
    #[error("audio device error: {0}")]
    Device(String),
    #[error("the device needs {0} output channels for this routing but has {1}")]
    Routing(u16, u16),
    #[error("recording: {0}")]
    Record(String),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    /// Stable identifier ("host:device") to store in settings.
    pub id: String,
    pub name: String,
    pub host: String,
    pub max_channels: u16,
    pub sample_rates: Vec<u32>,
    pub default_sample_rate: u32,
    /// (min, max) buffer frames when the driver reports it.
    pub buffer_range: Option<(u32, u32)>,
    pub is_default: bool,
}

const COMMON_RATES: [u32; 6] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];

fn describe(device: &cpal::Device, host: &cpal::Host, is_default: bool) -> Option<DeviceInfo> {
    let id = device.id().ok()?.to_string();
    let name = device.to_string();
    let default = device.default_output_config().ok()?;
    let mut rates = Vec::new();
    let mut max_ch = default.channels();
    let mut buf: Option<(u32, u32)> = None;
    if let Ok(cfgs) = device.supported_output_configs() {
        for c in cfgs {
            max_ch = max_ch.max(c.channels());
            for r in COMMON_RATES {
                if r >= c.min_sample_rate() && r <= c.max_sample_rate() && !rates.contains(&r) {
                    rates.push(r);
                }
            }
            if let cpal::SupportedBufferSize::Range { min, max } = *c.buffer_size() {
                buf = Some(match buf {
                    Some((a, b)) => (a.min(min), b.max(max)),
                    None => (min, max),
                });
            }
        }
    }
    rates.sort_unstable();
    Some(DeviceInfo {
        id,
        name,
        host: host.id().name().to_string(),
        max_channels: max_ch,
        sample_rates: rates,
        default_sample_rate: default.sample_rate(),
        buffer_range: buf,
        is_default,
    })
}

/// All output devices on all available audio APIs.
pub fn list_outputs() -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    for hid in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(hid) else { continue };
        let default_id = host.default_output_device().and_then(|d| d.id().ok());
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                let is_default = d.id().ok() == default_id && default_id.is_some();
                if let Some(info) = describe(&d, &host, is_default) {
                    out.push(info);
                }
            }
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostConfig {
    /// Device id from [`list_outputs`]; `None` = system default.
    pub device: Option<String>,
    pub sample_rate: Option<u32>,
    /// Requested buffer size in frames (smaller = less latency, more CPU risk).
    pub buffer_frames: Option<u32>,
    /// First channel (0-based) of the master stereo pair.
    pub master_channel: u16,
    /// First channel of the headphone pair; `None` = no separate cue output.
    pub cue_channel: Option<u16>,
}

impl Default for HostConfig {
    fn default() -> Self {
        HostConfig { device: None, sample_rate: None, buffer_frames: Some(256), master_channel: 0, cue_channel: None }
    }
}

/// Live statistics from the audio callback (lock-free).
#[derive(Debug, Default)]
pub struct HostStats {
    pub callbacks: AtomicU64,
    /// Callback time / buffer duration, in 1/1000 (1000 = the deadline).
    pub load_permille: AtomicU32,
    pub max_load_permille: AtomicU32,
    /// Callbacks that took longer than the buffer lasts (an audible dropout is likely).
    pub overruns: AtomicU64,
    /// Errors reported by the driver (device lost, xrun).
    pub errors: AtomicU64,
    pub device_lost: AtomicBool,
    pub last_buffer_frames: AtomicU32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct StatsSnapshot {
    pub callbacks: u64,
    pub load: f32,
    pub max_load: f32,
    pub overruns: u64,
    pub errors: u64,
    pub device_lost: bool,
    pub buffer_frames: u32,
}

impl HostStats {
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            callbacks: self.callbacks.load(Ordering::Relaxed),
            load: self.load_permille.load(Ordering::Relaxed) as f32 / 1_000.0,
            max_load: self.max_load_permille.load(Ordering::Relaxed) as f32 / 1_000.0,
            overruns: self.overruns.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            device_lost: self.device_lost.load(Ordering::Relaxed),
            buffer_frames: self.last_buffer_frames.load(Ordering::Relaxed),
        }
    }

    pub fn reset_peak(&self) {
        self.max_load_permille.store(0, Ordering::Relaxed);
    }
}

/// A running audio stream. Dropping it stops audio.
pub struct AudioHost {
    _stream: cpal::Stream,
    pub stats: Arc<HostStats>,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_name: String,
    /// Requested buffer (actual callback sizes are in the stats).
    pub buffer_frames: Option<u32>,
}

/// Largest block handed to the engine at once; longer callbacks are split.
const MAX_CHUNK: usize = 4_096;

fn find_device(cfg: &HostConfig) -> Result<cpal::Device, HostError> {
    match &cfg.device {
        None => cpal::default_host().default_output_device().ok_or(HostError::NoDevice),
        Some(id) => {
            let parsed: cpal::DeviceId = id.parse().map_err(|_| HostError::DeviceNotFound(id.clone()))?;
            let host = cpal::host_from_id(parsed.host()).map_err(|e| HostError::Device(e.to_string()))?;
            host.device_by_id(&parsed).ok_or_else(|| HostError::DeviceNotFound(id.clone()))
        }
    }
}

impl AudioHost {
    /// Opens the device, builds the engine at the device's rate with `engine_cfg`
    /// (its sample rate is overridden), and starts playing.
    pub fn start(cfg: &HostConfig, mut engine_cfg: EngineConfig) -> Result<(AudioHost, Controller), HostError> {
        let device = find_device(cfg)?;
        let default = device.default_output_config().map_err(|e| HostError::Device(e.to_string()))?;
        let needed = (cfg.master_channel + 2).max(cfg.cue_channel.map(|c| c + 2).unwrap_or(0));
        // Pick a configuration with enough channels at the requested rate.
        let mut chosen = None;
        if let Ok(cfgs) = device.supported_output_configs() {
            let want_rate = cfg.sample_rate.unwrap_or(default.sample_rate());
            let mut list: Vec<_> = cfgs.collect();
            // Prefer f32, then the fewest channels that satisfy the routing.
            list.sort_by_key(|c| (c.sample_format() != SampleFormat::F32, c.channels()));
            for c in list {
                if c.channels() >= needed {
                    if let Some(s) = c.try_with_sample_rate(want_rate) {
                        chosen = Some(s);
                        break;
                    }
                }
            }
        }
        let supported = match chosen {
            Some(c) => c,
            None if default.channels() >= needed => default,
            None => return Err(HostError::Routing(needed, default.channels())),
        };
        let mut stream_cfg: cpal::StreamConfig = supported.config();
        if let Some(b) = cfg.buffer_frames {
            let ok = match supported.buffer_size() {
                cpal::SupportedBufferSize::Range { min, max } => (*min..=*max).contains(&b),
                cpal::SupportedBufferSize::Unknown => true,
            };
            if ok {
                stream_cfg.buffer_size = cpal::BufferSize::Fixed(b);
            }
        }
        engine_cfg.sample_rate = stream_cfg.sample_rate;
        let (engine, controller) = Engine::new(engine_cfg);
        let stats = Arc::new(HostStats::default());
        let format = supported.sample_format();
        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, &stream_cfg, engine, cfg, stats.clone()),
            SampleFormat::I16 => build::<i16>(&device, &stream_cfg, engine, cfg, stats.clone()),
            SampleFormat::I32 => build::<i32>(&device, &stream_cfg, engine, cfg, stats.clone()),
            SampleFormat::U16 => build::<u16>(&device, &stream_cfg, engine, cfg, stats.clone()),
            other => return Err(HostError::Device(format!("unsupported sample format {other:?}"))),
        }?;
        stream.play().map_err(|e| HostError::Device(e.to_string()))?;
        Ok((
            AudioHost {
                _stream: stream,
                stats,
                sample_rate: stream_cfg.sample_rate,
                channels: stream_cfg.channels,
                device_name: device.to_string(),
                buffer_frames: match stream_cfg.buffer_size {
                    cpal::BufferSize::Fixed(b) => Some(b),
                    _ => None,
                },
            },
            controller,
        ))
    }

    /// Output latency of one buffer in milliseconds (driver and converter latency come on top).
    pub fn buffer_latency_ms(&self) -> f32 {
        let frames = self.buffer_frames.unwrap_or(self.stats.last_buffer_frames.load(Ordering::Relaxed));
        frames as f32 * 1_000.0 / self.sample_rate as f32
    }
}

fn build<T>(
    device: &cpal::Device,
    cfg: &cpal::StreamConfig,
    mut engine: Engine,
    routing: &HostConfig,
    stats: Arc<HostStats>,
) -> Result<cpal::Stream, HostError>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let ch = cfg.channels as usize;
    let sr = cfg.sample_rate as f64;
    let m0 = routing.master_channel as usize;
    let c0 = routing.cue_channel.map(|c| c as usize);
    let mut master = vec![0.0f32; MAX_CHUNK * 2];
    let mut cue = vec![0.0f32; MAX_CHUNK * 2];
    let mut first = true;
    let err_stats = stats.clone();
    let data_cb = move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
        if first {
            denormals::disable_denormals();
            first = false;
        }
        let start = Instant::now();
        let frames = data.len() / ch;
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(MAX_CHUNK);
            engine.process(&mut master[..n * 2], &mut cue[..n * 2]);
            for i in 0..n {
                let out = &mut data[(done + i) * ch..(done + i + 1) * ch];
                for s in out.iter_mut() {
                    *s = T::from_sample(0.0);
                }
                out[m0] = T::from_sample(master[2 * i]);
                out[m0 + 1] = T::from_sample(master[2 * i + 1]);
                if let Some(c) = c0 {
                    out[c] = T::from_sample(cue[2 * i]);
                    out[c + 1] = T::from_sample(cue[2 * i + 1]);
                }
            }
            done += n;
        }
        let budget = frames as f64 / sr;
        let load = (start.elapsed().as_secs_f64() / budget.max(1e-9) * 1_000.0) as u32;
        stats.callbacks.fetch_add(1, Ordering::Relaxed);
        stats.load_permille.store(load, Ordering::Relaxed);
        stats.max_load_permille.fetch_max(load, Ordering::Relaxed);
        stats.last_buffer_frames.store(frames as u32, Ordering::Relaxed);
        if load > 1_000 {
            stats.overruns.fetch_add(1, Ordering::Relaxed);
        }
    };
    let err_cb = move |e: cpal::Error| {
        err_stats.errors.fetch_add(1, Ordering::Relaxed);
        if matches!(e.kind(), cpal::ErrorKind::DeviceNotAvailable) {
            err_stats.device_lost.store(true, Ordering::Relaxed);
        }
    };
    device
        .build_output_stream::<T, _, _>(cfg.clone(), data_cb, err_cb, None)
        .map_err(|e| HostError::Device(e.to_string()))
}
