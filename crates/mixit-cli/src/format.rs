//! Plain-text reports for the terminal.

use std::fmt::Write;

use mixit_analysis::{Analysis, CueRole};
use mixit_core::Key;
use mixit_core::key::KeyNotation;
use mixit_library::Track;
use mixit_library::suggest::Suggestion;

/// `m:ss`, or `h:mm:ss` from an hour.
pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// `m:ss.t` (tenths).
pub fn clock_precise(seconds: f64) -> String {
    let t = (seconds.max(0.0) * 10.0).round() as u64;
    format!("{}:{:02}.{}", t / 600, t / 10 % 60, t % 10)
}

/// "8A (Am)" in Camelot, "1m (Am)" in Open Key, "Am" in standard.
pub fn key_name(k: Key, notation: KeyNotation) -> String {
    match notation {
        KeyNotation::Standard => k.standard_name(),
        n => format!("{} ({})", k.display(n), k.standard_name()),
    }
}

fn key_short(k: Option<Key>, notation: KeyNotation) -> String {
    k.map(|k| k.display(notation)).unwrap_or_else(|| "–".into())
}

/// A readable summary of an analysis.
pub fn analysis_report(name: &str, a: &Analysis, notation: KeyNotation) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "{name}");
    let row = |s: &mut String, label: &str, value: String| {
        let _ = writeln!(s, "  {label:<10}{value}");
    };
    row(
        &mut s,
        "Length",
        format!("{} (sound {}–{})", clock(a.duration), clock_precise(a.audible.0), clock_precise(a.audible.1)),
    );
    if a.is_rhythmic() {
        let grid = if a.grid.is_constant() {
            "steady grid".to_string()
        } else {
            format!("tempo drifts {:.0} ms, grid follows it ({} anchors)", a.drift_ms, a.grid.anchors.len())
        };
        let mut v = format!(
            "{:.2} BPM, {}/4, {grid} (confidence {:.0} %)",
            a.bpm,
            a.grid.beats_per_bar,
            a.tempo_confidence * 100.0
        );
        let alts: Vec<String> = a.bpm_candidates.iter().skip(1).take(2).map(|(b, _)| format!("{b:.1}")).collect();
        if !alts.is_empty() {
            let _ = write!(v, "; also plausible {}", alts.join(", "));
        }
        row(&mut s, "Tempo", v);
    } else {
        row(&mut s, "Tempo", "no steady beat (ambient, spoken or beatless)".into());
    }
    match &a.key {
        Some(k) => {
            let mut v = format!("{}, confidence {:.0} %", key_name(k.key, notation), k.confidence * 100.0);
            if k.second != k.key {
                let _ = write!(v, "; runner-up {}", key_name(k.second, notation));
            }
            if k.tuning_cents.abs() >= 10.0 {
                let _ = write!(v, "; tuned {:+.0} cents", k.tuning_cents);
            }
            row(&mut s, "Key", v);
            if a.key_segments.len() > 1 {
                let segs: Vec<String> = a
                    .key_segments
                    .iter()
                    .map(|g| format!("{} from {}", key_short(Some(g.key), notation), clock(g.start)))
                    .collect();
                row(&mut s, "", format!("key changes: {}", segs.join(", ")));
            }
        }
        None => row(&mut s, "Key", "not analysed".into()),
    }
    let l = &a.loudness;
    row(
        &mut s,
        "Loudness",
        format!(
            "{:.1} LUFS, range {:.1} LU, true peak {:.1} dBTP; auto gain {:+.1} dB",
            l.integrated_lufs, l.range_lu, l.true_peak_dbtp, l.auto_gain_db
        ),
    );
    row(&mut s, "Energy", format!("{}/10", a.energy));
    if !a.sections.is_empty() {
        let _ = writeln!(s, "  Sections");
        for sec in &a.sections {
            let _ = writeln!(
                s,
                "    {:>7}  {:<10} {:>3} bars  energy {:.0} %",
                clock_precise(sec.start),
                sec.label.name(),
                sec.bars,
                sec.energy * 100.0
            );
        }
    }
    if !a.cues.is_empty() {
        let _ = writeln!(s, "  Cues");
        for c in &a.cues {
            let role = match c.role {
                CueRole::Load => "load",
                CueRole::MixIn => "mix in",
                CueRole::MixOut => "mix out",
                CueRole::Section(_) => "section",
            };
            let lp = c.loop_beats.map(|b| format!("  loop {b:.0} beats")).unwrap_or_default();
            let _ = writeln!(s, "    {:>7}  {:<12} ({role}){lp}", clock_precise(c.seconds), c.label);
        }
    }
    s
}

/// One line per track: id, tempo, key, energy, length, artist and title.
pub fn track_table(tracks: &[Track], notation: KeyNotation) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "{:>6}  {:>7}  {:<4} {:>2}  {:>6}  {:<1}  TRACK", "ID", "BPM", "KEY", "E", "TIME", "★");
    for t in tracks {
        let bpm = t.best_bpm().map(|b| format!("{b:.2}")).unwrap_or_else(|| "–".into());
        let energy = t.energy.map(|e| e.to_string()).unwrap_or_else(|| "–".into());
        let state = if t.missing { " [missing]" } else { "" };
        let who =
            if t.artist.is_empty() { t.display_title() } else { format!("{} – {}", t.artist, t.display_title()) };
        let _ = writeln!(
            s,
            "{:>6}  {:>7}  {:<4} {:>2}  {:>6}  {:<1}  {who}{state}",
            t.id,
            bpm,
            key_short(t.best_key(), notation),
            energy,
            clock(t.duration),
            if t.rating > 0 { t.rating.to_string() } else { " ".into() },
        );
    }
    s
}

/// Ranked suggestions with their reasons.
pub fn suggestions(list: &[(Suggestion, Track)], notation: KeyNotation) -> String {
    let mut s = String::new();
    for (i, (sg, t)) in list.iter().enumerate() {
        let who =
            if t.artist.is_empty() { t.display_title() } else { format!("{} – {}", t.artist, t.display_title()) };
        let _ = writeln!(
            s,
            "{:>2}. {:>3.0} %  #{:<5} {:>7} {:<4} {who}",
            i + 1,
            sg.score * 100.0,
            t.id,
            t.best_bpm().map(|b| format!("{b:.1}")).unwrap_or_else(|| "–".into()),
            key_short(t.best_key(), notation),
        );
        for r in &sg.reasons {
            let _ = writeln!(s, "            · {}", r.describe());
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::Mode;

    #[test]
    fn clocks_and_keys() {
        assert_eq!(clock(59.6), "1:00");
        assert_eq!(clock(3725.0), "1:02:05");
        assert_eq!(clock_precise(83.44), "1:23.4");
        let am = Key::new(9, Mode::Minor);
        assert_eq!(key_name(am, KeyNotation::Camelot), "8A (Am)");
        assert_eq!(key_name(am, KeyNotation::Standard), "Am");
    }
}
