//! The DJ mixer: channel strips, crossfader, master chain and headphone cue.
//!
//! Channel signal flow (as on club mixers):
//!
//! ```text
//! deck → trim (+ auto-gain) → studio (gate, EQ, compressor, saturation, width)
//!      → EQ → filter → [meter, cue tap] → (FX pre) → fader × crossfader → pan
//!      → (FX post, default) → ducking → master bus
//!                                    └→ sends → reverb / echo returns → master bus
//! ```
//!
//! With FX post-fader, pulling the fader down stops feeding an echo or reverb while its
//! tail keeps ringing: the classic echo-out. The sends are post-fader too.
//!
//! Channels are processed first and summed afterwards, so a channel can be ducked by any
//! other channel's sound in the same block (see [`Mixer::sum`]).
//!
//! Master: bus + returns → master FX → master studio (glue compressor, EQ…) → master
//! level → limiter → meters. Headphones blend the cue bus with the master (or split cue:
//! cue left, master right, both mono).

use mixit_core::DeckId;
use mixit_dsp::curves::{CrossfaderCurve, FaderCurve, PanLaw, crossfader_gains, fader_gain, pan_gains};
use mixit_dsp::djeq::{DjEq, EqMode, EqVoicing};
use mixit_dsp::djfilter::DjFilter;
use mixit_dsp::dynamics::Limiter;
use mixit_dsp::fx::{FxContext, FxRack};
use mixit_dsp::meters::{CorrelationMeter, LoudnessMeter, TruePeakMeter};
use mixit_dsp::smooth::Smoothed;
use mixit_dsp::studio::{Ducker, StudioSettings, StudioStrip};
use mixit_dsp::svf::{Svf, SvfCoeffs, SvfMode};
use mixit_dsp::util::{db_to_gain, flush, one_pole_coeff};

use crate::commands::{MixerCommand, XfAssign};
use crate::deck::BLOCK;
use crate::trash::{Trash, TrashBin};

pub const LIMITER_CEILING_DB: f32 = -0.3;

/// Number of shared send effects (0 = reverb, "space"; 1 = echo).
pub const RETURNS: usize = 2;

/// What feeds the spectrum analyser.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ScopeSource {
    #[default]
    Off,
    Master,
    /// A channel after its studio chain and EQ, before the fader.
    Channel(usize),
}

/// A shared effect fed by the channels' sends (a reverb or echo "return").
pub struct ReturnBus {
    pub fx: Box<dyn mixit_dsp::fx::Effect>,
    pub l: Vec<f32>,
    pub r: Vec<f32>,
    level: Smoothed,
    /// Low cut on the way in: keeps the bass out of the reverb, as mix engineers do.
    hp: [Svf; 2],
    hp_c: SvfCoeffs,
    /// Blocks since anything audible came out (skips the effect once its tail is gone).
    quiet_blocks: u32,
    fed: bool,
}

impl ReturnBus {
    fn new(sr: f32, fx: Box<dyn mixit_dsp::fx::Effect>) -> ReturnBus {
        ReturnBus {
            fx,
            l: vec![0.0; BLOCK],
            r: vec![0.0; BLOCK],
            level: Smoothed::new(db_to_gain(-3.0), 20.0, sr),
            hp: [Svf::default(); 2],
            hp_c: SvfCoeffs::design(SvfMode::Highpass, 250.0, std::f32::consts::FRAC_1_SQRT_2, 0.0, sr),
            quiet_blocks: u32::MAX,
            fed: false,
        }
    }
}

/// Return parameters (see [`MixerCommand::SetReturn`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReturnParam {
    /// Level (dB).
    Level(f32),
    /// Effect parameter `index` (0 … 1): reverb size and tone, echo feedback and tone.
    Param(usize, f32),
    /// Echo time / reverb pre-delay in beats.
    Beats(f32),
}

pub struct ChannelStrip {
    trim_db: f32,
    trim: Smoothed,
    pub studio: StudioStrip,
    pub eq: DjEq,
    pub filter: DjFilter,
    fader_pos: f32,
    fader: Smoothed,
    pan: f32,
    pan_l: Smoothed,
    pan_r: Smoothed,
    pub cue: bool,
    pub assign: XfAssign,
    pub fx: FxRack,
    pub fx_post_fader: bool,
    pub fx_ctx: FxContext,
    /// Send levels to the returns (post-fader).
    send: [Smoothed; RETURNS],
    /// Turned down while this channel is loud.
    pub duck_source: Option<usize>,
    pub ducker: Ducker,
    pub(crate) l: Vec<f32>,
    pub(crate) r: Vec<f32>,
    /// The signal before processing, for A/B bypass.
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    /// Whether `l`/`r` hold this block's output (false when the channel was skipped).
    live: bool,
    /// Peak since the last telemetry snapshot (pre-fader).
    pub peak: [f32; 2],
    pub sum_sq: f64,
    pub count: u64,
    /// Post-fader bass (below about 150 Hz), for spotting two basslines at once.
    low_lp: [f32; 2],
    low_c: f32,
    pub low_sum_sq: f64,
    pub duck_peak_db: f32,
    pub gr_peak_db: f32,
}

impl ChannelStrip {
    pub fn new(sr: f32) -> ChannelStrip {
        // Classic EQ by default: bit-transparent at unity. Isolator is one switch away.
        let mut eq = DjEq::new(sr, EqVoicing::default());
        eq.set_mode_now(EqMode::Classic);
        ChannelStrip {
            trim_db: 0.0,
            trim: Smoothed::new(1.0, 20.0, sr),
            studio: StudioStrip::new(sr, BLOCK),
            eq,
            filter: DjFilter::new(sr),
            fader_pos: 1.0,
            fader: Smoothed::new(1.0, 8.0, sr),
            pan: 0.0,
            pan_l: Smoothed::new(1.0, 20.0, sr),
            pan_r: Smoothed::new(1.0, 20.0, sr),
            cue: false,
            assign: XfAssign::Thru,
            fx: FxRack::new(sr, BLOCK),
            fx_post_fader: true,
            fx_ctx: FxContext::free(sr, 120.0),
            send: [Smoothed::new(0.0, 20.0, sr), Smoothed::new(0.0, 20.0, sr)],
            duck_source: None,
            ducker: Ducker::new(sr),
            l: vec![0.0; BLOCK],
            r: vec![0.0; BLOCK],
            dry_l: vec![0.0; BLOCK],
            dry_r: vec![0.0; BLOCK],
            live: false,
            peak: [0.0; 2],
            sum_sq: 0.0,
            count: 0,
            low_lp: [0.0; 2],
            low_c: 1.0 - one_pole_coeff(1.0 / (2.0 * std::f32::consts::PI * 150.0), sr),
            low_sum_sq: 0.0,
            duck_peak_db: 0.0,
            gr_peak_db: 0.0,
        }
    }

    pub fn take_meters(&mut self) -> ([f32; 2], f32) {
        let rms = if self.count > 0 { (self.sum_sq / self.count as f64).sqrt() as f32 } else { 0.0 };
        let p = self.peak;
        self.peak = [0.0; 2];
        self.sum_sq = 0.0;
        self.count = 0;
        (p, rms)
    }

    /// Post-fader bass level (RMS), compressor and ducking reduction (positive dB) since
    /// the last call.
    pub fn take_studio_meters(&mut self, frames: u64) -> (f32, f32, f32) {
        let low = if frames > 0 { (self.low_sum_sq / frames as f64).sqrt() as f32 } else { 0.0 };
        let out = (low, self.gr_peak_db, self.duck_peak_db);
        self.low_sum_sq = 0.0;
        self.gr_peak_db = 0.0;
        self.duck_peak_db = 0.0;
        out
    }

    pub fn send_level(&self, k: usize) -> f32 {
        self.send[k].target()
    }
}

pub struct Mixer {
    sr: f32,
    pub strips: Vec<ChannelStrip>,
    crossfader: f32,
    xf_curve: CrossfaderCurve,
    xf_reverse: bool,
    xf_a: Smoothed,
    xf_b: Smoothed,
    fader_curve: FaderCurve,
    master_db: f32,
    master: Smoothed,
    booth_db: f32,
    cue_mix: Smoothed,
    headphones: Smoothed,
    split_cue: bool,
    auto_gain: bool,
    limiter_on: bool,
    pub limiter: Limiter,
    pub master_fx: FxRack,
    pub master_studio: StudioStrip,
    pub returns: [ReturnBus; RETURNS],
    pub scope_source: ScopeSource,
    /// Mono copy of the scope source for this block.
    pub scope: Vec<f32>,
    pub master_l: Vec<f32>,
    pub master_r: Vec<f32>,
    /// A/B bypass: 1 = everything processed, 0 = plain (EQ, filter, effects, studio and
    /// returns switched out). Faders, crossfader and the limiter always work. Advanced
    /// once per chunk, like the crossfader, and interpolated across it.
    ab: Smoothed,
    ab_l: Vec<f32>,
    ab_r: Vec<f32>,
    pub cue_l: Vec<f32>,
    pub cue_r: Vec<f32>,
    pub hp_l: Vec<f32>,
    pub hp_r: Vec<f32>,
    pub loudness: LoudnessMeter,
    pub true_peak: TruePeakMeter,
    pub correlation: CorrelationMeter,
    pub master_peak: [f32; 2],
    pub cue_peak: [f32; 2],
    pub clipped: bool,
}

impl Mixer {
    pub fn new(sr: f32, channels: usize) -> Mixer {
        let mut limiter = Limiter::new(sr, LIMITER_CEILING_DB, 1.5, 80.0);
        limiter.set_enabled(true);
        Mixer {
            sr,
            strips: (0..channels).map(|_| ChannelStrip::new(sr)).collect(),
            crossfader: 0.0,
            xf_curve: CrossfaderCurve::ConstantPower,
            xf_reverse: false,
            xf_a: Smoothed::new(1.0, 2.0, sr),
            xf_b: Smoothed::new(1.0, 2.0, sr),
            fader_curve: FaderCurve::Smooth,
            master_db: 0.0,
            master: Smoothed::new(1.0, 20.0, sr),
            booth_db: 0.0,
            cue_mix: Smoothed::new(0.0, 20.0, sr),
            headphones: Smoothed::new(db_to_gain(-6.0), 20.0, sr),
            split_cue: false,
            auto_gain: true,
            limiter_on: true,
            limiter,
            master_fx: FxRack::new(sr, BLOCK),
            master_studio: StudioStrip::new(sr, BLOCK),
            returns: [ReturnBus::new(sr, Self::return_fx(sr, 0)), ReturnBus::new(sr, Self::return_fx(sr, 1))],
            scope_source: ScopeSource::Off,
            scope: vec![0.0; BLOCK],
            master_l: vec![0.0; BLOCK],
            master_r: vec![0.0; BLOCK],
            ab: Smoothed::new(1.0, 15.0, sr),
            ab_l: vec![0.0; BLOCK],
            ab_r: vec![0.0; BLOCK],
            cue_l: vec![0.0; BLOCK],
            cue_r: vec![0.0; BLOCK],
            hp_l: vec![0.0; BLOCK],
            hp_r: vec![0.0; BLOCK],
            loudness: LoudnessMeter::new(sr),
            true_peak: TruePeakMeter::new(),
            correlation: CorrelationMeter::new(sr),
            master_peak: [0.0; 2],
            cue_peak: [0.0; 2],
            clipped: false,
        }
        .with_crossfader_gains()
    }

    /// The effect behind return `k` (allocates: construction only).
    fn return_fx(sr: f32, k: usize) -> Box<dyn mixit_dsp::fx::Effect> {
        use mixit_dsp::fx::Effect as _;
        if k == 0 {
            let mut r = mixit_dsp::fx::reverb::Reverb::new(sr);
            r.set_param(0, 0.5);
            r.set_param(1, 0.5);
            r.set_beats(0.25);
            Box::new(r)
        } else {
            let mut e = mixit_dsp::fx::delay_fx::Echo::new(sr, mixit_dsp::fx::delay_fx::EchoStyle::PingPong);
            e.set_param(0, 0.5);
            e.set_param(1, 0.5);
            e.set_beats(0.75);
            Box::new(e)
        }
    }

    fn with_crossfader_gains(mut self) -> Self {
        self.update_crossfader();
        let (a, b) = (self.xf_a.target(), self.xf_b.target());
        self.xf_a.reset(a);
        self.xf_b.reset(b);
        self
    }

    fn update_crossfader(&mut self) {
        let (a, b) = crossfader_gains(self.crossfader, self.xf_curve, self.xf_reverse);
        self.xf_a.set(a);
        self.xf_b.set(b);
    }

    pub fn booth_gain(&self) -> f32 {
        db_to_gain(self.master_db + self.booth_db)
    }

    pub fn auto_gain(&self) -> bool {
        self.auto_gain
    }

    pub fn limiter_on(&self) -> bool {
        self.limiter_on
    }

    /// Updates a channel's trim target (call when auto-gain or the track changes).
    pub fn refresh_trim(&mut self, ch: usize, auto_gain_db: f32) {
        let ag = if self.auto_gain { auto_gain_db } else { 0.0 };
        let s = &mut self.strips[ch];
        s.trim.set(db_to_gain((s.trim_db + ag).clamp(-60.0, 24.0)));
    }

    pub fn handle(&mut self, cmd: MixerCommand, auto_gains: &[f32], trash: &mut TrashBin) {
        use MixerCommand as M;
        let ch = |d: DeckId| d.index();
        match cmd {
            M::SetTrim(d, db) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.trim_db = db.clamp(-24.0, 12.0);
                }
                let ag = auto_gains.get(ch(d)).copied().unwrap_or(0.0);
                if ch(d) < self.strips.len() {
                    self.refresh_trim(ch(d), ag);
                }
            }
            M::SetEq(d, band, db) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.eq.set_gain_db(band, db)
                }
            }
            M::SetEqKill(d, band, on) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.eq.set_kill(band, on)
                }
            }
            M::SetFilter(d, v) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.filter.set_value(v)
                }
            }
            M::SetFilterResonance(d, v) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.filter.set_resonance(v)
                }
            }
            M::SetFader(d, v) => {
                let curve = self.fader_curve;
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.fader_pos = v.clamp(0.0, 1.0);
                    s.fader.set(fader_gain(s.fader_pos, curve));
                }
            }
            M::SetPan(d, p) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.pan = p.clamp(-1.0, 1.0);
                    let (l, r) = pan_gains(s.pan, PanLaw::ZeroDb);
                    s.pan_l.set(l);
                    s.pan_r.set(r);
                }
            }
            M::SetCue(d, on) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.cue = on
                }
            }
            M::SetAssign(d, a) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.assign = a
                }
            }
            M::SetCrossfader(x) => {
                self.crossfader = x.clamp(-1.0, 1.0);
                self.update_crossfader();
            }
            M::SetCrossfaderCurve(c) => {
                self.xf_curve = c;
                self.update_crossfader();
            }
            M::SetCrossfaderReverse(r) => {
                self.xf_reverse = r;
                self.update_crossfader();
            }
            M::SetFaderCurve(c) => {
                self.fader_curve = c;
                for s in &mut self.strips {
                    s.fader.set(fader_gain(s.fader_pos, c));
                }
            }
            M::SetEqMode(m) => {
                for s in &mut self.strips {
                    s.eq.set_mode(m);
                }
            }
            M::SetMasterDb(db) => {
                self.master_db = db.clamp(-60.0, 6.0);
                self.master.set(db_to_gain(self.master_db));
            }
            M::SetBoothDb(db) => self.booth_db = db.clamp(-60.0, 6.0),
            M::SetCueMix(m) => self.cue_mix.set(m.clamp(0.0, 1.0)),
            M::SetHeadphonesDb(db) => self.headphones.set(db_to_gain(db.clamp(-60.0, 12.0))),
            M::SetSplitCue(on) => self.split_cue = on,
            M::SetAutoGain(on) => {
                self.auto_gain = on;
                for i in 0..self.strips.len() {
                    let ag = auto_gains.get(i).copied().unwrap_or(0.0);
                    self.refresh_trim(i, ag);
                }
            }
            M::SetBypass(on) => self.ab.set(if on { 0.0 } else { 1.0 }),
            M::SetLimiter(on) => {
                self.limiter_on = on;
                self.limiter.set_enabled(on);
            }
            M::SetFxPostFader(d, post) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.fx_post_fader = post
                }
            }
            M::SetStudio(target, settings) => {
                match target {
                    Some(d) => {
                        if let Some(s) = self.strips.get_mut(ch(d)) {
                            s.studio.set(*settings)
                        }
                    }
                    None => self.master_studio.set(*settings),
                }
                trash.put(Trash::Studio(settings));
            }
            M::SetSend(d, k, v) => {
                if let Some(s) = self.strips.get_mut(ch(d))
                    && k < RETURNS
                {
                    s.send[k].set(v.clamp(0.0, 1.0));
                }
            }
            M::SetDuck(d, source, depth_db) => {
                let n = self.strips.len();
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.duck_source = source.map(ch).filter(|&j| j < n && j != ch(d));
                    s.ducker.set_depth_db(if s.duck_source.is_some() { depth_db } else { 0.0 });
                }
            }
            M::SetReturn(k, p) => {
                if let Some(rb) = self.returns.get_mut(k) {
                    match p {
                        ReturnParam::Level(db) => rb.level.set(if db <= -60.0 { 0.0 } else { db_to_gain(db.min(6.0)) }),
                        ReturnParam::Param(i, v) => rb.fx.set_param(i, v),
                        ReturnParam::Beats(b) => rb.fx.set_beats(b),
                    }
                }
            }
            M::SetScope(src) => self.scope_source = src,
        }
    }

    /// Whether channel `ch` reaches the master: its fader and crossfader side are up
    /// (where they are heading, so a fader being pulled down already counts as down).
    pub fn on_air(&self, ch: usize) -> bool {
        let Some(s) = self.strips.get(ch) else { return false };
        let xf = match s.assign {
            XfAssign::A => self.xf_a.target(),
            XfAssign::B => self.xf_b.target(),
            XfAssign::Thru => 1.0,
        };
        s.fader.target() * xf > 0.05
    }

    pub fn eq_mode(&self) -> EqMode {
        self.strips.first().map(|s| s.eq.mode()).unwrap_or(EqMode::Classic)
    }

    /// Clears the buses for a new chunk.
    pub fn begin(&mut self, n: usize) {
        self.master_l[..n].fill(0.0);
        self.master_r[..n].fill(0.0);
        self.cue_l[..n].fill(0.0);
        self.cue_r[..n].fill(0.0);
        for rb in &mut self.returns {
            rb.l[..n].fill(0.0);
            rb.r[..n].fill(0.0);
            rb.fed = false;
        }
    }

    /// The A/B bypass weight at the start and end of this chunk (1 = processed).
    fn ab_span(&self, n: usize) -> (f32, f32) {
        let mut end = self.ab.clone();
        (self.ab.value(), end.advance(n as u32))
    }

    /// Processes one channel into its own buffers (call for every channel, then [`Mixer::sum`]).
    pub fn mix_channel(&mut self, ch: usize, in_l: &[f32], in_r: &[f32], n: usize, active: bool) {
        let scope_here = self.scope_source == ScopeSource::Channel(ch);
        let (ws, we) = self.ab_span(n);
        let plain = ws < 1.0 || we < 1.0;
        let s = &mut self.strips[ch];
        // Skip silent, idle channels cheaply (but let FX tails and smoothers finish).
        if !active && !s.fx.is_active() && s.trim.is_steady() && s.fader.is_steady() {
            s.fader.advance(n as u32);
            s.live = false;
            if scope_here {
                self.scope[..n].fill(0.0);
            }
            return;
        }
        s.live = true;
        let (l, r) = (&mut s.l[..n], &mut s.r[..n]);
        l.copy_from_slice(&in_l[..n]);
        r.copy_from_slice(&in_r[..n]);
        for i in 0..n {
            let g = s.trim.next();
            l[i] *= g;
            r[i] *= g;
        }
        if plain {
            s.dry_l[..n].copy_from_slice(l);
            s.dry_r[..n].copy_from_slice(r);
        }
        if !s.studio.is_transparent() {
            s.studio.process(l, r);
            s.gr_peak_db = s.gr_peak_db.max(s.studio.meter_gr_db);
        }
        if !s.eq.is_transparent() {
            s.eq.process(l, r);
        }
        if !s.filter.is_bypassed() {
            s.filter.process(l, r);
        }
        if plain {
            blend(l, &s.dry_l[..n], ws, we);
            blend(r, &s.dry_r[..n], ws, we);
        }
        if scope_here {
            for i in 0..n {
                self.scope[i] = 0.5 * (l[i] + r[i]);
            }
        }
        // Meters and cue tap (pre-fader).
        for i in 0..n {
            let (a, b) = (l[i].abs(), r[i].abs());
            s.peak[0] = s.peak[0].max(a);
            s.peak[1] = s.peak[1].max(b);
            s.sum_sq += 0.5 * (l[i] as f64 * l[i] as f64 + r[i] as f64 * r[i] as f64);
        }
        s.count += n as u64;
        if s.cue {
            for i in 0..n {
                self.cue_l[i] += l[i];
                self.cue_r[i] += r[i];
            }
        }
        if !s.fx_post_fader {
            fx_ab(&mut s.fx, l, r, &s.fx_ctx, (&mut s.dry_l[..n], &mut s.dry_r[..n]), plain.then_some((ws, we)));
        }
        // Fader, crossfader and pan. The crossfader smoothers are shared, so read them
        // ahead without advancing (they are advanced once per chunk in `finish`).
        let xa = self.xf_a.value();
        let xb = self.xf_b.value();
        let (xs, xe) = match s.assign {
            XfAssign::A => (xa, self.xf_a.target()),
            XfAssign::B => (xb, self.xf_b.target()),
            XfAssign::Thru => (1.0, 1.0),
        };
        let inv = 1.0 / n as f32;
        for i in 0..n {
            let xg = xs + (xe - xs) * ((i + 1) as f32 * inv).min(1.0);
            let g = s.fader.next() * xg;
            l[i] *= g * s.pan_l.next();
            r[i] *= g * s.pan_r.next();
        }
        if s.fx_post_fader {
            fx_ab(&mut s.fx, l, r, &s.fx_ctx, (&mut s.dry_l[..n], &mut s.dry_r[..n]), plain.then_some((ws, we)));
        }
    }

    /// Ducks, sends and sums every processed channel into the master bus.
    pub fn sum(&mut self, n: usize) {
        for ch in 0..self.strips.len() {
            if !self.strips[ch].live {
                // Nothing to add, but a ducker still recovers and smoothers keep time.
                let s = &mut self.strips[ch];
                for snd in &mut s.send {
                    snd.advance(n as u32);
                }
                continue;
            }
            // Ducking by another channel's output in this block.
            match self.strips[ch].duck_source {
                Some(j) if self.strips[j].live => {
                    let (a, b) = if ch < j {
                        let (x, y) = self.strips.split_at_mut(j);
                        (&mut x[ch], &y[0])
                    } else {
                        let (x, y) = self.strips.split_at_mut(ch);
                        (&mut y[0], &x[j])
                    };
                    a.ducker.process(&mut a.l[..n], &mut a.r[..n], &b.l[..n], &b.r[..n]);
                    a.duck_peak_db = a.duck_peak_db.max(a.ducker.meter_db);
                }
                _ => {
                    let a = &mut self.strips[ch];
                    if a.ducker.is_active() {
                        a.ducker.release(&mut a.l[..n], &mut a.r[..n]);
                        a.duck_peak_db = a.duck_peak_db.max(a.ducker.meter_db);
                    }
                }
            }
            let s = &mut self.strips[ch];
            // Sends (post-fader).
            for (k, rb) in self.returns.iter_mut().enumerate() {
                let snd = &mut s.send[k];
                if snd.is_steady() && snd.value() == 0.0 {
                    continue;
                }
                rb.fed = true;
                for i in 0..n {
                    let g = snd.next();
                    rb.l[i] += s.l[i] * g;
                    rb.r[i] += s.r[i] * g;
                }
            }
            // Bass meter (post-fader) and the master bus.
            let c = s.low_c;
            let (mut a, mut b) = (s.low_lp[0], s.low_lp[1]);
            let mut acc = 0.0f64;
            for i in 0..n {
                a += c * (s.l[i] - a);
                b += c * (s.r[i] - b);
                let m = 0.5 * (a + b);
                acc += (m * m) as f64;
                self.master_l[i] += s.l[i];
                self.master_r[i] += s.r[i];
            }
            s.low_lp = [flush(a), flush(b)];
            s.low_sum_sq += acc;
        }
    }

    /// Master chain and headphone mix for the chunk.
    pub fn finish(&mut self, n: usize, master_ctx: &FxContext) {
        // Crossfader smoothers advance once per chunk (channels interpolated across it).
        self.xf_a.advance(n as u32);
        self.xf_b.advance(n as u32);
        let (ws, we) = self.ab_span(n);
        let plain = ws < 1.0 || we < 1.0;
        self.ab.advance(n as u32);
        let inv = 1.0 / n as f32;
        // Returns: run while fed or while their tail rings (about 10 s of quiet ends it).
        for rb in &mut self.returns {
            if !rb.fed && rb.quiet_blocks > (10.0 * self.sr / BLOCK as f32) as u32 {
                rb.level.advance(n as u32);
                continue;
            }
            let (l, r) = (&mut rb.l[..n], &mut rb.r[..n]);
            for i in 0..n {
                l[i] = rb.hp[0].process(&rb.hp_c, l[i]);
                r[i] = rb.hp[1].process(&rb.hp_c, r[i]);
            }
            rb.fx.process(l, r, master_ctx);
            let pk = mixit_dsp::util::peak(l).max(mixit_dsp::util::peak(r));
            if pk > 1e-5 || rb.fed {
                rb.quiet_blocks = 0;
            } else {
                rb.quiet_blocks = rb.quiet_blocks.saturating_add(1);
            }
            for i in 0..n {
                let mut g = rb.level.next();
                if plain {
                    g *= ws + (we - ws) * ((i + 1) as f32 * inv).min(1.0);
                }
                self.master_l[i] += mixit_dsp::util::sanitize(l[i]) * g;
                self.master_r[i] += mixit_dsp::util::sanitize(r[i]) * g;
            }
        }
        let (ml, mr) = (&mut self.master_l[..n], &mut self.master_r[..n]);
        if plain {
            self.ab_l[..n].copy_from_slice(ml);
            self.ab_r[..n].copy_from_slice(mr);
        }
        self.master_fx.process(ml, mr, master_ctx);
        if !self.master_studio.is_transparent() {
            self.master_studio.process(ml, mr);
        }
        if plain {
            blend(ml, &self.ab_l[..n], ws, we);
            blend(mr, &self.ab_r[..n], ws, we);
        }
        for i in 0..n {
            let g = self.master.next();
            ml[i] *= g;
            mr[i] *= g;
        }
        let pre_peak = mixit_dsp::util::peak(ml).max(mixit_dsp::util::peak(mr));
        if pre_peak > 1.0 && !self.limiter_on {
            self.clipped = true;
        }
        self.limiter.process(ml, mr);
        if !self.limiter_on {
            for i in 0..n {
                ml[i] = ml[i].clamp(-1.0, 1.0);
                mr[i] = mr[i].clamp(-1.0, 1.0);
            }
        }
        self.master_peak[0] = self.master_peak[0].max(mixit_dsp::util::peak(ml));
        self.master_peak[1] = self.master_peak[1].max(mixit_dsp::util::peak(mr));
        self.loudness.process(ml, mr);
        self.true_peak.process(ml, mr);
        self.correlation.process(ml, mr);
        if self.scope_source == ScopeSource::Master {
            for i in 0..n {
                self.scope[i] = 0.5 * (ml[i] + mr[i]);
            }
        }

        // Headphones.
        for i in 0..n {
            let m = self.cue_mix.next();
            let hg = self.headphones.next();
            let (cl, cr) = (self.cue_l[i], self.cue_r[i]);
            let (l, r) = if self.split_cue {
                (0.5 * (cl + cr), 0.5 * (ml[i] + mr[i]))
            } else {
                (cl + (ml[i] - cl) * m, cr + (mr[i] - cr) * m)
            };
            self.hp_l[i] = (l * hg).clamp(-1.0, 1.0);
            self.hp_r[i] = (r * hg).clamp(-1.0, 1.0);
        }
        self.cue_peak[0] = self.cue_peak[0].max(mixit_dsp::util::peak(&self.hp_l[..n]));
        self.cue_peak[1] = self.cue_peak[1].max(mixit_dsp::util::peak(&self.hp_r[..n]));
    }

    pub fn fx_rack(&mut self, ch: Option<usize>) -> Option<&mut FxRack> {
        match ch {
            Some(c) => self.strips.get_mut(c).map(|s| &mut s.fx),
            None => Some(&mut self.master_fx),
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// Current settings of a channel's (or, with `None`, the master's) studio strip.
    pub fn studio_settings(&self, ch: Option<usize>) -> Option<StudioSettings> {
        match ch {
            Some(c) => self.strips.get(c).map(|s| *s.studio.settings()),
            None => Some(*self.master_studio.settings()),
        }
    }
}

/// Puts a replaced effect in the trash.
/// `x` = dry + (x - dry) × w, with w gliding from `ws` to `we` across the block.
fn blend(x: &mut [f32], dry: &[f32], ws: f32, we: f32) {
    let inv = 1.0 / x.len().max(1) as f32;
    for (i, (v, d)) in x.iter_mut().zip(dry).enumerate() {
        let w = ws + (we - ws) * ((i + 1) as f32 * inv).min(1.0);
        *v = d + (*v - d) * w;
    }
}

/// Runs an FX rack, blended toward its input while A/B bypass is on or moving.
fn fx_ab(
    fx: &mut FxRack,
    l: &mut [f32],
    r: &mut [f32],
    ctx: &FxContext,
    dry: (&mut [f32], &mut [f32]),
    ab: Option<(f32, f32)>,
) {
    match ab {
        None => fx.process(l, r, ctx),
        Some((ws, we)) => {
            dry.0.copy_from_slice(l);
            dry.1.copy_from_slice(r);
            fx.process(l, r, ctx);
            blend(l, dry.0, ws, we);
            blend(r, dry.1, ws, we);
        }
    }
}

pub fn trash_effect(trash: &mut TrashBin, old: Option<Box<dyn mixit_dsp::fx::Effect>>) {
    trash.put_opt(old, Trash::Effect);
}
