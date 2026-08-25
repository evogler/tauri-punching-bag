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

### Layout of the frontend

| File | Role |
|---|---|
| `App.tsx` | State, config plumbing, the whole canvas draw path. Large. |
| `config.ts` | `defaultRustConfig` / `defaultJsConfig` — the split below matters. |
| `layout.ts` | `getCanvasPositions` — pure geometry, where a beat lands on screen. |
| `Input.tsx` | Generic config inputs, dispatched on value type. `parseNumberList`. |
| `GridList.tsx` / `ChannelList.tsx` / `DrumList.tsx` | The three list UIs. |
| `presets.ts` | Named presets *and* the auto-restored session. |
| `parser1.js` / `parser2.js` | Generated PEG parsers for rhythm syntax. Don't hand-edit. |

## The config system — sharp edges

Config is split in two by *where it's needed*: `defaultRustConfig` (audio) and
`defaultJsConfig` (display). `get(key)` / `set(key, value)` route by which object
the key lives in. Adding a key to the wrong one silently does nothing.

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
- **Transient keys.** `presets.ts` excludes `canvasWidth`/`canvasHeight`
  (derived from window size) and `paused` (transport state) from both presets
  and the saved session.
- **Session restore** merges over defaults, so new keys keep their default and
  removed keys are dropped. A restored session pushes one `set_config` on mount,
  because Rust boots from its own `default_config()`.

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

## Display pipeline

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

### Channels

`visibleChannels` holds *device channel indices*, and indices past the input count
are **synthetic buses**, in the order the frontend labels them:

```
[ ch 1 … ch N ]  [ drums ]  [ click ]
     inputs        bus N      bus N+1
```

The frontend's `channelLabels` order **must** match how `main.rs` fills them.
Only real inputs are pannable — the buses aren't routed. `splitChannels` draws
even slots above the row centre and odd slots below (designed for exactly 2).

The sample stream is flattened — `{channels, beats, values}`, one beat per frame
and `channels` values after it, read as `values[i * channels + c]`. Flattened
rather than a Vec-of-Vecs so the audio callback never allocates per frame.

### Drums

Each `DrumVoice` has a path, its own rhythm, a volume, and an offset in ms.
**The offset is a look-ahead, not a seek**: triggering evaluates
`beat_bisect(times, beat + offset_beats)` so the sample starts *early* and its
transient lands on the beat. Seeking into the file would chop the front off a
slow attack. `offset_beats = offset_ms / 1000 * bpm / 60`.

Files are decoded in Rust by `load_drum_sample` and keyed by path; the callback
only does a map lookup. Built-ins are keyed by plain name (`"ride"`) so a voice
can refer to one without knowing the install path.

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

## State as of 2026-08-24

Verified by the owner in the real app: single-channel input, 2-channel input with
up/down split, per-channel looping, the scrollable settings panel.

Not verified by ear: drum offsets landing where expected, panning, the
drums/click display buses. The click's timbre was preserved *by construction*
(its counter and per-channel RNG were deliberately left untouched) rather than by
listening.

Uncommitted at time of writing: the click display bus, and gating the drum bus on
`drumOn` so both buses show only what's audible.

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

## Conventions

- Comments explain *why*, not what. Match the surrounding density.
- Temp test files: write `src/Foo.tmp.test.tsx`, run
  `CI=true npx react-scripts test --testPathPattern Foo.tmp`, then delete. The
  repo intentionally has no committed test suite.
- `user-event` is v13 — no `userEvent.setup()`, and `[` / `{` are special
  characters in `.type()`.
- jsdom has no `PointerEvent` or pointer capture; stub them for drag tests.
