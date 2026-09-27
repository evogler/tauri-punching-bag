# Microtime

(The repo, and the internal names listed under *macOS packaging*, are still
`tauri-punching-bag` -- see *The rename to Microtime*.)

A practice tool for drummers/musicians: a metronome with programmable rhythms, a
looper, and a real-time waveform display you play *against*. Tauri v2 app —
React/TypeScript frontend, Rust + CoreAudio backend. macOS, and iOS/iPadOS
(step 4 of the port: builds and runs in the simulator, not yet on a device).
Core Audio directly, not `cpal`.

**`docs/design-notes.md` is the full record** -- every decision, what was tried
first, what was measured. This file is the working summary; *Italic names* below
are section headings there. Other long versions: `docs/presets.md`,
`docs/calibration.md`, `docs/onsets.md`, `docs/pane-layout.md`,
`docs/drum-grid.md`, `docs/approachability.md`.
**`docs/ios-port.md` is the current plan of work** -- read it before touching the
audio layer, the Tauri config or the build.

## Commands

```
yarn dev            # tauri dev
yarn tauri build    # ALWAYS run this after a change
yarn start          # browser-only, fakes samples; no Rust backend
npx tsc --noEmit    # typecheck
yarn build:parser   # regenerate parser2.js from parser2.peg

# iOS (needs xcodegen + libimobiledevice from arm64 brew, and Rust targets
# aarch64-apple-ios / aarch64-apple-ios-sim)
yarn tauri ios dev "iPhone 16 Pro"            # simulator (device: `ios run`, or `ios dev --host`)
yarn tauri ios run                           # on a plugged-in device, bundled frontend
yarn tauri ios build --target aarch64-sim --debug   # sim .app in the xcarchive
yarn tauri ios build --target aarch64 --debug       # device .ipa
```

- **Run `yarn tauri build` after every change** (owner's explicit request). It
  compiles Rust **twice** (it is a universal build: arm64 + x86_64, ~17s
  each warm) and then waits on two notarizations -- ~2 min in all. The two
  expected warnings (`unused import: std::time::Instant`, `method hop_frames
  is never used`) therefore appear twice each.
- `yarn tauri` runs `scripts/tauri.mjs`: forwards args (adding `--target
  universal-apple-darwin` to a `build` that names no target), frees/refuses a
  mounted `/Volumes/Microtime` before building, sweeps stale `.dmg`s and
  updater tarballs/`.sig`s (by time) after a successful build, notarizes +
  staples the DMG, writes `latest.json` with both `darwin-aarch64` and
  `darwin-x86_64` pointing at the one universal tarball. Artifacts are under
  `src-tauri/target/universal-apple-darwin/release/bundle/`.
- **If it fails with `error running bundle_dmg.sh`, don't re-run.** Run
  `node_modules/.bin/tauri build --verbose` for the real error. Two causes: a
  mounted volume of the same name (`lsof +D /Volumes/...` names the holder), or
  `could not access /Volumes/.../Microtime.app - Operation not
  permitted`, which is TCC -- grant **App Management** to the terminal in System
  Settings. Don't chase LaunchServices. See *The disk image step*.
- **iOS builds**: `yarn tauri ios build` fails at the end with `failed to rename
  app ... Directory not empty` when `gen/apple/build/arm64*` is left from the
  last one -- `rm -rf src-tauri/gen/apple/build` first (the fresh app is in
  `build/app_iOS.xcarchive` anyway). Rust's `println!` shows in the unified
  log, not the console: `xcrun simctl spawn booted log show --last 2m
  --predicate 'process == "Microtime" AND eventMessage CONTAINS
  "[stdout]"'`. `gen/apple` is committed (Tauri's convention); `build/`,
  `Externals/` and `assets/` inside it are not. `scripts/tauri.mjs` only
  sweeps/notarizes after `build`, never `ios ...`.

## Architecture

Two channels between the halves:

- **Config push (JS → Rust).** Every setting change calls `set_config` with the
  whole config. Rust holds it in a mutex; the audio callback reads it every
  callback.
- **Sample poll (Rust → JS).** The callback appends to a shared buffer; the
  frontend polls `get_samples` at 100 Hz and draws.

`beat: f64` in the callback is the master clock -- advances by
`beats_per_sample` per frame, never wraps (except a practice-cycle restart).
Click, drums, display, looper and file position all derive from it. **Keep it
f64** (f32 causes ghost trails after ~20 min).

### Rust side (`src-tauri/src`)

| File | Role |
|---|---|
| `lib.rs` | `run()`: prefs, devices, kit, shared state, the `AudioHost`, Tauri. A library so iOS can link it; `main.rs` is one line over it. Menu, updater and global shortcut are `#[cfg(desktop)]`. |
| `audio_host.rs` | **What is running, and restarting it in-process** (device, input count, rate). The supervisor thread that turns platform `Hint`s into restarts -- and on iOS into suspend/resume. |
| `engine.rs` | **The audio core.** `Engine::process(input, [left, right])`: an interleaved input block in, two output slices filled. All real-time logic; knows no device. |
| `platform/mod.rs` | The backend surface both platforms provide, and `Hint`. |
| `platform/macos/` | `devices.rs`: discovery, formats, rate. `mod.rs`: the input queues, the input callback, the render callback that feeds the engine. |
| `platform/ios/` | `mod.rs`: the session snapshot as the "device", `DeviceChoice` = route + rate + inputs, latency seed, warnings. `remote_io.rs`: the RemoteIO unit on raw `coreaudio-sys`, one callback that pulls input and runs the engine. |
| `plugins/audio-session/` | Tauri plugin: `ios/Sources/AudioSessionPlugin.swift` configures `AVAudioSession` and forwards its notifications over a `Channel`; `src/lib.rs` is the Rust wrapper. Swift never touches a unit. |
| `structs.rs` | Config, shared state, `DrumVoice`, `VisualSamples`, `BusDelay`. |
| `commands.rs` | Tauri commands (`set_config`, `get_samples`, `load_drum_sample`, …). |
| `constants.rs` | `DEFAULT_SAMPLE_RATE` (fallback only), backlog caps (fns of a rate), `default_config()`. |
| `util.rs` | `beat_bisect`, `mod_add`, section/record-cycle bounds. |
| `analysis.rs` | STFT for spectrogram, spectral flux, onset picker. |
| `filter.rs` | Input high pass. |
| `calibration.rs` | Round-trip latency measurement. |
| `bleed.rs` | Speaker-bleed canceller. `loop_guard.rs`: looper feedback guard. |
| `stretch.rs` | WSOLA time stretch for the file player, rendered off-thread. |
| `recorder.rs` | WAV recording via a writer thread. |
| `prefs.rs` | `audio-prefs.json`: device choice + per-pair latency. Not config. |
| `applog.rs` | The log file (`microtime.log`), the panic hook, and `fatal` -- the alert + exit for a launch failure. |
| `presets.rs` | `presets.json` IO only -- moves text, knows nothing of presets. |

`src-tauri/examples/onsets.rs` runs the real `Analyzer` over a WAV
(`cargo run --release --example onsets -- analyze take.wav`); not built by
`yarn tauri build`.

### Frontend (`src`)

| File | Role |
|---|---|
| `App.tsx` | State, config plumbing, the whole canvas draw path. Large. |
| `TopBar.tsx` | Transport, tempo, looper switch, beat readout -- outside the panel. |
| `panel/` | Settings panel: `Panel.tsx`, one file per tab, `chrome.tsx` (`Section`/`Divider`/`Group`/`TabBar`/`TabPanel`), `types.ts` (the one `PanelProps` bundle). |
| `config.ts` | `defaultRustConfig` / `defaultJsConfig` / `defaultViewConfig`, helpers (`rowColorFor`, `drumGains`, `chipLabel`, kit). |
| `layout.ts` | `getCanvasPositions`, `rowBox`, `rowPlacement` -- pure geometry. |
| `paneLayout.ts` / `PaneMap.tsx` | Pane placement (pure) and its UI. |
| `expression.ts` | Parameter expression language, `parseNumberList` / `formatNumberList`. Pure. |
| `Input.tsx` | Generic config inputs (+ `Switch`, `Resolved`, `labelStyle`). |
| `ParameterList.tsx`, `GridList.tsx`, `ChannelList.tsx`, `DrumList.tsx`, `RowColorList.tsx`, `SpectrogramControls.tsx`, `Slider.tsx`, `RhythmStrip.tsx`, `RowPerNote.tsx` | Panel widgets. |
| `presets.ts` | Presets, the auto-restored session, migrations. |
| `examples.json` / `examples.ts` / `ExampleBar.tsx` | Built-in read-only example presets. |
| `help.tsx` / `helpText.ts` | Help area mechanism / all help text (keyed by config key or dotted id). |
| `theme.ts` + `index.css` | Colour tokens and control styling. |
| `SetupWizard.tsx`, `GlobalShortcut.tsx`, `Updater.tsx`, `LogFile.tsx` | First-launch setup, global pause key, manual update check, *Reveal log file*. |
| `platform.ts` / `IosRoute.tsx` | `isIOS()` (asked of Rust before first render; an iPad's user agent says Mac) / the iOS route panel shown instead of the device picker. |
| `parser2.js` | **Generated** from `parser2.peg` -- don't hand-edit. `parser1.js` is legacy with no source. |

## Config system -- sharp edges

- **Three homes by where it's needed**: `defaultRustConfig` (audio),
  `defaultJsConfig` (display, global), `defaultViewConfig` (per pane, in
  `views[i]`). `get`/`set` route by the first two; a key in the wrong one
  silently does nothing. View keys are reached only through `viewSetGet(i)`.
- **`snakeCaseKeys` is top-level only** -- a nested Rust struct field must be a
  single lowercase word (hence `DrumVoice.offset`, not `offset_ms`).
- **`unwrapValues` is recursive**: `{inputText, val}` fields reach Rust as `val`.
- **Never reuse a key name with new semantics or default.** Restore merges saved
  values over defaults, so old sessions win. Rename instead (`loopFeedback` →
  `loopEchoGain`); unknown keys are dropped. Shape changes must be migrated
  (`normalizeView`, `migrateRust`, `migrateViews`); changing a *default* may
  need migrating exactly-the-old-value (`onsetThreshold`, `onsetOffset`,
  chrome colours).
- **Session restore and preset load both merge over the *defaults***, never
  over the current config.
- **Transient/machine keys**: `paused` is excluded from presets and session.
  `LOCAL_RUST_KEYS` (`bufferCompensation`) is excluded *and* carried across
  preset loads (`KEPT_RUST_KEYS`, spread last) -- otherwise a preset clobbers
  the measured latency in `audio-prefs.json`.
- **The frontend pushes `set_config` once on mount, always.** Rust is silent
  (`ConfigReady` gate, treated exactly like pause) until it arrives. The first
  push waits (bounded by `FIRST_PUSH_WAIT_MS`) for drum samples to load.
- **`resolveConfigs` is the only way to resolve config** (both halves together;
  startup, `setParameters`, `loadPreset`). Rust-side expression keys must be
  re-resolved *and* pushed, since nothing on the JS side re-reads them.
- **A nested field may take an expression only after it is in
  `resolveRustConfig`'s / `resolveView`'s walk** -- add to the walk first, then
  change the syntax. Drum `offset`/`shift` are still literals for this reason.
- **The `react-hooks` eslint plugin isn't loaded** -- an
  `eslint-disable-next-line react-hooks/exhaustive-deps` comment is a build
  error. Don't add one.
- **Never write config from an effect unless it is a guarded fixed point**
  (`packedChannels` union, `applyDrumGrids` returning the same array).

## Parameters and expressions

`parameters: {name, value, inputText?}[]` -- named numbers or lists, usable in
expression fields (`bar/n x n`, `{n/bar}:1`). `expression.ts` is the language:
numbers, names, `+ - * / ( )`, `min`/`max`/`round`, `[...]x n` group repeats,
`choose`/`range` rolls. Every entry point **throws**; callers keep the last good
value (red field, still playing).

- Expression fields are stored `{inputText, val}`. Read them through
  `exprNumber` / `exprList` / `viewRowBeats`, never directly. Rust-side list:
  `RustExprKey` / `RUST_EXPR_FIELDS` / `RUST_EXPR_KEYS` -- register all three.
- `resolveJsConfig` re-resolves in the *same* update as a parameter change, not
  in an effect.
- Parameters may reference each other as a DAG (`resolveParameters`); cycles are
  rejected at the editor. A failed parameter contributes nothing.
- Rolls (`choose`/`range`) are **sticky**: stored `value` is the value; only
  rolled on explicit reroll (⌘R, section-cycle wrap, text commit). They throw
  outside a parameter.
- Reserved names: `x`, `x<digits>`, `min`, `max`, `round`, `choose`, `range`,
  and sound letters `h k r s`.
- Rhythm text takes bare parameter names (substituted before parsing); braces
  resolve first.
- Validators failing = syntax error. Especially `bpm` (0 → infinite loop size).

## Rhythm syntax (parser2)

| Written | Means |
|---|---|
| `4` | one note, span of 4 beats |
| `2:1` | 2 evenly spaced notes across 1 beat |
| `1/5` | one note, span 0.2 -- the grammar does arithmetic |
| `[2:1, 1]:1` | group; entries share the span after `]` |
| `[k 1, h 1]:1` | sounds: letter then weight (parsed, **read by nothing**) |
| `[h 1>-.1]:1` | `>` nudges that note's time |
| `1 r, 1` | trailing `r` = rest (takes its beat, removed by the grammar) |
| `[k 1, h 1]x4` / `x4:1` | repeat the group / repeat then squish into 1 beat |

- The rhythm `x` and the number-list `x` are **two different languages**.
- Refused (red, last good kept): zero/non-finite span, repeat < 1, all rests.
- Grammar docs live in `scripts/build-parser.mjs`'s header.

## UI conventions

- **Colours are tokens on `:root` in `src/index.css` only**, accessed via `ui`
  in `theme.ts`. Named by role, not value. Data colours (`channelStyleById`,
  `rowColors`, grid colours, `waveformBackground`, `paneGapColor`) are config,
  not tokens. Contrast bar 4.5:1.
- Controls are styled in `index.css`; text fields are `input:not([type])`,
  monospace, tabular. One type size (14px). Label column is `--label-col`
  (overridden to `auto` in `TopBar`). Booleans that take effect are `Switch`,
  not checkboxes.
- **Width** (*Fitting a phone*): `.panel-shell` in `index.css`, not inline.
  ≥1000px the panel is 600px beside the panes; 700-999 it is 60vw with
  `--label-col` 9em; under 700 it covers the window *over* the panes (kept
  laid out so the ResizeObserver never sees zero), `--label-col` 7.5em.
  Helpers: `.wide-only`/`.narrow-only` and `.key-hint` (phone), and `.lane`
  rows that wrap their `.lane-field` onto its own line below 1000px.
  A new row of several controls around one field should use `.lane`.
- **`TAB_GROUPS` is the source of truth** for the ten rail sections; `PanelTab`
  derives from it. Sections are ⌘⌥1..⌘⌥0 (positional) and ⌘[ / ⌘] -- ⌥, not
  ⇧, because macOS takes ⌘⇧3/4/5 for screenshots. Digits are read from
  `e.code`, since ⌥ changes `e.key`.
- **Parameter scenes** (`parameterScenes`, js config, travel in presets;
  `SceneList.tsx`): snapshots of whole `Parameter`s, recalled by ⌘1..⌘0
  through `setParameters`. `applyScene` matches by name and never adds or
  removes parameters; a roll comes back with its saved value.
- **Inactive tabs, folded `Group`s and drum-lane disclosures are hidden, not
  unmounted** -- half-typed expressions must survive. `Group` needs a `summary`
  stating values; empty says `none`.
- **Help**: attach with `onFocusCapture`, never `onFocus` (`useFocusedValue`
  owns `onFocus`). `Input` finds its own help entry by key. `App` provides it.
- Shortcuts: ⌘P pause, ⌘L loop, ⌘R reroll (bails on shift; ⌘⇧R is menu
  Restart), one listener via a ref. Menu is `Menu::default` + Restart
  (building from scratch drops Edit/copy-paste).
- Global shortcut (off by default, ⌘⌥P, localStorage): Carbon hotkey, no TCC
  grant; a key another app owns still fails silently, so the panel counts
  presses. The handler fires on release too -- act on `Pressed` only.
  Registrations serialised through one promise chain (StrictMode).
- Per-frame DOM readouts (`showFrameTime`, beat readout) write `textContent`
  directly, never through React state.
- localStorage keys: `punching-bag.help-visible`, `-setup-at` (still written;
  a device change no longer relaunches, so setup just continues), `-setup-step`,
  `-setup-done`, `-global-shortcut-on`, `-global-shortcut`,
  `-full-hides-top-bar` (layout → *Hide top bar*: hiding the panel takes the
  top bar too; off by default). The session is
  localStorage; presets are `presets.json`.

## Presets and examples

`presets.json` in the app config dir (see `docs/presets.md`). Versioned array
with `id`, `created`, `lastUsed`; import matches id → content hash → name. Hash
is computed, never stored. Writes are temp-file + rename; a corrupt store is
quarantined (`presets.corrupt-<stamp>.json`), never replaced. File IO goes
through Rust commands. `yarn start` falls back to localStorage on an explicit
`isTauri()` check (`BROWSER_DEBUG_MODE` in `env.ts`; v1's `__TAURI_IPC__` global
no longer exists).

Examples (`src/examples.json`) are preset files plus `description`/`tryThis`,
loaded through `loadPreset`. **Never hand-write one**: build it in the app,
export, then `yarn example:add exported.json`. Ids are stable slugs.

## Audio thread rules

The render callback runs ~21×/s with 2048 frames on macOS; the engine takes
any block up to `MAX_BLOCK_FRAMES` (4096) and is block-size invariant.

- **Never allocate or free** -- per frame or per callback. Resolve rhythm
  vectors, pan gains, sample lookups, tap gains, section bounds once per
  callback into vectors kept on the `Engine` (a `collect` per callback is still
  the allocator). **Size for `MAX_BLOCK_FRAMES`, never the typical block.** Display buffers are swapped for pre-sized ones
  (`DrainSizes`, `MAX_VISUAL_BACKLOG`); anything heavy (stretch, WAV writing,
  correlation, dropping big buffers) happens off-thread or outside the lock.
- The callback holds the display mutexes for its whole run; command-side work
  under them must be O(1) swaps. Lock order: config, then file.
- **Real-time logic goes in `engine.rs`; only queueing and device specifics in
  a backend.** `process` splits any block past `MAX_BLOCK_FRAMES` itself
  (bit-identical; temp-tested). iOS calls it from the one RemoteIO callback,
  after pulling input with `AudioUnitRender` into a buffer sized for
  `MAX_BLOCK_FRAMES` -- no queue there. At a 256-frame IO buffer the
  per-callback costs run ~190×/s, ~9× the Mac's.
- **Per-frame vs per-output-channel**: the output loop runs twice per frame.
  Anything advancing time (input pops, loop buffer, beat, triggers, display
  pushes) goes outside it.
- `buffer_compensation` is in **frames** (default 4330). Don't change units.
- No Tauri events from the callback -- signal through the sample stream
  (e.g. `VisualSamples::cycle`) or atomics.
- Guards that must stay: `beat_bisect` falls back on a non-finite/non-positive
  span; `mod_add` with `max == 0`; loop buffer clamped to `MAX_LOOP_FRAMES`.

## Input, devices, sample rate

- **The sample rate is the input device's**; AUHAL won't convert input and
  returns silent zeroes on mismatch. **It is engine state, not a global**: it
  lives in `AudioStatus` (with the active devices and input count), written only
  by `audio_host.rs` while the units are stopped *and the config lock is held*.
  Everything that needs it takes it as an argument (`to_device_stereo`,
  `wsola`, `desired_ratio`, `get_loop_spacing`, calibration, recorder); the
  engine has its own copy. Command-side readers: size engine-used state under
  the config lock (`set_config`), load/start things under `AudioHost::gate`
  (drum samples, the file, recording, calibration, bleed run).
- Input is interleaved, output non-interleaved (required for multichannel in).
- The macOS input queues (`make_queues`) are one `Arc` shared by both ends; the
  render callback pops a whole block every callback whatever the engine then
  does with it (pause/calibration included), capped by `max_input_backlog()`.
- Devices are chosen in the panel, stored by UID in `audio-prefs.json`, and
  **applied at once** (`restart_audio`): the audio restarts in-process -- open
  new units, prepare at the new rate while the old engine plays, stop, swap,
  start seeded from `engine::Carry` (beat, click `last_beat`, cycle,
  `loop_written`). ~100-200 ms. Loop buffer cleared on a rate or channel-count
  change; drums re-converted from their decoded source, the file re-decoded
  from its path -- **never convert a conversion**. Calibration cancelled,
  bleed measurement lost, a recording kept only if rate and width match.
  "System default" follows macOS (listeners on the device list, both defaults
  and the input's rate -- **listeners only send a hint**; the supervisor
  debounces and restarts). Missing / wrong-role / won't-open devices fall back
  to the default with the reason in red, at launch and on restart alike. Launch
  setup failures print device, role, error and prefs path, then exit. See
  *Restarting the audio in-process*.
- `pairCompensations: {inUid: {outUid: frames}}` in the same file; applied once
  **per pair** (stored value, else the default -- never the last pair's),
  written back on change only after the applied figure has landed.
- Channels have fixed ids (see *Channels and streams*), so a device switch
  renumbers nothing. An input the new device lacks stays in every pane's
  config, draws nothing, and is listed as "not connected".
- Frontend never sees frames: streams are stamped in beats.
- **iOS** (*The iOS backend*): no picker -- the session's route is the device.
  Swift sets `playAndRecord` / `measurement` / `defaultToSpeaker` +
  `allowBluetoothA2DP` (never HFP), asks 48 kHz and 256 frames, activates, and
  forwards route changes, interruptions, becoming active and media-services
  resets; every event carries a session snapshot. **Route change = restart**
  (ports, rate or inputs differ). **Interruption = suspend/resume the same
  unit and engine** (bleed filter kept); a route change while suspended waits
  for the resume. RemoteIO is opened only after the old unit stops, so a
  failed open is silence + `audio-restart-failed` until the next hint. Launch
  is a restart from nothing on a thread after `start_session` (off the main
  thread: the mic prompt needs it). Pairs are keyed `portType:uid`; an
  unmeasured pair starts at the session's in + out latency + 2 IO buffers
  (`suggestedCompensation`). Bluetooth/AirPlay output and a refused mic warn
  at the top of the panel. `UIBackgroundModes: audio` (in `Info.ios.plist`)
  keeps the click going with the screen locked.

## Channels and streams

```
[ ch 1 … ch N ]            [ drums ]  [ click ]  [ file ]
  inputs: id 0 … N-1         1000       1001       1002
```

- **Channel ids are fixed** (*Stable channel identities*): input k is `k` on
  every device, the buses are `BUS_DRUMS`/`BUS_CLICK`/`BUS_FILE` in both
  `config.ts` and `constants.rs` (keep them equal). Only inputs pan
  (`channelPans`, an array by input index); `spectrogramChannel` is an input
  index too.
- Keys holding ids: `views[i].channelIds`, `channelStyleById` /
  `channelGainById` (sparse maps by id), rust `packedChannels`. They were
  **renamed** from `channels` / `channelStyles` / `channelGains` /
  `visibleChannels`, whose numbers put the buses after the inputs; the old
  keys are migrated in `presets.ts` (`migrateChannelKeys`, `normalizeView`)
  against `getLegacyInputCount()` -- the device running when first read, set
  in `index.tsx` before the first render. A preset store with old keys is
  rewritten once after loading (not if an entry was skipped).
- An input the device lacks is **kept** in config, never pushed
  (`packedChannelIds` filters it), has no style in the draw path, and shows
  as "not connected" (`channelInfos`). It keeps its place in `splitChannels`.
  Rust packs any id it can't supply as 0, so a push racing a restart can't
  shift a slot.
- Sample stream is flattened `{channels, beats, values}` in `packedChannels`
  order; `streamSlots[id]` translates. `packedChannels` is derived from the
  panes and the input count, pushed from a guarded effect.
- Samples are stamped `visual_beat = beat - buffer_compensation *
  beats_per_sample`; `BusDelay` delays the synthetic buses to match.
- The analysis stream (spectrogram bytes, flux, onsets) is separate, device
  order, max 4 input channels, stamped at the window centre. Hop = window/4.

## Features, in brief

Each has a full section in `docs/design-notes.md`.

- **Looper**: multi-tap delay, one buffer per input, `loop_echoes` taps with
  compounding `loop_echo_gain` (gain 0 silences echoes after the first -- check
  this first when echoes "do nothing"). `loop_written` voids pre-restart audio.
  Record cycles gate the *write* with silence, asked of the visual beat, list
  starts silent.
- **Practice cycle** (`sections`, `sectionsOn`, `sectionOrder`): at the wrap
  `beat = 0`, file/analyzer reset, frontend rerolls. Everything including
  `display_start` is gated on `sectionsOn`. Drum voices are gated on the section
  the hit *sounds* in. `sections[].drums` indexes voices and is **not**
  re-indexed on voice delete (known bug).
- **Drums**: `shift` (beats, musical) vs `offset` (ms, look-ahead trigger).
  `gains`/`chances` indexed by hit count with `rem_euclid`. A lost roll keeps
  its slot. Kit in `samples/kit.json`; ids are never renamed. Drum grid
  (`drumGrids`) compiles to ordinary rhythm/gains/chances; unchecked = chance 0.
- **File player**: read position derived from `beat` (`fileBeats` > 0
  phase-locks; 0 free-runs). `fileStretch` renders WSOLA off-thread with a
  `generation` counter. `filePath` is pushed whenever it changes; empty clears.
- **High pass**: per input channel, two one-pole complements with `POLE_SCALE`;
  always running. `input_raw` (analyzer) / `input_frame` (picture) /
  `input_audio` (monitor + looper) differ by the filter/canceller switches.
- **Speaker bleed**: measured once (noise probe), frozen, then bounded NLMS
  tracking (`TRACK_GUARD` 10). Reference is the delayed synthetic buses, never
  the monitor. Doesn't persist across restarts.
- **Calibration**: swept sine, matched filter, 5 probes, median; refuses with
  numbers shown; offered, never auto-applied. Does nothing while paused.
- **Onsets**: `onsetThreshold` 0.4, `onsetOffset` -4 ms, `ONSET_CENTRE_BIAS`
  0.32, `analysisWindow` 1024 -- all measured, see *Onsets*.
- **Recorder**: 32-bit float WAV, fixed-capacity double buffer, drops and
  counts on overflow, header rewritten every flush. Not config.

## Display pipeline

- Panes on a CSS grid (`col`/`row`/`colSpan`/`rowSpan`); **`fitViews` is the only
  enforcement of no-overlap** and the only writer of those keys. `copyView`
  deep-copies -- never share arrays between panes.
- Each pane's backing store is measured from its own box (`ResizeObserver` ×
  `devicePixelRatio`, plus a `matchMedia` for ratio changes). Every pane needs
  `minWidth: 0, minHeight: 0`.
- One `requestAnimationFrame` loop in `App` draws all panes, then drains
  samples once.
- Each pane draws into an offscreen layer (sweep, flux, onsets, spectrogram);
  every frame blits it, then paints grids, grid chips and the pane name on top.
  Never paint those into the layer.
- Sweep mode never clears: `drawSweep` flushes once per pixel column;
  eraser and trace share `columnLeft` / `rowBox` / `clipToStrip` and must
  agree exactly -- an unvisited column is never erased.
- `layoutKey` changes → clear canvas + layer and reset draw state **in place**.
- `getCanvasPositions` returns every on-screen copy of a beat (margins,
  `rowColumns` strips, `viewsSequential` chaining).
- `gridWidth` and pane-name size are CSS pixels × pane scale; waveform stroke,
  erase column and onset ticks are surface pixels.

## macOS packaging, signing, updates

- Permissions are `src-tauri/capabilities/main.json` (dialog open/save) and
  `desktop.json` (global shortcut, updater; `platforms` excludes iOS, where
  those plugins aren't compiled): only what the frontend calls.
  Our own commands need none. A new plugin call from JS needs a line there.
- **Named Microtime** (`productName`, `mainBinaryName`, window title, iOS
  `PRODUCT_NAME` + `CFBundleDisplayName`, usage strings, wizard). **Not
  renamed, on purpose**: bundle id `com.vogler.dev` (config dir, TCC grant,
  WebKit data store, updater continuity), the `punching-bag.*` localStorage
  keys, `PRESET_FORMAT` (`"tauri-punching-bag presets"` -- a file format id),
  the GitHub repo / updater endpoint, `~/.tauri/punching-bag.key`, the Cargo
  package `app`. An updated old install keeps its folder name
  (`tauri-punching-bag.app`) with Microtime inside -- the updater swaps the
  bundle's contents in place.
- App config dir is `~/Library/Application Support/com.vogler.dev`
  (`audio-prefs.json`, `presets.json`) -- same as under v1; don't move it.
- `src-tauri/Info.plist` (Mac) and `Info.ios.plist` (merged into
  `gen/apple/app_iOS/Info.plist` by the CLI) carry `NSMicrophoneUsageDescription`;
  `Entitlements.plist` needs `com.apple.security.device.audio-input` (hardened
  runtime). Never add `com.apple.private.tcc.allow-prompting`.
- Signed with `Developer ID Application: Eric Vogler (9KMDH5UH9Z)`, notarized
  and stapled (app and DMG). Credentials `APPLE_ID` / `APPLE_PASSWORD`
  (app-specific) / `APPLE_TEAM_ID` from gitignored `.env.signing`; missing
  credentials skip notarization *quietly*. Check with `xcrun notarytool
  history`.
- iOS: bundle id `com.vogler.dev`, the same as the Mac -- iOS does not
  require a different one, and changing the Mac's would void every TCC grant;
  team
  `9KMDH5UH9Z` in `bundle.iOS.developmentTeam`, signed by Xcode automatic
  signing with the *Apple Development* certificate (not the Developer ID).
- **Identify an artifact with `codesign -dvvv`** -- expect `Mach-O universal
  (x86_64 arm64)` (`lipo -archs` on the binary says the same),
  `TeamIdentifier=9KMDH5UH9Z`. Not file size. Stale TCC:
  `tccutil reset Microphone com.vogler.dev`.
- Updater: minisign key at `~/.tauri/punching-bag.key` (back it up; losing it
  strands every install), GitHub Releases endpoint (repo must stay public).
  Tauri v2 from the first release after 0.4.0: the launch-time dialog is ours (`lib.rs`), not the
  plugin's; `createUpdaterArtifacts: "v1Compatible"` keeps v1 installs able
  to update and must stay until none are left (*Tauri v2*).
  **Bump the version** in `tauri.conf.json` and `package.json`; **commit before
  building** (notes come from the last commit subject). The build prints
  publish commands rather than running them; publish all artifacts from one
  build.

## Failing loudly

A rejected `set_config` keeps Rust on the last accepted config while the UI
shows the new one. `JSON.stringify(NaN)` is `null`, which serde refuses for
`f64`. Keep the `.catch` banner; `sanitizeRhythm` repairs restored rhythms;
`resolveRhythm` refuses degenerate re-parses. Prefer surfacing an error over
silently doing nothing, everywhere.

- **Log with `log::info!`/`warn!`/`error!`, not `println!`** (*The log
  file*). `applog.rs` installs a `log` logger first thing in `run`, before the
  devices open: every line goes to stdout/stderr as before *and* (Info and up,
  Mac only) to `~/Library/Application Support/com.vogler.dev/microtime.log`,
  rotated at 2 MB to `microtime.1.log`. `debug!` is terminal-only (the
  per-keystroke config dump). Panics are logged by a hook. **Never log from the
  audio thread** (lock, allocation, disk) -- nothing in `engine.rs` or the
  render callbacks does. The frontend logs through `log_message` (refused
  `set_config`s); Setup → *Log* reveals the file.
- **A launch failure before any window is `applog::fatal`**: logs, shows a
  native alert (rfd, Mac) naming the error, the prefs advice and the log path,
  exits 1. iOS just logs and exits, as before.

## Known issues

- `sections[].drums` isn't re-indexed when a drum voice is deleted.
- Device picker `describe()` shows input channel count in the output list.
- Output channel count `2` is a magic literal; untangle before channel work.
- Click counter ticks twice per frame (`400` is really 200 frames).
- Default `audioSubdivisions` has a hand-written `val` with `sounds: ["h"]`
  that isn't what `"2:1"` parses to.

## Verification

**The owner tests everything in the real app, usually without saying.** Still
open (details under *Verification* in the design notes):

- Onset trim -4 not checked by eye; 3/7 guitar notes ~20 ms late; quiet playing.
- `buffer_compensation` at 48 kHz (use *measure latency*).
- Speaker bleed on real hardware: ~10 dB observed vs 14.8 measured; widening
  `TAPS` is the cheap next try. Looper on speakers regressed with
  `loopFeedbackGuardOn` -- bisect by turning it off, then `bleedCancelAudioOn`.
- **iOS has only run in the simulator** (UI, session, RemoteIO, click and
  input drawn, suspend/resume/reset via injected hints). Nothing about latency,
  the mic, routes or interruptions is known on a device -- the step 5
  checklist in `docs/ios-port.md`.
- In-process audio restart: exercised through the real path (output on
  BlackHole), never listened to -- headphones/AirPods, interface unplug,
  44.1↔48 kHz with the kit, file and stretch.
- Not yet used in the app: one-row-per-note, presets-to-file migration, pane
  placement / `rowColumns`, the control restyle, section rail, examples picker,
  drum grid, and v0.3.0's chances / pane names / recorder / record cycles /
  global key.

## Conventions

- Comments explain *why*, not what. Match the surrounding density.
- Temp tests: write `src/Foo.tmp.test.tsx`, run
  `CI=true npx react-scripts test --testPathPattern Foo.tmp`, then delete. No
  committed test suite, on purpose.
- `user-event` is v13 -- no `userEvent.setup()`; `[` / `{` are special in
  `.type()`. jsdom has no `PointerEvent` or pointer capture; stub them.
- When a decision is made, record it (and why) in `docs/design-notes.md`; keep
  this file to what's needed to work safely.
