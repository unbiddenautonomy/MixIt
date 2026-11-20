//! Waveform overviews for drawing: a pyramid of columns, each with peak, RMS and
//! low/mid/high band levels, so the UI can colour the waveform by frequency content
//! (bass red, mids green, highs blue) at any zoom without touching the audio.

use mixit_dsp::crossover::ThreeBandSplitter;
use serde::{Deserialize, Serialize};

/// Frames per column at the finest level.
pub const BASE_COLUMN: usize = 64;
/// Each level is this many times coarser than the one below.
pub const LEVEL_FACTOR: usize = 4;
pub const LEVELS: usize = 5;

/// One column, levels as 0..255 (linear amplitude ×255, bands perceptually scaled).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Column {
    pub peak: u8,
    pub rms: u8,
    pub low: u8,
    pub mid: u8,
    pub high: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WaveformLevel {
    /// Source frames covered by each column.
    pub frames_per_column: usize,
    pub columns: Vec<Column>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Waveform {
    pub sample_rate: u32,
    /// Finest first.
    pub levels: Vec<WaveformLevel>,
}

impl Waveform {
    /// The coarsest level with at least `min_columns` columns (or the finest).
    pub fn level_for(&self, min_columns: usize) -> &WaveformLevel {
        self.levels.iter().rev().find(|l| l.columns.len() >= min_columns).unwrap_or(&self.levels[0])
    }

    /// A fixed-width overview (e.g. 1000 columns for the track overview strip).
    pub fn overview(&self, width: usize) -> Vec<Column> {
        let base = &self.levels[0];
        let n = base.columns.len();
        if n == 0 || width == 0 {
            return vec![];
        }
        (0..width)
            .map(|i| {
                let a = i * n / width;
                let b = ((i + 1) * n / width).max(a + 1).min(n);
                merge(&base.columns[a..b])
            })
            .collect()
    }
}

fn merge(cols: &[Column]) -> Column {
    let mut c = Column::default();
    let (mut rms, mut lo, mut mi, mut hi) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for x in cols {
        c.peak = c.peak.max(x.peak);
        rms += (x.rms as f32).powi(2);
        lo = lo.max(x.low as f32);
        mi = mi.max(x.mid as f32);
        hi = hi.max(x.high as f32);
    }
    let n = cols.len().max(1) as f32;
    c.rms = (rms / n).sqrt().round() as u8;
    c.low = lo as u8;
    c.mid = mi as u8;
    c.high = hi as u8;
    c
}

#[inline]
fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Builds the pyramid from interleaved stereo.
pub fn waveform(interleaved: &[f32], sample_rate: u32) -> Waveform {
    let frames = interleaved.len() / 2;
    let mut split = ThreeBandSplitter::new(200.0, 2_500.0, sample_rate as f64);
    let cols = frames.div_ceil(BASE_COLUMN);
    let mut base = Vec::with_capacity(cols);
    let mut raw_bands = Vec::with_capacity(cols);
    let mut band_max = [1e-9f32; 3];
    for c in 0..cols {
        let a = c * BASE_COLUMN;
        let b = (a + BASE_COLUMN).min(frames);
        let (mut peak, mut sq) = (0.0f32, 0.0f32);
        let mut bands = [0.0f32; 3];
        for i in a..b {
            let m = 0.5 * (interleaved[2 * i] + interleaved[2 * i + 1]);
            peak = peak.max(interleaved[2 * i].abs()).max(interleaved[2 * i + 1].abs());
            sq += m * m;
            let (l, mid, h) = split.split(m);
            bands[0] += l * l;
            bands[1] += mid * mid;
            bands[2] += h * h;
        }
        let n = (b - a).max(1) as f32;
        for k in 0..3 {
            bands[k] = (bands[k] / n).sqrt();
            band_max[k] = band_max[k].max(bands[k]);
        }
        raw_bands.push(bands);
        base.push(Column {
            peak: to_u8(peak),
            rms: to_u8((sq / n).sqrt() * std::f32::consts::SQRT_2),
            ..Default::default()
        });
    }
    // Bands are scaled to a shared reference so their relative balance is preserved,
    // then compressed (square root) so quiet detail stays visible.
    let reference = band_max.iter().copied().fold(0.0, f32::max);
    for (col, b) in base.iter_mut().zip(&raw_bands) {
        col.low = to_u8((b[0] / reference).sqrt());
        col.mid = to_u8((b[1] / reference).sqrt());
        col.high = to_u8((b[2] / reference).sqrt());
    }
    let mut levels = vec![WaveformLevel { frames_per_column: BASE_COLUMN, columns: base }];
    for _ in 1..LEVELS {
        let prev = levels.last().unwrap();
        let columns: Vec<Column> = prev.columns.chunks(LEVEL_FACTOR).map(merge).collect();
        let fpc = prev.frames_per_column * LEVEL_FACTOR;
        levels.push(WaveformLevel { frames_per_column: fpc, columns });
    }
    Waveform { sample_rate, levels }
}

/// First and last frames where the audio rises above `threshold_db` (dBFS), ignoring
/// isolated clicks: the level must stay above the threshold for a few milliseconds.
pub fn audible_span(interleaved: &[f32], sample_rate: u32, threshold_db: f32) -> Option<(usize, usize)> {
    let t = 10f32.powf(threshold_db / 20.0);
    let frames = interleaved.len() / 2;
    let win = (sample_rate as usize / 200).max(1); // 5 ms
    let loud = |w: usize| -> bool {
        let a = w * win;
        let b = (a + win).min(frames);
        let mut s = 0.0f32;
        for i in a..b {
            let m = 0.5 * (interleaved[2 * i] + interleaved[2 * i + 1]);
            s += m * m;
        }
        (s / (b - a).max(1) as f32).sqrt() > t
    };
    let wins = frames.div_ceil(win);
    let first = (0..wins).find(|&w| loud(w))?;
    let last = (0..wins).rev().find(|&w| loud(w))?;
    Some((first * win, ((last + 1) * win).min(frames)))
}
