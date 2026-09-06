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
Rust deps are already built. Two warnings are pre-existing and expected
(`unused import: std::time::Instant`, `unused imports: AudioUnit and Error`).

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
| `parser1.js` / `parser2.js` | Generated PEG parsers for rhythm syntax (see Rhythm syntax). Don't hand-edit. |

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
- **⌘P pauses, ⌘L toggles looping.** One `keydown` listener, registered once and
  reaching the current `set`/`get` through a ref -- those are new closures every
  render, so depending on them would rebuild the listener each time. Both are
  taken unconditionally, text fields included: neither is a text-editing key.
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
  `loopEchoGain`, `clickVolume`, `audioInGain`, `bufferCompensation` (see
  `RustExprKey`). Read them through `exprNumber` / `exprList` / `viewRowBeats`,
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
- **`beatsPerRow` changed shape** from `number[]` to `{inputText, val}`, which
  is the `loopFeedback` trap above: restore merges a saved array *over* the new
  object and `Math.max(...beatsPerRow)` returns NaN, drawing a blank pane.
  `normalizeView` wraps arrays (and bare numbers, for the three scalar fields)
  explicitly, and `migrateRust` does the same for the Rust-side keys. Wrapped
  rather than renamed, so saved layouts and tempos survive.
- **Drum `offset`, `shift` and `gains` are deliberately still literals.** They're
  nested in the drums array and not in the re-resolution walk, so an expression
  there would silently go stale on a parameter change. Add them to
  `resolveRustConfig` first, then make them expression-backed -- not the other
  way round.

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

## Audio thread rules

The render callback in `main.rs` runs ~21×/sec with 2048 frames. Inside it:

- **Never allocate per frame.** Rhythm time-vectors, pan gains, and drum sample
  lookups are all resolved *once per callback* into locals. The click's times
  array used to be `.collect()`ed inside the per-frame, per-channel loop — about
  88,000 allocations/sec. Don't reintroduce that pattern.
- **Per-frame vs per-output-channel.** The output loop runs twice per frame
  (stereo). Anything advancing sample time — input pops, the loop buffer, the
  beat, triggers, display pushes — belongs *outside* it. Things that legitimately
  live inside: writing `channel[i]`, the mp3 read, drum sample mixing.
- **`buffer_compensation` is in frames** (default 4330 ≈ 98 ms), hand-tuned by
  the owner. Don't change its units.
- **`beat` must stay f64 end-to-end.** It counts up from launch, so at f32 the
  gap between representable values outgrows a screen pixel after ~20 minutes and
  the waveform stops being redrawn densely enough to erase the previous pass —
  ghost trails. Fixed once; don't reintroduce a cast.

### Input capture

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

### Row colours

`rowColors` is a per-pane list of colours and `rowColorPattern` says which row
takes which, 1-based, in the same `parseNumberList` syntax as `beatsPerRow`.
`rowColorFor` in `config.ts` resolves them, next to `gridAlpha` and `drumGains`.

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
  `parseNumberList` rejects an empty list. Setting it to the same text as the
  upper pattern is the equivalent, and turning `splitChannels` off ignores it
  entirely.

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
[ ch 1 … ch N ]  [ drums ]  [ click ]
     inputs        bus N      bus N+1
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

## Known issues / latent bugs

- **Mono audio files play at double speed.** `mp3.pos += 1` and
  `sounding_samples[j].pos += 1` happen once per *output* channel, which assumes
  decoded audio is interleaved stereo. `copy_interleaved_ref` gives whatever the
  file has. The bundled `ride_cropped.wav` is stereo so it's fine, but any mono
  file a user adds as a drum sample will play an octave high. **Most likely thing
  to hit next.**
- **The channel count `2` is a magic literal** in the output stream format and
  `if ch == 0 || ch == 1`. Untangling these into one constant is prerequisite work
  for any further channel changes.
- **The click counter ticks twice per frame** (once per output channel), so
  `click_sound_counter = 400` is really 200 frames. Moving it out of the output
  loop would double the click's length — halve the constants if you do.
- `subdivisionOffset` is in the config with a UI input but is unused by the draw
  code. Dead before any of this work.
- A zero-length `beatsToLoop` used to panic; guarded now, but similar bare
  indexing exists elsewhere.

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
`codesign`, but **nobody has confirmed the microphone prompt actually appears
yet** -- that needs `tccutil reset Microphone com.vogler.dev` and a launch of
the bundled app.

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

Not checked: that Restart actually relaunches with audio (an ad-hoc signature
changes every build, so TCC may treat the relaunch as a new app), and that a
pane showing only the drums bus draws what you'd expect -- the buses have no
spectrum, so flux and onsets stay empty there by design.

## Discussed but not built

- **Per-channel latency offsets.** Wanted, low priority — the owner isn't
  worried about a few ms of mic distance.
- **Multiple input devices.** Do *not* build offset correction for this. Latency
  correction fixes the constant offset but not clock drift between independent
  crystals (~0.2 ms/s worst case, so ~1 ms of misalignment within seconds). The
  answer is a macOS Aggregate Device, which resamples onto one clock; then
  "several interfaces" is the same code path as "one device with more channels".
  v1 = user creates it in Audio MIDI Setup; v2 = app creates it via
  `AudioHardwareCreateAggregateDevice`.
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
