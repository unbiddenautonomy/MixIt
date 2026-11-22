//! The work behind each command, kept out of `main` so it can be tested.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result, anyhow, bail};
use mixit_analysis::{Analysis, AnalysisOptions};
use mixit_core::Key;
use mixit_io::export::{ExportFormat, WavDepth};
use mixit_library::jobs::{JobEvent, JobOptions, analyze_tracks};
use mixit_library::plan::plan_track;
use mixit_library::suggest::{self, Candidate, EnergyDirection};
use mixit_project::automix::{AutomixOptions, PlanTrack, automix};
use mixit_project::{MixProject, TrackRef};
use serde::Serialize;

use crate::resolve::Resolver;

/// Parses an export format: wav16, wav24, wav32f, flac16, flac24 (or infers from a path).
pub fn parse_format(s: &str) -> Result<ExportFormat> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "wav" | "wav24" => ExportFormat::Wav(WavDepth::Pcm24),
        "wav16" => ExportFormat::Wav(WavDepth::Pcm16),
        "wav32" | "wav32f" | "float" => ExportFormat::Wav(WavDepth::Float32),
        "flac" | "flac24" => ExportFormat::Flac { bits: 24 },
        "flac16" => ExportFormat::Flac { bits: 16 },
        other => bail!("unknown format {other:?} (use wav16, wav24, wav32f, flac16 or flac24)"),
    })
}

/// The format to write `path` in: `explicit` if given, else from the extension.
pub fn format_for(path: &Path, explicit: Option<&str>) -> Result<ExportFormat> {
    if let Some(f) = explicit {
        return parse_format(f);
    }
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("flac") => Ok(ExportFormat::Flac { bits: 24 }),
        _ => Ok(ExportFormat::Wav(WavDepth::Pcm24)),
    }
}

pub fn write_audio(path: &Path, data: &[f32], sample_rate: u32, format: ExportFormat) -> Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    mixit_io::export::write_audio(path, data, 2, sample_rate, format)
        .with_context(|| format!("writing {}", path.display()))
}

/// Analyses files in parallel. Results come back in input order.
pub fn analyze_files(
    paths: &[PathBuf],
    opts: &JobOptions,
    mut progress: impl FnMut(usize, usize, &Path),
) -> Vec<Result<Analysis, String>> {
    let items: Vec<(i64, PathBuf)> = paths.iter().enumerate().map(|(i, p)| (i as i64, p.clone())).collect();
    let mut out: Vec<Option<Result<Analysis, String>>> = (0..paths.len()).map(|_| None).collect();
    let mut done = 0;
    analyze_tracks(items, opts, &AtomicBool::new(false), |ev| {
        let (i, r) = match ev {
            JobEvent::Done(i, a) => (i as usize, Ok(*a)),
            JobEvent::Failed(i, e) => (i as usize, Err(e)),
        };
        out[i] = Some(r);
        done += 1;
        progress(done, paths.len(), &paths[i]);
    });
    out.into_iter().map(|r| r.unwrap_or_else(|| Err("cancelled".into()))).collect()
}

/// A project reference to a file: tags for the names, the content hash for relocation.
pub fn file_ref(path: &Path, a: &Analysis) -> TrackRef {
    let tags = mixit_io::read_tags(path).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    TrackRef {
        hash: mixit_io::hash_file(path).ok().map(|h| h.to_hex()),
        path: Some(std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()).to_string_lossy().into_owned()),
        title: tags.title.filter(|t| !t.trim().is_empty()).unwrap_or(stem),
        artist: tags.artist.unwrap_or_default(),
        bpm: a.bpm,
        key: a.key.as_ref().map(|k| k.key),
        duration: a.duration,
    }
}

#[derive(Clone, Debug)]
pub struct SetOptions {
    pub automix: AutomixOptions,
    /// Reorder the tracks into the best harmonic/tempo path.
    pub reorder: bool,
    pub energy: EnergyDirection,
}

/// Plans and lays out a set from analysed files. Returns the project and the order used.
pub fn automix_analysed(
    name: &str,
    items: Vec<(PathBuf, Analysis)>,
    opts: &SetOptions,
) -> Result<(MixProject, Vec<PathBuf>)> {
    if items.is_empty() {
        bail!("no tracks to mix");
    }
    let mut plans: Vec<(PathBuf, PlanTrack, Analysis)> =
        items.into_iter().map(|(p, a)| (p.clone(), plan_track(file_ref(&p, &a), &a), a)).collect();
    if opts.reorder && plans.len() > 2 {
        let cands: Vec<Candidate> = plans
            .iter()
            .enumerate()
            .map(|(i, (_, pl, a))| Candidate {
                id: i as i64,
                bpm: a.is_rhythmic().then_some(a.bpm),
                key: pl.track.key,
                energy: Some(a.energy),
                genre: String::new(),
                rating: 0,
                sound: vec![],
            })
            .collect();
        // Open with the calmest track when building up, the most intense when winding down.
        let start = match opts.energy {
            EnergyDirection::Up | EnergyDirection::Steady => (0..plans.len()).min_by_key(|&i| plans[i].2.energy),
            EnergyDirection::Down => (0..plans.len()).max_by_key(|&i| plans[i].2.energy),
        };
        let order = suggest::order_set(&cands, start, opts.energy);
        let mut taken: Vec<Option<(PathBuf, PlanTrack, Analysis)>> = plans.into_iter().map(Some).collect();
        plans = order.into_iter().map(|i| taken[i].take().unwrap()).collect();
    }
    let order = plans.iter().map(|(p, _, _)| p.clone()).collect();
    let tracks: Vec<PlanTrack> = plans.into_iter().map(|(_, pl, _)| pl).collect();
    let project = automix(name, &tracks, &opts.automix).map_err(|e| anyhow!("automix: {e}"))?;
    Ok((project, order))
}

#[derive(Clone, Debug, Serialize)]
pub struct RenderSummary {
    pub seconds: f64,
    pub integrated_lufs: f64,
    pub true_peak_dbtp: f32,
    pub relocated: Vec<(String, PathBuf)>,
}

/// Bounces a project to `out`.
pub fn render_to_file(
    project: &MixProject,
    resolver: &mut Resolver,
    render: &mixit_host::project::RenderOptions,
    out: &Path,
    format: ExportFormat,
    progress: impl FnMut(f32),
) -> Result<RenderSummary> {
    let audio = render_project(project, resolver, render, progress)?;
    write_audio(out, &audio, render.sample_rate, format)?;
    let l =
        mixit_analysis::loudness::measure(&audio, render.sample_rate, mixit_analysis::loudness::DEFAULT_TARGET_LUFS);
    Ok(RenderSummary {
        seconds: audio.len() as f64 / 2.0 / render.sample_rate as f64,
        integrated_lufs: l.integrated_lufs,
        true_peak_dbtp: l.true_peak_dbtp,
        relocated: resolver.relocated.clone(),
    })
}

pub fn render_project(
    project: &MixProject,
    resolver: &mut Resolver,
    render: &mixit_host::project::RenderOptions,
    progress: impl FnMut(f32),
) -> Result<Vec<f32>> {
    let cancel = AtomicBool::new(false);
    match mixit_host::project::render_project(project, render, |c| resolver.resolve(c), &cancel, progress) {
        Ok(a) => Ok(a),
        Err(mixit_host::project::RenderError::MissingTrack { title, .. }) => {
            Err(anyhow!("{}", resolver.last_error.clone().unwrap_or_else(|| format!("track not found: {title}"))))
        }
        Err(e) => Err(anyhow!("{e}")),
    }
}

pub fn load_project(path: &Path) -> Result<MixProject> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    MixProject::from_json(&text).map_err(|e| anyhow!("{}: {e}", path.display()))
}

pub fn save_project(path: &Path, p: &MixProject) -> Result<()> {
    std::fs::write(path, p.to_json()).with_context(|| format!("writing {}", path.display()))
}

/// How much to speed a file up for `stretch`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Speed {
    Factor(f64),
    Percent(f64),
    /// Target tempo; the source tempo is analysed.
    Bpm(f64),
}

#[derive(Clone, Debug, Serialize)]
pub struct StretchSummary {
    pub source_bpm: Option<f64>,
    pub speed: f64,
    pub semitones: f32,
    pub seconds: f64,
}

/// Changes tempo and/or key of a file, with key lock (pitch independent of tempo).
pub fn stretch_file(
    input: &Path,
    output: &Path,
    speed: Speed,
    semitones: f32,
    to_key: Option<Key>,
    sample_rate: u32,
    format: ExportFormat,
) -> Result<StretchSummary> {
    let t = mixit_io::load_track(input, sample_rate, None).with_context(|| format!("loading {}", input.display()))?;
    let need_analysis = matches!(speed, Speed::Bpm(_)) || to_key.is_some();
    let a = need_analysis.then(|| {
        mixit_analysis::analyze(
            &t.data,
            t.sample_rate,
            &AnalysisOptions { waveform: false, key: to_key.is_some(), ..Default::default() },
        )
    });
    let factor = match speed {
        Speed::Factor(f) => f,
        Speed::Percent(p) => 1.0 + p / 100.0,
        Speed::Bpm(target) => {
            let a = a.as_ref().unwrap();
            if !a.is_rhythmic() {
                bail!("{} has no steady beat to match a tempo to", input.display());
            }
            target / a.bpm
        }
    };
    if !(0.25..=4.0).contains(&factor) {
        bail!("speed {factor:.3} is outside 0.25–4×");
    }
    let mut semis = semitones;
    if let Some(k) = to_key {
        let from = a.as_ref().and_then(|a| a.key.as_ref()).map(|k| k.key).ok_or_else(|| anyhow!("key not detected"))?;
        // Nearest transposition (±6) that lands on the target or its relative key.
        let best = (-6..=6)
            .filter(|&s| {
                let t = from.transposed(s);
                t == k || t.camelot_distance(k) == 0
            })
            .min_by_key(|s: &i32| s.abs())
            .or_else(|| (-6..=6).filter(|&s| from.transposed(s).is_compatible(k)).min_by_key(|s: &i32| s.abs()))
            .ok_or_else(|| anyhow!("cannot reach {} from {}", k.standard_name(), from.standard_name()))?;
        semis += best as f32;
    }
    let y = mixit_stretch::stretch_buffer(&t.data, t.sample_rate, factor, semis, mixit_stretch::StretchQuality::High);
    write_audio(output, &y, t.sample_rate, format)?;
    Ok(StretchSummary {
        source_bpm: a.map(|a| a.bpm),
        speed: factor,
        semitones: semis,
        seconds: y.len() as f64 / 2.0 / t.sample_rate as f64,
    })
}

/// Collects audio files from paths that may be folders.
pub fn collect_audio(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in paths {
        if p.is_dir() {
            let mut v: Vec<PathBuf> = walk(p).into_iter().filter(|f| mixit_io::is_audio_file(f)).collect();
            v.sort();
            out.extend(v);
        } else {
            out.push(p.clone());
        }
    }
    out
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(parse_format("wav16").unwrap(), ExportFormat::Wav(WavDepth::Pcm16));
        assert_eq!(format_for(Path::new("a.flac"), None).unwrap(), ExportFormat::Flac { bits: 24 });
        assert_eq!(format_for(Path::new("a.wav"), Some("float")).unwrap(), ExportFormat::Wav(WavDepth::Float32));
        assert!(parse_format("mp3").is_err());
    }
}
