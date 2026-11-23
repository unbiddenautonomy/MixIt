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
- A safety loop: if the only track playing reaches its end with nothing mixed in, its last bars loop on the beat so the music never stops.
- Instant doubles (copy a playing track to another deck, in time) and fader start (a channel fader starts and stops its deck).
- A now playing text file for streams (OBS and the like), with your own format.
- A set clock: choose your set length or end time, watch it count down, and get warned before a track runs past the end.
- 17 beat-synced effects per deck (echo, ping-pong, reverb, filter LFO, flanger, phaser, chorus, gater, slicer, beat repeat, bitcrusher, distortion, tape stop, pitch delay, ring modulator, noise riser, dub echo).
- Auto DJ eases the tempo back to each new track's own speed after a mix, too slowly to notice, so a set is not stuck at its first track's tempo.
- Auto DJ loops the last bars of a track that ends too soon after its mix-out point, so every mix gets its full length.
- An Auto DJ queue that grades every change (smooth, needs care, rough) with the reason, puts itself in the order that mixes best, and fills a rough change with a library track that fits both sides.
- Hear a mix first: any change in the Auto DJ queue, the next one while Auto DJ plays, or a suggested next track, rendered just as it will be mixed and played in your headphones, or the whole queue one change after another (Rehearse the set), so you can check a set before the audience hears it.
- **Mix it:** one button runs a whole transition (blend, bass swap, filter fade, echo out, cut, brake) on the beat, the way a DJ's hands would.
- The same effects on the master, for a reverb wash or echo over the whole mix.
- Eight sampler pads (Shift+1 to Shift+8) with a built-in synthesised kit (air horn, siren, riser, impact, drum and hi-hat loops and more), any audio file, a library track, or a loop captured from a deck. Pads play once, while held or as tempo-locked loops.
- Recording to WAV, with live loudness (LUFS) and limiter metering.

**Understand your music**
- Analysis of tempo and beatgrid (including drifting live recordings), downbeats, key (with confidence and an alternative), tuning, loudness and true peak, energy over time, song sections (intro, build, drop, breakdown, outro) and suggested mix-in and mix-out points.
- Ranked next-track suggestions with plain-language reasons: tempo, Camelot key compatibility (with key shifts that make a track fit), energy direction, genre, sound and what you played next in past sets.
- Vocal detection: where each track has singing or rapping, shown on the decks, searchable (`vocals:no` for instrumentals) and used by the coach to warn when two voices clash, and by Mix it and Auto DJ to start a transition between sung lines instead of cutting one off.
- "Sounds like": a sound profile from analysis (tone colour, brightness, bass/mid/high balance, punch, kick, snare and hat density, groove) finds the tracks that sound most alike, whatever their tempo or key; `like:42` in a search or smart playlist does the same.
- A coach that explains what is happening while you mix and offers one-click fixes, explain mode on every control, and Easy and Pro views.

**Organise**
- SQLite library with folder scanning, a search language (`bpm:120-128 key:~8A energy:6+ -genre:trance played:never tag:"peak time" sort:-energy`), smart playlists built from rules, folders, ratings, colours and your own tags.
- Past sets: every session's tracklist, renamed, saved as a playlist or copied as text.
- Choose, resize and sort the columns; preview a track in your headphones in time with the decks.
- Album art on the decks, in the inspector and in the track list, and a collection overview (tempos, keys on the Camelot wheel, energy, genres, plays) with notes on gaps.
- Playlist tools: move between folders, duplicate, shuffle, take out repeats and missing files, and copy a set's music to a USB stick with a playlist beside it.
- Undo and redo for library changes (Ctrl+Z in the Library).
- Daily library backups with one-click restore.
- Brings your library from other DJ apps with cues, loops, beat grids and playlists: rekordbox (XML), Traktor (collection.nml), Serato (the _Serato_ folder and the cues in your files) and VirtualDJ (database.xml). Exports for rekordbox and Traktor, writes cues into files for Serato, and M3U both ways.
- Duplicate detection, relocation of moved files, and writing details into the files' tags.
- Tidy details: titles and artists from file names, stray spaces, web clutter, one way to write "feat.", SHOUTING names and one spelling per genre, each change shown first and undoable.

**Arrange and render**
- Build a set: pick a length and an energy shape (warm-up, build to the peak, peak time, journey, cool-down) and MixIt chooses the tracks from your collection, a playlist or a search, every change mixable, with the singing as you like it (any, never three singers in a row, or instrumentals only).
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
