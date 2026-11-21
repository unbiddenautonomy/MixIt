# MixIt

A desktop app for DJ mixing, arranging and editing, built so a beginner makes a good-sounding mix in the first minute and a pro can trust it for a full set.

- **Engine:** Rust, real-time safe, sample-accurate. The same code plays live and renders offline.
- **Shell:** Tauri 2 (Windows, macOS, Linux).
- **UI:** React 19, TypeScript and Tailwind, canvas-drawn waveforms and meters.
- **Web-ready core:** the engine, DSP, analysis and project crates also compile to WebAssembly for a later web app.

## What it does

**Play and mix**
- Two or four decks with beat-accurate sync, tempo master, key lock (Signalsmith Stretch), key shift and one-click "match key".
- Three-band EQ with kills and isolator mode, DJ filter, gain, auto-gain from measured loudness, crossfader curves, master limiter, headphone cue and split cue.
- Hot cues, beat-quantised loops, loop roll, beat jump, slip mode, reverse, brake and spin-up, censor.
- 17 beat-synced effects per deck (echo, ping-pong, reverb, filter LFO, flanger, phaser, chorus, gater, slicer, beat repeat, bitcrusher, distortion, tape stop, pitch delay, ring modulator, noise riser, dub echo).
- **Mix it:** one button runs a whole transition (blend, bass swap, filter fade, echo out, cut, brake) on the beat, the way a DJ's hands would.
- Recording to WAV, with live loudness (LUFS) and limiter metering.

**Understand your music**
- Analysis of tempo and beatgrid (including drifting live recordings), downbeats, key (with confidence and an alternative), tuning, loudness and true peak, energy over time, song sections (intro, build, drop, breakdown, outro) and suggested mix-in and mix-out points.
- Ranked next-track suggestions with plain-language reasons: tempo, Camelot key compatibility (with key shifts that make a track fit), energy direction and genre.
- A coach that explains what is happening while you mix and offers one-click fixes, explain mode on every control, and Easy and Pro views.

**Organise**
- SQLite library with folder scanning, a search language (`bpm:120-128 key:~8A energy:6+ -genre:trance played:never sort:-energy`), smart playlists, folders, ratings, colours, history and tracklists.
- rekordbox XML import and export, M3U import and export, duplicate detection and relocation of moved files.

**Arrange and render**
- Automix turns a playlist into a finished mix project: smooth order for keys and energy, phrase-aligned transitions, tempo ramps and key matching.
- A timeline of clips over the tempo map with automation, then render to WAV or FLAC.

**Command line:** `mixit` does analysis, library management, suggestions, automix, rendering, time-stretching, conversion and playback from the terminal (`mixit --help`).

## Repository

| Path | What |
| --- | --- |
| `crates/mixit-core` | Time, tempo maps, beatgrids, keys, parameters and the action registry (wasm) |
| `crates/mixit-dsp` | Real-time DSP: filters, DJ EQ, crossfader curves, effects, dynamics, meters (wasm) |
| `crates/mixit-engine` | The real-time DJ engine: decks, sync, mixer, effects, sampler, action dispatcher (wasm) |
| `crates/mixit-analysis` | Tempo, beatgrid, key, loudness, waveforms, sections, cue suggestions (wasm) |
| `crates/mixit-generator` | Practice tracks with exact ground truth, used by the tests (wasm) |
| `crates/mixit-project` | Mix projects, transitions, automix, undo (wasm) |
| `crates/mixit-stretch` | Key lock and key shift with Signalsmith Stretch |
| `crates/mixit-io` | Decoding, resampling, hashing, decode cache, tags, export |
| `crates/mixit-library` | The music library and suggestions |
| `crates/mixit-host` | Audio devices (cpal), virtual output, recorder, offline and project rendering |
| `crates/mixit-cli` | The `mixit` command |
| `apps/desktop` | The desktop app: React UI (`src/`) and the Tauri backend (`src-tauri/`) |

## Build and run

Requirements: Rust (stable, 1.85+), Node 22, and on Linux `libasound2-dev` plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (`libwebkit2gtk-4.1-dev` and friends).

```sh
# Engine, library and command line tool
cargo test
cargo run --release -p mixit-cli -- --help

# Desktop app (development, hot reload)
cd apps/desktop
npm install
npm run tauri dev

# The UI alone in a browser, on a simulated engine and a demo library
npm run dev        # http://localhost:5173

# Release build of the app
npm run tauri build
```

When no audio device can be opened the app runs on a silent virtual output, so it still starts (and says so in the top bar).

See `CLAUDE.md` for development conventions.
