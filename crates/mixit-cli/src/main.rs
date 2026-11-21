//! `mixit`: analyse, organise, automix, render, stretch and play from the terminal.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use mixit_analysis::AnalysisOptions;
use mixit_cli::format::{self, analysis_report, key_name, track_table};
use mixit_cli::ops::{self, SetOptions, Speed};
use mixit_cli::resolve::Resolver;
use mixit_core::key::KeyNotation;
use mixit_core::{Beatgrid, DeckId, Key};
use mixit_engine::{Command, DeckCommand, DeckTrack, EngineConfig, Event, MixerCommand, TrackAudio};
use mixit_generator::{Style, TrackSpec};
use mixit_host::project::RenderOptions;
use mixit_library::jobs::JobOptions;
use mixit_library::suggest::{EnergyDirection, SuggestOptions};
use mixit_library::{Library, PlaylistKind};
use mixit_project::automix::{AutomixOptions, TempoPolicy};
use mixit_project::{Issue, MixProject, TransitionKind};

#[derive(Parser)]
#[command(name = "mixit", version, about = "MixIt: analyse, organise, automix and render DJ mixes.")]
struct Cli {
    /// Library database (default: the app's library).
    #[arg(long, global = true, env = "MIXIT_DB")]
    db: Option<PathBuf>,
    /// How keys are written.
    #[arg(long, global = true, value_enum, default_value_t = Notation::Camelot)]
    notation: Notation,
    /// Machine-readable JSON instead of text.
    #[arg(long, global = true)]
    json: bool,
    /// No progress output.
    #[arg(long, short, global = true)]
    quiet: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Clone, Copy, ValueEnum)]
enum Notation {
    Camelot,
    OpenKey,
    Standard,
}

impl From<Notation> for KeyNotation {
    fn from(n: Notation) -> Self {
        match n {
            Notation::Camelot => KeyNotation::Camelot,
            Notation::OpenKey => KeyNotation::OpenKey,
            Notation::Standard => KeyNotation::Standard,
        }
    }
}

#[derive(Subcommand)]
enum Cmd {
    /// List audio output devices.
    Devices,
    /// Analyse files: tempo, beatgrid, key, loudness, structure and cue points.
    Analyze(AnalyzeArgs),
    /// Explain a key: its neighbours on the Camelot wheel and what mixes with it.
    Key {
        /// Camelot (8A), Open Key (1m) or a name (A minor, F#m, Bb).
        key: String,
    },
    /// Build a mix project from files: phrase-aligned transitions, tempo and key matching.
    Automix(AutomixArgs),
    /// Bounce a mix project to an audio file.
    Render(RenderArgs),
    /// Summarise a mix project and list problems (clashing keys, overlaps, big stretches).
    Project { project: PathBuf },
    /// Change a file's tempo and/or key with key lock.
    Stretch(StretchArgs),
    /// Convert or resample an audio file.
    Convert {
        input: PathBuf,
        #[arg(short, long)]
        output: PathBuf,
        /// wav16, wav24, wav32f, flac16, flac24 (default from the extension).
        #[arg(long)]
        format: Option<String>,
        #[arg(long, default_value_t = 44_100)]
        sample_rate: u32,
    },
    /// Play a file or a mix project through the audio device.
    Play(PlayArgs),
    /// Make a synthetic test track with known tempo, key and structure.
    Generate(GenerateArgs),
    /// Manage the music library.
    #[command(subcommand, visible_alias = "lib")]
    Library(LibCmd),
}

#[derive(Args)]
struct AnalysisFlags {
    /// Lowest tempo to consider.
    #[arg(long, default_value_t = 60.0)]
    bpm_min: f64,
    /// Highest tempo to consider.
    #[arg(long, default_value_t = 200.0)]
    bpm_max: f64,
    /// Always use a constant grid (no tempo-drift following).
    #[arg(long)]
    no_warp: bool,
    /// Parallel analysis threads (default: all cores but one).
    #[arg(long)]
    threads: Option<usize>,
}

impl AnalysisFlags {
    fn job_options(&self) -> JobOptions {
        let mut o = JobOptions::default();
        if let Some(t) = self.threads {
            o.threads = t.max(1);
        }
        o.analysis = AnalysisOptions {
            bpm_range: (self.bpm_min, self.bpm_max),
            allow_warp: !self.no_warp,
            waveform: false,
            ..Default::default()
        };
        o
    }
}

#[derive(Args)]
struct AnalyzeArgs {
    /// Files or folders.
    #[arg(required = true)]
    paths: Vec<PathBuf>,
    #[command(flatten)]
    flags: AnalysisFlags,
}

#[derive(Clone, Copy, ValueEnum)]
enum Transition {
    Blend,
    BassSwap,
    FilterFade,
    EchoOut,
    Cut,
    Brake,
}

impl From<Transition> for TransitionKind {
    fn from(t: Transition) -> Self {
        match t {
            Transition::Blend => TransitionKind::Blend,
            Transition::BassSwap => TransitionKind::BassSwap,
            Transition::FilterFade => TransitionKind::FilterFade,
            Transition::EchoOut => TransitionKind::EchoOut,
            Transition::Cut => TransitionKind::Cut,
            Transition::Brake => TransitionKind::Brake,
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum Energy {
    Steady,
    Up,
    Down,
}

impl From<Energy> for EnergyDirection {
    fn from(e: Energy) -> Self {
        match e {
            Energy::Steady => EnergyDirection::Steady,
            Energy::Up => EnergyDirection::Up,
            Energy::Down => EnergyDirection::Down,
        }
    }
}

#[derive(Args)]
struct MixFlags {
    #[arg(long, value_enum, default_value_t = Transition::BassSwap)]
    transition: Transition,
    /// "first" (hold the opener's tempo), "follow" (ramp to each track's own) or a BPM.
    #[arg(long, default_value = "first")]
    tempo: String,
    /// Longest overlap in beats.
    #[arg(long, default_value_t = 32.0)]
    overlap: f64,
    /// Do not shift keys to make neighbours compatible.
    #[arg(long)]
    no_harmonic: bool,
    /// Largest key shift in semitones.
    #[arg(long, default_value_t = 2)]
    max_shift: i32,
    /// Reorder the tracks into the best tempo/key/energy path.
    #[arg(long)]
    reorder: bool,
    /// Energy direction when reordering.
    #[arg(long, value_enum, default_value_t = Energy::Up)]
    energy: Energy,
}

impl MixFlags {
    fn options(&self) -> Result<SetOptions> {
        let tempo = match self.tempo.to_ascii_lowercase().as_str() {
            "first" => TempoPolicy::FirstTrack,
            "follow" => TempoPolicy::Follow,
            s => TempoPolicy::Fixed(s.parse::<f64>().map_err(|_| anyhow!("--tempo: first, follow or a BPM"))?),
        };
        Ok(SetOptions {
            automix: AutomixOptions {
                transition: self.transition.into(),
                max_overlap: self.overlap.max(4.0),
                min_overlap: (self.overlap / 2.0).clamp(4.0, 16.0),
                tempo,
                harmonic: !self.no_harmonic,
                max_key_shift: self.max_shift.clamp(0, 6),
            },
            reorder: self.reorder,
            energy: self.energy.into(),
        })
    }
}

#[derive(Args)]
struct RenderFlags {
    /// wav16, wav24, wav32f, flac16, flac24 (default from the extension).
    #[arg(long)]
    format: Option<String>,
    #[arg(long, default_value_t = 44_100)]
    sample_rate: u32,
    #[arg(long)]
    no_limiter: bool,
    /// Do not level tracks to the same loudness.
    #[arg(long)]
    no_auto_gain: bool,
    /// Seconds of tail after the last clip.
    #[arg(long, default_value_t = 2.0)]
    tail: f64,
}

impl RenderFlags {
    fn options(&self) -> RenderOptions {
        RenderOptions {
            sample_rate: self.sample_rate,
            tail: self.tail.max(0.0),
            limiter: !self.no_limiter,
            auto_gain: !self.no_auto_gain,
            ..Default::default()
        }
    }
}

#[derive(Args)]
struct AutomixArgs {
    /// Files or folders, in play order (unless --reorder).
    #[arg(required = true)]
    paths: Vec<PathBuf>,
    /// Project file to write.
    #[arg(short, long)]
    output: PathBuf,
    #[arg(long, default_value = "Automix")]
    name: String,
    #[command(flatten)]
    mix: MixFlags,
    /// Also bounce the mix to this audio file.
    #[arg(long)]
    render: Option<PathBuf>,
    #[command(flatten)]
    render_flags: RenderFlags,
    #[command(flatten)]
    analysis: AnalysisFlags,
}

#[derive(Args)]
struct RenderArgs {
    project: PathBuf,
    #[arg(short, long)]
    output: PathBuf,
    #[command(flatten)]
    flags: RenderFlags,
}

#[derive(Args)]
struct StretchArgs {
    input: PathBuf,
    #[arg(short, long)]
    output: PathBuf,
    /// Speed factor (1.05 = 5 % faster).
    #[arg(long, conflicts_with_all = ["percent", "bpm"])]
    speed: Option<f64>,
    /// Tempo change in percent.
    #[arg(long, allow_hyphen_values = true, conflicts_with = "bpm")]
    percent: Option<f64>,
    /// Target tempo (the file's tempo is analysed).
    #[arg(long)]
    bpm: Option<f64>,
    /// Pitch shift in semitones.
    #[arg(long, allow_hyphen_values = true, default_value_t = 0.0)]
    semitones: f32,
    /// Shift to this key (or its relative) by the smallest step.
    #[arg(long)]
    to_key: Option<String>,
    #[arg(long)]
    format: Option<String>,
    #[arg(long, default_value_t = 44_100)]
    sample_rate: u32,
}

#[derive(Args)]
struct PlayArgs {
    /// Audio file or mix project (.json).
    input: PathBuf,
    /// Output device id (see `mixit devices`).
    #[arg(long)]
    device: Option<String>,
    /// Tempo change in percent (key lock on).
    #[arg(long, allow_hyphen_values = true, default_value_t = 0.0)]
    tempo: f64,
    #[arg(long, allow_hyphen_values = true, default_value_t = 0.0)]
    semitones: f32,
    /// Start position in seconds.
    #[arg(long, default_value_t = 0.0)]
    start: f64,
    /// Stop after this many seconds.
    #[arg(long)]
    seconds: Option<f64>,
    #[arg(long)]
    buffer: Option<u32>,
}

#[derive(Clone, Copy, ValueEnum)]
enum StyleArg {
    House,
    Techno,
    Trance,
    Dnb,
    HipHop,
}

#[derive(Args)]
struct GenerateArgs {
    #[arg(short, long)]
    output: PathBuf,
    #[arg(long, value_enum, default_value_t = StyleArg::House)]
    style: StyleArg,
    #[arg(long, default_value_t = 124.0)]
    bpm: f64,
    /// Glide to this tempo over the track.
    #[arg(long)]
    end_bpm: Option<f64>,
    #[arg(long, default_value = "8A")]
    key: String,
    /// About 40 s instead of a full 3–4 minute arrangement.
    #[arg(long)]
    short: bool,
    #[arg(long, default_value_t = 1)]
    seed: u64,
    /// Silence before the first beat (seconds).
    #[arg(long, default_value_t = 0.0)]
    lead_in: f64,
    /// 0 = straight, 0.6 = heavy swing.
    #[arg(long, default_value_t = 0.0)]
    swing: f64,
    /// Write the ground truth (beats, sections, key) as JSON here.
    #[arg(long)]
    truth: Option<PathBuf>,
}

#[derive(Subcommand)]
enum LibCmd {
    /// Add folders or files (and analyse new tracks).
    Scan {
        #[arg(required = true)]
        paths: Vec<PathBuf>,
        #[arg(long)]
        no_analyze: bool,
        #[command(flatten)]
        flags: AnalysisFlags,
    },
    /// Analyse every track that still needs it.
    Analyze {
        #[command(flatten)]
        flags: AnalysisFlags,
    },
    /// Check every track's file again (finds moved, changed and missing files).
    Rescan,
    /// Search: text, artist:, bpm:120-128, bpm:~124, key:~8A, energy:>6, played:never, sort:bpm …
    Search {
        query: Vec<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Everything about one track.
    Info {
        id: i64,
    },
    /// What to play next after a track.
    Suggest {
        id: i64,
        #[arg(long, value_enum, default_value_t = Energy::Steady)]
        energy: Energy,
        /// Largest tempo change, percent.
        #[arg(long, default_value_t = 6.0)]
        tolerance: f64,
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// Tracks that sound like a track (instruments, production, groove), whatever the tempo or key.
    SoundsLike {
        id: i64,
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    Stats,
    /// Groups of identical files.
    Duplicates,
    /// Point tracks under one folder to another (after moving a music folder).
    Relocate {
        from: PathBuf,
        to: PathBuf,
    },
    /// List playlists.
    Playlists,
    /// Create a playlist (or a smart playlist from a search).
    PlaylistCreate {
        name: String,
        #[arg(long)]
        smart: Option<String>,
        /// Track ids to add.
        #[arg(long, value_delimiter = ',')]
        tracks: Vec<i64>,
    },
    /// Show a playlist's tracks.
    PlaylistShow {
        playlist: String,
    },
    /// Append tracks to a playlist.
    PlaylistAdd {
        playlist: String,
        #[arg(required = true)]
        tracks: Vec<i64>,
    },
    /// Reorder a playlist into the smoothest tempo/key/energy path.
    PlaylistOrder {
        playlist: String,
        #[arg(long, value_enum, default_value_t = Energy::Up)]
        energy: Energy,
        /// Track to open with.
        #[arg(long)]
        start: Option<i64>,
    },
    /// Build a mix project from a playlist.
    Automix {
        playlist: String,
        #[arg(short, long)]
        output: PathBuf,
        #[command(flatten)]
        mix: MixFlags,
        #[arg(long)]
        render: Option<PathBuf>,
        #[command(flatten)]
        render_flags: RenderFlags,
    },
    /// Export a playlist as M3U (relative paths with --relative) or CSV.
    Export {
        playlist: String,
        output: PathBuf,
        #[arg(long)]
        relative: bool,
    },
    /// Export the library (or one playlist) as Rekordbox XML.
    ExportRekordbox {
        output: PathBuf,
        #[arg(long)]
        playlist: Option<String>,
    },
    /// Import a Rekordbox XML collection: tracks, grids, cues and playlists.
    ImportRekordbox {
        file: PathBuf,
    },
    /// Import an M3U playlist.
    ImportM3u {
        file: PathBuf,
        #[arg(long)]
        name: Option<String>,
    },
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli) {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

struct Ctx {
    db: Option<PathBuf>,
    notation: KeyNotation,
    json: bool,
    quiet: bool,
}

impl Ctx {
    fn library(&self) -> Result<Library> {
        let path = self.db.clone().unwrap_or_else(mixit_cli::default_db_path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        Library::open(&path).with_context(|| format!("opening library {}", path.display()))
    }

    /// The library if one exists (for finding moved files); never creates one.
    fn existing_library(&self) -> Option<Library> {
        let path = self.db.clone().unwrap_or_else(mixit_cli::default_db_path);
        path.is_file().then(|| Library::open(&path).ok()).flatten()
    }

    fn progress(&self, msg: &str) {
        if !self.quiet && std::io::IsTerminal::is_terminal(&std::io::stderr()) {
            eprint!("\r\x1b[2K{msg}");
            let _ = std::io::stderr().flush();
        }
    }

    fn done(&self) {
        if !self.quiet && std::io::IsTerminal::is_terminal(&std::io::stderr()) {
            eprint!("\r\x1b[2K");
        }
    }

    fn print_json<T: serde::Serialize>(&self, v: &T) -> Result<()> {
        println!("{}", serde_json::to_string_pretty(v)?);
        Ok(())
    }
}

fn run(cli: Cli) -> Result<()> {
    let ctx = Ctx { db: cli.db, notation: cli.notation.into(), json: cli.json, quiet: cli.quiet };
    match cli.cmd {
        Cmd::Devices => devices(&ctx),
        Cmd::Analyze(a) => analyze(&ctx, a),
        Cmd::Key { key } => key_info(&ctx, &key),
        Cmd::Automix(a) => automix(&ctx, a),
        Cmd::Render(a) => render(&ctx, a),
        Cmd::Project { project } => project_info(&ctx, &project),
        Cmd::Stretch(a) => stretch(&ctx, a),
        Cmd::Convert { input, output, format, sample_rate } => {
            let t = mixit_io::load_track(&input, sample_rate, None)
                .with_context(|| format!("loading {}", input.display()))?;
            ops::write_audio(&output, &t.data, sample_rate, ops::format_for(&output, format.as_deref())?)?;
            if !ctx.quiet {
                eprintln!("Wrote {} ({})", output.display(), format::clock(t.frames() as f64 / sample_rate as f64));
            }
            Ok(())
        }
        Cmd::Play(a) => play(&ctx, a),
        Cmd::Generate(a) => generate(&ctx, a),
        Cmd::Library(c) => library(&ctx, c),
    }
}

fn devices(ctx: &Ctx) -> Result<()> {
    let list = mixit_host::list_outputs();
    if ctx.json {
        return ctx.print_json(&list);
    }
    if list.is_empty() {
        println!("No audio outputs found.");
    }
    for d in list {
        let buf = d.buffer_range.map(|(a, b)| format!(", buffers {a}–{b}")).unwrap_or_default();
        println!(
            "{}{} [{}]\n    id {}  ·  {} channels, {} Hz default{buf}",
            if d.is_default { "* " } else { "  " },
            d.name,
            d.host,
            d.id,
            d.max_channels,
            d.default_sample_rate
        );
    }
    Ok(())
}

fn analyze(ctx: &Ctx, a: AnalyzeArgs) -> Result<()> {
    let files = ops::collect_audio(&a.paths);
    if files.is_empty() {
        bail!("no audio files found");
    }
    let started = Instant::now();
    let results = ops::analyze_files(&files, &a.flags.job_options(), |done, total, p| {
        ctx.progress(&format!("Analysing {done}/{total}: {}", p.file_name().unwrap_or_default().to_string_lossy()))
    });
    ctx.done();
    let mut failed = 0;
    if ctx.json {
        #[derive(serde::Serialize)]
        struct Item<'a> {
            path: &'a Path,
            #[serde(skip_serializing_if = "Option::is_none")]
            analysis: Option<&'a mixit_analysis::Analysis>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<&'a str>,
        }
        let items: Vec<Item> = files
            .iter()
            .zip(&results)
            .map(|(p, r)| Item { path: p, analysis: r.as_ref().ok(), error: r.as_ref().err().map(|s| s.as_str()) })
            .collect();
        ctx.print_json(&items)?;
    } else {
        for (p, r) in files.iter().zip(&results) {
            match r {
                Ok(an) => println!("{}", analysis_report(&p.display().to_string(), an, ctx.notation)),
                Err(e) => {
                    failed += 1;
                    println!("{}\n  failed: {e}\n", p.display());
                }
            }
        }
        if !ctx.quiet && files.len() > 1 {
            eprintln!("{} files in {:.1} s", files.len(), started.elapsed().as_secs_f64());
        }
    }
    if failed == files.len() { bail!("analysis failed") } else { Ok(()) }
}

fn key_info(ctx: &Ctx, s: &str) -> Result<()> {
    let k = Key::parse(s).ok_or_else(|| anyhow!("not a key: {s:?} (try 8A, 1m, A minor, F#m)"))?;
    let n = ctx.notation;
    let others: Vec<Key> = (0..24).map(Key::from_index).collect();
    let compatible: Vec<Key> = others.iter().copied().filter(|o| *o != k && k.is_compatible(*o)).collect();
    if ctx.json {
        #[derive(serde::Serialize)]
        struct Out {
            key: String,
            camelot: String,
            open_key: String,
            compatible: Vec<String>,
            energy_boost: String,
        }
        return ctx.print_json(&Out {
            key: k.standard_name(),
            camelot: k.display(KeyNotation::Camelot),
            open_key: k.display(KeyNotation::OpenKey),
            compatible: compatible.iter().map(|c| c.display(n)).collect(),
            energy_boost: k.transposed(2).display(n),
        });
    }
    println!(
        "{}  ·  Camelot {}  ·  Open Key {}",
        k.standard_name(),
        k.display(KeyNotation::Camelot),
        k.display(KeyNotation::OpenKey)
    );
    println!("\nMixes smoothly with (same key and Camelot neighbours):");
    for c in &compatible {
        println!("  {}", key_name(*c, n));
    }
    println!("\nEnergy boost: {} (two steps up the wheel, a whole tone higher).", key_name(k.transposed(2), n));
    println!("\nTracks in other keys fit after a key shift (with key lock on):");
    for s in [-2i32, -1, 1, 2] {
        let mut fits: Vec<Key> =
            others.iter().copied().filter(|o| !k.is_compatible(*o) && o.transposed(s).is_compatible(k)).collect();
        fits.sort_by_key(|o| o.camelot());
        if !fits.is_empty() {
            let names: Vec<String> = fits.iter().map(|o| o.display(n)).collect();
            println!("  shift them {s:+} semitone(s): {}", names.join(", "));
        }
    }
    Ok(())
}

fn print_project_summary(p: &MixProject, order: Option<&[PathBuf]>) {
    println!("{}  ·  {} tracks  ·  {}", p.name, p.clips.len(), format::clock(p.length_seconds()));
    for (i, c) in p.clips.iter().enumerate() {
        let t = p.tempo.seconds_at_beat(c.start);
        let shift = if c.key_shift != 0.0 { format!("  key {:+}", c.key_shift) } else { String::new() };
        let stretch = if c.track.bpm > 0.0 {
            format!("  {:+.1} %", (p.tempo.bpm_at_beat(c.start) / c.track.bpm - 1.0) * 100.0)
        } else {
            String::new()
        };
        let who = if c.track.artist.is_empty() {
            c.track.title.clone()
        } else {
            format!("{} – {}", c.track.artist, c.track.title)
        };
        println!("  {:>2}. {:>7}  deck {}  {who}{stretch}{shift}", i + 1, format::clock(t), (b'A' + c.lane) as char);
        if let Some(o) = order {
            if let Some(path) = o.get(i) {
                println!("               {}", path.display());
            }
        }
    }
    let issues = p.check();
    for i in &issues {
        let name = |id: u64| p.clip(id).map(|c| c.track.title.clone()).unwrap_or_default();
        match i {
            Issue::LaneOverlap { a, b } => println!("  ! {} and {} overlap on the same deck", name(*a), name(*b)),
            Issue::KeyClash { a, b } => println!("  ! keys clash between {} and {}", name(*a), name(*b)),
            Issue::TempoStretch { clip, percent } => println!("  ! {} is stretched {percent:+.1} %", name(*clip)),
        }
    }
}

fn render_with(
    ctx: &Ctx,
    p: &MixProject,
    project_path: Option<&Path>,
    out: &Path,
    flags: &RenderFlags,
    lib: Option<&Library>,
) -> Result<()> {
    let opts = flags.options();
    let cache = mixit_io::DecodeCache::new(mixit_cli::default_cache_dir()).ok();
    let mut r = Resolver::new(opts.sample_rate, lib, cache);
    r.base_dir = project_path.and_then(|p| p.parent()).map(Path::to_path_buf);
    let fmt = ops::format_for(out, flags.format.as_deref())?;
    let started = Instant::now();
    let summary = ops::render_to_file(p, &mut r, &opts, out, fmt, |f| {
        if (f * 1000.0) as u32 % 10 == 0 {
            ctx.progress(&format!("Rendering {:.0} %", f * 100.0));
        }
    })?;
    ctx.done();
    if ctx.json {
        return ctx.print_json(&summary);
    }
    for (t, path) in &summary.relocated {
        eprintln!("Found {t} at {}", path.display());
    }
    if !ctx.quiet {
        eprintln!(
            "Wrote {} ({}, {:.1} LUFS, peak {:.1} dBTP) in {:.1} s",
            out.display(),
            format::clock(summary.seconds),
            summary.integrated_lufs,
            summary.true_peak_dbtp,
            started.elapsed().as_secs_f64()
        );
    }
    Ok(())
}

fn automix(ctx: &Ctx, a: AutomixArgs) -> Result<()> {
    let files = ops::collect_audio(&a.paths);
    if files.len() < 2 {
        bail!("automix needs at least two tracks");
    }
    let results = ops::analyze_files(&files, &a.analysis.job_options(), |done, total, p| {
        ctx.progress(&format!("Analysing {done}/{total}: {}", p.file_name().unwrap_or_default().to_string_lossy()))
    });
    ctx.done();
    let mut items = Vec::new();
    for (p, r) in files.into_iter().zip(results) {
        match r {
            Ok(an) if an.is_rhythmic() => items.push((p, an)),
            Ok(_) => eprintln!("Skipping {} (no steady beat)", p.display()),
            Err(e) => eprintln!("Skipping {}: {e}", p.display()),
        }
    }
    let (project, order) = ops::automix_analysed(&a.name, items, &a.mix.options()?)?;
    ops::save_project(&a.output, &project)?;
    if ctx.json {
        ctx.print_json(&project)?;
    } else {
        print_project_summary(&project, Some(&order));
        eprintln!("Saved {}", a.output.display());
    }
    if let Some(out) = &a.render {
        let lib = ctx.existing_library();
        render_with(ctx, &project, Some(&a.output), out, &a.render_flags, lib.as_ref())?;
    }
    Ok(())
}

fn render(ctx: &Ctx, a: RenderArgs) -> Result<()> {
    let p = ops::load_project(&a.project)?;
    let lib = ctx.existing_library();
    render_with(ctx, &p, Some(&a.project), &a.output, &a.flags, lib.as_ref())
}

fn project_info(ctx: &Ctx, path: &Path) -> Result<()> {
    let p = ops::load_project(path)?;
    if ctx.json {
        #[derive(serde::Serialize)]
        struct Out<'a> {
            project: &'a MixProject,
            seconds: f64,
            issues: Vec<String>,
        }
        let issues = p.check().iter().map(|i| format!("{i:?}")).collect();
        return ctx.print_json(&Out { project: &p, seconds: p.length_seconds(), issues });
    }
    print_project_summary(&p, None);
    Ok(())
}

fn stretch(ctx: &Ctx, a: StretchArgs) -> Result<()> {
    let speed = match (a.speed, a.percent, a.bpm) {
        (Some(s), _, _) => Speed::Factor(s),
        (_, Some(p), _) => Speed::Percent(p),
        (_, _, Some(b)) => Speed::Bpm(b),
        _ => Speed::Factor(1.0),
    };
    let to_key = match &a.to_key {
        Some(s) => Some(Key::parse(s).ok_or_else(|| anyhow!("not a key: {s:?}"))?),
        None => None,
    };
    let fmt = ops::format_for(&a.output, a.format.as_deref())?;
    ctx.progress("Stretching…");
    let s = ops::stretch_file(&a.input, &a.output, speed, a.semitones, to_key, a.sample_rate, fmt)?;
    ctx.done();
    if ctx.json {
        return ctx.print_json(&s);
    }
    let from = s.source_bpm.map(|b| format!(" ({b:.2} → {:.2} BPM)", b * s.speed)).unwrap_or_default();
    println!(
        "Wrote {}: speed ×{:.4}{from}, pitch {:+.1} semitones, {}",
        a.output.display(),
        s.speed,
        s.semitones,
        format::clock(s.seconds)
    );
    Ok(())
}

fn generate(ctx: &Ctx, a: GenerateArgs) -> Result<()> {
    let key = Key::parse(&a.key).ok_or_else(|| anyhow!("not a key: {:?}", a.key))?;
    let style = match a.style {
        StyleArg::House => Style::House,
        StyleArg::Techno => Style::Techno,
        StyleArg::Trance => Style::Trance,
        StyleArg::Dnb => Style::DrumAndBass,
        StyleArg::HipHop => Style::HipHop,
    };
    let mut spec = if a.short { TrackSpec::short(style, a.bpm, key) } else { TrackSpec::standard(style, a.bpm, key) };
    spec.end_bpm = a.end_bpm;
    spec.seed = a.seed;
    spec.lead_in = a.lead_in.max(0.0);
    spec.swing = a.swing.clamp(0.0, 0.9);
    let g = mixit_generator::generate(&spec);
    ops::write_audio(&a.output, &g.audio, g.sample_rate, ops::format_for(&a.output, None)?)?;
    if let Some(t) = &a.truth {
        std::fs::write(t, serde_json::to_string_pretty(&g.truth)?)?;
    }
    if !ctx.quiet {
        eprintln!(
            "Wrote {} ({}, {:.1} BPM, {})",
            a.output.display(),
            format::clock(g.truth.duration),
            a.bpm,
            key_name(key, ctx.notation)
        );
    }
    Ok(())
}

fn play(ctx: &Ctx, a: PlayArgs) -> Result<()> {
    let cfg = mixit_host::HostConfig {
        device: a.device.clone(),
        buffer_frames: a.buffer.or(Some(512)),
        ..Default::default()
    };
    let (host, mut ctl) = mixit_host::AudioHost::start(&cfg, EngineConfig { decks: 2, ..Default::default() })
        .map_err(|e| anyhow!("audio device: {e}"))?;
    let sr = host.sample_rate;
    let is_project = a.input.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("json"));
    let (audio, grid, gain, title) = if is_project {
        let p = ops::load_project(&a.input)?;
        let lib = ctx.existing_library();
        let cache = mixit_io::DecodeCache::new(mixit_cli::default_cache_dir()).ok();
        let mut r = Resolver::new(sr, lib.as_ref(), cache);
        r.base_dir = a.input.parent().map(Path::to_path_buf);
        let opts = RenderOptions { sample_rate: sr, ..Default::default() };
        let data =
            ops::render_project(&p, &mut r, &opts, |f| ctx.progress(&format!("Preparing mix {:.0} %", f * 100.0)))?;
        ctx.done();
        let grid = Beatgrid::constant(sr, p.tempo.bpm_at_beat(0.0), 0.0);
        (data, grid, 0.0, p.name.clone())
    } else {
        ctx.progress("Loading…");
        let t = mixit_io::load_track(&a.input, sr, None).with_context(|| format!("loading {}", a.input.display()))?;
        let an = mixit_analysis::analyze(&t.data, sr, &AnalysisOptions { waveform: false, ..Default::default() });
        ctx.done();
        let title = a.input.file_name().unwrap_or_default().to_string_lossy().into_owned();
        (t.data, an.grid, an.loudness.auto_gain_db as f32, title)
    };
    let total = audio.len() as f64 / 2.0 / sr as f64;
    let id = DeckId(0);
    let mut track = DeckTrack::new(Arc::new(TrackAudio::new(sr, audio)), Arc::new(grid));
    track.auto_gain_db = gain;
    let send = |ctl: &mut mixit_engine::Controller, c: Command| {
        let _ = ctl.send(c);
    };
    send(
        &mut ctl,
        Command::Deck(
            id,
            DeckCommand::SetStretcher(Box::new(mixit_stretch::SignalsmithStretch::new(
                sr,
                mixit_stretch::StretchQuality::High,
            ))),
        ),
    );
    send(&mut ctl, Command::Deck(id, DeckCommand::Load(Box::new(track))));
    send(&mut ctl, Command::Deck(id, DeckCommand::SetTempoRange(1.0)));
    if a.tempo != 0.0 || a.semitones != 0.0 {
        send(&mut ctl, Command::Deck(id, DeckCommand::SetKeylock(true)));
    }
    send(&mut ctl, Command::Deck(id, DeckCommand::SetTempo(a.tempo / 100.0)));
    send(&mut ctl, Command::Deck(id, DeckCommand::SetKeyShift(a.semitones)));
    send(&mut ctl, Command::Mixer(MixerCommand::SetAutoGain(!is_project)));
    send(&mut ctl, Command::Mixer(MixerCommand::SetFader(id, 1.0)));
    if a.start > 0.0 {
        send(&mut ctl, Command::Deck(id, DeckCommand::Seek(a.start * sr as f64)));
    }
    send(&mut ctl, Command::Deck(id, DeckCommand::Play));
    if !ctx.quiet {
        eprintln!("Playing {title} on {} ({} Hz, {:.1} ms buffer)", host.device_name, sr, host.buffer_latency_ms());
    }
    let started = Instant::now();
    let mut last;
    loop {
        std::thread::sleep(Duration::from_millis(100));
        ctl.collect_trash();
        let ended = ctl.events().any(|e| matches!(e, Event::TrackEnded { .. }));
        let t = ctl.telemetry();
        let d = &t.decks[0];
        let peak = t.master.peak[0].max(t.master.peak[1]);
        let db = if peak > 0.0 { 20.0 * peak.log10() } else { -99.0 };
        last = format!(
            "{} / {}  {:.1} BPM  beat {:.0}  {:>5.1} dB{}",
            format::clock(d.position / sr as f64),
            format::clock(total),
            d.bpm,
            d.beat.floor() + 1.0,
            db,
            if t.master.limiter_gr_db < -0.5 { "  limiting" } else { "" }
        );
        ctx.progress(&last);
        let out_of_time = a.seconds.is_some_and(|s| started.elapsed().as_secs_f64() >= s);
        if ended || out_of_time {
            break;
        }
    }
    ctx.done();
    if !ctx.quiet {
        eprintln!("Stopped at {last}");
    }
    drop(host);
    Ok(())
}

fn find_playlist(lib: &Library, s: &str) -> Result<mixit_library::Playlist> {
    let all = lib.playlists()?;
    if let Ok(id) = s.parse::<i64>() {
        if let Some(p) = all.iter().find(|p| p.id == id) {
            return Ok(p.clone());
        }
    }
    all.iter().find(|p| p.name.eq_ignore_ascii_case(s)).cloned().ok_or_else(|| anyhow!("no playlist called {s:?}"))
}

fn analyse_pending(ctx: &Ctx, lib: &Library, flags: &AnalysisFlags) -> Result<()> {
    let mut opts = flags.job_options();
    opts.analysis.waveform = true;
    opts.cache_dir = Some(mixit_cli::default_cache_dir());
    let started = Instant::now();
    let s = lib.analyze_pending(&opts, &AtomicBool::new(false), |done, total, _| {
        ctx.progress(&format!("Analysing {done}/{total}"))
    })?;
    ctx.done();
    if !ctx.quiet && s.analysed + s.failed > 0 {
        eprintln!("Analysed {} tracks ({} failed) in {:.1} s", s.analysed, s.failed, started.elapsed().as_secs_f64());
    }
    Ok(())
}

fn library(ctx: &Ctx, c: LibCmd) -> Result<()> {
    let lib = ctx.library()?;
    let n = ctx.notation;
    match c {
        LibCmd::Scan { paths, no_analyze, flags } => {
            let mut total = mixit_library::scan::ScanReport::default();
            for p in &paths {
                let r = if p.is_dir() {
                    lib.add_folder(p)?;
                    lib.scan_folder(p, |i, f| ctx.progress(&format!("Scanning {i}: {}", f.display())))?
                } else {
                    let mut r = mixit_library::scan::ScanReport::default();
                    match lib.import_file(p) {
                        Ok(mixit_library::scan::Imported::Added(id)) => r.added.push(id),
                        Ok(mixit_library::scan::Imported::Updated(id)) => r.updated.push(id),
                        Ok(mixit_library::scan::Imported::Moved(id)) => r.moved.push(id),
                        Ok(mixit_library::scan::Imported::Unchanged(_)) => r.unchanged += 1,
                        Err(e) => r.errors.push((p.clone(), e.to_string())),
                    }
                    r
                };
                total.added.extend(r.added);
                total.updated.extend(r.updated);
                total.moved.extend(r.moved);
                total.missing.extend(r.missing);
                total.unchanged += r.unchanged;
                total.errors.extend(r.errors);
            }
            ctx.done();
            if ctx.json {
                ctx.print_json(&total)?;
            } else {
                println!(
                    "{} added, {} updated, {} moved, {} missing, {} unchanged",
                    total.added.len(),
                    total.updated.len(),
                    total.moved.len(),
                    total.missing.len(),
                    total.unchanged
                );
                for (p, e) in &total.errors {
                    println!("  could not read {}: {e}", p.display());
                }
            }
            if !no_analyze {
                analyse_pending(ctx, &lib, &flags)?;
            }
            Ok(())
        }
        LibCmd::Analyze { flags } => analyse_pending(ctx, &lib, &flags),
        LibCmd::Rescan => {
            let r = lib.rescan_all(|i, f| ctx.progress(&format!("Checking {i}: {}", f.display())))?;
            ctx.done();
            if ctx.json {
                return ctx.print_json(&r);
            }
            println!(
                "{} updated, {} moved, {} missing, {} unchanged",
                r.updated.len(),
                r.moved.len(),
                r.missing.len(),
                r.unchanged
            );
            Ok(())
        }
        LibCmd::Search { query, limit } => {
            let q = mixit_library::query::parse(&query.join(" "));
            for w in &q.warnings {
                eprintln!("note: {w}");
            }
            let tracks = lib.search_query(&q, Some(limit))?;
            if ctx.json {
                return ctx.print_json(&tracks);
            }
            print!("{}", track_table(&tracks, n));
            Ok(())
        }
        LibCmd::Info { id } => {
            let t = lib.track(id)?;
            if ctx.json {
                #[derive(serde::Serialize)]
                struct Out {
                    track: mixit_library::Track,
                    analysis: Option<mixit_analysis::Analysis>,
                    cues: Vec<mixit_library::Cue>,
                }
                let mut analysis = lib.analysis(id)?;
                if let Some(a) = analysis.as_mut() {
                    a.waveform = None;
                }
                return ctx.print_json(&Out { cues: lib.cues(id)?, analysis, track: t });
            }
            print!("{}", track_table(std::slice::from_ref(&t), n));
            println!("  {}", t.path.display());
            if let Some(a) = lib.analysis(id)? {
                println!();
                print!("{}", analysis_report(&t.display_title(), &a, n));
            } else {
                println!("  not analysed yet ({:?})", t.analysis_state);
            }
            Ok(())
        }
        LibCmd::Suggest { id, energy, tolerance, limit } => {
            let opts =
                SuggestOptions { energy: energy.into(), tempo_tolerance_pct: tolerance, limit, ..Default::default() };
            let list = lib.suggest_next(id, &opts)?;
            if ctx.json {
                return ctx.print_json(&list);
            }
            let cur = lib.track(id)?;
            println!(
                "After {} ({}, {}):",
                cur.display_title(),
                cur.best_bpm().map(|b| format!("{b:.1} BPM")).unwrap_or_default(),
                cur.best_key().map(|k| k.display(n)).unwrap_or_default()
            );
            let rows: Vec<_> = list.into_iter().filter_map(|s| lib.track(s.id).ok().map(|t| (s, t))).collect();
            print!("{}", format::suggestions(&rows, n));
            Ok(())
        }
        LibCmd::SoundsLike { id, limit } => {
            let list = lib.sounds_like(id, limit)?;
            if ctx.json {
                let rows: Vec<_> =
                    list.iter().map(|(id, score)| serde_json::json!({ "id": id, "score": score })).collect();
                return ctx.print_json(&rows);
            }
            let cur = lib.track(id)?;
            if list.is_empty() {
                println!("No matches yet for {}: analyse it (and more of your library) first.", cur.display_title());
                return Ok(());
            }
            println!("Sounds like {}:", cur.display_title());
            for (other, score) in list {
                let t = lib.track(other)?;
                println!(
                    "  {:>3} %  #{:<5} {}  ({}, {})",
                    (score * 100.0).round(),
                    t.id,
                    t.display_title(),
                    t.best_bpm().map(|b| format!("{b:.1} BPM")).unwrap_or_else(|| "? BPM".into()),
                    t.best_key().map(|k| k.display(n)).unwrap_or_else(|| "?".into())
                );
            }
            Ok(())
        }
        LibCmd::Stats => {
            let s = lib.stats()?;
            if ctx.json {
                return ctx.print_json(&s);
            }
            println!(
                "{} tracks ({}), {} analysed, {} waiting, {} failed, {} missing, {} playlists",
                s.tracks,
                format::clock(s.total_seconds),
                s.analysed,
                s.pending,
                s.failed,
                s.missing,
                s.playlists
            );
            Ok(())
        }
        LibCmd::Duplicates => {
            let groups = lib.duplicates()?;
            if ctx.json {
                return ctx.print_json(&groups);
            }
            if groups.is_empty() {
                println!("No duplicates.");
            }
            for g in groups {
                println!("Same audio:");
                for id in g {
                    let t = lib.track(id)?;
                    println!("  #{id}  {}", t.path.display());
                }
            }
            Ok(())
        }
        LibCmd::Relocate { from, to } => {
            let n = lib.relocate_prefix(&from, &to)?;
            println!("Relocated {n} tracks.");
            Ok(())
        }
        LibCmd::Playlists => {
            let all = lib.playlists()?;
            if ctx.json {
                return ctx.print_json(&all);
            }
            fn walk(all: &[mixit_library::Playlist], lib: &Library, parent: Option<i64>, depth: usize) {
                for p in all.iter().filter(|p| p.parent == parent) {
                    let count = lib.playlist_tracks(p.id).map(|v| v.len()).unwrap_or(0);
                    let kind = match p.kind {
                        PlaylistKind::Folder => "folder".to_string(),
                        PlaylistKind::List => format!("{count} tracks"),
                        PlaylistKind::Smart => format!("smart: {}  ({count})", p.query.as_deref().unwrap_or("")),
                    };
                    println!("{:indent$}{:>4}  {}  [{kind}]", "", p.id, p.name, indent = depth * 2);
                    walk(all, lib, Some(p.id), depth + 1);
                }
            }
            walk(&all, &lib, None, 0);
            Ok(())
        }
        LibCmd::PlaylistCreate { name, smart, tracks } => {
            let kind = if smart.is_some() { PlaylistKind::Smart } else { PlaylistKind::List };
            let id = lib.create_playlist(&name, kind, None, smart.as_deref())?;
            if !tracks.is_empty() {
                lib.add_to_playlist(id, &tracks)?;
            }
            println!("Created playlist {id}: {name}");
            Ok(())
        }
        LibCmd::PlaylistShow { playlist } => {
            let p = find_playlist(&lib, &playlist)?;
            let tracks: Vec<_> = lib.playlist_tracks(p.id)?.into_iter().filter_map(|id| lib.track(id).ok()).collect();
            if ctx.json {
                return ctx.print_json(&tracks);
            }
            println!(
                "{} ({} tracks, {})",
                p.name,
                tracks.len(),
                format::clock(tracks.iter().map(|t| t.duration).sum())
            );
            print!("{}", track_table(&tracks, n));
            Ok(())
        }
        LibCmd::PlaylistAdd { playlist, tracks } => {
            let p = find_playlist(&lib, &playlist)?;
            if p.kind != PlaylistKind::List {
                bail!("{} is not a regular playlist", p.name);
            }
            lib.add_to_playlist(p.id, &tracks)?;
            println!("Added {} tracks to {}.", tracks.len(), p.name);
            Ok(())
        }
        LibCmd::PlaylistOrder { playlist, energy, start } => {
            let p = find_playlist(&lib, &playlist)?;
            if p.kind != PlaylistKind::List {
                bail!("{} is not a regular playlist", p.name);
            }
            let ids = lib.playlist_tracks(p.id)?;
            let order = lib.order_set(&ids, start, energy.into())?;
            lib.set_playlist_tracks(p.id, &order)?;
            let tracks: Vec<_> = order.iter().filter_map(|&id| lib.track(id).ok()).collect();
            println!("Reordered {}:", p.name);
            print!("{}", track_table(&tracks, n));
            Ok(())
        }
        LibCmd::Automix { playlist, output, mix, render, render_flags } => {
            let p = find_playlist(&lib, &playlist)?;
            let mut ids = lib.playlist_tracks(p.id)?;
            let opts = mix.options()?;
            if opts.reorder {
                ids = lib.order_set(&ids, None, opts.energy)?;
            }
            let plans = lib.plan_tracks(&ids)?;
            let project =
                mixit_project::automix::automix(&p.name, &plans, &opts.automix).map_err(|e| anyhow!("automix: {e}"))?;
            ops::save_project(&output, &project)?;
            if ctx.json {
                ctx.print_json(&project)?;
            } else {
                print_project_summary(&project, None);
                eprintln!("Saved {}", output.display());
            }
            if let Some(out) = render {
                render_with(ctx, &project, Some(&output), &out, &render_flags, Some(&lib))?;
            }
            Ok(())
        }
        LibCmd::Export { playlist, output, relative } => {
            let p = find_playlist(&lib, &playlist)?;
            let ids = lib.playlist_tracks(p.id)?;
            let csv = output.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("csv"));
            if csv {
                lib.export_csv(&ids, &output)?
            } else {
                lib.export_m3u(&ids, &output, relative)?
            }
            println!("Exported {} tracks to {}", ids.len(), output.display());
            Ok(())
        }
        LibCmd::ExportRekordbox { output, playlist } => {
            let ids = match playlist {
                Some(pl) => Some(lib.playlist_tracks(find_playlist(&lib, &pl)?.id)?),
                None => None,
            };
            lib.export_rekordbox_xml(ids.as_deref(), &output)?;
            println!("Exported to {}", output.display());
            Ok(())
        }
        LibCmd::ImportRekordbox { file } => {
            let r = lib.import_rekordbox_xml(&file)?;
            if ctx.json {
                return ctx.print_json(&r);
            }
            println!(
                "Imported {} tracks ({} missing), {} grids, {} cues, {} playlists",
                r.tracks,
                r.missing.len(),
                r.grids,
                r.cues,
                r.playlists
            );
            Ok(())
        }
        LibCmd::ImportM3u { file, name } => {
            let (ids, missing) = lib.import_m3u(&file)?;
            let name = name.unwrap_or_else(|| file.file_stem().unwrap_or_default().to_string_lossy().into_owned());
            let id = lib.create_playlist(&name, PlaylistKind::List, None, None)?;
            lib.add_to_playlist(id, &ids)?;
            println!("Created {name} with {} tracks ({} not found)", ids.len(), missing.len());
            Ok(())
        }
    }
}
