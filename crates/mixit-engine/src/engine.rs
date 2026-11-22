//! The engine: owns decks, mixer and sampler on the audio thread, and the controller that
//! talks to it from the UI side.

use std::sync::Arc;

use mixit_core::{DeckId, Quantize};
use mixit_dsp::fx::FxContext;

use crate::commands::{Command, DeckCommand, FxCommand, FxTarget, GlobalCommand, Timed};
use crate::deck::{BLOCK, Deck, DeckEnv};
use crate::input::{MicChannel, MicCommand};
use crate::kernels::PlaybackKernels;
use crate::mixer::{Mixer, ScopeSource, trash_effect};
use crate::preview::{PreviewRoute, Previewer};
use crate::sampler::{Sampler, SamplerEnv};
use crate::telemetry::{Event, EventSink, MasterTelemetry, MicTelemetry, PreviewTelemetry, Telemetry};
use crate::trash::{Trash, TrashBin};

#[derive(Clone, Debug)]
pub struct EngineConfig {
    pub sample_rate: u32,
    pub decks: usize,
    pub pads: usize,
    pub command_capacity: usize,
    pub event_capacity: usize,
    /// Seconds of master audio the recorder ring holds before the writer must drain it.
    pub recorder_seconds: f32,
    /// Seconds of mic audio the capture ring holds (for sampling the mic onto a pad or
    /// recording a take into the library).
    pub capture_seconds: f32,
    /// Telemetry snapshots per second.
    pub telemetry_rate: f32,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig {
            sample_rate: 48_000,
            decks: 4,
            pads: 16,
            command_capacity: 4_096,
            event_capacity: 1_024,
            recorder_seconds: 8.0,
            capture_seconds: 8.0,
            telemetry_rate: 60.0,
        }
    }
}

const PENDING: usize = 256;

/// The audio-thread half. Call [`Engine::process`] from the audio callback.
pub struct Engine {
    sr: f64,
    decks: Vec<Deck>,
    envs: Vec<DeckEnv>,
    auto_gains: Vec<f32>,
    mixer: Mixer,
    sampler: Sampler,
    mic: MicChannel,
    preview: Previewer,
    preview_on: bool,
    quantize: Quantize,
    master: Option<DeckId>,
    clock_explicit: bool,
    clock_bpm: f64,
    clock_beat: f64,
    rx: rtrb::Consumer<Timed>,
    pending: Vec<Timed>,
    dropped_commands: u32,
    events: EventSink,
    tel_tx: rtrb::Producer<Telemetry>,
    tel_interval: u64,
    tel_countdown: u64,
    trash: TrashBin,
    rec_tx: rtrb::Producer<f32>,
    scope_tx: rtrb::Producer<f32>,
    recording: bool,
    recorded: u64,
    frame: u64,
    last_snapshot: u64,
}

/// The control-side half: send commands, read telemetry and events, drain the recorder.
pub struct Controller {
    pub sample_rate: u32,
    tx: rtrb::Producer<Timed>,
    events: rtrb::Consumer<Event>,
    telemetry: rtrb::Consumer<Telemetry>,
    trash: rtrb::Consumer<Trash>,
    recorder: rtrb::Consumer<f32>,
    capture: rtrb::Consumer<f32>,
    scope: rtrb::Consumer<f32>,
    latest: Telemetry,
}

impl Engine {
    /// Builds the engine and its controller. Allocates everything up front.
    pub fn new(cfg: EngineConfig) -> (Engine, Controller) {
        let sr = cfg.sample_rate as f32;
        let kernels = Arc::new(PlaybackKernels::new());
        let n = cfg.decks.clamp(1, DeckId::MAX);
        let decks = (0..n).map(|i| Deck::new(DeckId(i as u8), cfg.sample_rate, kernels.clone())).collect();
        let (tx, rx) = rtrb::RingBuffer::new(cfg.command_capacity);
        let (ev_tx, ev_rx) = rtrb::RingBuffer::new(cfg.event_capacity);
        let (tel_tx, tel_rx) = rtrb::RingBuffer::new(64);
        let (trash_tx, trash_rx) = rtrb::RingBuffer::new(1_024);
        let (rec_tx, rec_rx) = rtrb::RingBuffer::new((cfg.recorder_seconds * sr) as usize * 2);
        let (cap_tx, cap_rx) = rtrb::RingBuffer::new((cfg.capture_seconds.max(1.0) * sr) as usize * 2);
        // A little more than a quarter second of mono for the spectrum analyser.
        let (scope_tx, scope_rx) = rtrb::RingBuffer::new(16_384);
        let tel_interval = (sr / cfg.telemetry_rate.max(1.0)) as u64;
        let engine = Engine {
            sr: sr as f64,
            decks,
            envs: vec![DeckEnv::default(); n],
            auto_gains: vec![0.0; n],
            mixer: Mixer::new(sr, n),
            sampler: Sampler::new(sr, cfg.pads),
            mic: MicChannel::new(sr, cap_tx),
            preview: Previewer::new(sr, BLOCK),
            preview_on: false,
            quantize: Quantize::Beat,
            master: None,
            clock_explicit: false,
            clock_bpm: 120.0,
            clock_beat: 0.0,
            rx,
            pending: Vec::with_capacity(PENDING),
            dropped_commands: 0,
            events: EventSink::new(ev_tx),
            tel_tx,
            tel_interval: tel_interval.max(64),
            tel_countdown: 0,
            trash: TrashBin::new(trash_tx),
            rec_tx,
            scope_tx,
            recording: false,
            recorded: 0,
            frame: 0,
            last_snapshot: 0,
        };
        let ctl = Controller {
            sample_rate: cfg.sample_rate,
            tx,
            events: ev_rx,
            telemetry: tel_rx,
            trash: trash_rx,
            recorder: rec_rx,
            capture: cap_rx,
            scope: scope_rx,
            latest: Telemetry::default(),
        };
        (engine, ctl)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sr as u32
    }

    pub fn frame(&self) -> u64 {
        self.frame
    }

    pub fn deck(&self, id: DeckId) -> Option<&Deck> {
        self.decks.get(id.index())
    }

    pub fn mixer(&self) -> &Mixer {
        &self.mixer
    }

    /// Renders interleaved stereo `master` and `cue` (headphones) buffers of equal length.
    /// Real-time safe: no allocation, locking or blocking.
    pub fn process(&mut self, master: &mut [f32], cue: &mut [f32]) {
        let total = master.len().min(cue.len()) / 2;
        self.receive();
        let mut done = 0;
        while done < total {
            self.apply_due();
            let mut n = (total - done).min(BLOCK);
            if let Some(next) = self.pending.iter().filter_map(|t| t.at).min() {
                if next > self.frame {
                    n = n.min((next - self.frame) as usize);
                }
            }
            self.render_chunk(n);
            for i in 0..n {
                let o = (done + i) * 2;
                master[o] = self.mixer.master_l[i];
                master[o + 1] = self.mixer.master_r[i];
                cue[o] = self.mixer.hp_l[i];
                cue[o + 1] = self.mixer.hp_r[i];
            }
            if self.preview_on {
                // Straight to the output: never in the master bus, a recording or the meters.
                let out: &mut [f32] = match self.preview.route {
                    PreviewRoute::Headphones => &mut *cue,
                    PreviewRoute::Speakers => &mut *master,
                };
                for i in 0..n {
                    let o = (done + i) * 2;
                    out[o] = (out[o] + self.preview.out_l[i]).clamp(-1.0, 1.0);
                    out[o + 1] = (out[o + 1] + self.preview.out_r[i]).clamp(-1.0, 1.0);
                }
            }
            if self.recording {
                self.record(n);
            }
            if self.mixer.scope_source != ScopeSource::Off {
                self.push_scope(n);
            }
            self.frame += n as u64;
            done += n;
            if self.tel_countdown <= n as u64 {
                self.publish_telemetry();
                self.tel_countdown = self.tel_interval;
            } else {
                self.tel_countdown -= n as u64;
            }
        }
        self.trash.flush();
    }

    fn receive(&mut self) {
        while let Ok(t) = self.rx.pop() {
            let due = t.at.is_none_or(|a| a <= self.frame);
            if due {
                self.apply(t.cmd);
            } else if self.pending.len() < self.pending.capacity() {
                self.pending.push(t);
            } else {
                // No room to schedule: apply now rather than lose it.
                self.dropped_commands += 1;
                self.apply(t.cmd);
            }
        }
    }

    fn apply_due(&mut self) {
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].at.is_none_or(|a| a <= self.frame) {
                let t = self.pending.swap_remove(i);
                self.apply(t.cmd);
            } else {
                i += 1;
            }
        }
    }

    fn update_envs(&mut self) {
        let q = self.quantize.beats(4, 8);
        for (i, e) in self.envs.iter_mut().enumerate() {
            *e = DeckEnv {
                quantize: q,
                clock_bpm: self.clock_bpm,
                clock_beat: self.clock_beat,
                clock_running: true,
                is_master: self.master == Some(DeckId(i as u8)),
            };
        }
    }

    fn set_master(&mut self, m: Option<DeckId>) {
        if self.master != m {
            if let Some(id) = m {
                self.decks[id.index()].hold_tempo();
            }
            self.master = m;
            self.events.send(Event::MasterChanged { deck: m });
        }
    }

    fn apply(&mut self, cmd: Command) {
        self.update_envs();
        match cmd {
            Command::Deck(id, dc) => {
                let i = id.index();
                if i >= self.decks.len() {
                    return;
                }
                match dc {
                    DeckCommand::DuplicateFrom(src) => {
                        let s = src.index();
                        if s < self.decks.len() && s != i {
                            let (a, b) = if s < i {
                                let (lo, hi) = self.decks.split_at_mut(i);
                                (&lo[s], &mut hi[0])
                            } else {
                                let (lo, hi) = self.decks.split_at_mut(s);
                                (&hi[0], &mut lo[i])
                            };
                            b.copy_transport_from(a);
                        }
                    }
                    DeckCommand::BecomeMaster => {
                        self.clock_explicit = false;
                        self.set_master(Some(id));
                    }
                    DeckCommand::Sync(true) => {
                        // First deck to sync with no master becomes the master.
                        if self.master.is_none() && !self.clock_explicit {
                            self.set_master(Some(id));
                            self.update_envs();
                        }
                        let env = self.envs[i];
                        self.decks[i].handle(DeckCommand::Sync(true), &env, &mut self.trash, &mut self.events);
                    }
                    DeckCommand::Sync(false) => {
                        let env = self.envs[i];
                        self.decks[i].handle(DeckCommand::Sync(false), &env, &mut self.trash, &mut self.events);
                        if self.master == Some(id) {
                            let next = self.next_master(Some(id));
                            self.set_master(next);
                        }
                    }
                    other => {
                        let is_load = matches!(other, DeckCommand::Load(_) | DeckCommand::Eject);
                        let env = self.envs[i];
                        self.decks[i].handle(other, &env, &mut self.trash, &mut self.events);
                        if is_load {
                            self.auto_gains[i] = self.decks[i].auto_gain_db();
                            self.mixer.refresh_trim(i, self.auto_gains[i]);
                            if self.master == Some(id) && !self.decks[i].is_loaded() {
                                let next = self.next_master(Some(id));
                                self.set_master(next);
                            }
                        }
                    }
                }
            }
            Command::Mixer(mc) => self.mixer.handle(mc, &self.auto_gains, &mut self.trash),
            Command::Fx(target, slot, fc) => {
                let ch = match target {
                    FxTarget::Deck(d) => Some(d.index()),
                    FxTarget::Master => None,
                };
                let ctx = match ch {
                    Some(c) if c < self.mixer.strips.len() => self.mixer.strips[c].fx_ctx,
                    _ => self.master_ctx(),
                };
                let Some(rack) = self.mixer.fx_rack(ch) else { return };
                let Some(s) = rack.slots.get_mut(slot) else { return };
                match fc {
                    FxCommand::SetEffect(e) => {
                        let old = s.set_effect(e);
                        trash_effect(&mut self.trash, old);
                    }
                    FxCommand::SetOn(on) => s.set_on(on, &ctx),
                    FxCommand::SetMix(m) => s.set_mix(m),
                    FxCommand::SetBeats(b) => s.set_beats(b),
                    FxCommand::SetParam(p, v) => s.set_param(p, v),
                }
            }
            Command::Sampler(sc) => {
                let env = self.sampler_env();
                self.sampler.handle(sc, &env, &mut self.trash, &mut self.events);
            }
            Command::Mic(mc) => self.mic.handle(mc, &mut self.trash),
            Command::Preview(pc) => self.preview.handle(pc, &mut self.trash),
            Command::Global(g) => match g {
                GlobalCommand::SetQuantize(q) => self.quantize = q,
                GlobalCommand::SetClockBpm(b) => self.clock_bpm = b.clamp(20.0, 400.0),
                GlobalCommand::ClockMaster => {
                    self.clock_explicit = true;
                    self.set_master(None);
                }
                GlobalCommand::SetRecording(on) => {
                    if on && !self.recording {
                        self.recorded = 0;
                    }
                    self.recording = on;
                }
                GlobalCommand::SetTelemetryRate(r) => {
                    self.tel_interval = ((self.sr as f32 / r.max(1.0)) as u64).max(64)
                }
            },
        }
    }

    /// Another synced, playing deck to hand the master role to.
    fn next_master(&self, except: Option<DeckId>) -> Option<DeckId> {
        self.decks.iter().find(|d| Some(d.id) != except && d.sync_enabled() && d.is_playing()).map(|d| d.id)
    }

    fn master_ctx(&self) -> FxContext {
        FxContext {
            sample_rate: self.sr as f32,
            bpm: self.clock_bpm as f32,
            beat: self.clock_beat,
            beats_per_frame: self.clock_bpm / 60.0 / self.sr,
        }
    }

    fn sampler_env(&self) -> SamplerEnv {
        SamplerEnv {
            clock_bpm: self.clock_bpm,
            clock_beat: self.clock_beat,
            beats_per_frame: self.clock_bpm / 60.0 / self.sr,
            quantize: self.quantize.beats(4, 8),
        }
    }

    fn render_chunk(&mut self, n: usize) {
        // 1. Master clock: follow the master deck while it plays (or, with no master, the
        //    deck being heard), otherwise free-run.
        if let Some(m) = self.master {
            let d = &self.decks[m.index()];
            if d.is_loaded() && d.is_playing() {
                self.clock_bpm = d.effective_bpm().clamp(20.0, 400.0);
                self.clock_beat = d.beat();
            } else if let Some(next) = self.next_master(Some(m)) {
                self.set_master(Some(next));
            } else if d.is_loaded() {
                // Master stopped: keep its tempo so followers do not drift.
                self.clock_bpm = d.fader_bpm().clamp(20.0, 400.0);
            }
        } else if !self.clock_explicit {
            // Nobody is master (no deck is synced): the clock follows the first deck that
            // is playing and heard, so master effects and sampler loops stay in time with
            // the music instead of a default tempo.
            if let Some(d) =
                self.decks.iter().find(|d| d.is_loaded() && d.is_playing() && d.is_audible() && d.effective_bpm() > 1.0)
            {
                self.clock_bpm = d.effective_bpm().clamp(20.0, 400.0);
                self.clock_beat = d.beat();
            }
        }
        self.update_envs();

        // 2. Effect timing per channel (taken before the decks advance).
        for i in 0..self.decks.len() {
            let d = &self.decks[i];
            let ctx = if d.is_audible() && d.effective_bpm() > 1.0 {
                let bpm = d.effective_bpm();
                FxContext {
                    sample_rate: self.sr as f32,
                    bpm: bpm as f32,
                    beat: d.beat(),
                    beats_per_frame: bpm / 60.0 / self.sr,
                }
            } else {
                self.master_ctx()
            };
            self.mixer.strips[i].fx_ctx = ctx;
        }

        // 3. Decks and mixer.
        self.mixer.begin(n);
        for i in 0..self.decks.len() {
            let env = self.envs[i];
            self.decks[i].render(n, &env, &mut self.events);
            let active = self.decks[i].is_audible();
            let d = &self.decks[i];
            let (l, r) = (&d.out_l, &d.out_r);
            self.mixer.mix_channel(i, l, r, n, active);
        }
        self.mixer.sum(n);
        let senv = self.sampler_env();
        let (ml, mr) = (&mut self.mixer.master_l, &mut self.mixer.master_r);
        self.sampler.render(ml, mr, n, &senv, &mut self.events);
        self.mic.render(n, &mut self.mixer);
        let mctx = self.master_ctx();
        self.mixer.finish(n, &mctx);
        self.preview_on = self.preview.render(n, self.clock_bpm, self.clock_beat);
        if self.mixer.clipped {
            self.mixer.clipped = false;
            self.events.send(Event::Clip);
        }

        // 4. Advance the free-running clock.
        let master_playing = self.master.is_some_and(|m| self.decks[m.index()].is_playing());
        if !master_playing {
            self.clock_beat += self.clock_bpm / 60.0 / self.sr * n as f64;
        }
    }

    /// Feeds the spectrum analyser; drops samples when the reader falls behind.
    fn push_scope(&mut self, n: usize) {
        let k = n.min(self.scope_tx.slots());
        if k == 0 {
            return;
        }
        if let Ok(mut chunk) = self.scope_tx.write_chunk_uninit(k) {
            let (a, b) = chunk.as_mut_slices();
            for (i, slot) in a.iter_mut().chain(b.iter_mut()).enumerate() {
                slot.write(self.mixer.scope[i]);
            }
            // SAFETY: every slot of both slices was written above.
            unsafe { chunk.commit_all() };
        }
    }

    fn record(&mut self, n: usize) {
        let need = n * 2;
        if self.rec_tx.slots() < need {
            self.events.send(Event::RecorderOverrun { frames: n as u32 });
            return;
        }
        if let Ok(mut chunk) = self.rec_tx.write_chunk_uninit(need) {
            let (a, b) = chunk.as_mut_slices();
            for (k, slot) in a.iter_mut().chain(b.iter_mut()).enumerate() {
                let i = k / 2;
                let v = if k % 2 == 0 { self.mixer.master_l[i] } else { self.mixer.master_r[i] };
                slot.write(v);
            }
            // SAFETY: every slot of both slices was written above.
            unsafe { chunk.commit_all() };
            self.recorded += n as u64;
        }
    }

    fn publish_telemetry(&mut self) {
        let t = self.snapshot();
        let _ = self.tel_tx.push(t);
    }

    /// Builds a state snapshot now (meters cover the time since the previous one). Used by
    /// the periodic publisher and by offline renders and tests.
    pub fn snapshot(&mut self) -> Telemetry {
        let mut t = Telemetry {
            frame: self.frame,
            clock_bpm: self.clock_bpm,
            clock_beat: self.clock_beat,
            master_deck: self.master,
            recording: self.recording,
            recorded_frames: self.recorded,
            sampler_playing: self.sampler.playing_mask(),
            sequencer_step: self.sampler.sequencer_step(),
            preview: PreviewTelemetry {
                loaded: self.preview.is_loaded(),
                playing: self.preview.is_playing(),
                position_frames: self.preview.position(),
                frames: self.preview.frames(),
                ended: std::mem::take(&mut self.preview.ended),
                synced: self.preview.is_synced(),
                rate: self.preview.rate(),
            },
            leaked: self.trash.leaked,
            dropped_commands: self.dropped_commands + self.events.dropped,
            ..Telemetry::default()
        };
        for i in 0..self.decks.len() {
            let mut d = self.decks[i].telemetry(&self.envs[i]);
            let since = self.frame.saturating_sub(self.last_snapshot);
            let st = &mut self.mixer.strips[i];
            let (peak, rms) = st.take_meters();
            d.peak = peak;
            d.rms = rms;
            let (low, gr, duck) = st.take_studio_meters(since);
            d.low_rms = low;
            d.comp_gr_db = gr;
            d.duck_db = duck;
            d.gate_open = st.studio.gate_open();
            t.decks[i] = d;
        }
        let (peak, rms, duck_db) = self.mic.take_meters();
        let r = &self.mic.reader;
        t.mic = MicTelemetry {
            connected: r.is_connected(),
            live: r.is_live(),
            on_air: self.mic.on_air(),
            peak,
            rms,
            duck_db,
            gate_open: self.mic.gate_open(),
            latency_ms: r.latency_ms(),
            drift_ppm: r.drift_ppm(),
            underruns: r.underruns,
            capturing: self.mic.capturing(),
            captured_frames: self.mic.captured,
        };
        let m = &mut self.mixer;
        t.master = MasterTelemetry {
            peak: m.master_peak,
            true_peak_db: m.true_peak.max_dbtp(),
            momentary_lufs: m.loudness.momentary() as f32,
            short_term_lufs: m.loudness.short_term() as f32,
            correlation: m.correlation.value(),
            limiter_gr_db: m.limiter.meter_gr_db,
            glue_gr_db: m.master_studio.meter_gr_db,
            cue_peak: m.cue_peak,
            clipped: false,
        };
        m.master_peak = [0.0; 2];
        m.cue_peak = [0.0; 2];
        self.last_snapshot = self.frame;
        m.true_peak.reset();
        t
    }
}

impl Controller {
    /// Sends a command for the next block. Returns it back if the ring is full.
    pub fn send(&mut self, cmd: Command) -> Result<(), Command> {
        self.tx.push(Timed { at: None, cmd }).map_err(|rtrb::PushError::Full(t)| t.cmd)
    }

    /// Schedules a command at an exact engine frame.
    pub fn send_at(&mut self, frame: u64, cmd: Command) -> Result<(), Command> {
        self.tx.push(Timed { at: Some(frame), cmd }).map_err(|rtrb::PushError::Full(t)| t.cmd)
    }

    pub fn deck(&mut self, id: DeckId, cmd: DeckCommand) -> Result<(), Command> {
        self.send(Command::Deck(id, cmd))
    }

    /// Drains events.
    pub fn events(&mut self) -> impl Iterator<Item = Event> + '_ {
        std::iter::from_fn(move || self.events.pop().ok())
    }

    /// Reads all pending snapshots and returns the newest.
    pub fn telemetry(&mut self) -> &Telemetry {
        while let Ok(t) = self.telemetry.pop() {
            self.latest = t;
        }
        &self.latest
    }

    /// Frees objects the audio thread has let go of. Call regularly (e.g. every UI frame).
    pub fn collect_trash(&mut self) -> usize {
        let mut n = 0;
        while let Ok(item) = self.trash.pop() {
            drop(item);
            n += 1;
        }
        n
    }

    /// Sends a mic command.
    pub fn mic(&mut self, cmd: MicCommand) -> Result<(), Command> {
        self.send(Command::Mic(cmd))
    }

    /// Sends a preview player command.
    pub fn preview(&mut self, cmd: crate::preview::PreviewCommand) -> Result<(), Command> {
        self.send(Command::Preview(cmd))
    }

    /// Moves captured mic audio (interleaved stereo, see [`MicCommand::Capture`]) into `out`.
    pub fn drain_capture(&mut self, out: &mut Vec<f32>) -> usize {
        let n = self.capture.slots();
        if n == 0 {
            return 0;
        }
        if let Ok(chunk) = self.capture.read_chunk(n) {
            let (a, b) = chunk.as_slices();
            out.extend_from_slice(a);
            out.extend_from_slice(b);
            chunk.commit_all();
        }
        n
    }

    /// Moves spectrum-analyser samples (mono, see [`MixerCommand::SetScope`]) into `out`.
    pub fn drain_scope(&mut self, out: &mut Vec<f32>) -> usize {
        let n = self.scope.slots();
        if n == 0 {
            return 0;
        }
        if let Ok(chunk) = self.scope.read_chunk(n) {
            let (a, b) = chunk.as_slices();
            out.extend_from_slice(a);
            out.extend_from_slice(b);
            chunk.commit_all();
        }
        n
    }

    /// Moves recorded master audio (interleaved stereo) into `out`.
    pub fn drain_recorder(&mut self, out: &mut Vec<f32>) -> usize {
        let n = self.recorder.slots();
        if n == 0 {
            return 0;
        }
        if let Ok(chunk) = self.recorder.read_chunk(n) {
            let (a, b) = chunk.as_slices();
            out.extend_from_slice(a);
            out.extend_from_slice(b);
            chunk.commit_all();
        }
        n
    }
}
