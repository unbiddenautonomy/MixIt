//! The DJ mixer: channel strips, crossfader, master chain and headphone cue.
//!
//! Channel signal flow (as on club mixers):
//!
//! ```text
//! deck → trim (+ auto-gain) → EQ → filter → [meter, cue tap] → (FX pre) → fader × crossfader
//!      → pan → (FX post, default) → master bus
//! ```
//!
//! With FX post-fader, pulling the fader down stops feeding an echo or reverb while its
//! tail keeps ringing: the classic echo-out.
//!
//! Master: bus → master FX → master level → limiter → meters. Headphones blend the cue bus
//! with the master (or split cue: cue left, master right, both mono).

use mixit_core::DeckId;
use mixit_dsp::curves::{CrossfaderCurve, FaderCurve, PanLaw, crossfader_gains, fader_gain, pan_gains};
use mixit_dsp::djeq::{DjEq, EqMode, EqVoicing};
use mixit_dsp::djfilter::DjFilter;
use mixit_dsp::dynamics::Limiter;
use mixit_dsp::fx::{FxContext, FxRack};
use mixit_dsp::meters::{CorrelationMeter, LoudnessMeter, TruePeakMeter};
use mixit_dsp::smooth::Smoothed;
use mixit_dsp::util::db_to_gain;

use crate::commands::{MixerCommand, XfAssign};
use crate::deck::BLOCK;
use crate::trash::{Trash, TrashBin};

pub const LIMITER_CEILING_DB: f32 = -0.3;

pub struct ChannelStrip {
    trim_db: f32,
    trim: Smoothed,
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
    l: Vec<f32>,
    r: Vec<f32>,
    /// Peak since the last telemetry snapshot (pre-fader).
    pub peak: [f32; 2],
    pub sum_sq: f64,
    pub count: u64,
}

impl ChannelStrip {
    pub fn new(sr: f32) -> ChannelStrip {
        // Classic EQ by default: bit-transparent at unity. Isolator is one switch away.
        let mut eq = DjEq::new(sr, EqVoicing::default());
        eq.set_mode_now(EqMode::Classic);
        ChannelStrip {
            trim_db: 0.0,
            trim: Smoothed::new(1.0, 20.0, sr),
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
            l: vec![0.0; BLOCK],
            r: vec![0.0; BLOCK],
            peak: [0.0; 2],
            sum_sq: 0.0,
            count: 0,
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
    pub master_l: Vec<f32>,
    pub master_r: Vec<f32>,
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
            master_l: vec![0.0; BLOCK],
            master_r: vec![0.0; BLOCK],
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

    pub fn handle(&mut self, cmd: MixerCommand, auto_gains: &[f32]) {
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
            M::SetLimiter(on) => {
                self.limiter_on = on;
                self.limiter.set_enabled(on);
            }
            M::SetFxPostFader(d, post) => {
                if let Some(s) = self.strips.get_mut(ch(d)) {
                    s.fx_post_fader = post
                }
            }
        }
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
    }

    /// Processes one channel and adds it to the buses.
    pub fn mix_channel(&mut self, ch: usize, in_l: &[f32], in_r: &[f32], n: usize, active: bool) {
        let s = &mut self.strips[ch];
        // Skip silent, idle channels cheaply (but let FX tails and smoothers finish).
        if !active && !s.fx.is_active() && s.trim.is_steady() && s.fader.is_steady() {
            s.fader.advance(n as u32);
            return;
        }
        let (l, r) = (&mut s.l[..n], &mut s.r[..n]);
        l.copy_from_slice(&in_l[..n]);
        r.copy_from_slice(&in_r[..n]);
        for i in 0..n {
            let g = s.trim.next();
            l[i] *= g;
            r[i] *= g;
        }
        if !s.eq.is_transparent() {
            s.eq.process(l, r);
        }
        if !s.filter.is_bypassed() {
            s.filter.process(l, r);
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
            s.fx.process(l, r, &s.fx_ctx);
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
            s.fx.process(l, r, &s.fx_ctx);
        }
        for i in 0..n {
            self.master_l[i] += l[i];
            self.master_r[i] += r[i];
        }
    }

    /// Master chain and headphone mix for the chunk.
    pub fn finish(&mut self, n: usize, master_ctx: &FxContext) {
        // Crossfader smoothers advance once per chunk (channels interpolated across it).
        self.xf_a.advance(n as u32);
        self.xf_b.advance(n as u32);
        let (ml, mr) = (&mut self.master_l[..n], &mut self.master_r[..n]);
        self.master_fx.process(ml, mr, master_ctx);
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
}

/// Puts a replaced effect in the trash.
pub fn trash_effect(trash: &mut TrashBin, old: Option<Box<dyn mixit_dsp::fx::Effect>>) {
    trash.put_opt(old, Trash::Effect);
}
