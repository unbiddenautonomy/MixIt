# Working on MixIt

## Commands

```sh
cargo fmt --all
cargo clippy --all-targets -- -D warnings      # default members (everything but the desktop app)
cargo test                                     # default members
cargo clippy -p mixit-desktop --all-targets -- -D warnings   # needs the webview toolchain
cargo build --target wasm32-unknown-unknown -p mixit-core -p mixit-dsp -p mixit-engine -p mixit-analysis -p mixit-generator -p mixit-project

cd apps/desktop
npm run typecheck && npm test && npm run build
npm run dev          # UI in a browser on the demo backend
npm run tauri dev    # the real app
```

On small machines build the desktop crate with `-j 2`; linking it with full parallelism can run out of memory.

## Architecture

- **The audio thread never allocates, locks or blocks.** The UI talks to the engine through `Controller` (a lock-free command ring); the engine reports back through `Telemetry` (a copyable snapshot) and an event ring. Anything that allocates (stretchers, decoded tracks, grids) is built off the audio thread and sent in; old objects go back through the trash ring to be dropped elsewhere.
- **One action registry** (`mixit-core::actions`) names every control (`deck.A.play`, `mixer.B.eq.low`, `fx.A.1.mix`). Keyboard shortcuts, the command palette, explain mode, tooltips and (later) MIDI mapping all come from it. `mixit-engine::actions::ActionDispatcher` turns an action and input into engine commands; `app.*` actions and a few deck actions (`key_sync`, `grid.*`) are handled by the app.
- **wasm-safe crates** (core, dsp, engine, analysis, generator, project) must not use threads, files or system audio. Native-only code lives in io, library, host, stretch, cli and the desktop app.
- **Desktop app:** `src-tauri/src/commands.rs` exposes the backend; `telemetry.rs` streams engine state to the UI at display rate and writes recordings; DTOs in `dto.rs` are camelCase and mirrored in `src/backend/types.ts`.
- **UI:** every call goes through the `Backend` interface (`src/backend/index.ts`). In a plain browser the `DemoBackend` simulates the engine and library, so UI work and screenshots need no Rust build. Keep it in step when you add a command.
- **UI state:** zustand stores. Canvas loops (waveforms, meters) read `useTelemetry.getState()` every frame instead of re-rendering React. Selectors must return primitives or stable references (zustand 5 re-renders forever on a new array each time).
- **Controls** go through `act`/`press`/`setValue` in `src/lib/actions.ts`, which also mirror mixer and FX values into the store (the engine does not report them back).

## Conventions

- Tests generate their audio with `mixit-generator`, so every claim (BPM, key, beat positions, section boundaries) is checked against exact ground truth.
- User-facing text is plain language for someone who has never DJed: say what a control does, not its jargon.
- Easy view shows the essentials; Pro shows everything. Never lock a feature behind Pro, only hide it.
- Commit messages: imperative subject, a body that says what and why.
