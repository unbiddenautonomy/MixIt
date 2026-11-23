//! Soak test: the whole engine under a long, random but repeatable session.
//!
//! Every control in the action registry (decks and their stems, mixer, effects, sampler,
//! mic, A/B bypass) is pressed, held, switched and swept to random and extreme values,
//! while the decks keep loading hostile material: full-scale sweeps and square waves, DC
//! offset, single impulses, white noise and silence, half of it with stems. Blocks come
//! in odd sizes. Throughout:
//!
//! * the audio callback never allocates (checked by the allocator),
//! * every sample of the master and headphone outputs is finite and within full scale,
//! * nothing that was sent to the engine is leaked instead of coming back to be freed,
//! * and, on a long run, the engine keeps up with real time with room to spare (a
//!   denormal or a runaway filter shows up as a slowdown).
//!
//! `cargo test` runs one minute of audio. For a real soak set the length in minutes:
//! `MIXIT_SOAK_MINUTES=60 cargo test --release -p mixit-engine --test soak -- --nocapture`.
//! `MIXIT_SOAK_SEED` replays another session.

use std::sync::Arc;
use std::time::Instant;

use mixit_core::actions::{ActionKind, registry};
use mixit_core::{Beatgrid, DeckId};
use mixit_dsp::stretch::TimeStretch;
use mixit_dsp::testkit;
use mixit_engine::actions::{ActionDispatcher, ActionInput};
use mixit_engine::*;

#[global_allocator]
static ALLOC: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

const SR: u32 = 48_000;
const DECKS: usize = 4;
const PADS: usize = 16;

/// xorshift64*: small, fast and the same everywhere.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
}

/// The material decks are loaded with, in turn (all 20 s, mono).
fn material(kind: usize) -> (&'static str, Vec<f32>) {
    let n = SR as usize * 20;
    let sr = SR as f32;
    match kind % 7 {
        0 => ("full-scale sweep", testkit::sweep(n, 20.0, 20_000.0, sr, 0.99)),
        1 => ("full-scale square", (0..n).map(|i| if (i / 120) % 2 == 0 { 1.0 } else { -1.0 }).collect()),
        2 => ("DC offset", (0..n).map(|i| 0.6 + 0.05 * ((i as f32 * 0.01).sin())).collect()),
        3 => ("impulses", (0..n).map(|i| if i % (SR as usize / 2) == 0 { 1.0 } else { 0.0 }).collect()),
        4 => ("white noise", testkit::noise(n, kind as u64 + 1, 0.95)),
        5 => ("silence", vec![0.0; n]),
        _ => ("music-like tone", testkit::sine(n, 110.0, sr, 0.5)),
    }
}

fn load(ctl: &mut Controller, deck: usize, kind: usize, rng: &mut Rng) {
    let (_, x) = material(kind);
    // Some grids are warped, as a live recording's would be.
    let mut grid = Beatgrid::constant(SR, 100.0 + rng.unit() * 60.0, rng.unit() * 2_000.0);
    if rng.chance(0.3) {
        let f = grid.frame_at(32.0) + (rng.unit() - 0.5) * 2_000.0;
        let _ = grid.add_warp_anchor(f);
    }
    let t = DeckTrack::new(Arc::new(TrackAudio::from_mono(SR, &x)), Arc::new(grid));
    let id = DeckId(deck as u8);
    let _ = ctl.deck(id, DeckCommand::Load(Box::new(t)));
    // Half the tracks get stems (arbitrary but full-scale ones), now and then ones that
    // do not fit, which the deck must give back.
    if rng.chance(0.5) {
        let n = if rng.chance(0.1) { x.len() - 1 } else { x.len() };
        let st: Vec<f32> = x[..n].iter().flat_map(|&v| [v, -v]).collect();
        let noise: Vec<f32> = testkit::noise(n, rng.next(), 0.9).iter().flat_map(|&v| [v, v]).collect();
        let stems = StemAudio { vocals: st.clone(), drums: noise, bass: st.iter().map(|v| v * 0.5).collect() };
        let _ = ctl.deck(id, DeckCommand::SetStems(Arc::new(stems)));
    }
    let stretch: Box<dyn TimeStretch> = if rng.chance(0.5) {
        Box::new(mixit_stretch::PhaseVocoder::new(SR))
    } else {
        Box::new(mixit_dsp::stretch::ResampleStretch::new())
    };
    let _ = ctl.deck(id, DeckCommand::SetStretcher(stretch));
}

/// A random input that suits the control: sometimes at an extreme, sometimes anywhere.
fn input_for(kind: &ActionKind, rng: &mut Rng) -> ActionInput {
    match kind {
        ActionKind::Trigger | ActionKind::Momentary => ActionInput::Press,
        ActionKind::Toggle => ActionInput::Set(rng.chance(0.5)),
        ActionKind::Continuous { spec } => {
            let (lo, hi) = (spec.min as f64, spec.max as f64);
            let v = match rng.below(5) {
                0 => lo,
                1 => hi,
                _ => lo + rng.unit() * (hi - lo),
            };
            ActionInput::Value(v)
        }
        ActionKind::Choice { options, .. } => ActionInput::Choice(rng.below(options.len())),
    }
}

/// Renders `frames` in random block sizes and checks every sample.
fn render(e: &mut Engine, rng: &mut Rng, frames: usize, m: &mut [f32], c: &mut [f32], worst: &mut f32) {
    let mut left = frames;
    while left > 0 {
        // Mostly ordinary sizes, sometimes odd ones (a single frame, a prime).
        let n = match rng.below(4) {
            0 => 1 + rng.below(512),
            1 => 509,
            _ => 256,
        }
        .min(left);
        let (mm, cc) = (&mut m[..n * 2], &mut c[..n * 2]);
        assert_no_alloc::assert_no_alloc(|| e.process(mm, cc));
        for &v in mm.iter().chain(cc.iter()) {
            assert!(v.is_finite(), "non-finite output");
            *worst = worst.max(v.abs());
        }
        left -= n;
    }
}

#[test]
fn soak_the_whole_engine() {
    let minutes: f64 = std::env::var("MIXIT_SOAK_MINUTES").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let seed: u64 = std::env::var("MIXIT_SOAK_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x5eed_cafe);
    let mut rng = Rng(seed | 1);

    let (mut engine, mut ctl) = Engine::new(EngineConfig { sample_rate: SR, ..Default::default() });
    let mut disp = ActionDispatcher::new(SR, DECKS);
    // Everything the engine handles itself (app.* belongs to the app).
    let actions: Vec<_> = registry(DECKS, PADS).into_iter().filter(|a| !a.id.starts_with("app.")).collect();
    assert!(actions.len() > 300);

    let mut kind = 0;
    for d in 0..DECKS {
        load(&mut ctl, d, kind, &mut rng);
        kind += 1;
        let _ = ctl.deck(DeckId(d as u8), DeckCommand::Play);
    }

    let total = (minutes * 60.0 * SR as f64) as usize;
    let (mut m, mut c) = (vec![0.0f32; 1024], vec![0.0f32; 1024]);
    let mut sink = Vec::new();
    let mut held: Vec<(usize, usize)> = Vec::new(); // (action, release after n steps)
    let (mut done, mut steps, mut worst) = (0usize, 0usize, 0.0f32);
    let started = Instant::now();
    let trace = std::env::var("MIXIT_SOAK_TRACE").is_ok();

    while done < total {
        steps += 1;
        // A control change.
        let i = rng.below(actions.len());
        let a = &actions[i];
        let input = input_for(&a.kind, &mut rng);
        if trace {
            eprintln!("{steps} @{:.1}s {} {input:?}", done as f64 / SR as f64, a.id);
        }
        if let Ok(cmds) = disp.dispatch(&a.id, input) {
            for cmd in cmds {
                let _ = ctl.send(cmd);
            }
        }
        if matches!(a.kind, ActionKind::Momentary) {
            held.push((i, steps + 1 + rng.below(8)));
        }
        // Let go of held buttons when their time comes.
        let mut k = 0;
        while k < held.len() {
            if held[k].1 <= steps {
                let (j, _) = held.swap_remove(k);
                if let Ok(cmds) = disp.dispatch(&actions[j].id, ActionInput::Release) {
                    for cmd in cmds {
                        let _ = ctl.send(cmd);
                    }
                }
            } else {
                k += 1;
            }
        }
        // Now and then a deck gets new material and starts again.
        if rng.chance(0.02) {
            let d = rng.below(DECKS);
            load(&mut ctl, d, kind, &mut rng);
            kind += 1;
            let _ = ctl.deck(DeckId(d as u8), DeckCommand::Play);
        }
        let frames = (64 + rng.below(4_096)).min(total - done);
        render(&mut engine, &mut rng, frames, &mut m, &mut c, &mut worst);
        done += frames;
        // The app's side of the session: recordings drained, old objects freed.
        ctl.drain_recorder(&mut sink);
        sink.clear();
        ctl.collect_trash();
    }

    let took = started.elapsed().as_secs_f64();
    let audio = total as f64 / SR as f64;
    println!(
        "soak: {audio:.0} s of audio, {steps} control changes, {kind} loads, loudest sample {worst:.3}, {:.1}x real time",
        audio / took
    );
    assert!(worst <= 1.0 + 1e-6, "output beyond full scale: {worst}");
    let t = engine.snapshot();
    assert_eq!(t.leaked, 0, "objects leaked instead of being freed off the audio thread");
    // A long run must keep up with real time with room to spare. (Short runs in a debug
    // build or on a busy CI machine say little, so only long ones are timed.)
    if minutes >= 10.0 {
        assert!(audio / took > 2.0, "only {:.2}x real time", audio / took);
    }
}
