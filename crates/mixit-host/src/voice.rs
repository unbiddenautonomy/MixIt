//! The mic cleaner's thread: sits between the input device and the engine.
//!
//! ```text
//! input callback → raw ring → cleaner thread (echo cancel, noise removal) → InputFeed → engine
//!                                   ↑
//!            engine's echo tap (what the master plays, without the mic)
//! ```
//!
//! The device callback stays as it was (no allocation, no locks): it writes into a ring
//! the thread reads. The thread wakes every couple of milliseconds, gives the cleaner
//! what the speakers played since, then cleans whatever mic audio has arrived, 10 ms at
//! a time, and passes it on. It stops when the input stream does.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use mixit_engine::push_input;
use mixit_ml::voice::{Denoise, VoiceCleaner, VoiceSettings};

use crate::input::{MicClean, MicDenoise};

/// How long the thread sleeps when there is nothing to do.
const NAP: Duration = Duration::from_millis(2);

impl From<MicClean> for VoiceSettings {
    fn from(c: MicClean) -> Self {
        VoiceSettings {
            echo: c.echo,
            denoise: match c.denoise {
                MicDenoise::Off => Denoise::Off,
                MicDenoise::Light => Denoise::Light,
                MicDenoise::Strong => Denoise::Strong,
            },
        }
    }
}

/// Counters from the cleaner thread.
#[derive(Debug, Default)]
pub struct CleanStats {
    /// Mic frames cleaned.
    pub frames: AtomicU64,
    /// Cleaned frames that did not fit on the way to the engine.
    pub dropped: AtomicU64,
}

/// A running cleaner thread. Dropping it stops the thread.
pub struct CleanerThread {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub stats: Arc<CleanStats>,
    /// What it does, in plain words.
    pub describe: String,
    /// The delay it adds, in mic frames.
    pub delay_frames: usize,
}

impl CleanerThread {
    /// Starts cleaning: reads interleaved stereo from `raw` (a mono mic on both sides),
    /// what the speakers play from `reference` (mono at `output_rate`) and writes the
    /// cleaned mic, on both sides, to `out`.
    pub fn start(
        settings: VoiceSettings,
        rate: u32,
        output_rate: u32,
        raw: rtrb::Consumer<f32>,
        reference: rtrb::Consumer<f32>,
        out: rtrb::Producer<f32>,
    ) -> Result<CleanerThread, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::new(CleanStats::default());
        let (stop2, stats2) = (stop.clone(), stats.clone());
        // The trained model cannot move between threads, so it is built on the thread
        // that runs it, which reports back whether it started.
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new()
            .name("mixit-mic-clean".into())
            .spawn(move || match VoiceCleaner::new(settings, rate, output_rate) {
                Ok(cleaner) => {
                    let _ = ready_tx.send(Ok((cleaner.describe().to_string(), cleaner.delay())));
                    run(cleaner, raw, reference, out, &stop2, &stats2);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                }
            })
            .map_err(|e| e.to_string())?;
        match ready_rx.recv() {
            Ok(Ok((describe, delay_frames))) => {
                Ok(CleanerThread { stop, thread: Some(thread), stats, describe, delay_frames })
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err("the mic cleaner stopped".into())
            }
        }
    }
}

impl Drop for CleanerThread {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run(
    mut cleaner: VoiceCleaner,
    mut raw: rtrb::Consumer<f32>,
    mut reference: rtrb::Consumer<f32>,
    mut out: rtrb::Producer<f32>,
    stop: &AtomicBool,
    stats: &CleanStats,
) {
    crate::denormals::disable_denormals();
    let mut refs = Vec::with_capacity(16_384);
    let mut mono = Vec::with_capacity(16_384);
    let mut clean = Vec::with_capacity(16_384);
    let mut stereo = Vec::with_capacity(32_768);
    while !stop.load(Ordering::Relaxed) {
        // What the speakers played first, so the echo it causes is never ahead of it.
        refs.clear();
        drain(&mut reference, |v| refs.push(v));
        cleaner.reference(&refs);
        mono.clear();
        let mut k = 0usize;
        drain(&mut raw, |v| {
            if k % 2 == 0 {
                mono.push(v);
            }
            k += 1;
        });
        clean.clear();
        cleaner.process(&mono, &mut clean);
        if clean.is_empty() {
            std::thread::sleep(NAP);
            continue;
        }
        stereo.clear();
        stereo.extend(clean.iter().flat_map(|&v| [v, v]));
        let pushed = push_input(&mut out, &stereo);
        stats.frames.fetch_add(clean.len() as u64, Ordering::Relaxed);
        stats.dropped.fetch_add((clean.len() - pushed) as u64, Ordering::Relaxed);
    }
}

/// Reads everything waiting in `ring`.
fn drain(ring: &mut rtrb::Consumer<f32>, mut each: impl FnMut(f32)) {
    let n = ring.slots();
    if let Ok(c) = ring.read_chunk(n) {
        let (a, b) = c.as_slices();
        a.iter().chain(b).for_each(|&v| each(v));
        c.commit_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_the_mic_on_its_way_to_the_engine() {
        // Noise alone into the mic: the noise remover takes it out, the frames all arrive.
        let (mut raw_tx, raw_rx) = rtrb::RingBuffer::new(96_000);
        let (mut ref_tx, ref_rx) = rtrb::RingBuffer::new(48_000);
        let (out_tx, mut out_rx) = rtrb::RingBuffer::new(192_000);
        let settings = VoiceSettings { echo: true, denoise: Denoise::Light };
        let t = CleanerThread::start(settings, 48_000, 48_000, raw_rx, ref_rx, out_tx).unwrap();
        assert_eq!(t.describe, "echo cancelled, noise removed (RNNoise)");
        let mut s = 5u32;
        let mut sent = 0.0f64;
        for _ in 0..200 {
            let block: Vec<f32> = (0..256)
                .flat_map(|_| {
                    s ^= s << 13;
                    s ^= s >> 17;
                    s ^= s << 5;
                    let v = (s as f32 / u32::MAX as f32 - 0.5) * 0.05;
                    [v, v]
                })
                .collect();
            sent += block.iter().map(|&v| v as f64 * v as f64).sum::<f64>();
            push_input(&mut raw_tx, &block);
            for _ in 0..256 {
                let _ = ref_tx.push(0.0);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while t.stats.frames.load(Ordering::Relaxed) < 50_000 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        // 200 blocks of 256 = 51_200 frames: every whole 10 ms frame comes out.
        assert_eq!(t.stats.frames.load(Ordering::Relaxed), 51_200 / 480 * 480);
        assert_eq!(t.stats.dropped.load(Ordering::Relaxed), 0);
        drop(t);
        let n = out_rx.slots();
        let c = out_rx.read_chunk(n).unwrap();
        let (a, b) = c.as_slices();
        let got: f64 = a.iter().chain(b).map(|&v| v as f64 * v as f64).sum();
        assert_eq!(n, 51_200 / 480 * 480 * 2);
        assert!(got < sent * 0.3, "noise {sent:.3} -> {got:.3}");
    }
}
