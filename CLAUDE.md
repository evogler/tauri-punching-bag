# tauri-punching-bag

A practice tool for drummers/musicians: a metronome with programmable rhythms, a
looper, and a real-time waveform display you play *against*. Tauri v1 app —
React/TypeScript frontend, Rust + CoreAudio backend. macOS only (uses
`coreaudio-rs` directly, not `cpal`).

## Commands

```
yarn dev            # tauri dev
yarn tauri build    # ALWAYS run this after a change (see below)
yarn start          # browser-only, fakes samples; no Rust backend
npx tsc --noEmit    # typecheck
```

**Run `yarn tauri build` after every change.** The owner asked for this
explicitly. `tsc` and `react-scripts build` only cover the frontend; the Tauri
build also compiles Rust and packages the app, and it's fast (~30s) because the
Rust deps are already built. Three warnings are pre-existing and expected
(`unused import: std::time::Instant`, `unused imports: AudioUnit and Error`, and
`method hop_frames is never used`).

If the DMG step fails with `error running bundle_dmg.sh`, it's usually
transient — just re-run.

## Architecture

Two halves that talk through exactly two channels:

- **Config push (JS → Rust).** Any setting change calls `set_config` with the
  whole config object. Rust holds it behind a mutex; the audio callback reads it
  every callback.
- **Sample poll (Rust → JS).** The audio callback appends to a shared buffer;
  the frontend polls `get_samples` at 100 Hz and draws.

`beat: f64` in the audio callback is the master clock — it advances by
`beats_per_sample` per frame and never wraps. Everything (click, drums, display
position, looper) derives from it.

### Layout of the Rust side

| File | Role |
|---|---|
| `main.rs` | Setup + the render callback. Nearly all real-time logic lives in one closure. |
| `io_channels.rs` | Device discovery, stream formats, input callback, per-channel queues. |
| `structs.rs` | Config, shared state, `DrumVoice`, `VisualSamples`. |
| `commands.rs` | Tauri commands (`set_config`, `get_samples`, `load_drum_sample`, …). |
| `constants.rs` | `SAMPLE_RATE`, `MAX_INPUT_BACKLOG`, `default_config()`. |
| `util.rs` | `beat_bisect` (which subdivision a beat falls in), `mod_add`. |
| `analysis.rs` | The short-time FFT behind the spectrogram and the spectral flux (see below). |
| `calibration.rs` | The round-trip latency measurement -- probe, matched filter, gates. |
| `stretch.rs` | WSOLA time stretching for the file player, and the off-thread render that applies it. |
| `prefs.rs` | `audio-prefs.json`: device choice and per-pair latency. Not the config. |

### Layout of the frontend

| File | Role |
|---|---|
| `App.tsx` | State, config plumbing, the whole canvas draw path. Large. |
| `config.ts` | `defaultRustConfig` / `defaultJsConfig` — the split below matters. |
| `layout.ts` | `getCanvasPositions` — pure geometry, where a beat lands on screen. |
| `Input.tsx` | Generic config inputs, dispatched on value type. |
| `expression.ts` | The parameter expression language, and `parseNumberList` / `formatNumberList` built on it. Pure. |
| `ParameterList.tsx` | The named-number UI. |
| `GridList.tsx` / `ChannelList.tsx` / `DrumList.tsx` | The three list UIs. |
| `RowColorList.tsx` | The per-view row color swatches. |
| `SpectrogramControls.tsx` | The per-view spectrogram channel/gain/floor controls. |
| `Slider.tsx` | The labelled range input those and `flux gain` share. |
| `presets.ts` | Named presets *and* the auto-restored session. |
| `parser1.js` / `parser2.js` | Generated PEG parsers for rhythm syntax (see Rhythm syntax). Don't hand-edit -- `parser2.js` is built from `parser2.peg` by `yarn build:parser`. `parser1.js` has no source and is legacy. |

## The config system — sharp edges

Config is split three ways by *where it's needed*: `defaultRustConfig` (audio),
`defaultJsConfig` (display, global), and `defaultViewConfig` (display, per-pane).
`get(key)` / `set(key, value)` route by which of the first two the key lives in.
Adding a key to the wrong one silently does nothing.

Rules that will bite you:

- **`snakeCaseKeys` is top-level only.** A nested Rust struct field must be a
  single lowercase word, or serde won't match it. This is why `DrumVoice` has
  `offset` (documented as ms) rather than `offset_ms`.
- **`unwrapValues` is recursive.** Rhythms are stored as
  `{inputText, val, type}` so fields keep what was typed; Rust only wants `val`.
  Drum voices nest a rhythm inside an array, hence the recursion.
- **The `react-hooks` eslint plugin is not loaded.** An
  `// eslint-disable-next-line react-hooks/exhaustive-deps` comment is itself a
  *build error* ("Definition for rule … was not found"). Don't add one.
- **View keys are unreachable from the plain `get`/`set`.** They live in
  `views[i]`, in neither default object, so `isRustConfigKey` and `isJsConfigKey`
  both miss and `set` does nothing. `Config` includes `ViewConfig` only so
  `Input` can be typed against those keys; the panel reaches them through the
  view-scoped pair `viewSetGet(i)` returns, which falls through to the global
  `get`/`set` for everything else.
- **Transient keys.** `presets.ts` excludes `canvasWidth`/`canvasHeight`
  (derived from window size) and `paused` (transport state) from both presets
  and the saved session.
- **Never reuse a config key name with different semantics or a different
  default.** Restore merges the saved value *over* the default, so a session
  written by an older build silently wins. This bit once: `loopFeedback` was a
  recursive feedback amount defaulting to 0, then became a per-echo gain
  defaulting to 1 — sessions written by the first build restored the 0 and
  silenced every echo after the first, which looked like the echo count being
  ignored. Renaming it to `loopEchoGain` was the fix, because unrecognized keys
  *are* dropped. Rename rather than redefine.
- **Session restore** merges over defaults, so new keys keep their default and
  removed keys are dropped. A restored session pushes one `set_config` on mount,
  because Rust boots from its own `default_config()`.

## The panel, the shortcuts and the menu

- **The panel is four tabs** -- sound, signal, visual, views -- with the
  transport, `parameters` and the preset bar pinned above them. Parameters are
  pinned rather than tabbed because you edit `n` while looking at a field that
  reads `bar/n x n`.
- **Inactive tabs are hidden, not unmounted** (`TabPanel` sets
  `display: none`). `Input` holds the text you are typing in local state and an
  expression is invalid for most of the time it takes to type, so unmounting
  would throw a half-written field away on every tab switch. Every section
  rendered on every render before tabs existed, so this costs nothing new.
- **Which tab is open is plain React state, not a config key** -- transient UI,
  kept out of presets and the session on purpose.
- `Divider` is the labelled hairline that groups settings inside one Section.
- **⌘P pauses, ⌘L toggles looping, ⌘R rerolls every random parameter.** One
  `keydown` listener, registered once and reaching the current `set`/`get`
  through a ref -- those are new closures every render, so depending on them
  would rebuild the listener each time. All three are taken unconditionally,
  text fields included: none is a text-editing key. ⌘R checks `shiftKey` and
  bows out, because the menu's ⌘⇧R (Restart) arrives at the webview too.
- **The app menu carries Restart** (⌘⇧R), added to `Menu::os_default` rather
  than to a menu built from scratch -- building one drops Edit, and with it
  cut/copy/paste in every text field in the panel. `AppHandle::restart` reads
  Info.plist on macOS, so the *bundle* comes back rather than the bare binary,
  which matters because only the bundle can hold the microphone grant. The
  session is written to local storage on every config change, so settings
  survive the relaunch; `paused` doesn't, being transient.

## Parameters and expressions

`parameters: {name, value}[]` in `defaultJsConfig` is a global list of named
numbers, and several view fields hold arithmetic over them instead of literals.
With `n = 16, bar = 4`, a pane's rows read `bar/n x n` (0.25 x 16) and a grid
reads `{n/bar}:1` (4:1) -- so "switch to 16ths" is one edit rather than five.

`expression.ts` is the whole language: numbers, parameter names, `+ - * / ( )`,
and `min` / `max` / `round`. Every entry point **throws** rather than returning
NaN or a partial result; callers use the throw to decide between committing and
keeping the last good value. Deliberately not a scripting language.

- **Expression-backed fields are stored `{inputText, val}`** -- the same shape
  as `Rhythm`, so the recursive `unwrapValues` already strips them to `val` and
  they cost nothing on the Rust side. Per-view: `beatsPerRow`, `marginLeft`,
  `marginRight`, `visualGain`. Rust-side: `bpm`, `beatsToLoop`, `loopEchoes`,
  `loopEchoGain`, `clickVolume`, `audioInGain`, `bufferCompensation`,
  `fileVolume`, `fileBeats`, `fileOffsetMs`, `fileShift` (see `RustExprKey`). Read them through `exprNumber` / `exprList` / `viewRowBeats`,
  never directly. Sliders and dropdowns keep plain numbers -- there's nowhere to
  type an expression.
- **Rhythm text takes bare parameter names**, no braces. Both generated PEG
  grammars already reserve `+ - * / ( ) [ ]` and evaluate them (`1/5` parses to
  a span of 0.2, `2*3` to 6), so a parameter only has to become its value before
  parsing and the grammar does the arithmetic. `substituteParams` leaves
  identifiers it doesn't know alone, which is what keeps parser2's sound letters
  working -- and is why `h`/`k`/`r`/`s` are reserved parameter names.
  `resolveRhythmText` runs braces first, since `min`/`max`/`round` have no
  equivalent in the grammars. Grid, click and drum rhythms all re-resolve.
- **The Rust side has to be re-resolved *and* pushed.** Nothing in the frontend
  reads those keys -- they exist only to reach the audio thread -- so a stale
  `val` would sit there until some unrelated setting change happened to push
  again. `setParameters` calls `resolveRustConfig` and `updateRustConfig`
  alongside the js update; `loadPreset` and the restored session do the same.
- **A validator failing is treated exactly like a syntax error**: red, not
  applied, last good value kept. `resolveNumber` takes the same validator, since
  a parameter change is a path the input component can't see. This matters most
  for `bpm` -- `n - n` would otherwise push a 0 across, and `get_loop_spacing`
  divides by it, giving infinity, which `as usize` saturates to `usize::MAX` and
  panics at the allocation. `get_loop_buffer_size` clamps to `MAX_LOOP_FRAMES`
  as the last line of defence.
- **`resolveJsConfig` is the freshness mechanism.** `val` must never be one
  render stale, since the draw loop reads it directly, so the parameter setter
  re-walks the whole js config in the *same* update. Not an effect: an effect
  that writes config is a render loop waiting to happen, and it would still
  draw one frame from the old numbers. It's also run on the restored session
  and on preset load.
- **A field that stops evaluating keeps its last good `val`** and its text.
  Deleting a parameter marks every field that referred to it invalid (red
  border, recomputed from what's on screen so it survives a blur) rather than
  blanking the pane. Renaming a parameter does *not* rewrite the expressions
  using it.
- **`x` is reserved**, and so is `x` followed by digits: `formatNumberList`
  writes `0.25x16` with no spaces, so the tokenizer has to split `x16` rather
  than read it as an identifier. `min`/`max`/`round` are reserved too.
  `isValidParameterName` is the one place a user can hit this.
- **A fractional repeat count rounds**, it doesn't reject -- `bar/n x n/2` at
  `n = 7` wants 3.5 rows, and rejecting would flash the field red at every
  intermediate value of a parameter sweep. `MAX_LIST_LENGTH` still caps at 128.
- **`x` repeats a *group*, not only a number.** `[.6,.4]x8` gives sixteen
  entries alternating, and groups nest: `[[.6,.4]x2, 1]x3`. A bracketed group
  is parsed by exactly the same rules as a whole field -- `parseTokenList` is
  the single implementation, used for both -- so expressions and parameters
  work inside one (`[bar/n, .4]x2`). `[` and `]` are ops in the tokenizer and
  `splitTop` counts their depth alongside parentheses.
- **A parameter can be a list**: `divs = .6,.4`, then `rows: divs x 4`. A bare
  list parameter stands exactly where a group would. `Params` is
  `Record<string, number | number[]>` and `Parameter.value` was **widened**
  rather than renamed -- unusually safe here, because a saved session's plain
  number is still a valid value, so restore merges it over the default and
  nothing changes meaning. The one place widening is not enough is a scalar
  context: `evaluateTokens` throws `"divs" is a list` rather than guessing at
  the first element or the length, and `divs*2` is an error in a list field too
  -- arithmetic on a list has no meaning here.
- **A list parameter substitutes into rhythm text as its comma-joined values**,
  which is exactly a group body in both grammars, so `[divs]:1` becomes
  `[0.6,0.4]:1` and works. Anywhere else in a rhythm it will fail to parse,
  which surfaces as the field going red with its last good value kept.
- **A parameter may be an expression over the other parameters**, in any order,
  so long as the references form a **DAG**. `resolveParameters` enforces that
  without building a graph: each pass resolves every parameter whose references
  are already resolved, and when a pass resolves *nothing*, whatever is left is
  a cycle, depends on one, or names something that doesn't exist. Same answer a
  topological sort gives, with no graph, no visited set and no recursion.
  `parameterValues` is now `resolveParameters(...).values`, so every existing
  caller -- session restore, `setParameters`, `loadPreset`, `resolveJsConfig` --
  picked this up unchanged.
- **A failed parameter contributes nothing, not its cached value.** Falling back
  to the cache would let a cycle appear to work off stale numbers, which is
  worse than an error. Fields referring to it go red and keep their own last
  good values, exactly as when a parameter is deleted.
- **A cycle is rejected where it is typed**, not stored and then reported: the
  editor resolves a *candidate* list on each keystroke and commits only if this
  parameter resolves in it. `referencedNames` then separates "circular
  reference" from "unknown parameter zzz" in the message -- the same failure to
  an evaluator, completely different things to fix.
- **`Parameter` gained an optional `inputText`** rather than becoming
  `{inputText, val}`. Optional means a session written before this loads with no
  migration at all: its `{ name, value: 4 }` is already valid, and
  `parameterText` derives the text from the value. `resolveJsConfig` writes the
  resolved value back into each parameter, so `b = a*2` doesn't keep showing the
  old product wherever `value` is read directly.
- **Scalar is tried before list** when evaluating a parameter, because
  `parseNumberList("4")` is `[4]` -- a one-element *list* -- so the other order
  would quietly turn every literal into one.
- **`MAX_LIST_LENGTH` counts group members**, so `[1,2]x64` is exactly at the
  cap and `[1,2]x128` is rejected.
- **`beatsPerRow` changed shape** from `number[]` to `{inputText, val}`, which
  is the `loopFeedback` trap above: restore merges a saved array *over* the new
  object and `Math.max(...beatsPerRow)` returns NaN, drawing a blank pane.
  `normalizeView` wraps arrays (and bare numbers, for the three scalar fields)
  explicitly, and `migrateRust` does the same for the Rust-side keys. Wrapped
  rather than renamed, so saved layouts and tempos survive.
- **A parameter can be a roll**: `choose(1,2,3)` picks one of the values,
  `range(1,3)` picks a number between them, and `range(1,3,0.25)` picks one of
  the multiples of the step -- a tempo in whole bpm, a shift in 16ths. They are functions in
  `expression.ts` like `min`/`max`/`round`, except that they take an `Rng`
  argument rather than reaching for `Math.random` -- which is what puts *when* a
  roll happens under the caller's control.
- **A stepped `range` draws uniformly over the steps that fit**, rather than
  rounding a continuous draw: rounding gives the two ends half the weight of
  everything between them, which is visible in a set as small as `range(1,3,1)`.
  A step that doesn't divide the span stops short rather than overshooting the
  high end, and the result is put through `toPrecision(12)`, since a tempo of
  `1.3000000000000003` reads as a bug wherever it is printed.
- **A roll is sticky, and that is the whole design.** The random parameter's
  stored `value` **is** its value: `resolveParameters` does not evaluate the
  text at all unless asked to roll. Everything here is re-resolved on every
  keystroke, every preset load and every `resolveJsConfig`, so a live `choose()`
  would re-roll on all of them and no number in the app would hold still. As a
  consequence a roll is written to the session and comes back the same at
  launch, which is what you want from a setup you liked.
- **Nothing needs to know what a random parameter feeds.** A reroll writes the
  new draw back as the parameter's `value` and then goes through `setParameters`
  like any hand edit, so `b = a*2`, every view field and every Rust-side
  expression re-derive on the same update. `rollParameters(list, pick)` is the
  whole mechanism; `reroll()` in `App.tsx` is one line.
- **A random parameter is a DAG leaf when it isn't being rolled**, since its
  text is never evaluated -- so `a = range(1, n)` resolves in the first pass
  whatever `n` is doing. At *roll* time it is an ordinary node and `n` must
  resolve first, which is why a cycle through a roll is still reported as one.
- **`choose`/`range` throw everywhere except a parameter.** Without an rng
  `evaluateTokens` reports `choose() only works in a parameter` rather than
  producing a number, because a field is re-resolved constantly and would draw a
  new value every time. Same reason the roll is sticky, one level up.
- **The editor rolls to validate, and rolls on commit.** `accepts` resolves the
  candidate list with `roll = () => true`, or a half-typed `choose(1,2` would
  never be parsed by anything and so would never go red. And committing text
  whose *text changed* rolls it, since the row would otherwise show whatever the
  parameter was before -- a number that need not even be one of the choices.
- `isRandomText` tokenizes rather than matching the word, so a parameter called
  `chooser` isn't mistaken for a roll. `choose` and `range` join `x`, `min`,
  `max`, `round` and the sound letters as reserved parameter names, and are
  skipped by `referencedNames` like the other functions.
- **Drum `gains` takes expressions; `offset` and `shift` still don't.** The rule
  is the same one as before -- a nested field may only take an expression once
  it is in `resolveRustConfig`'s walk, or a parameter change leaves `val` stale
  in the one config nothing on this side re-reads. `gains` was added to that
  walk and then made expression-backed, in that order. `offset` and `shift`
  aren't in it, so they stay literal: add them first, then change them.
- **Gains went `number[]` -> `NumberListExpr | number[]`**, which is the
  `beatsPerRow` shape change again and is handled the same way -- `normalizeGains`
  wraps a bare array rather than renaming the key, so every saved drum part
  survives. Unusually, the migration needs no entry in `migrateRust`: the
  wrapping happens inside `resolveRustConfig`, which every path into the config
  already runs (startup, `setParameters`, `loadPreset`), and `exprList` in
  `drumGains` covers anything that slips past. `unwrapValues` was already
  recursive for the nested rhythm, so Rust still receives a plain `Vec<f64>` and
  is untouched.
- `drumGains` is the values, `drumGainsText` is what the field shows -- the text
  as typed where there is one, so `1, g x k` survives a render instead of being
  reformatted into its current numbers.

## Rhythm syntax

Only ever documented in a comment at the top of the generated `parser2.js`, so
it's written out here. Everything defaults to **parser2**; nothing creates a
parser1 rhythm any more and there's no UI to switch, so parser1 is effectively
legacy (it returns a flat array of times rather than `{notes, start, end}`).

| Written | Means |
|---|---|
| `4` | one note, span of 4 beats |
| `2:1` | 2 evenly spaced notes across 1 beat |
| `5:1` | 5 across a beat -- 16ths against a 4-beat bar |
| `1/5` | one note, span of 0.2 -- **the grammars do arithmetic** |
| `[2:1, 1]:1` | a group; entries share the span given after the `]` |
| `[k 1, h 1]:1` | sounds: a letter (`h` `k` `r` `s`) then a weight |
| `[h 1>-.1]:1` | `>` nudges that note's time -- lands at 0.9, not 0 |
| `[[k 1>-.1, h 1, s 1]:1, 3:1, 1]:1` | groups nest |
| `[k 1, h 1]x4` | repeat the group four times |
| `[k 1, h 1]x4:1` | repeat, *then* squish the whole run into one beat |

- **`x` repeats a group, and it is a *different* `x` from the one in number
  lists.** They look alike and are two languages: `parseNumberList` handles
  `beatsPerRow`, `rowColorPattern` and drum `gains`; the PEG grammar handles
  rhythms. `[.6,.4]x2` in a rhythm field used to fail with `Expected ":" or end
  of input but "x" found` for exactly that reason. The grammar now has a
  `Repeat` rule, and `Squish` takes `(Repeat / Group)` so `[k 1, h 1]x4:1`
  repeats *then* squishes -- eight evenly spaced notes in one beat.
- **A fractional repeat rounds** here too, matching `parseNumberList`, but a
  count below 1 is an **error** rather than an empty rhythm. `end: 0` is a shape
  nothing downstream is written to survive, and this grammar could not produce
  one before; erroring leaves the field red with its last good value, like any
  other syntax error.
- **A zero-length rhythm is a syntax error**, not a value. `"0"`, `"4:0"`,
  `"0:1"` and `"1/0"` used to parse into notes at NaN, which is `null` over IPC
  and unloadable by serde -- see *Failing loudly*. Same treatment as a repeat
  count below 1, and for the same stated reason.
- **`parser2.js` is generated and regenerating it is now a one-liner.**
  `yarn build:parser` runs `scripts/build-parser.mjs`, which uses `peggy`
  (a devDependency as of this change) with `format: "bare"` -- that is why the
  file reads `export default (function(){...})();`, the same shape it always
  had, so nothing importing it changes. The syntax documentation lives in the
  script's header constant so it is regenerated alongside the parser rather than
  drifting from it. Checked by replaying 19 existing rhythms through the old and
  new parsers: byte-identical output on every one.
- **`+ - * / ( ) [ ]` are all grammar tokens and are evaluated natively.** That
  is why parameters need no braces in a rhythm field (see Parameters and
  expressions) -- substituting the name is enough and the grammar does the rest.
- **Nothing reads `sounds`.** The Rust `Note` struct has the field commented out
  and the draw code only uses `note.time`, so the letters parse and are then
  discarded. They're reserved as parameter names anyway, to keep the syntax
  usable if a sound ever gets wired to a drum voice.
- The default `audioSubdivisions` has `inputText: "2:1"` but a hand-written
  `val` carrying `sounds: ["h"]`, which is *not* what that text parses to.
  Harmless while nothing reads sounds; misleading the moment something does.

## macOS packaging and permissions

**The bundled app and the bare binary do not have the same permissions.**
Running `target/release/tauri-punching-bag` from a terminal works because
Terminal is then the responsible process for TCC and the child inherits
Terminal's microphone grant. The `.app` has to earn its own, and three things
were stopping it:

- **`NSMicrophoneUsageDescription` was missing entirely.** Without that string
  macOS never shows the prompt, and CoreAudio returns silence rather than an
  error -- an input of all zeroes with nothing in any log. Tauri v1 merges
  `src-tauri/Info.plist` into the generated one; that file exists now solely to
  carry this key. Verify a build with
  `plutil -p .../tauri-punching-bag.app/Contents/Info.plist | grep -i usage`.
- **The hardened runtime is on** (`codesign -dv` reports
  `flags=0x10002(adhoc,runtime)`), and under it a process cannot open an input
  device without `com.apple.security.device.audio-input`. It was commented out.
- **`com.apple.private.tcc.allow-prompting` was the only entitlement applied.**
  That is an Apple *private* entitlement; third parties can't use it, it did
  nothing here, and it would make a real Developer ID signature invalid. Removed
  -- don't put it back.

Still outstanding, and the reason other machines are hard:

- **Signing is ad-hoc** (`signingIdentity: "-"`, `TeamIdentifier=not set`). TCC
  keys a grant to the code signature, and an ad-hoc signature changes every
  build, so a granted permission won't survive a rebuild. On another Mac,
  Gatekeeper blocks an ad-hoc, un-notarized bundle outright.
- Interim workaround on another Mac: `xattr -dr com.apple.quarantine <app>`,
  then right-click → Open.
- Real fix: an Apple Developer Program membership, a Developer ID Application
  certificate in `signingIdentity`, and `APPLE_ID` / `APPLE_PASSWORD` set so the
  build stops logging `skipping app notarization`.
- A stale TCC record survives all of this, keyed by the bundle id. After
  changing any of the above, `tccutil reset Microphone com.vogler.dev` is what
  makes the prompt appear again.

### Installing on a second Mac

**The build now sweeps stale disk images, so there should only ever be one.**
`bundle/dmg/tauri-punching-bag_0.1.0_aarch64.dmg` is the release artifact.

This used to be a real hazard. A rebuild never cleaned up after itself, so old
images sat in the tree looking like build outputs indefinitely -- the bundler's
`bundle/macos/rw.*_x64.dmg` scratch image from **March 2023**, and a **November
2022** `x86_64` build under `target/debug/bundle/dmg/` whose name was *identical*
in shape to a real artifact. Shipping one by mistake produced an app that first
refused to launch and then, once launched, captured nothing -- no microphone
prompt, no entry in Privacy & Security, silence with nothing in any log. Every
one of those symptoms is *also* what a correct build looks like when Gatekeeper,
TCC, or the sample rate is wrong, which is why it survived several rounds of
plausible fixes aimed at the wrong thing.

- **`yarn tauri` runs `scripts/tauri.mjs`, not the CLI directly.** It forwards
  every argument untouched and only sweeps after a `build` that *succeeded* --
  a failed build is left exactly as it fell, so there is something to look at,
  and so a transient `bundle_dmg.sh` failure can't take the previous good
  artifact with it. `yarn tauri dev` is unaffected.
- **The sweep is by time, not by name.** Any `.dmg` under `src-tauri/target`
  older than the moment the build started is from some other build and goes.
  The `rw.` prefix is only the case we happened to know about; the image that
  actually cost a day was named exactly like a real one, which a name pattern
  would never have caught.

**Identify the artifact before debugging anything else.** One command settles it:

```
codesign -dvvv /Applications/tauri-punching-bag.app
```

- `Format=... (x86_64)` -- wrong DMG. Current builds are `arm64`.
- `Info.plist entries=17` -- wrong DMG. A build carrying the microphone key has 27.
- `CodeDirectory v=20400` -- wrong DMG; current is `v=20500`.

Without a terminal, 7 MB versus 36 MB is the same check.

**The install recipe that works**, once the artifact is right:

```
rm -rf /Applications/tauri-punching-bag.app          # never merge onto an old one
xattr -dr com.apple.quarantine <the>.dmg             # if the image itself won't mount
ditto -R /Volumes/tauri-punching-bag/tauri-punching-bag.app \
         /Applications/tauri-punching-bag.app        # ditto, not a Finder drag
xattr -dr com.apple.quarantine /Applications/tauri-punching-bag.app
open /Applications/tauri-punching-bag.app            # then Open Anyway, possibly twice
```

On macOS 15 the escape hatch is **System Settings → Privacy & Security → Open
Anyway**, which only appears *after* a launch has been refused; right-click →
Open no longer works. Expect to use it more than once.

**Three things look like failures and are not.** All three were chased here:

- `com.apple.provenance` surviving `xattr -dr` -- a different, system-restricted
  attribute that Gatekeeper does not read. Only `com.apple.quarantine` matters.
- `unable to initialize qtn_proc` and `putting executable into provenance` in
  the log -- what syspolicyd prints for a file with *no* quarantine attribute.
  They mean the removal worked.
- `spctl -a` reporting `rejected` -- expected for anything ad-hoc and
  un-notarized, and unrelated to whether the signature is valid. `codesign
  -vvv --deep --strict` is the question worth asking; it reports `valid on
  disk` for a good ad-hoc bundle.

**A self-signed certificate is a free stable identity**, and is worth reaching
for before the Developer ID if the only goal is running the app on a machine you
control. Keychain Access → Certificate Assistant → Create a Certificate, with
**Identity Type: Self Signed Root** and **Certificate Type: Code Signing**, then
`codesign --force --options runtime --entitlements Entitlements.plist --sign
"<name>"`. `Warning: unable to build chain to self-signed root` is expected and
the signature still lands -- `Signature size=` in `codesign -dvvv` is how you
tell a real signature from `Signature=adhoc`. It does nothing for Gatekeeper,
but unlike ad-hoc it gives TCC something durable to key a grant to, so the
microphone permission survives a rebuild.

Two Keychain Access details that waste time: `security find-identity -v -p
codesigning` hides untrusted certificates, so check without `-v` before
concluding the certificate does not exist; and Get Info on the *private key*
shows only Attributes and Access Control -- the Trust pane is on the
**certificate**, the parent row under My Certificates.

## Audio thread rules

The render callback in `main.rs` runs ~21×/sec with 2048 frames. Inside it:

- **Never allocate at all, per frame or per callback.** The display buffers
  were the exception and stopped being one: `get_samples` used `mem::take`,
  which leaves a vector with *no capacity* behind, so the callback grew both
  from zero on every drain -- ~20 reallocations and a copy of the whole batch,
  on the audio thread, scaling with how many channels the panes ask for. It now
  swaps in vectors sized *before* the lock is taken, from what the last drain
  took (`DrainSizes`, atomics deliberately outside the mutex so the sizing
  can't itself make the callback wait). `MAX_VISUAL_BACKLOG` caps the buffer at
  a second so a wedged frontend can't grow it -- and with it the next reserve --
  without bound. The audio thread waiting on the allocator while the IPC thread
  holds it is the classic way a synthesised part comes out late; the whole
  point is that it never gets there.
- **The callback holds both display mutexes for its entire run**, so a drain
  only happens between callbacks. Everything the commands do inside the lock is
  therefore O(1) by construction -- a swap, never a copy or an allocation.
- **Never allocate per frame.** Rhythm time-vectors, pan gains, and drum sample
  lookups are all resolved *once per callback* into locals. The click's times
  array used to be `.collect()`ed inside the per-frame, per-channel loop — about
  88,000 allocations/sec. Don't reintroduce that pattern.
- **Per-frame vs per-output-channel.** The output loop runs twice per frame
  (stereo). Anything advancing sample time — input pops, the loop buffer, the
  beat, triggers, display pushes — belongs *outside* it. Things that legitimately
  live inside: writing `channel[i]`, the mp3 read, drum sample mixing.
- **`buffer_compensation` is in frames** (default 4330 ≈ 98 ms), hand-tuned by
  the owner and since confirmed to within 3 frames by the calibration measurement
  (see *Measuring it automatically*). Don't change its units.
- **`beat` must stay f64 end-to-end.** It counts up from launch, so at f32 the
  gap between representable values outgrows a screen pixel after ~20 minutes and
  the waveform stops being redrawn densely enough to erase the previous pass —
  ghost trails. Fixed once; don't reintroduce a cast.

### Input capture

- **The sample rate is the input device's, not a constant.**
  `get_input_output_channels` reads `kAudioDevicePropertyNominalSampleRate` off
  the default input device and calls `set_sample_rate` before anything derived
  is built; `sample_rate()` in `constants.rs` is the `OnceLock` everything else
  reads. **AUHAL will not convert on the way in**: point it at a 48 kHz
  microphone while asking for 44.1 kHz and it hands back zeroes -- no error, no
  log, an input of all silence indistinguishable from a missing microphone
  grant. That is why the constant had to go; a MacBook's built-in mic is 48 kHz
  out of the box, so the old code only ever worked on a device already sitting
  at 44.1. Confirmed by setting the device rate and watching the waveform go
  flat.
- **Output does convert, so when the two devices disagree the input wins.** The
  render callback advances `beat` and pops one input sample per *output* frame,
  so both sides are assumed locked to one rate. Input's rate is chosen because
  it is the side that refuses to resample; the output unit takes the ordinary
  "play 44.1 on a 48 kHz device" path. The disagreement is logged. Genuinely
  separate devices still drift -- the answer there is an aggregate device, not
  offset correction (see *Discussed but not built*).
- **Everything sized in frames is now a fn, not a const**: `max_input_backlog()`,
  `max_visual_backlog()` (`constants.rs`) and `max_loop_frames()`
  (`get_loop_buffer_size.rs`). They are documented in seconds -- a quarter
  second, one second, ten minutes -- and a const would quietly stop meaning that
  at 48 kHz.
- **`buffer_compensation` is still in frames, so its duration moves with the
  rate.** 4330 frames is ~98 ms at 44.1 kHz and ~90 ms at 48 kHz. It was tuned
  by ear at 44.1, so expect to retune it on a 48 kHz device. The units are
  deliberately unchanged: making it milliseconds would be redefining a key that
  restored sessions already carry, which is the `loopFeedback` trap.
- **The frontend never sees frames.** The sample stream is stamped in beats, so
  the whole draw path is rate-independent. Three references had leaked in and
  are fixed: `ANALYSIS_NYQUIST` (a hard 22050 put the top 2 kHz of the flux band
  out of reach at 48 kHz) is now `analysisNyquist()` over a module-level rate
  fetched once via the `get_sample_rate` command, and the fft dropdown's
  millisecond label divides by that rate. `mockGetArray`'s
  `beatsPerSample = 91 / 60 / 44100` is left alone -- it is fake data for
  `yarn start`, with no Rust behind it.
- Input stream is **interleaved**, output is **non-interleaved**.
  `coreaudio-rs` returns `NonInterleavedInputOnlySupportsMono` for multi-channel
  non-interleaved input, but has no such limit interleaved. That flip is the only
  reason multi-channel input works. `types.rs` has a separate `InputArgs` alias.
- Channel count is discovered from the device via
  `kAudioDevicePropertyStreamConfiguration`; if the device rejects that count it
  falls back to mono and logs it.
- **`make_buffers` hands out the same `Arc` as producer and consumer.** Despite
  the names there is one queue per channel, not two ends of a ring. If the render
  callback ever stops draining while the input callback keeps pushing, it grows
  unbounded (~172 KB/s/channel) *and* replays the backlog as stale audio.
  `MAX_INPUT_BACKLOG` (11,025 = 0.25 s) caps it. The pause path drains and
  discards rather than returning early.

### Device selection, and the third store

The input and output devices are chosen in the panel (signal tab → *device*) and
applied **at the next launch**, not live. `restart_app` is the button; ⌘⇧R is
the same thing from the menu.

- **Not hot-swappable, on purpose.** `set_render_callback` at `main.rs:188` is a
  `move` closure that *owns* `input_frame`, `loop_visual`, `analyzer`,
  `bus_delay`, `drum_last_beats`, `tap_gains` and the consumer queues -- all of
  them sized from `input_channels`. Swapping a device means resizing every one
  of them from outside the callback, which means a lock the audio thread can
  wait on. That is precisely the hazard `DrainSizes` and the pre-sized swap
  buffers exist to remove. A two-second relaunch is the cheaper trade.
- **There is now a third store, and it is not the config.** `prefs.rs` writes
  `audio-prefs.json` in the app config dir. The config describes the music and
  the picture; this file describes the hardware in front of it. Two reasons it
  cannot be a config key: the device is opened before any window exists, so
  localStorage is unreachable at that point; and presets travel between machines,
  where a device UID or someone else's latency figure is noise. The panel still
  owns the editing -- the frontend writes through `set_audio_prefs` on every
  change, so the file mirrors what the UI shows rather than being a second thing
  to keep in sync.
- **Devices are keyed by UID.** `AudioDeviceID` is a runtime handle, reassigned
  across reboots and on replug; names are not unique, since two of the same
  interface are indistinguishable. `get_device_uid` reads
  `kAudioDevicePropertyDeviceUID`, a CFString rather than a number, cribbed from
  `get_device_name` in `macos_helpers.rs`. A device with no readable UID is
  filtered out of the picker -- it cannot be persisted, so it cannot be offered.
- **A saved device that is gone falls back to the system default and says so.**
  `ActiveDevices` carries `input_fell_back` / `output_fell_back` and the panel
  prints it in red next to what is actually running. Silently recording from the
  built-in mic while the user believes their interface is selected is the exact
  shape of the bug that cost a day on 2026-09-06 -- an app that looks fine and
  is listening to the wrong thing.
- **The list refreshes on Core Audio's own notification**, not on a timer.
  `watch_device_changes` registers a listener on
  `kAudioHardwarePropertyDevices` and emits `devices-changed`; the picker
  re-enumerates on it, so an interface plugged in after launch appears without a
  relaunch. The listener runs on a Core Audio thread -- not the render thread --
  and only emits a Tauri event, so it cannot stall audio. The `AppHandle` handed
  to it is deliberately leaked, because Core Audio holds the pointer for as long
  as the listener is registered and it never is unregistered.
  Two cheaper paths back it up in case the registration fails: window focus
  (plugging something in usually means clicking back into the app) and
  `onMouseDown` on the dropdown itself, which fires before the popup opens.
- `get_input_output_channels` now takes `&AudioPrefs` and returns an
  `AudioSetup` struct rather than a 4-tuple, which had run out of room.

#### Per-device latency compensation

`pairCompensations: { input uid -> output uid -> frames }` in the same file.
`buffer_compensation` in the config is unchanged -- one number, in frames,
pushed to the audio thread, which must never do a map lookup.

- **Keyed by the device *pair*, not the input alone.** What the number
  compensates for is a round trip: the click leaves at frame F, reaches your
  ears at F + L_out, you play in time with what you *hear*, so you hit at
  F + L_out, and the mic hands those frames over at F + L_out + L_in. Both
  halves are in it, which is why swapping headphones for the interface's own
  output changes the answer -- and why the auto-calibration in item 3, which
  measures exactly that round trip, has somewhere correct to write its result.
- Nested rather than a joined `"in|out"` key so the file stays readable by hand,
  and **named `pairCompensations` rather than reusing `compensations`**, which
  was input-only for one build. serde drops an unknown field, so a file written
  before this reverts to the default instead of being reinterpreted with
  different semantics. Rename rather than redefine -- the config rule applies
  here too.

- **Applied once, over the restored session.** The session is the same on every
  machine; this number is not, so on mount the stored value for whatever device
  actually opened wins. A `useRef` guard rather than state, because applying it
  must not depend on having applied it.
- **Written back on change**, guarded on equality *and* on having applied first,
  so it can neither loop nor overwrite a saved measurement with the default
  before that measurement has been read.
- **Frames, not milliseconds.** Partly because that is the unit the key has
  always been in and redefining it is the `loopFeedback` trap, and partly
  because a device implies its own sample rate -- so a per-device frame count
  absorbs the 44.1/48 difference by itself, which is the retuning problem the
  sample-rate work left behind.

#### Measuring it automatically

`measure latency` in the device section plays a 20 ms swept sine, finds it in
the input with a matched filter, and offers the frame difference.
**`docs/calibration.md` is the long version** -- why a sweep rather than a
click, why correlation is immune to the speaker and the room colouring the
probe, why not the onset detector, and what each gate means.

- **A sweep, not a click.** A click's energy is flat, so most of it lands where
  a small speaker can't reproduce it. A sweep puts its energy where speakers and
  mics are efficient, and matched filtering compresses it to a peak ~133 us
  wide -- six frames -- against the several milliseconds a click comes back as.
- **Correlation doesn't care that the sound comes back transformed.** The
  speaker, the room and the mic *convolve* with the probe, and convolution does
  not move where a signal starts. Coloration costs sharpness, not accuracy.
- **First peak, then its apex** -- an early reflection can be louder than the
  direct arrival, and the direct arrival is the one that answers the question.
  The threshold crossing finds the leading edge, so climb to the top of that
  same peak or you read ~5 frames early.
- **Five probes, median.** One door closing gets outvoted rather than becoming
  the answer.
- **It refuses to answer** on low input level, a weak match, fewer than three
  probes, or probes disagreeing by more than 5 ms -- and shows all four numbers
  *with their thresholds* whether it passes or fails, because "too quiet" and
  "loud but not locking" need opposite responses from the user. The result is
  offered with an `apply` button, never applied on its own.
- **Not the onset detector**, though it is right there. Its resolution is a hop
  (5.8 ms), and `ONSET_CENTRE_BIAS` and `onsetOffset` were themselves calibrated
  by ear against the drums bus -- measuring latency with an instrument whose
  zero point is one of the unknowns is circular.
- **Audio-thread shape**: allocated in `start_calibration`, locked once per
  callback like the display buffers, capture handed over by `mem::take` rather
  than copied, correlation run in the command outside the lock. It takes the
  callback over entirely -- no drums, looper, monitor or file, since anything
  else playing would correlate against the probe -- but still drains every input
  channel, because `make_buffers` hands out the same queue to both ends.
- Checked against a simulated round trip (low-passed, a louder-than-direct
  reflection, heavy noise) at 2200/3000/4330 frames: recovered within 4-5 frames
  each time, and silence and uncorrelated noise were both refused. Temp tests,
  run and deleted.
- **Verified against the real thing, 2026-09-06.** It measured 4331-4333 frames
  where `buffer_compensation` had been hand-tuned *by ear* to 4330 -- two
  independent methods, neither able to bias the other, agreeing within 3 frames
  (0.07 ms). Moving the microphone a few feet back added ~100 frames, which is
  2.27 ms, which at ~1.125 ft/ms is ~2.5 feet. That second check is the stronger
  one: a number that tracks the microphone's position is measuring the acoustic
  path rather than producing a plausible constant. It also retroactively
  confirms the 4330 default.

### Looper

One buffer **per input channel**, sharing a position, advancing once per frame.
Sized in frames (`get_loop_buffer_size`, no `*2`). It was previously a single
interleaved-stereo buffer recording a mono sum, which made every input show up on
every channel. Loop length and compensation timing are unchanged by that
rewrite — verified arithmetically.

It is a **multi-tap delay**, not a feedback loop. The buffer is a plain history
— `buf[p] = live`, nothing mixed back in — and the echoes come from reading it at
`loop_echoes` taps, each one `beats_to_loop` further back. Recording never stops,
so overlapping phrases just work.

- `loop_echoes` is how many times a phrase comes back; `loop_echo_gain` is the
  gain per echo, compounding, so echo *k* plays at `loop_echo_gain^(k-1)`. At 1
  every echo is full volume and the run simply stops. **3 echoes at gain 1 gives
  repeats at +4, +8, +12 beats and then silence** — verified by simulating the
  index arithmetic.
- **A gain of 0 silences every echo after the first**, which presents as the echo
  count doing nothing. That's arithmetic, not a bug — but it's why the key is
  called a gain rather than a feedback amount, and why it was renamed out of the
  way of stale sessions (see the config rules above).
- `loop_echoes = 1, loop_echo_gain = 1` reproduces the original looper exactly:
  one repeat a loop later, then gone. Those are the defaults.
- **The buffer is `spacing * echoes` frames**, since the oldest tap reads a whole
  run back. Memory grows with echoes × beatsToLoop × channels — hence
  `MAX_LOOP_ECHOES = 16` (~30MB across four channels at 4 beats, 91bpm).
  `get_loop_spacing` is one echo's worth; `get_loop_buffer_size` is the product.
- Tap offsets are taken `% loop_len` so that the callback or two between a config
  change and the buffer resize aliases briefly instead of indexing past the end.
- Tap gains are built once per callback into a reused `tap_gains` vec, next to
  `drum_last_beats.resize` — not powered per frame and per channel.
- Nothing is clamped: with finite taps the worst case is `echoes × amplitude`,
  which is loud but bounded and can't run away. Manage input gain.
- Two models were tried and rejected before this one. Gating the write on a pass
  counter turns the looper on and off. Recursive feedback (`buf[p] = buf[p]*f +
  live`) gives infinite decaying repeats that never quite stop, and can run away.
  Neither is "a fixed number of full-volume echoes, then gone".

If the echo count appears to do nothing, check `loop_echo_gain` before suspecting
the taps — the tap arithmetic is simulation-checked, the gain is the part that
can silently zero the run.

## Display pipeline

### Views

The canvas area is divided into panes, one `<canvas>` each, on a CSS grid of
`viewCols` x `viewRows`. The point is to watch one performance against two
rulings at once -- `0.25x16` on the left, `0.3333x12` on the right -- so rows,
margins, grids, visual gain, split, bar-colour mode and refresh mode are all
per-pane, held in `views: ViewConfig[]`.

- **`views.length === viewCols * viewRows` is an invariant.** The arrangement is
  the only control over how many panes exist; `setArrangement` resizes the list,
  and `migrateViews` re-squares it on load. Growing copies pane 0 (adding one is
  nearly always "the same thing, against another grid"), shrinking truncates.
- **A view's arrays must never be shared between panes.** `copyView` deep-copies
  for exactly this reason -- two panes pointing at one `grids` array means
  editing either edits both.
- **Sessions from before views** carried these keys at the top level of the js
  config. `migrateViews` folds them into `views[0]` *before* `pickKnownKeys`
  runs, since that drops keys it doesn't recognise -- without it an upgrade
  would silently reset someone's rows and grids.
- **`viewsSequential` chains the panes instead of overlaying them.** Off, every
  pane covers the same beats against its own ruling -- the reason panes exist.
  On, the panes divide one long timeline: pane *k* covers the beats after every
  earlier pane's, so the signal runs through pane 1's rows, then pane 2's.
  `Layout` carries `cycleBeats` (what the display wraps on) and `chainStart`
  (where this pane sits in it); simultaneous is `cycleBeats = beatsPerWindow,
  chainStart = 0`, which is the pre-chain arithmetic exactly. Everything else
  followed from those two fields: `getCanvasPositions` subtracts `chainStart`
  and a beat belonging to another pane yields no positions, so an inactive pane
  simply stops being drawn over and holds its last pass. Margins bleed across
  the pane boundary and grids tile the whole timeline, both because the timeline
  is what repeats. `chainStart` is derived from the panes' own lengths, never a
  setting.
- **A beat exactly on a row boundary draws twice** -- dim at the end of the row
  above, solid at the start of the row below. Long-standing (the loop bound is
  inclusive at the right edge); chaining extends it to the pane boundary.
- **Each pane's backing store is measured from its own box**, in a
  `useLayoutEffect` holding one `ResizeObserver` over every canvas, times
  `devicePixelRatio`. It used to be `appWindow.innerSize()` -- the *window*, in
  **physical** pixels -- less a hard-coded 500x250, divided by the arrangement:
  numbers that stopped describing the layout as soon as the panel could be
  hidden or a gutter put between the panes, and that were in a different unit
  than the box besides. `canvasWidth`/`canvasHeight` are gone from the config
  entirely, and with them the window-resize listener that fed them.
  - **Nothing ever *moved* under the old scheme.** The draw code places
    everything as a fraction of the surface, so a beat sat on its grid line
    whatever the scale factor was. What the mismatch cost was resolution, and
    anisotropically: at the sizes in use the surface was ~1.4x the screen across
    and ~0.87x down, so the picture was oversampled horizontally and *upscaled*,
    i.e. blurred, vertically. The parts counted in pixels rather than fractions
    -- the 1px erase column, the grid hairlines, the onset ticks -- came out at
    different apparent weights across and down for the same reason.
  - **A pixel ratio change fires no `ResizeObserver`**, since the CSS box is
    unchanged, so a `matchMedia("(resolution: Ndppx)")` listener re-measures on
    it. The query can only ask about one ratio, so it is rebuilt around the new
    one each time it fires.
  - **The measurement is state, so it must not set state that has not changed**
    -- an unconditional `setPaneSizes` loops, and writing the `width` attribute
    blanks a canvas even when the number is the same.
- **Every pane carries `minWidth: 0, minHeight: 0`, and must.** A grid item's
  `min-width`/`min-height` are `auto`, and for a *replaced* element that floor
  is its own aspect ratio -- a `1fr` row will not shrink below the cell's width
  divided by the backing store's aspect. Hiding the 600px panel widened the cell
  enough for that floor to outgrow the window, and the bottom of the last row
  went under the edge of the screen. Zero lets the tracks size from the space
  there actually is -- and it is now **load-bearing in a second way**: with the
  backing store measured from the box, an aspect-ratio floor would let a bigger
  surface ask for a bigger box, which is a feedback loop rather than a
  one-off overflow.

- **A pane is cleared when its geometry changes**, not only when the background
  does -- `layoutKey` carries the backing store size, `pixelsPerBeat`,
  `cycleBeats`, `chainStart`, the margins and `beatsPerRow`. The sweep only ever
  erases columns it visits, so at a new zoom the old picture's bars stand in
  whatever columns the new one happens not to reach. The per-pane draw state is
  reset alongside, since a sweep position and a map of per-column peaks only
  mean something at one zoom -- **in place** (`Object.assign`), because the
  `ViewCtx`s the draw loop is holding reference those objects from the render
  before the effect ran, and replacing the array would leave the sweep on the
  old state.
- **`showFrameTime` overlays what the draw loop costs**, to answer whether a
  repaint-everything model is affordable before restructuring the draw path for
  it (see *Discussed but not built*). Off by default.
  - **It writes `textContent` from inside the loop, never through React.** A
    readout that caused a render sixty times a second would be measuring
    itself. The measurement is taken unconditionally -- two `performance.now()`
    calls -- and the write is skipped when the node isn't mounted.
  - **`draw` and `frame` answer different questions.** `draw` is the JS side of
    a frame; `frame` is the gap between callbacks, which is what actually says
    whether the loop is keeping up. Canvas work can be queued and rasterised
    after the JS returns, so a small `draw` next to a long `frame` means the
    cost is real but not where the timer is.
  - Accumulated over 250 ms and flushed, because a number changing every frame
    is unreadable -- and the **max** is the half that matters, since a repaint
    model would show up as occasional long frames rather than a raised average.
  - **`ops` and `us/op` are what make the timing actionable.** Every canvas
    primitive in the hot paths increments one counter, so the readout separates
    "there is too much to draw" from "each thing is drawn too expensively".
    Only the second is fixable without changing the picture, and the two call
    for opposite work.
  - **Measured 0.22 us/op, so the sweep was op-count bound, not state bound.**
    ~7 ms at that rate is ~32,000 primitives a frame -- which is what the
    per-column flush below was for.
  - **Measured under a stress test: ~7 ms average, ~30 ms max, 55-60 fps** --
    the sweep spending ~40% of a 60 Hz budget and dropping the occasional frame
    *before* any repaint model was considered. **After the per-column flush
    below: under 1 ms average, ~2 ms max, ~275 ops.** A hundredfold fewer
    primitives, and the headroom question is now settled the other way.
  - **`us/op` stops meaning anything once `ops` is small.** At ~275 the frame's
    cost is dominated by what the counter doesn't count -- the per-sample peak
    accumulation, `getCanvasPositions`, plain loop overhead -- so the figure
    rose to 1-2 while the frame got seven times cheaper. Read it only when
    `ops` is in the thousands.
  - A literal full repaint is still out: rows x pane width columns per channel
    per pane, of order 200k primitives, which at the 0.22 us/op measured when
    the counter was meaningful is ~50 ms a frame. Affordable **on demand**,
    never per frame. See *Discussed but not built*.
- **`drawSweep` flushes once per pixel column, not once per sample.** It used
  to compare the sweep position as a float, which changes on every sample, so a
  column was erased and redrawn once per sample that landed in it -- several
  times over at any zoom, and more the wider the pane. The `channelPeaks`
  accumulator was already there for exactly this; only the boundary was wrong,
  and the spectrogram had always flushed this way (`Math.floor`).
  - **A column is painted at `pendingBeat`**, the last beat that landed in it,
    when the sweep leaves -- not at the beat that triggered the flush, which
    belongs to the *next* column and would draw every peak one column late.
    `canvasPos` starts at -1 and `pendingBeat` at NaN so the first column of a
    fresh pane isn't painted from an empty accumulator.
  - **The picture gets more accurate, not just cheaper.** One stroke at the
    column's true maximum replaces several overlapping antialiased strokes at
    fractional x whose blend only approximated it.
  - It costs up to one column of display latency -- the tens of microseconds of
    audio in a pixel.
  - **It also exposed the eraser, which had never fully erased.** `eraseColumn`
    stroked a 1px line at a fractional x, which covers two columns at partial
    opacity; while the sweep flushed once per *sample*, several of those piled
    up per column and between them cleared it. One flush per column left a
    single partial stroke, and the previous pass showed through -- worse the
    further out you zoom, since that is where the pile-up had been deepest. The
    eraser and the channel trace now share `columnLeft(x, span)` and both draw
    filled rects on whole columns, so what is drawn is exactly what gets cleared
    next time round.
  - **Whole columns across, fractional down.** The horizontal edges have to land
    on the pixel grid for the eraser to cover them; the vertical extent is the
    *signal*, and rounding it would drop a quiet passage to nothing rather than
    drawing it faintly.
  - **`span` is how many columns the sweep just crossed, computed per copy on
    screen**, and normally 1. It is greater where the zoom puts consecutive
    samples more than a pixel apart, and those skipped columns have to be
    erased too -- the same ghosting at the other end of the zoom range.
    - **It cannot be taken once from the loop's own column index.** A row's `x`
      is the loop position minus a *fractional* offset (`rowStart` and
      `marginLeft` times `pixelsPerBeat`), so `floor(x)` and `floor(loopPixels)`
      cross pixel boundaries at different moments. One span for every copy left
      a column unvisited at some zooms -- and an unvisited column is never
      erased, so a bar from an earlier picture stood there indefinitely. The
      span comes from `lastFlushPixels` instead: the columns crossed are
      `(floor(x - advance), floor(x)]`, evaluated at each copy's own `x`, which
      tiles the column space exactly.
    - A non-finite advance is the first flush and a negative one is the loop
      wrapping; both mean "just this column". The pane's width bounds the rest.
- **Each pane draws through an offscreen layer.** `layers` holds one detached
  canvas per pane carrying everything painted *incrementally* -- the sweep's
  waveform, the flux, the onsets, the spectrogram's columns. Every frame the
  visible canvas is rebuilt: one `drawImage` of the layer, then the grids over
  it.
  - **The grids are the whole reason.** They used to be painted straight onto
    the pane every frame, compositing over their own previous pass, which drove
    any `alpha` below 1 to opaque within about a second -- so a grid's alpha was
    honest only just after the sweep erased it. Onto a surface rebuilt every
    frame they land exactly once, at the alpha asked for.
  - **It also settles where a grid line sits.** Sweep mode had them *under* the
    waveform in the column the sweep was in and *over* it everywhere else;
    whole-cycle mode had them under; the spectrogram drew them per column,
    clipped, specifically to dodge the compositing problem. All three now paint
    them on top, once, and the spectrogram's clip dance is gone.
  - **The layer is sized on demand** in `layerFor`, and setting either dimension
    blanks it -- which is what a resize wants. It is filled with the background
    on creation, so the `drawImage` is opaque and the pane needs no clear of its
    own.
  - Cleared alongside the visible canvases whenever the background or
    `layoutKey` changes: the layer is where the stale picture actually lives.
- **One `requestAnimationFrame` loop, in `App`.** It draws every pane and then
  drains the sample batch **once**, after all of them have read it. `Canvas.tsx`
  used to own the loop and clear the buffer itself; with more than one pane that
  races, and whichever drew first would eat the samples. The loop reads the
  current draw closure through a ref rather than depending on it -- the old
  `[draw]` dependency rebuilt the loop on every render.
- **Draw state is per-pane** (`ViewDrawState`): sweep position, cycle columns,
  and channel peaks. Panes disagree about where a pixel column ends, because
  `pixelsPerBeat` is derived from each pane's own cell width.
- Only `channelStyles` and the channel selection stay global, so a channel keeps
  its colour in every pane -- unless the pane sets row colours, below.

### Layout chrome

`waveformBackground`, `paneGap` and `paneGapColor` in `defaultJsConfig`, edited
in the *layout* Section at the top of the visual tab. What a pane sits on, and
what sits between the panes -- the frame rather than the signal.

- **Global, not per-pane.** A gutter belongs to no one pane, and a background
  differing pane by pane would read as a difference in what is being *drawn*
  rather than in what it is drawn on. The per-pane palette is `rowColors`, which
  describes the signal; these describe the surface. `WAVEFORM_BACKGROUND` was a
  module constant and is now `const background = get("waveformBackground")`,
  read once per render next to `viewCols` -- the three draw sites (`eraseColumn`,
  the spectrogram column, `paintWholeCycle`) close over it.
- **Changing the background repaints every canvas from an effect**, because the
  sweep *never clears*: it erases one column at a time just ahead of where it
  draws, so a new colour would otherwise arrive a column per frame and leave the
  pane in two colours for a whole cycle -- and dragging the picker makes that a
  stack of bands. The repaint costs the waveform already on screen, which is
  what a resize already does.
- **The gutter is the grid container showing through**, so `paneGapColor` is
  that element's `backgroundColor` and not anything a canvas paints. It is
  invisible at a 1x1 arrangement or a gap of 0, and the panel says so rather
  than leaving a control that appears to do nothing.
- **The gap costs the panes their width, exactly.** The gutter comes out of the
  grid's tracks, and each pane's backing store is measured from the track it
  lands in, so a wider gap gives every pane a genuinely narrower surface rather
  than the same surface squeezed. Nothing has to know the gap is there.
- **`gridWidth` is in CSS pixels, not surface pixels**, and `drawGrids`
  multiplies it by the pane's measured ratio. The hard-coded `lineWidth = 2`
  was in surface pixels, so its weight moved with the surface-to-screen scale --
  hiding the panel used to make grid lines 65% heavier, and a Retina pane drew
  them at half the weight an external monitor did. A CSS width is the same line
  everywhere. The default of 1 is exactly what the old constant came to on a 2x
  display, so nothing changes until the slider is moved.
  - **Grid lines are filled rects on whole pixels, not strokes.** A stroke at a
    fractional `x` -- which is every one of them -- spreads its width over one
    more column than it asked for, at partial coverage. That would only be soft
    edges, except that sweep mode repaints the grids *every frame*, so alpha
    compositing drives every column the stroke touches to full opacity within
    about a second. The width on screen was therefore how many columns the
    stroke overlapped: 1 device pixel and 2 came out as 2 columns and 3, which
    is why the control looked like it did nothing. `fillRect` on rounded
    coordinates with a whole-pixel width draws exactly the columns asked for.
  - **The same repainting makes a grid's `alpha` nearly inert in sweep mode.**
    It is honest for the fraction of a second after the sweep passes a line and
    then saturates. Fixing it means painting the grids per column inside the
    sweep, the way the spectrogram already does, rather than over the whole pane
    every frame. Not done.
  - **0.5 is the floor because that is one device pixel on a 2x display** --
    the thinnest line the screen can draw, which is the end of the range worth
    having. Below it a line is a fraction of a pixel and antialiases to a
    smudge; a fainter grid is what each grid's own `alpha` is for.
  - **The panel resolves the width against `paneSizes[0].scale`**, the ratio the
    panes were actually measured at, rather than reading
    `window.devicePixelRatio` again -- the readout should name the number being
    drawn with, not a second opinion about it.
  - The waveform stroke, the erase column and the onset ticks are **still in
    surface pixels** and so still display-dependent. They are a coupled set --
    the eraser must be at least as wide as what it erases -- and giving them CSS
    widths would double their weight on a Retina display, which is a look to
    choose deliberately rather than to inherit from this change.
- **`ColorInput` is called by name, not dispatched on type.** `Input` picks its
  widget from the value's type, and `filePath` is a string too -- "every string
  is a colour" would be wrong the moment anything else took one. Same treatment
  as `Slider` and `RowColorList`.

### Row colours

`rowColors` is a per-pane list of colours and `rowColorPattern` says which row
takes which, 1-based, in the same `parseNumberList` syntax as `beatsPerRow`.
`rowColorFor` in `config.ts` resolves them, next to `gridAlpha` and `drumGains`.

- **Both patterns are expression-backed**, so `1, 2x(n-1)` puts a beat marker
  every `n` rows and follows a parameter change. They are in `resolveView`'s
  walk, which is the prerequisite (see *Parameters and expressions*); the widened
  `NumberListExpr | number[]` and `normalizeView`'s `wrapList` are how a saved
  palette survives the shape change. `rowColorFor` reads both through
  `exprList`, so a bare array that reaches it anyway still colours.
- **The pattern is cycled by row index, not stretched over the rows.** Like drum
  `gains`, a pattern that doesn't divide the row count drifts rather than
  resetting. That's the point: `0.25x16` rows with `"1,2x3"` puts colour 1 on
  rows 0, 4, 8, 12 -- exactly the 16ths that start a beat.
- Empty `rowColors` means rows keep the channel's colour, so panes behave
  exactly as they did before this existed. One colour (or an empty pattern)
  paints every row the same. The pattern input only appears once there are two
  colours to choose between; emptying the colour list is the off switch, since
  `parseNumberList` rejects an empty list and so can't clear the pattern.
- An index past the end of the colour list **wraps**, so deleting a colour can't
  leave the pattern reading `undefined`.
- **Row colour overrides the channel colour**, so with several channels visible
  in one pane they all draw in the row's colour. `barColorMode` still wins over
  both -- it encodes amplitude as brightness, so a hue would have nothing to
  say.
- **A split row can read the palette through two patterns.**
  `rowColorPatternDown` is the lower half's, and empty -- the default -- means
  it reads `rowColorPattern` like the upper half, which is how panes behaved
  before it existed. One palette rather than two lists: with `1,2x3` above and
  `3,4x7` below, the two channels come out of different parts of the same
  colours and both still mark the beat. `rowColorFor` takes the half, and
  `"both"` (an unsplit row) reads the upper pattern.
- Like `rowColorPattern`, it **cannot be typed back to empty** --
  `parseNumberList` rejects an empty list, which is also why an empty pattern
  field shows a red border in a pane that has colours but no pattern yet. The
  value is right (every row takes colour 1); only the border is misleading. Setting it to the same text as the
  upper pattern is the equivalent, and turning `splitChannels` off ignores it
  entirely.

### Grid and click offsets

Both are the *musical* half of the drum pair -- a `shift` in beats, positive
moving the pattern later, subtracted (or added, on the display side) the same
way `DrumVoice.shift` is. Neither gets a millisecond partner: a grid is drawn,
not sounded, and the click is synthesised in the callback, so there is no file
attack to align.

- **`VisualGrid.shift` is expression-backed**, unlike the drums'. The drums'
  are literals because they are nested in the `drums` array and *not* in the
  re-resolution walk, so an expression there would go stale on a parameter
  change; `resolveView` already walks every grid to re-resolve its rhythm, so a
  grid's shift is re-resolved with it and `1/3` or `bar/n` are safe to type.
- **Optional, like `alpha`**, and read through `gridShift`. Left absent rather
  than defaulted by `resolveView`, so a preset saved before this keeps its shape
  and answers 0.
- **Reduced modulo the pattern length before drawing**, since the pattern tiles
  every `end` and a whole pattern of shift is a no-op -- the same property the
  drums' shift has. The tiling starts one pattern *early* (`startBeat = -end`)
  and skips negative results, or a shift would leave the first beats of the pane
  empty instead of filling them from the previous tile.
- **`clickShift` is an ordinary `RustExprKey`** -- registered in `RustExprKey`,
  `RUST_EXPR_FIELDS` and `RUST_EXPR_KEYS` like every other Rust-side expression
  -- and reaches the callback as `beat_bisect(&click_times, beat -
  config.click_shift)`.

`getCanvasPositions(layout, beat)` in `layout.ts` returns **every** place a beat
appears on screen. Each row draws its own beats plus `marginLeft` beats of lead-in
and `marginRight` of lead-out; because the loop repeats, a margin wider than the
loop shows the same beat multiple times (a 1-beat row with margins of 2 draws it
five times, filling the width). Copies outside a row's own beats are flagged
`isMargin` and drawn dimmer.

The canvas is **never cleared** in sweep mode. Erasure is a dark
`WAVEFORM_BACKGROUND` column painted by `eraseColumn` just before the channels are
drawn over it. Two draw modes:

- **Sweep** (default) — erase and redraw each column as the cursor reaches it.
- **`refreshAtCycleEnd`** — accumulate a peak per pixel column for the whole
  window, then `fillRect` + repaint everything when the beat wraps. No per-column
  erase here (the fill already cleared), so grids stay visible behind quiet parts.

### The visual latency offset

The sample stream is stamped with `visual_beat = beat - buffer_compensation *
beats_per_sample`, i.e. in *input* time, so audio you played is drawn where you
played it. The drums and click aren't captured — they're synthesised in the
callback — so that shift would draw them ~98 ms early. `BusDelay` in `structs.rs`
holds both bus values for `buffer_compensation` frames so they meet the stamp on
their own beat. It only allocates on resize, which happens once per callback next
to `drum_last_beats.resize`. Audio is untouched by this; it is display-only.

### Channels

Channels are named by *device channel index*, and indices past the input count
are **synthetic buses**, in the order the frontend labels them:

```
[ ch 1 … ch N ]  [ drums ]  [ click ]  [ file ]
     inputs        bus N      bus N+1    bus N+2
```

The frontend's `channelLabels` order **must** match how `main.rs` fills them.
Only real inputs are pannable — the buses aren't routed.

The sample stream is flattened — `{channels, beats, values}`, one beat per frame
and `channels` values after it, read as `values[i * channels + c]`. Flattened
rather than a Vec-of-Vecs so the audio callback never allocates per frame.

**Which channels a pane draws is per-pane** (`views[i].channels`), and
`visibleChannels` is no longer a setting: it is the *union* of what the panes
ask for, and exists only to tell the callback what to pack.

- **Everything user-facing is indexed by device channel.** The pane's list, the
  colours (`channelStyles`, global, so a channel looks the same everywhere), the
  pans, `spectrogramChannel`, and the flux and onset streams all agree. Only the
  sample stream is in packed order, and `streamSlots[channel]` is the one place
  that translates. Before this there were two conventions and `drawFluxAt` was
  where they collided.
- **The union is pushed from an effect**, guarded on equality, rather than from
  each of the five places the panes can change (a per-pane edit, the
  arrangement, a preset, the restored session, a pane being dropped). It cannot
  loop: the union is a pure function of `views` and the push is a fixed point.
  This is the one pane setting that reaches the audio thread at all.
- **A channel a pane wants that isn't packed yet reads `undefined` and is
  skipped**, so the frame or two between adding a channel and the stream
  widening draws nothing rather than misreading a neighbour.
- `splitChannels` splits by position *within the pane's own list*, so two panes
  showing different pairs each split their own.
- **`channelGains` is a per-channel display trim**, sparse and 1 where unset,
  multiplied into the pane's own `visualGain` so a quiet mic and a hot line can
  share a row. Display only -- unlike the pans it never reaches the audio
  thread -- and it applies to the synthetic buses too. Waveform only: the flux
  and the spectrogram have their own gains, and the flux is a normalised dB
  measure that a level trim would say nothing about.
- **A session written before this has no per-pane lists**, so `normalizeView`
  seeds every pane from the old global `visibleChannels` — including the
  pre-views path, where `defaultViewConfig()`'s own `channels: [0]` would
  otherwise win and quietly reset what was on screen.

### Drums

Each `DrumVoice` has a path, its own rhythm, a volume, an offset in ms, and a
`shift` in beats. The two offsets are different things: `shift` is *musical*
placement (which beat the part starts on, tempo-independent) and is subtracted
from the beat before bisecting; `offset` is *mechanical* alignment for the file's
attack and is added. A shift of a whole cycle length is a no-op, since the rhythm
repeats.

`gains` is a list of per-hit multipliers on top of `volume`, using the same
`parseNumberList` "1,0.5x3" syntax as `beatsPerRow`. It is indexed by *hit count*
(`hit.rem_euclid(gains.len())`), not by position in the bar, so a list whose
length doesn't divide the rhythm's deliberately drifts in and out of phase rather
than resetting each cycle. Empty means no modulation.
**The offset is a look-ahead, not a seek**: triggering evaluates
`beat_bisect(times, beat + offset_beats)` so the sample starts *early* and its
transient lands on the beat. Seeking into the file would chop the front off a
slow attack. `offset_beats = offset_ms / 1000 * bpm / 60`.

`shift` and `gains` carry `#[serde(default)]` because `presets.ts` only merges top-level
keys — a session saved before it existed has drum voices without the field. The
TS side mirrors this with optional `shift?` / `gains?` read through `drumShift()`
and `drumGains()`, the same pattern as `VisualGrid.alpha`.

Files are decoded in Rust by `load_drum_sample` and keyed by path; the callback
only does a map lookup. Built-ins are keyed by plain name (`"ride"`) so a voice
can refer to one without knowing the install path.

### The file player

One file, played along with, looping. `playFile` switches it, `fileVolume` is
its output gain, and it appears as the third synthetic bus so it can be drawn
against your own playing like any other channel.

- **The read position is derived from `beat`, never accumulated.** This is the
  whole of the sync fix. `mp3.pos` used to be a counter incremented once per
  output channel and wrapped at `buffer.len()`, with nothing anywhere
  reconciling it against the beat clock -- they agreed only at a beat reset, and
  any mismatch between the file's length and its length in beats added up, one
  wrap at a time, without bound. A bounce 40 frames longer than exactly 8 beats
  is 4505 frames -- 102 ms -- out after ten minutes, which is what "it slowly
  goes out of sync" was. Simulation-checked both ways: derived lands within one
  frame of the file's start on every eighth beat over the same ten minutes.
- **`fileBeats` is what makes that possible, and 0 means "don't".** Above zero
  the file is phase-locked: `phase = (beat - fileShift) mod fileBeats`, times
  the frame count. At 0 it free-runs at its natural rate off `Mp3Buffer::pos`,
  which is the old behaviour minus the bugs -- and is not locked to anything, so
  it will still slide against the grid. That's honest rather than fixable: a
  file whose length nobody has declared has no beat.
- **A rounded bpm cannot slide the file off the grid.** With the position
  derived from `beat`, tempo only sets the playback *rate*; the file still hits
  its start exactly on the beat. That is why `set tempo from file` can round to
  four places -- the residue is a millionth of a semitone of varispeed, not a
  drift.
- **Declaring a length that isn't the file's natural one is a varispeed**, and
  the read interpolates for it. At the natural rate `frac` is 0 and the read is
  an exact sample copy, so nothing is filtered that needn't be.
- **`fileOffsetMs` and `fileShift` are the drum `offset`/`shift` split**, for
  the same reasons: ms is mechanical (a bounce whose downbeat sits a few ms in),
  positive *earlier*; beats is musical placement and is tempo-independent.
- **The rate and channel count were decoded and thrown away**, which was two
  silent bugs at once: a 44.1k file on a 48k device played 8.8% fast, and a mono
  file played an octave high because the position advanced once per output
  channel. `decode_audio_file` now returns them and `to_device_stereo` converts
  **at load**, off the audio thread -- linear interpolation, and mono goes to
  both sides at full level rather than being panned. `get_samples_from_filename`
  is that pair composed, so the drum voices were fixed by the same change.
- **`mp3_loaded` was captured at startup from a hard-coded path**
  (`/Users/eric/Music/Logic/tauri-file.wav`), so on any machine where that file
  doesn't exist, picking a file decoded it and then never played it. The
  callback asks the buffer instead. The startup path is still there and still
  personal; nothing depends on it any more.
- **Loading a file no longer resets the beat.** It used to, because that reset
  was the only thing that ever aligned the two clocks. Now the file is locked to
  the beat by construction, so restarting the clock to line a file up is neither
  needed nor wanted mid-practice.
- **A-B repeat is the same formula with a different cycle.** `fileRepeatOn`
  plus `fileRepeatStart`/`fileRepeatEnd`, in the *file's* beats, cycles over
  that segment instead of the whole file; off, the segment is `0..fileBeats`,
  which is the pre-existing arithmetic exactly (checked position-for-position).
  The segment repeats on **its own length**, so a 3-beat A-B against a 4-beat
  grid deliberately walks around the bar rather than resetting -- the same
  choice drum `gains` and `rowColorPattern` make.
- **The segment may cross the file's end.** There are two wraps: the phase into
  the segment, then the resulting file beat into the file. So `14..18` of a
  16-beat file is the last two beats followed by the first two, which is how you
  loop a pickup. Nothing can index outside the buffer -- checked by sweeping
  50 beats either side of zero for segments that are negative, wrapping, tiny
  and entirely past the end.
- **A backwards or zero-length segment falls back to the whole file** rather
  than being refused, because it's a state you pass through while typing the
  other end. Same for A-B with no `fileBeats`: a position in beats means
  nothing until a length in beats has been declared, and the panel says so
  rather than silently doing nothing.
#### Time stretching

`fileStretch` renders the file to fit `fileBeats` at the current tempo without
moving its pitch. **`docs/` has nothing on this; `stretch.rs` is the reference.**

- **Nothing about it runs on the audio thread, and that is the whole design.**
  The ratio changes only on a config event, and the file is known in advance, so
  the entire file is re-rendered on a worker thread and the result swapped in.
  The render callback is untouched: it still reads a plain buffer at a position
  derived from the beat. This is the same shape as the load-time resampling, for
  the same reason.
- **The ratio needs no new setting.** `naturalBpm = fileBeats * 60 /
  naturalSeconds`, and the ratio is `naturalBpm / bpm` -- both numbers are
  already on screen. The frontend derives it independently for display rather
  than asking Rust, since it is a consequence of two fields it owns.
- **WSOLA, not a phase vocoder**, although `realfft` is already in the tree and
  would have made one easy. A phase vocoder smears transients, and smeared
  transients are exactly what this app exists to let you place. WSOLA is
  overlap-add with a similarity search choosing where each grain is cut from,
  which is what keeps successive grains in phase.
- **Both buffers are circular.** The file is going to be looped, so wrapping the
  overlap-add across the end is what makes the loop point seamless instead of a
  fade to silence every cycle. Measured: block peaks stay within 0.999-1.000
  across the seam.
- **The render is rounded to a whole hop, and that cannot desync anything.** The
  read position is a fraction of *whatever length the buffer turns out to be*,
  so the file still spans `fileBeats` exactly; the rounding shows up as a
  ~0.05% difference in playback rate and nowhere else. This is the same property
  that lets `set tempo from file` round to four places.
- **`natural` is kept alongside `buffer`.** Every render is computed from the
  unstretched source, never from the last stretch -- restretching a stretch
  compounds artifacts, and the ratio moves every time the tempo does. Costs a
  second copy of the file in memory.
- **A `generation` counter is what makes it safe to ask on every keystroke.**
  The frontend pushes a config per keypress, so typing `120` is three requests.
  Each bumps the counter; a render that finishes holding a stale one is dropped
  rather than applied over a newer answer. A 200 ms debounce in front of it
  means the superseded ones usually never start.
- **The swap allocates and frees outside the lock**, and `mem::replace`s the old
  buffer out to be dropped after unlocking. The callback holds this mutex for
  its whole run, so a 23 MB free inside it is time the audio thread waits.
- **Lock order is config, then file** -- the same order the callback takes them,
  which is why `set_config` drops the config guard before requesting a stretch.
- **Quality is honest to about a third either way.** Measured: a 440 Hz sine
  comes back within 0.5 Hz from 0.5x to 2x, where naive resampling puts it at
  293 Hz at 1.5x. But past ~0.75-1.33 a drum loop starts to flam and sustained
  material warbles, so the panel turns the ratio orange there. Logic's Flex Time
  is much better; bouncing per tempo is still the right answer for big changes.
- 10 s of stereo renders in ~375 ms, which is why there is a `file-stretch`
  event and a `rendering…` note rather than a silent pause.

- **`filePath` lives in the js config** so a session comes back with its file
  loaded -- Rust holds decoded samples and not the path, so the frontend pushes
  it back through `set_mp3_buffer` once on mount. `set_mp3_buffer` returns a
  `FileInfo` (frames, seconds, source rate and channels, device rate), which is
  what the panel prints and what `set tempo from file` divides.

### The analysis stream and the spectrogram view kind

A second stream, deliberately separate from `VisualSamples` so the per-frame path
is untouched: `analysis.rs` runs a Hann FFT every `window / 4` frames per input
channel, groups the magnitudes into 64 bins and sends them as `u8` decibels.
`views[i].kind = "spectrogram"` draws them instead of the waveform; everything
else about the pane -- rows, margins, grids, `getCanvasPositions`, the sweep --
is unchanged.

- **The window is a setting, `analysisWindow`**, one of `ANALYSIS_WINDOWS`
  (256/512/1024/2048/4096), default 1024. It is the frequency-vs-time trade, and
  **the hop is always a quarter of it** so one control moves the smear, the
  column width and the flux's precision together while the overlap stays at the
  conventional 4x. A dropdown, so a plain number rather than an expression.
  Anything not in the list snaps to the nearest that is. Global, not per-pane:
  one FFT feeds every pane and the flux.
- **Changing the window allocates nothing.** Every size is planned at startup
  and every buffer is sized at `MAX_WINDOW`, so `configure` only recomputes the
  Hann table and the bin edges in place. `realfft` wants `input` and `spectrum`
  at exactly the transform's length but only requires `scratch` to be *at least*
  long enough, which is why one max-sized scratch serves every plan and the
  other two are sliced. Pointer-identity checked.
- **A shorter window makes the low end worse**, in the specific way `edges`
  already documents: wherever log spacing asks for finer than the window's
  resolution the axis is one bin per group, i.e. linear, and a shorter window
  pushes more of the axis into that regime. That is the cost of the trade, not a
  bug to fix.
- **All the FFT state is in one `Analyzer`**, built before the render closure so
  the planners and scratch buffers are allocated once. `configure(channels,
  window)` is called once per callback next to `bus_delay.resize`; `push` per
  frame, next to where `input_frame` is filled -- *not* inside the
  per-output-channel loop. Reset on beat reset, while paused, and on either
  change, so no window is stitched across a gap and no spectrum is differenced
  against one grouped by different edges.
- **The stamp is the window centre.** A hop completing at frame *i* describes
  the window centred `window_len/2` frames earlier, so it is stamped
  `visual_beat - (window_len/2) * beats_per_sample` -- the sample stream's stamp,
  less half a window, **read from the analyzer** since the window moves.
  Attaching it to frame *i* draws every column a whole half window late: ~92 px
  at `0.25x16` and 140bpm with the default window, which reads as the FFT being
  broken rather than the stamp. (Simulation-checked, along with the flattening
  index below.)
- **The flux scale is stable across windows.** Magnitudes are normalised by the
  window length, so a hard 1 kHz attack measures ~0.30-0.32 at every size --
  changing the window must not move the picture's brightness or make a threshold
  mean something different. Measured, not assumed.
- **The `u8` contract is fixed at -100..0 dB.** 0 is silence, 255 is full scale.
  Deliberately wide, because `spectrogramGain` and `spectrogramFloor` are applied
  in the frontend: tuning the picture must never push config to the audio thread.
- **The stream is flattened** the same way and for the same reason as the
  samples: `mags[(hop * channels + ch) * bins + bin]`, `beats` one per hop.
  `channels` is the *analysed input* count, capped at `MAX_ANALYSIS_CHANNELS`
  (4) -- device channel order, not the `visibleChannels` subset, so
  `spectrogramChannel` indexes it directly. The synthetic buses have no spectrum.
- **`analysisOn` is the off switch**, default true. Not derived from whether any
  pane is a spectrogram: that would mean writing rust config from a render.
- **A column is as wide as the gap since the last one.** Hops arrive 172 times a
  second, which at high zoom is dozens of pixels apart, so a one-pixel line per
  hop would draw a picket fence. The column is painted *backwards* from the
  hop's x -- it covers the span ending at that beat. At low zoom several hops
  share a pixel and the per-bin max wins, so the flush boundary here is a whole
  pixel column (`Math.floor`), unlike `drawSweep`'s float compare.
- **Grids are drawn per column, clipped to it, after the spectrum.** A column
  fills the row height, so grids have to go on top; repainting the whole pane's
  grids every frame instead would composite a sub-1 alpha to opaque in a few
  frames.
- `refreshAtCycleEnd` is ignored for spectrogram panes. Sweep only.

### Onsets

Peak picking over the flux, in `Analyzer::pick_onset`, reported as sparse
`Onset { beat, channel, strength }` on the same stream. `views[i].showOnsets`
draws each as a short tick at the row's edge in the channel's colour -- short
and at the edge so it can't be mistaken for a grid line, which is the thing it
exists to be read against.

- **Three standard conditions**: largest within `peak_radius` either side,
  standing `onsetThreshold` above the *median* of the `median_back` hops behind
  it, and at least `onsetMinGap` after the last onset on that channel. Median
  rather than mean because a mean is dragged up by the very peaks being
  detected, which suppresses the next one.
- **The spans are in milliseconds, not hops** (20 ms radius, 100 ms median),
  converted in `retune`. Fixed in hops they would silently become 70 ms of
  lookahead at a 4096 window and 1.5 ms at 256.
- **The picker runs `peak_radius` hops behind**, because a candidate needs
  neighbours on both sides. That is the only latency it adds on top of the half
  window, and it is affordable exactly because the display already runs
  `buffer_compensation` behind the audio.
- **Nothing is reported for 60-140 ms after a reset**, depending on the window:
  the guard waits until a candidate has a full median behind it and a full
  radius in front. Not a bug -- a peak picked across the gap would be measured
  against a median from before it.
- **`ONSET_CENTRE_BIAS = 0.32` is a measured correction, not a fudge.** The hop
  stamp names its window's *centre*, which is right for a spectrogram column and
  wrong for an onset: the flux peaks when a transient *enters* the window.
  Measured against clicks at known frames the lead came out at
  0.303/0.318/0.321/0.336/0.321 of the window for 256..4096 -- proportional and
  otherwise constant. Uncorrected it is ~60 px at `0.25x16` and 140bpm.
  With it, reported times land within half a hop at every window.
- **`onsetOffset` (ms) is the trim on top**, because that 0.32 was measured on an
  instant attack and a slow-attack instrument sits differently. The drums bus is
  the reference to calibrate against -- the callback knows its trigger times
  exactly, which is the one thing in this app that has only ever been set by ear.
- **Sub-hop placement.** A parabola through the candidate and its two neighbours
  recovers the peak between them; a hop is 5.8 ms at the default window, which
  is ~46 px at the zoom levels in use, so the hop grid alone would be the
  binding limit on a tool about where an attack sits.
- Onsets carry their own beat, so they are *not* indexed against `beats`, and
  they survive `barColorMode` (a tick sits on top of the shading) where the flux
  does not.

#### Spectral flux

The onset detection function, computed in `analyze_into` next to the
spectrogram's bytes and sent on the same stream: `flux[hop * channels + ch]`,
one f32 a hop a channel, unclamped.

- **It rides here rather than in the sample stream on purpose.** A hop describes
  the window centred `WINDOW/2` frames back, and a per-frame value can only be
  stamped *now* -- so putting the flux in `VisualSamples` would need a 512-frame
  delay line on every other channel and the whole display shifted to match. This
  stream is already stamped at the window centre, so there is nothing to align.
  `buffer_compensation`, the sample stamp and `bus_delay` are untouched by any of
  it. `docs/onsets.md` has the long version.
- **Log domain, not linear.** The sum of positive frame-to-frame change in *dB*,
  so the same attack reads about the same whether it lands in a quiet passage or
  a loud one -- which is what lets a threshold over it be one setting rather
  than one per dynamic. Falls don't count: a note decaying is not an onset.
- **The dB values are floored at -100 dB before either consumer sees them.** The
  `u8` never noticed, since anything under the floor already clamped to 0. The
  flux does: a bin holding numerical noise sits near -300 dB and wanders tens of
  dB a hop, and without the floor that noise was most of the number. Found by
  test, not by reading.
- **Normalised per bin, not per band.** Divided by 20 dB (a factor of ten in
  amplitude, roughly what a bin does under a transient) *and* by the number of
  groups actually in the band, so narrowing the band doesn't rescale the curve.
  A strong full-band attack measures around 2.3, so the useful `fluxGain` is
  below 1 -- it defaults to 0.3 over a 0.05..4 slider. The normalisation is
  about a threshold meaning the same thing at any dynamic, not about the curve
  filling a row.
- **`analysisBandLow` / `analysisBandHigh`, in Hz** (30 / 16000) are how you stop
  a bass note reading on a snare's detector. Expression-backed, so they are
  registered in `RustExprKey`, `RUST_EXPR_FIELDS` and `RUST_EXPR_KEYS`.
  `Analyzer::band_groups` turns them into a group range **once per callback**,
  from the groups' real spans rather than the nominal log spacing, and falls back
  to the full range for anything unusable -- reversed, non-finite, or covering no
  group.
- **The first hop after a reset reports 0.** Its "previous" spectrum is the
  zeroed buffer, which every bin is far above, so it would read as a full-scale
  onset on every unpause. `hops_since_reset` is a count rather than a bool
  because `analyze_into` runs once per channel and the state has to outlast all
  of them; `reset()` clears it and `prev_db` along with the ring.
- **Drawn after `drawSweep`**, which erases each column immediately before
  redrawing it -- draw the flux first and it is wiped. It lands a few pixels
  *behind* the sweep cursor, because its stamp is half a window older than the
  newest sample. That is the stamp being honest, not lag.
- Per-view `showFlux` / `fluxGain` are plain values, not expressions: a checkbox
  and a slider have nowhere to type one. Both draw modes work --
  `fluxColumns` mirrors `cycleColumns` for `refreshAtCycleEnd`, collected before
  the wrap check because a cycle's last hops arrive after its samples have
  wrapped.
- **Indexed by device channel, not by stream slot.** The sample stream is packed
  in `visibleChannels` order; the analysis stream is in device order, so
  `drawFluxAt` reads `peaks[visibleChannels[slot]]` and draws it in
  `visibleStyles[slot]`'s colour. A slot pointing at a synthetic bus has no
  entry and is skipped -- the buses aren't captured, so they have no spectrum.
- Skipped for spectrogram panes and in `barColorMode`, both of which fill the
  row height: there is nowhere to put a second signal.

## Failing loudly

A config push is all-or-nothing and used to fail in silence, which cost a
debugging session on 2026-09-06: a click rhythm of `0` made the panel look
completely dead -- pause, mute, every button -- while the audio carried on
exactly as before.

- **Tauri deserializes a command's arguments before the command runs**, so one
  bad field means the *whole* `set_config` is refused and Rust keeps whatever it
  last accepted. Nothing in the panel changes: React state updates, the checkbox
  ticks, the field is green. Only the sound disagrees.
- **The trigger was `JSON.stringify(NaN) === "null"`**, and serde will not take
  `null` for an `f64`. `parser2`'s `Result` rule wraps every note into the cycle
  with `t % endTime`, which is NaN when `endTime` is 0 -- so `"0"`, `"4:0"`,
  `"0:1"` and `"1/0"` all parsed *successfully* into a config that could never
  be sent. The grammar rejects a non-positive or non-finite span now, the same
  way and for the same reason it rejects a repeat count below 1.
- **`invoke("set_config")` now has a `.catch`** and the panel shows a red banner
  saying what you are looking at is not what is playing. This is the fix that
  matters: the grammar hole is closed, but the next one won't be, and a push
  that fails has to be visible rather than inferred from the sound not changing.
- **A saved session was the worse half.** The session is written on every config
  change, so a `null` time went to local storage and came back at launch --
  rejecting every push from the first render, before anything could be retyped.
  `sanitizeRhythm` in `presets.ts` swaps an unusable `val` for the default's
  while keeping `inputText`, so the field still shows what was typed and still
  reads red. Applies to `audioSubdivisions` and each drum voice's rhythm; the
  view grids don't need it, since they never leave the frontend and `drawGrids`
  already skips a non-positive span.
- **`resolveRhythm` refuses an unusable re-parse too.** A parameter can make a
  rhythm degenerate without the field being touched -- `n:1` with `n` set to
  0 -- and there's no input component watching that path to turn red.
- **Two audio-thread guards, independent of all of the above.** `beat_bisect`
  falls back to its default cycle when the span isn't finite and positive:
  `beat / 0` saturates the loop count to `isize::MAX` and then *overflows* to
  `isize::MIN` on the way out, which in release wraps silently and stops the
  click triggering at all. And `mod_add` returned into a `while res >= max`
  loop that never terminates when `max` is 0 -- a hung render callback holding
  every lock the IPC thread needs, which is the worst failure available here.
  Both are O(1) and neither depends on the frontend having validated anything.

## Known issues / latent bugs

- ~~**Mono audio files play at double speed.**~~ -- **fixed 2026-09-06.**
  Everything is converted to interleaved stereo at the device rate on the way
  in, so `sounding_samples[j].pos += 1` per output channel is now a correct
  assumption rather than a lucky one. See *The file player*.
- **The channel count `2` is a magic literal** in the output stream format and
  `if ch == 0 || ch == 1`. Untangling these into one constant is prerequisite work
  for any further channel changes.
- **The click counter ticks twice per frame** (once per output channel), so
  `click_sound_counter = 400` is really 200 frames. Moving it out of the output
  loop would double the click's length — halve the constants if you do.
- A zero-length `beatsToLoop` used to panic; guarded now, but similar bare
  indexing exists elsewhere.
- ~~`SAMPLE_RATE` hard-coded at 44100~~ -- **fixed 2026-09-06**, adopted from
  the input device instead. See *Input capture*. The rate is still read **once**
  at startup: changing the device rate in Audio MIDI Setup, or switching the
  default input device, while the app is running is not picked up and needs a
  restart.

## State as of 2026-08-30

Verified by the owner in the real app: single-channel input, 2-channel input with
up/down split, per-channel looping, the scrollable settings panel, multiple
views, row colours.

Not verified by ear: drum offsets landing where expected, panning, the
drums/click display buses, and the multi-tap looper. The click's timbre was
preserved *by construction* (its counter and per-channel RNG were deliberately
left untouched) rather than by listening.

Parameters and expressions are committed (`variables`, `arithmetic in more
places`) and covered by temp tests that were run and deleted.

The analysis stream, the spectrogram pane and the spectral flux are new and
**nobody has looked at either picture**. The arithmetic (hop timing, the
window-centre stamp, the flattening index, the log bin edges) is simulation- and
unit-checked, and so is the flux: silence reads 0, a tone entering reads 2.3 and
under 0.009 across twenty hops of sustain, a decay reads 0, a band excluding the
tone reads 0, the first hop after a reset reads 0, and the spectrogram bytes are
bit-identical to the pre-flux formula. That either picture is legible against
real playing, that the flux spikes on real attacks and not between them, and
that both line up with the grid, are not.

The macOS `Info.plist` and entitlements fix is committed (`documentation &
permissions`) and was verified against a real build with `plutil` and
`codesign`. **Confirmed working 2026-09-06** on a second Mac: the prompt
appears and the bundle captures on its own grant (see the 2026-09-06 note).

Still unchecked on the views work: that a restored pre-views session comes back
with its old rows and grids intact, and that switching arrangement doesn't leave
stale pixels in a pane.

### 2026-09-05

The panel tabs, ⌘P/⌘L, chained panes, the 4x1 arrangement, per-pane channels and
the Restart menu item are all new. The owner has seen the tabs and chaining in
the real app; nothing else here has been used yet.

Checked by temp test (run, then deleted): chained geometry, including that
simultaneous panes are position-for-position identical to the pre-chain
implementation, that a beat is owned by exactly one pane, and that the wrap and
the boundary margins behave; and the channel migration, including a pre-views
session and a pane that chose its own channels.

The audio-thread allocation fix (`DrainSizes`, `MAX_VISUAL_BACKLOG`) was found
while chasing an occasional late drum hit, but **that symptom turned out to
happen in other applications too**, so it was a system-wide glitch and this
fix is not known to have changed anything audible. It stands on its own: the
callback really was calling the allocator every drain, and the cost really did
scale with the channels the panes ask for. Don't read it as a cure.

Not checked: that Restart actually relaunches with audio (an ad-hoc signature
changes every build, so TCC may treat the relaunch as a new app), and that a
pane showing only the drums bus draws what you'd expect -- the buses have no
spectrum, so flux and onsets stay empty there by design.

### 2026-09-06

The bundle was installed and run on a **second Mac** for the first time. It
launches, prompts for the microphone, and captures -- so the `Info.plist` and
entitlements work end to end, which had been unverified since they were written.

Getting there took a long detour, and the cause was mundane: the DMG that was
shipped over was `bundle/macos/rw.tauri-punching-bag_0.1.0_x64.dmg`, an Intel
scratch image from **March 2023**. It predates `NSMicrophoneUsageDescription`
entirely, so it behaved exactly like the original bug -- silence, no prompt, no
Privacy & Security entry -- while every diagnosis was aimed at the current
build's Gatekeeper, TCC and sample-rate behaviour. `codesign -dvvv` names the
architecture and the `Info.plist` entry count in one line and would have caught
it immediately; see **Installing on a second Mac**.

What that detour does and does not establish:

- **Established.** The install recipe (`ditto`, strip quarantine, Open Anyway,
  possibly twice) works on an unmanaged Mac. `codesign -vvv --deep --strict`
  reports the shipped bundle valid on another machine, so the DMG transports the
  signature intact. A self-signed code-signing certificate is a usable free
  alternative to ad-hoc.
- **Not established.** Whether ad-hoc *plus* the hardened runtime is what
  produced `taskgated invalid signature` / `Termination Reason: CODESIGNING 1`
  -- every one of those crashes was the 2023 x86_64 binary, and the current
  build launched without needing the runtime flag dropped.
- **The sample-rate bug was real after all**, and was confirmed separately once
  the correct build was installed: at 48 kHz the waveform is flat, at 44.1 kHz
  it draws. Fixed the same day -- see *Input capture*. Nothing about the fix has
  been heard yet on a 48 kHz device beyond "input arrives"; in particular
  `buffer_compensation` was tuned by ear at 44.1 kHz and its duration is ~8 ms
  shorter at 48 kHz, so the visual alignment there is unverified.
- On a **managed work Mac** the app could not be launched at all. An MDM profile
  or EDR agent enforcing notarization is the likely reason; Homebrew is
  unaffected because CLI binaries do not go through LaunchServices. Not worth
  working around -- a notarized Developer ID build is the answer, if IT's policy
  is the standard one rather than an allowlist.

### 2026-09-06, later: the file player

Everything in *The file player* is new and **none of it has been heard**. The
position arithmetic and the resampler are simulation- and unit-checked (run,
then deleted): mono folds to stereo at the same length, a matching rate is a
byte-exact copy, 44.1k resamples to 48k at the same duration, empty and
zero-channel files don't panic, a whole cycle of `fileShift` is a no-op, and the
derived position holds within one frame over ten minutes where the old
accumulating one is 4505 frames out.

What that does *not* establish: that a Logic bounce lands where you expect
against the click, that `fileOffsetMs` has the sign that feels right at the
keyboard, that `set tempo from file` gives a tempo you'd have typed, or that the
file bus is legible in a pane next to your own playing. The mono and rate
conversions also now sit under the *drum* samples, which were fine before and
should be listened to once for that reason.

A-B repeat and the time stretching are newer still and equally unheard. The
stretch is unit-checked for pitch (a sine holds within 0.5 Hz from 0.5x to 2x),
for amplitude across the loop seam, for length, for degenerate ratios and for
cost; what no test can say is whether a real drum loop at 0.85x sounds like
something you'd want to play along with.

Still to build, and deliberately not started: selecting a *region* of the file
rather than using all of it, and the static waveform with hand-drawn beat
markers. The static waveform is v2 by decision -- a long file is the open
question there, and per-pixel peaks of a whole one is the wrong first answer.

### 2026-09-07: random parameters, and expressions in drum gains

`choose` / `range`, the per-row 🎲, reroll-all and ⌘R are new and **nobody has
clicked any of it**. Covered by temp tests (run, then deleted): `choose` only
ever returns one of its arguments and doesn't fall off the end at an rng of
exactly 1, `range` stays inside its ends, a roll reads the other parameters,
resolving fifty times in a row does not re-roll, a dependant follows every
reroll, rerolling one leaves the others untouched, a list roll repeats like a
list, a half-typed roll keeps its stored value but fails the editor's check, and
a cycle through a roll is still reported as a cycle.

What that does *not* establish: whether ⌘R actually reaches the webview in the
bundle rather than being eaten, whether a rerolled tempo or rhythm pushes to the
audio thread as promptly as a typed one does, and whether the roll being sticky
across a session restore is what you want in practice or whether you'd rather it
rolled fresh at launch.

Drum `gains` becoming expression-backed is unheard too. Checked by temp test
(run, then deleted): a pre-expression bare array still reads and is wrapped on
the way through the resolve walk, an expression re-resolves on every parameter
change, a list parameter stands where a group would, a parameter going away
keeps the last good gains *and* the typed text, absent gains stay absent and
read as unity, an empty list can never be committed, and the rhythm beside it is
untouched. What no test says is whether `1, g x k` with a rolled `g` is a
musically useful thing to have or just a noisy one.

`rowColorPattern` / `rowColorPatternDown` took expressions in the same pass and
by the same two steps. Temp-tested (run, then deleted): a pre-expression bare
array still colours and is wrapped by the walk, `1, 2x(n-1)` follows `n` in both
directions, the down pattern resolves independently of the upper one, an empty
down pattern still means the halves agree, an empty pattern still paints every
row the first colour, no colours still falls back to the channel's, a vanished
parameter keeps the last good pattern *and* the text, and an index past the
palette still wraps.

## Discussed but not built

- **An iOS / iPadOS port.** Wanted eventually, iPad first. Doable, and the code
  is already split roughly the right way: `analysis.rs`, `calibration.rs`,
  `structs.rs`, `read_audio_file.rs`, `util.rs`, `prefs.rs` and
  `get_loop_buffer_size.rs` -- about 1500 lines, including the beat clock, the
  FFT, the flux, the onset picker and the matched filter -- are pure logic and
  port unchanged. The damage is concentrated in `io_channels.rs` (428 lines, 31
  Core Audio calls) and the setup half of `main.rs`. Two blockers and three
  consequences:
  - **Tauri v1 has no mobile support.** A v2 migration comes first: allowlist to
    the capabilities model, `tauri::api::path` into plugins, a new config
    schema. Mechanical but wide -- every command and the whole config file.
  - **iOS has no Core Audio HAL.** `AudioObjectGetPropertyData`, `AudioDeviceID`,
    device enumeration, `kAudioDevicePropertyNominalSampleRate` are all
    macOS-only. iOS uses AVAudioSession, which is a different *model*, not a
    different spelling: you declare a category and a *preferred* rate, and the
    system routes and decides. Audio itself is a RemoteIO unit rather than AUHAL.
    `coreaudio-rs`'s `macos_helpers` is exactly what its name says.
  - **The device picker becomes meaningless**, not merely unported -- routing is
    the user's business on iOS.
  - **The calibration becomes optional but stays useful.** iOS reports
    `inputLatency` / `outputLatency` / `ioBufferDuration` directly. Keep the
    measurement anyway: it reads the real round trip including the air path,
    which those figures cannot know.
  - **Decimated sample transport stops being optional.** `get_samples` returns
    JSON over IPC 100x a second, which is comfortable on a Mac and not on a
    phone.
  - Phone-specific and *not* just design: AVAudioSession interruptions (calls,
    alarms, another app taking the session) have to be handled and the unit
    restarted -- there is no macOS equivalent in the code today. And Bluetooth
    output is ~150-200 ms, which the calibration would measure honestly and
    absorb correctly while still being unplayable -- not because 200 ms is
    large, which `buffer_compensation` handles fine, but because it *varies*
    with codec renegotiation and interference, and a compensation can only
    absorb a constant. Wired or built-in only.
  - An Apple Developer Program membership stops being optional: iOS has no
    ad-hoc sideloading escape hatch.

- **Staying in sync with a loop playing in Logic**, so you can watch your
  playing against a part Logic is looping *live* rather than a bounce of it.
  - **The clock is not the problem; the phase is.** On one audio device Logic's
    playback and this app's `beat` come off the same crystal, so a tempo typed
    in exactly never drifts from Logic's. All that is missing is where bar 1
    fell, once. On separate devices the drift is back and the answer is an
    Aggregate Device, as it is for multiple inputs.
  - **Bouncing the loop and using the file player already solves this exactly**,
    by construction -- `fileBeats` phase-locks it, A-B repeat picks the segment,
    the stretch follows the tempo. Sync only matters when Logic has to stay
    live: muting parts, editing the arrangement while you play.
  - **MIDI clock over the IAC Driver is the first thing to try** (owner's call).
    Logic transmits it from Project Settings -> Synchronization -> MIDI; read it
    in Rust with `midir` or `coremidi`. 24 ppqn, and Start / Song Position
    Pointer are what carry the phase. Its jitter is the usual complaint and does
    not matter here, since it is only ever used to set phase -- and can be
    averaged over several loop passes.
  - **A tiny AU that broadcasts the host's transport** is the solid version: it
    reads tempo, beat and playing state per render block and sends them to the
    app over a local socket. Sample-accurate, and the app keeps its own device
    and its own clock. Costs a second build target and its signing.
  - **A sync tone through the mic** would reuse `calibration.rs`'s matched
    filter and arrive by the same path as your playing, so the latency is one
    already measured. Acoustically fragile; noted for completeness.
  - **Ableton Link is the right protocol and Logic does not support it.**
    Reachable only through a bridge app. ReWire is dead -- removed in Logic 10.5.
  - **Whatever carries the phase needs a trim**, because "bar 1" means when
    Logic's audio *sounds*, not when its transport says zero. One number, the
    same shape as `pairCompensations`, measurable by the round trip already
    built.

- **Building the whole thing as an Audio Unit**, loadable in Logic and
  GarageBand. Bigger than the sync question and it subsumes it -- a plugin gets
  tempo and phase from the host for free.
  - **It deletes the code blocking the iPad port.** The host owns the device, so
    device enumeration, the sample-rate negotiation, the picker and
    `audio-prefs.json` all stop existing, and `io_channels.rs` largely goes with
    them. That is the same 428 lines the iOS entry above names as the damage,
    and the same reason iOS was hard: an AUv3 is one target on both platforms.
    "Plugin for Logic" and "app for iPad" are substantially one project.
  - **AUv3, not AUv2** -- both hosts take it, and it is the only path to iPad.
  - **What the plugin keeps is the display and the looper.** The click and the
    drum parts are the two things Logic genuinely covers better. The looper is
    *not*: Delay Designer works in units of time with an awkward UI and a 10
    second ceiling, where this one is beat-locked and runs to ten minutes.
  - **The UI is the hard part, by a distance.** Either host a `WKWebView` in the
    `AUViewController` and keep the React panel and the whole canvas draw path
    -- rebuilding the transport, since `invoke`/`get_samples` becomes
    `WKScriptMessageHandler` and `evaluateJavaScript`, and 100 Hz JSON really
    would want the decimated peaks first -- or rewrite the panel in SwiftUI,
    which is much larger.
  - **Rust has no first-class AU story.** `nih-plug` covers CLAP and VST3 and is
    weakest exactly here. The pragmatic shape is a Swift `AUAudioUnit` subclass
    over a Rust staticlib, which is what the pure-logic modules are already
    shaped for.
  - **Anything process-global breaks**, because a plugin is instantiated many
    times per session. `sample_rate()`'s `OnceLock` in `constants.rs` is that
    bug already written down and waiting. An audit, not a redesign, but it
    precedes everything.
  - **Sandboxing changes file loading.** An app extension cannot open a path;
    the container app has to hand over a security-scoped bookmark, which the
    file player and the drum samples both go through.
  - **The host picks the buffer size**, possibly 32 frames rather than 2048.
    Everything documented as "once per callback" then happens 64x as often --
    all of it cheap, none of it confirmed.
  - **What gets easier:** `buffer_compensation` and most of the calibration
    evaporate, since the host positions the audio on its own timeline and
    latency is declared through a property; and AU state saves *with the Logic
    project*, which beats localStorage.
  - **The shape is a second front-end over a shared Rust core**, not a port --
    the ~1500 pure lines the iOS entry lists, plus whatever display logic can be
    pushed down out of `App.tsx`.

- **Per-channel latency offsets.** Wanted, low priority — the owner isn't
  worried about a few ms of mic distance.
- **Multiple input devices.** Do *not* build offset correction for this. Latency
  correction fixes the constant offset but not clock drift between independent
  crystals (~0.2 ms/s worst case, so ~1 ms of misalignment within seconds). The
  answer is a macOS Aggregate Device, which resamples onto one clock; then
  "several interfaces" is the same code path as "one device with more channels".
  v1 = user creates it in Audio MIDI Setup; v2 = app creates it via
  `AudioHardwareCreateAggregateDevice`.
- **A static file waveform, and hand-drawn beat markers.** The next step for
  playing along with a file: per-pixel peaks painted under the grid, stable
  rather than swept, as the surface you click on to say where the beats are.
  Deferred on the question of what a long file costs -- peaks for a whole file
  at pane resolution is fine for a two-bar loop and not for an album side, so it
  wants a region and probably a decimation step before it wants drawing code.
  The onset picker could *propose* markers once they exist, but manual ones come
  first: they're the ground truth any detector would be checked against, and the
  point of the tool is that it's authoritative.
- **Cancelling the app's own output out of the input.** The click, the drums and
  now the file all bleed into the microphone on speakers, and the callback knows
  exactly what it emitted -- so in principle it could be subtracted. Not
  attempted; the room's impulse response sits between the two, which is the
  whole difficulty. Headphones remain the answer.
- **Decimated sample transport.** Send per-block peaks from Rust instead of raw
  samples. The frontend already reduces to per-pixel peaks, so the picture is
  identical for ~8× less JSON. Worth doing before going past a few channels.
- **Onset detection.** Deliberately deferred — hard for pitched instruments
  (a new note on one string while another sustains needs frequency-domain work),
  and the amplitude envelope is genuinely informative for sustain and volume.
- Per-channel loop buffers exist now, but per-channel *input gain* does not.
- **High-passing the display signal.** Transients are HF-rich and steady tone is
  LF-dominant, so a high-pass before the `.abs()` in `main.rs` would lift attacks
  out of the picture; at the zoom levels in use (~3.6 samples per pixel column at
  `0.25x16` and 140bpm) the waveform is drawn nearly raw, so the slow humps are
  cycles of the fundamental rather than note envelopes. Deferred with onset
  detection, whose first stage this is -- not throwaway work when it happens.

## Conventions

- Comments explain *why*, not what. Match the surrounding density.
- Temp test files: write `src/Foo.tmp.test.tsx`, run
  `CI=true npx react-scripts test --testPathPattern Foo.tmp`, then delete. The
  repo intentionally has no committed test suite.
- `user-event` is v13 — no `userEvent.setup()`, and `[` / `{` are special
  characters in `.type()`.
- jsdom has no `PointerEvent` or pointer capture; stub them for drag tests.
