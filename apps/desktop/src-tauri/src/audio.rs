//! The engine and its output.
//!
//! The device stream is owned by a dedicated thread (on some platforms streams cannot
//! move between threads); this side keeps the [`Controller`]. When the device cannot be
//! opened the engine runs on the virtual output, so the app still works (and says so).

use std::sync::Arc;

use crossbeam_channel::{Sender, bounded};
use mixit_core::DeckId;
use mixit_engine::actions::ActionDispatcher;
use mixit_engine::{Command, Controller, DeckCommand, EngineConfig, GlobalCommand, MicCommand, MixerCommand};
use mixit_host::input::{InputConfig, InputHost, InputStats};
use mixit_host::{AudioHost, HostConfig, HostStats};
use mixit_stretch::{SignalsmithStretch, StretchQuality};

use crate::dto::{AudioStatus, MicStatus};

pub const DECKS: usize = 4;

pub struct Audio {
    pub ctl: Controller,
    pub dispatcher: ActionDispatcher,
    pub sample_rate: u32,
    pub stats: Arc<HostStats>,
    pub status: AudioStatus,
    keeper: Option<(Sender<()>, std::thread::JoinHandle<()>)>,
    mic: Option<Mic>,
}

/// An open input device. Its stream lives on its own thread, like the output's.
struct Mic {
    status: MicStatus,
    stats: Arc<InputStats>,
    keeper: (Sender<()>, std::thread::JoinHandle<()>),
}

struct Started {
    ctl: Controller,
    stats: Arc<HostStats>,
    status: AudioStatus,
}

impl Audio {
    /// Opens `cfg`'s device, or the virtual output when that fails (or `cfg.device` is
    /// "virtual").
    pub fn start(cfg: &HostConfig) -> Audio {
        let engine_cfg = EngineConfig { decks: DECKS, pads: 8, ..Default::default() };
        let (tx, rx) = bounded::<Result<Started, String>>(1);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let cfg2 = cfg.clone();
        let thread = std::thread::Builder::new()
            .name("mixit-audio-host".into())
            .spawn(move || {
                let want_virtual = cfg2.device.as_deref() == Some("virtual");
                let real = if want_virtual {
                    Err("virtual output selected".to_string())
                } else {
                    AudioHost::start(&cfg2, engine_cfg.clone()).map_err(|e| e.to_string())
                };
                let (host, ctl, warning) = match real {
                    Ok((h, c)) => (h, c, None),
                    Err(e) => match AudioHost::start_virtual(48_000, cfg2.buffer_frames.unwrap_or(256), engine_cfg) {
                        Ok((h, c)) => (h, c, (!want_virtual).then_some(e)),
                        Err(e2) => {
                            let _ = tx.send(Err(format!("{e}; virtual output: {e2}")));
                            return;
                        }
                    },
                };
                let status = AudioStatus {
                    device: host.device_name.clone(),
                    is_virtual: host.is_virtual(),
                    sample_rate: host.sample_rate,
                    buffer_frames: host.buffer_frames,
                    latency_ms: host.buffer_latency_ms(),
                    warning,
                };
                let _ = tx.send(Ok(Started { ctl, stats: host.stats.clone(), status }));
                // Keep the stream alive until asked to stop.
                let _ = stop_rx.recv();
                drop(host);
            })
            .expect("spawn audio thread");
        let started = rx.recv().expect("audio thread died").expect("no audio output at all");
        let sr = started.status.sample_rate;
        let mut a = Audio {
            ctl: started.ctl,
            dispatcher: ActionDispatcher::new(sr, DECKS),
            sample_rate: sr,
            stats: started.stats,
            status: started.status,
            keeper: Some((stop_tx, thread)),
            mic: None,
        };
        a.init();
        a
    }

    fn init(&mut self) {
        let sr = self.sample_rate;
        for d in 0..DECKS {
            let id = DeckId(d as u8);
            self.send(Command::Deck(
                id,
                DeckCommand::SetStretcher(Box::new(SignalsmithStretch::new(sr, StretchQuality::High))),
            ));
            self.send(Command::Deck(id, DeckCommand::SetTempoRange(0.08)));
            self.send(Command::Mixer(MixerCommand::SetFader(id, 1.0)));
        }
        self.send(Command::Global(GlobalCommand::SetTelemetryRate(60.0)));
    }

    pub fn send(&mut self, c: Command) {
        // A full command ring means the audio thread is stalled; dropping is the only
        // safe choice (the UI re-sends continuous values).
        let _ = self.ctl.send(c);
    }

    /// Opens an input device for the mic channel (closing any other first).
    pub fn open_mic(&mut self, cfg: &InputConfig) -> Result<MicStatus, String> {
        self.close_mic();
        let (tx, rx) = bounded::<Result<(mixit_engine::InputFeed, MicStatus, Arc<InputStats>), String>>(1);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let cfg2 = cfg.clone();
        let out_rate = self.sample_rate;
        let thread = std::thread::Builder::new()
            .name("mixit-audio-input".into())
            .spawn(move || match InputHost::start(&cfg2, out_rate) {
                Ok((host, feed)) => {
                    let status = MicStatus {
                        device: host.device_name.clone(),
                        sample_rate: host.sample_rate,
                        channels: host.channels,
                        buffer_frames: host.buffer_frames,
                        channel: cfg2.channel,
                        stereo: cfg2.stereo,
                    };
                    let _ = tx.send(Ok((feed, status, host.stats.clone())));
                    let _ = stop_rx.recv();
                    drop(host);
                }
                Err(e) => {
                    let _ = tx.send(Err(e.to_string()));
                }
            })
            .map_err(|e| e.to_string())?;
        let (feed, status, stats) = match rx.recv() {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                let _ = thread.join();
                return Err(e);
            }
            Err(_) => return Err("the input device thread stopped".into()),
        };
        self.send(Command::Mic(MicCommand::SetFeed(Some(Box::new(feed)))));
        self.mic = Some(Mic { status: status.clone(), stats, keeper: (stop_tx, thread) });
        Ok(status)
    }

    /// Disconnects and closes the input device.
    pub fn close_mic(&mut self) {
        if let Some(m) = self.mic.take() {
            self.send(Command::Mic(MicCommand::SetFeed(None)));
            let _ = m.keeper.0.send(());
            let _ = m.keeper.1.join();
        }
    }

    pub fn mic_status(&self) -> Option<MicStatus> {
        self.mic.as_ref().map(|m| m.status.clone())
    }

    /// True when the input device reported that it went away (unplugged).
    pub fn mic_lost(&self) -> bool {
        self.mic.as_ref().is_some_and(|m| m.stats.device_lost.load(std::sync::atomic::Ordering::Relaxed))
    }

    pub fn stop(&mut self) {
        self.close_mic();
        if let Some((tx, t)) = self.keeper.take() {
            let _ = tx.send(());
            let _ = t.join();
        }
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.stop();
    }
}
