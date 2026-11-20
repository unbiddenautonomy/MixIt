//! Faster-than-real-time rendering: drives the engine without a device (exports,
//! tests, the CLI and project bounces).

use mixit_engine::Engine;

/// Renders `frames` of master (and cue) output, calling `between(engine_frame)` before
/// each block so callers can feed commands at block granularity (sample-accurate
/// commands go through `Controller::send_at` instead).
pub fn render(engine: &mut Engine, frames: usize, block: usize, mut between: impl FnMut(u64)) -> (Vec<f32>, Vec<f32>) {
    crate::denormals::disable_denormals();
    let block = block.max(1);
    let mut master = vec![0.0f32; frames * 2];
    let mut cue = vec![0.0f32; frames * 2];
    let mut pos = 0;
    while pos < frames {
        let n = block.min(frames - pos);
        between(engine.frame());
        engine.process(&mut master[pos * 2..(pos + n) * 2], &mut cue[pos * 2..(pos + n) * 2]);
        pos += n;
    }
    (master, cue)
}
