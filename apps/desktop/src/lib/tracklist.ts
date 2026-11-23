// The tracklist of a recorded mix: which tracks were heard and from when, worked out from
// the frames captured while recording. Written as plain text (for a description on a mix
// site) and as a CUE sheet, which media players and mix sites read to show and skip
// between the tracks of one long recording.
import type { Capture } from "./capture";
import { fileName } from "./platform";

export interface TracklistEntry {
  /** Seconds into the recording when the track became clearly audible. */
  at: number;
  title: string;
  artist: string;
  /** Seconds it was heard. */
  heard: number;
}

/** A deck counts as heard while it plays with its volume (crossfader included) at least this high. */
const AUDIBLE = 0.5;

export function tracklistFromCapture(cap: Capture, minSeconds = 20): TracklistEntry[] {
  const seen = new Map<number, TracklistEntry>();
  const frames = cap.frames;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const dt = i + 1 < frames.length ? Math.min(1, frames[i + 1].t - f.t) : 0;
    for (const d of f.decks) {
      if (!d || !d.playing || d.volume < AUDIBLE) continue;
      const ref = cap.tracks[d.token];
      if (!ref) continue;
      const e = seen.get(d.token);
      if (e) e.heard += dt;
      else seen.set(d.token, { at: f.t, title: ref.title, artist: ref.artist, heard: dt });
    }
  }
  const all = [...seen.values()].sort((a, b) => a.at - b.at);
  const kept = all.filter((e) => e.heard >= minSeconds);
  const out = kept.length ? kept : all.slice(0, 1);
  // The first track starts the recording, even if it was faded in a moment later.
  if (out[0] && out[0].at < 10) out[0] = { ...out[0], at: 0 };
  return out;
}

/** 0:00, 4:05, 1:02:03. */
export function timestamp(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function tracklistText(entries: TracklistEntry[]): string {
  return entries.map((e, i) => `${String(i + 1).padStart(2, "0")}. [${timestamp(e.at)}] ${e.artist ? `${e.artist} - ` : ""}${e.title}`).join("\n") + "\n";
}

/** CUE times are minutes:seconds:frames, 75 frames a second, minutes not wrapping at an hour. */
function cueTime(s: number): string {
  const frames = Math.max(0, Math.round(s * 75));
  const m = Math.floor(frames / (75 * 60));
  const sec = Math.floor(frames / 75) % 60;
  const f = frames % 75;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(m)}:${p(sec)}:${p(f)}`;
}

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

export function cueSheet(entries: TracklistEntry[], audioFile: string, title: string, performer = "MixIt"): string {
  const name = fileName(audioFile) || audioFile;
  const type = /\.mp3$/i.test(name) ? "MP3" : "WAVE";
  const lines = [`PERFORMER ${quote(performer)}`, `TITLE ${quote(title)}`, `FILE ${quote(name)} ${type}`];
  entries.forEach((e, i) => {
    lines.push(`  TRACK ${String(i + 1).padStart(2, "0")} AUDIO`, `    TITLE ${quote(e.title)}`);
    if (e.artist) lines.push(`    PERFORMER ${quote(e.artist)}`);
    lines.push(`    INDEX 01 ${cueTime(e.at)}`);
  });
  return lines.join("\r\n") + "\r\n";
}

/** The recording's path without its extension, for the files written beside it. */
export function stemOf(path: string): string {
  return path.replace(/\.[^./\\]+$/, "");
}
