//! The search language, shared by the search box and smart playlists.
//!
//! ```text
//! deep house bpm:120-126 key:~8A energy:6+ -genre:techno played:>30d sort:-energy
//! ```
//!
//! * Bare words match title, artist, album, genre, label, remixer, comment and path
//!   (prefix match, accents ignored). `"quoted phrases"` match as phrases.
//! * `field:value` filters. Text fields (`artist title album genre label comment
//!   remixer`) match substrings. Numbers (`bpm energy rating year plays duration`)
//!   accept `120`, `120-128`, `>120`, `>=120`, `<120`, `<=120` and `6+`.
//!   `bpm:~128` finds tracks mixable with 128 BPM (±6 %, including half and double time).
//! * `key:8A` (Camelot, Open Key like `1m`, or names like `Am`, `F#`) is an exact key;
//!   `key:~8A` also accepts the harmonically compatible keys.
//! * `tag:peak`, `missing:yes`, `analysed:no`, `played:never`, `played:<7d`,
//!   `played:>30d`, `added:<2w` (units `h d w m y`).
//! * A leading `-` negates any term. `sort:bpm`, `sort:-added` (descending), `sort:random`.

use mixit_core::Key;
use rusqlite::types::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cmp {
    Eq(f64),
    Range(f64, f64),
    Gt(f64),
    Ge(f64),
    Lt(f64),
    Le(f64),
    /// Mixable with this BPM (±6 %, half and double time included).
    Near(f64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NumField {
    Bpm,
    Energy,
    Rating,
    Year,
    Plays,
    Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextField {
    Artist,
    Title,
    Album,
    Genre,
    Label,
    Comment,
    Remixer,
    Path,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TimeFilter {
    Never,
    /// Within the last N seconds.
    Within(i64),
    /// Not within the last N seconds (includes never).
    NotWithin(i64),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Term {
    Text(String),
    Phrase(String),
    Field(TextField, String),
    Num(NumField, Cmp),
    Key { key: Key, compatible: bool },
    Tag(String),
    Played(TimeFilter),
    Added(TimeFilter),
    Missing(bool),
    Analysed(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortKey {
    Artist,
    Title,
    Album,
    Genre,
    Bpm,
    Key,
    Energy,
    Rating,
    Added,
    Played,
    Plays,
    Duration,
    Year,
    Random,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Query {
    /// (negated, term)
    pub terms: Vec<(bool, Term)>,
    pub sort: Option<(SortKey, bool)>,
    /// Problems found while parsing (unknown fields, bad numbers); the rest still applies.
    pub warnings: Vec<String>,
}

fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').to_string()
}

fn parse_cmp(v: &str, scale: impl Fn(&str) -> Option<f64>) -> Option<Cmp> {
    let v = v.trim();
    if let Some(r) = v.strip_prefix(">=") {
        return scale(r).map(Cmp::Ge);
    }
    if let Some(r) = v.strip_prefix("<=") {
        return scale(r).map(Cmp::Le);
    }
    if let Some(r) = v.strip_prefix('>') {
        return scale(r).map(Cmp::Gt);
    }
    if let Some(r) = v.strip_prefix('<') {
        return scale(r).map(Cmp::Lt);
    }
    if let Some(r) = v.strip_prefix('~') {
        return scale(r).map(Cmp::Near);
    }
    if let Some(r) = v.strip_suffix('+') {
        return scale(r).map(Cmp::Ge);
    }
    if let Some((a, b)) = v.split_once('-') {
        if !a.is_empty() {
            let (a, b) = (scale(a)?, scale(b)?);
            return Some(Cmp::Range(a.min(b), a.max(b)));
        }
    }
    scale(v).map(Cmp::Eq)
}

fn plain_number(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `90`, `90s`, `5m`, `1:30`.
fn duration_secs(s: &str) -> Option<f64> {
    let s = s.trim();
    if let Some((m, sec)) = s.split_once(':') {
        return Some(plain_number(m)? * 60.0 + plain_number(sec)?);
    }
    if let Some(m) = s.strip_suffix('m') {
        return plain_number(m).map(|v| v * 60.0);
    }
    plain_number(s.strip_suffix('s').unwrap_or(s))
}

/// `7d`, `2w`, `12h`, `3m` (months), `1y`; a bare number is days.
fn age_secs(s: &str) -> Option<i64> {
    let s = s.trim();
    let (num, unit) = s.split_at(s.find(|c: char| c.is_alphabetic()).unwrap_or(s.len()));
    let n = plain_number(num)?;
    let mult = match unit {
        "h" => 3_600.0,
        "" | "d" => 86_400.0,
        "w" => 7.0 * 86_400.0,
        "m" => 30.0 * 86_400.0,
        "y" => 365.0 * 86_400.0,
        _ => return None,
    };
    Some((n * mult) as i64)
}

fn parse_time(v: &str) -> Option<TimeFilter> {
    if v.eq_ignore_ascii_case("never") {
        return Some(TimeFilter::Never);
    }
    if let Some(r) = v.strip_prefix('<') {
        return age_secs(r).map(TimeFilter::Within);
    }
    if let Some(r) = v.strip_prefix('>') {
        return age_secs(r).map(TimeFilter::NotWithin);
    }
    age_secs(v).map(TimeFilter::Within)
}

fn parse_bool(v: &str) -> Option<bool> {
    match v.to_ascii_lowercase().as_str() {
        "yes" | "y" | "true" | "1" => Some(true),
        "no" | "n" | "false" | "0" => Some(false),
        _ => None,
    }
}

pub fn parse(input: &str) -> Query {
    let mut q = Query::default();
    for tok in tokens(input) {
        let (neg, body) = match tok.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest.to_string()),
            _ => (false, tok.clone()),
        };
        let Some((field, value)) = body.split_once(':').filter(|(f, _)| !f.starts_with('"')) else {
            if body.starts_with('"') {
                let p = unquote(&body);
                if !p.is_empty() {
                    q.terms.push((neg, Term::Phrase(p)));
                }
            } else {
                q.terms.push((neg, Term::Text(body)));
            }
            continue;
        };
        let value = unquote(value);
        let f = field.to_ascii_lowercase();
        let text = |tf| Some(Term::Field(tf, value.clone()));
        let term = match f.as_str() {
            "artist" | "a" => text(TextField::Artist),
            "title" | "t" => text(TextField::Title),
            "album" => text(TextField::Album),
            "genre" | "g" => text(TextField::Genre),
            "label" => text(TextField::Label),
            "comment" => text(TextField::Comment),
            "remixer" => text(TextField::Remixer),
            "path" | "file" => text(TextField::Path),
            "bpm" | "tempo" => parse_cmp(&value, plain_number).map(|c| Term::Num(NumField::Bpm, c)),
            "energy" | "e" => parse_cmp(&value, plain_number).map(|c| Term::Num(NumField::Energy, c)),
            "rating" | "stars" => parse_cmp(&value, plain_number).map(|c| Term::Num(NumField::Rating, c)),
            "year" => parse_cmp(&value, plain_number).map(|c| Term::Num(NumField::Year, c)),
            "plays" => parse_cmp(&value, plain_number).map(|c| Term::Num(NumField::Plays, c)),
            "duration" | "length" | "len" => parse_cmp(&value, duration_secs).map(|c| Term::Num(NumField::Duration, c)),
            "key" | "k" => {
                let (compatible, k) = match value.strip_prefix('~') {
                    Some(r) => (true, r),
                    None => (false, value.as_str()),
                };
                Key::parse(k).map(|key| Term::Key { key, compatible })
            }
            "tag" | "#" => Some(Term::Tag(value.clone())),
            "played" | "last" => parse_time(&value).map(Term::Played),
            "added" => parse_time(&value).map(Term::Added),
            "missing" => parse_bool(&value).map(Term::Missing),
            "analysed" | "analyzed" => parse_bool(&value).map(Term::Analysed),
            "sort" | "order" => {
                let (desc, k) = match value.strip_prefix('-') {
                    Some(r) => (true, r),
                    None => (false, value.as_str()),
                };
                let key = match k.to_ascii_lowercase().as_str() {
                    "artist" => Some(SortKey::Artist),
                    "title" => Some(SortKey::Title),
                    "album" => Some(SortKey::Album),
                    "genre" => Some(SortKey::Genre),
                    "bpm" | "tempo" => Some(SortKey::Bpm),
                    "key" => Some(SortKey::Key),
                    "energy" => Some(SortKey::Energy),
                    "rating" => Some(SortKey::Rating),
                    "added" | "new" => Some(SortKey::Added),
                    "played" | "last" => Some(SortKey::Played),
                    "plays" => Some(SortKey::Plays),
                    "duration" | "length" => Some(SortKey::Duration),
                    "year" => Some(SortKey::Year),
                    "random" | "shuffle" => Some(SortKey::Random),
                    _ => None,
                };
                match key {
                    Some(k) => q.sort = Some((k, desc)),
                    None => q.warnings.push(format!("unknown sort key \"{k}\"")),
                }
                continue;
            }
            _ => {
                // Not a field: treat "word:thing" as text (e.g. a title with a colon).
                q.terms.push((neg, Term::Text(body.clone())));
                continue;
            }
        };
        match term {
            Some(t) => q.terms.push((neg, t)),
            None => q.warnings.push(format!("could not read \"{tok}\"")),
        }
    }
    q
}

/// Keys that mix harmonically with `k`: itself, ±1 on the Camelot wheel, and its relative.
pub fn compatible_keys(k: Key) -> Vec<Key> {
    (0..24).map(Key::from_index).filter(|o| k.camelot_distance(*o) <= 1).collect()
}

fn fts_escape(word: &str) -> String {
    format!("\"{}\"", word.replace('"', "\"\""))
}

fn num_column(f: NumField) -> &'static str {
    match f {
        NumField::Bpm => "COALESCE(t.bpm, t.tag_bpm)",
        NumField::Energy => "t.energy",
        NumField::Rating => "t.rating",
        NumField::Year => "t.year",
        NumField::Plays => "t.play_count",
        NumField::Duration => "t.duration",
    }
}

fn text_column(f: TextField) -> &'static str {
    match f {
        TextField::Artist => "t.artist",
        TextField::Title => "t.title",
        TextField::Album => "t.album",
        TextField::Genre => "t.genre",
        TextField::Label => "t.label",
        TextField::Comment => "t.comment",
        TextField::Remixer => "t.remixer",
        TextField::Path => "t.path",
    }
}

/// SQL for a query over `tracks t`: (WHERE clause, parameters, ORDER BY clause).
pub fn to_sql(q: &Query, now: i64) -> (String, Vec<Value>, String) {
    let mut clauses: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    // Positive bare words go into one FTS expression (fast); the rest become clauses.
    let mut fts: Vec<String> = Vec::new();
    for (neg, term) in &q.terms {
        let clause = match term {
            Term::Text(w) if !neg => {
                fts.push(format!("{}*", fts_escape(w)));
                continue;
            }
            Term::Phrase(p) if !neg => {
                fts.push(fts_escape(p));
                continue;
            }
            Term::Text(w) => {
                params.push(Value::Text(format!("{}*", fts_escape(w))));
                "t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)".to_string()
            }
            Term::Phrase(p) => {
                params.push(Value::Text(fts_escape(p)));
                "t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)".to_string()
            }
            Term::Field(f, v) => {
                params.push(Value::Text(format!("%{}%", v.replace('%', "\\%").replace('_', "\\_"))));
                format!("{} LIKE ? ESCAPE '\\'", text_column(*f))
            }
            Term::Num(f, c) => {
                let col = num_column(*f);
                let mut p = |v: f64| params.push(Value::Real(v));
                match *c {
                    Cmp::Eq(v) if *f == NumField::Bpm => {
                        p(v - 0.5);
                        p(v + 0.5);
                        format!("({col} >= ? AND {col} < ?)")
                    }
                    Cmp::Eq(v) => {
                        p(v);
                        format!("{col} = ?")
                    }
                    Cmp::Range(a, b) => {
                        p(a);
                        p(b);
                        format!("({col} BETWEEN ? AND ?)")
                    }
                    Cmp::Gt(v) => {
                        p(v);
                        format!("{col} > ?")
                    }
                    Cmp::Ge(v) => {
                        p(v);
                        format!("{col} >= ?")
                    }
                    Cmp::Lt(v) => {
                        p(v);
                        format!("{col} < ?")
                    }
                    Cmp::Le(v) => {
                        p(v);
                        format!("{col} <= ?")
                    }
                    Cmp::Near(v) => {
                        let mut parts = Vec::new();
                        for m in [0.5, 1.0, 2.0] {
                            p(v * m / 1.06);
                            p(v * m * 1.06);
                            parts.push(format!("({col} BETWEEN ? AND ?)"));
                        }
                        format!("({})", parts.join(" OR "))
                    }
                }
            }
            Term::Key { key, compatible } => {
                let keys = if *compatible { compatible_keys(*key) } else { vec![*key] };
                let list: Vec<String> = keys.iter().map(|k| k.index().to_string()).collect();
                format!("t.key_index IN ({})", list.join(","))
            }
            Term::Tag(name) => {
                params.push(Value::Text(name.clone()));
                "EXISTS (SELECT 1 FROM track_tags tt JOIN tags g ON g.id = tt.tag_id \
                 WHERE tt.track_id = t.id AND g.name = ? COLLATE NOCASE)"
                    .to_string()
            }
            Term::Played(tf) | Term::Added(tf) => {
                let col = if matches!(term, Term::Played(_)) { "t.last_played" } else { "t.added_at" };
                match *tf {
                    TimeFilter::Never => format!("{col} IS NULL"),
                    TimeFilter::Within(s) => {
                        params.push(Value::Integer(now - s));
                        format!("({col} IS NOT NULL AND {col} >= ?)")
                    }
                    TimeFilter::NotWithin(s) => {
                        params.push(Value::Integer(now - s));
                        format!("({col} IS NULL OR {col} < ?)")
                    }
                }
            }
            Term::Missing(b) => format!("t.missing = {}", *b as i32),
            Term::Analysed(b) => {
                if *b {
                    "t.analysis_state = 1".to_string()
                } else {
                    "t.analysis_state <> 1".to_string()
                }
            }
        };
        clauses.push(if *neg { format!("NOT ({clause})") } else { clause });
    }
    if !fts.is_empty() {
        params.insert(0, Value::Text(fts.join(" AND ")));
        clauses.insert(0, "t.id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)".to_string());
    }
    let wh = if clauses.is_empty() { "1".to_string() } else { clauses.join(" AND ") };
    let order = match q.sort {
        None => "t.artist COLLATE NOCASE, t.title COLLATE NOCASE".to_string(),
        Some((k, desc)) => {
            let dir = if desc { "DESC" } else { "ASC" };
            let col = match k {
                SortKey::Artist => "t.artist COLLATE NOCASE",
                SortKey::Title => "t.title COLLATE NOCASE",
                SortKey::Album => "t.album COLLATE NOCASE",
                SortKey::Genre => "t.genre COLLATE NOCASE",
                SortKey::Bpm => "COALESCE(t.bpm, t.tag_bpm)",
                // Camelot order: 1A, 1B, 2A … so neighbours sit together.
                SortKey::Key => "t.key_order",
                SortKey::Energy => "t.energy",
                SortKey::Rating => "t.rating",
                SortKey::Added => "t.added_at",
                SortKey::Played => "t.last_played",
                SortKey::Plays => "t.play_count",
                SortKey::Duration => "t.duration",
                SortKey::Year => "t.year",
                SortKey::Random => return (wh, params, "random()".to_string()),
            };
            format!("{col} {dir}, t.artist COLLATE NOCASE, t.title COLLATE NOCASE")
        }
    };
    (wh, params, order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixit_core::Mode;

    #[test]
    fn parses_the_documented_example() {
        let q = parse("deep house bpm:120-126 key:~8A energy:6+ -genre:techno played:>30d sort:-energy");
        assert_eq!(q.terms[0], (false, Term::Text("deep".into())));
        assert_eq!(q.terms[2], (false, Term::Num(NumField::Bpm, Cmp::Range(120.0, 126.0))));
        assert_eq!(q.terms[3], (false, Term::Key { key: Key::new(9, Mode::Minor), compatible: true }));
        assert_eq!(q.terms[4], (false, Term::Num(NumField::Energy, Cmp::Ge(6.0))));
        assert_eq!(q.terms[5], (true, Term::Field(TextField::Genre, "techno".into())));
        assert_eq!(q.terms[6], (false, Term::Played(TimeFilter::NotWithin(30 * 86_400))));
        assert_eq!(q.sort, Some((SortKey::Energy, true)));
        assert!(q.warnings.is_empty());
    }

    #[test]
    fn quotes_durations_and_warnings() {
        let q = parse("\"daft punk\" artist:\"the chemical brothers\" duration:<6m bpm:zz");
        assert_eq!(q.terms[0], (false, Term::Phrase("daft punk".into())));
        assert_eq!(q.terms[1], (false, Term::Field(TextField::Artist, "the chemical brothers".into())));
        assert_eq!(q.terms[2], (false, Term::Num(NumField::Duration, Cmp::Lt(360.0))));
        assert_eq!(q.warnings.len(), 1);
    }

    #[test]
    fn compatible_keys_are_the_camelot_neighbours() {
        let ks = compatible_keys(Key::new(9, Mode::Minor)); // 8A
        let names: Vec<String> = ks.iter().map(|k| format!("{}{}", k.camelot().0, k.camelot().1)).collect();
        assert_eq!(ks.len(), 4, "{names:?}");
        for want in ["8A", "7A", "9A", "8B"] {
            assert!(names.contains(&want.to_string()), "{names:?}");
        }
    }

    /// Every term the app's smart playlist rules write is understood (no warnings).
    #[test]
    fn understands_every_rule_the_app_writes() {
        let q = parse(
            "genre:\"deep house\" -artist:nova title:remix album:x label:y -comment:z bpm:120-126 bpm:~124.5 bpm:>=120 \
             bpm:<=128 key:~8A key:8A -key:5A energy:6+ energy:<=4 energy:3-7 rating:4+ rating:3 year:2015-2020 \
             year:>=2018 year:<2010 tag:vocal -tag:\"peak time\" played:never played:<30d played:>30d added:<14d \
             added:>90d sort:-energy",
        );
        assert!(q.warnings.is_empty(), "{:?}", q.warnings);
        assert_eq!(q.terms.len(), 28);
        assert_eq!(q.sort, Some((SortKey::Energy, true)));
        assert!(q.terms.contains(&(true, Term::Tag("peak time".into()))));
        assert!(q.terms.contains(&(false, Term::Num(NumField::Energy, Cmp::Le(4.0)))));
        assert!(q.terms.contains(&(false, Term::Played(TimeFilter::NotWithin(30 * 86_400)))));
    }
}
