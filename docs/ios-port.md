# Porting to iOS / iPadOS

The plan agreed on 2026-09-25. Goal of the first milestone: **the app running
correctly on the owner's iPad and iPhone** -- waveform drawn in time with the
playing, click and drums on the beat, the looper echoing a loop later. Touch UI
and the sandbox come after; neither is in doubt, and the system-level audio is
where the risk is.

## Decisions

- **The app route, not an Audio Unit.** One repo, one frontend, the Mac app
  keeps shipping while iOS catches up, and the platforms diverge only at the
  audio I/O layer (`#[cfg(target_os = "ios")]`). An AUv3 is a different
  product -- it lives inside a host and replaces the standalone app rather than
  joining it -- and stays in *Discussed but not built*.
- **Swift is minimal and bounded.** Swift configures `AVAudioSession` and
  listens for its notifications (interruptions, route changes), as a Tauri v2
  plugin. **Rust owns the render callback** and everything real-time: ARC
  retain/release is not safe on the audio thread, and the no-allocation rules
  live in Rust. No Objective-C.
- **Migration and split before any iOS code**, because both are verifiable on
  the Mac and worth having even if iOS never happens. The split is designed
  with RemoteIO's shape in mind so it is not reshaped twice.

## Steps

### 1. Tauri v1 → v2, on the Mac

Mechanical but wide: allowlist → capabilities, `tauri::api::*` → plugins
(dialog, fs, updater, global shortcut, process, …), new `tauri.conf.json`
schema, every `invoke` checked. Ship it on macOS before anything else, so a v2
regression is a Mac problem rather than an iOS mystery.

- **Existing installs must be able to update across the jump.** v1's updater
  has to be able to install the first v2 build (v2's
  `bundle.createUpdaterArtifacts: "v1Compatible"`). Losing that strands every
  friend's install on v1 -- the same stakes as losing the minisign key.
- Signing, notarization, stapling and `scripts/tauri.mjs` must keep working;
  the Developer ID and bundle id must not change, or every TCC grant is void.
- Behaviour unchanged. The owner tests in the real app.

### 2. Split the core from the platform

The render closure's body becomes a core that is handed buffers rather than
owning a device:

> *here are n frames of input (interleaved, `c_in` channels); fill n frames of
> output.*

- **macOS backend**: today's `io_channels.rs` and the setup half of `main.rs`.
  Input still arrives in its own callback and reaches the core through the
  existing per-channel queue.
- **iOS backend** (step 4): RemoteIO delivers input and wants output in *one*
  callback, so the queue largely disappears there -- same clock by
  construction.
- **Pure modules port unchanged**: `analysis.rs`, `calibration.rs`, `bleed.rs`,
  `filter.rs`, `stretch.rs`, `loop_guard.rs`, `util.rs`, the looper arithmetic.
- **Variable block sizes**: every loop already runs over `num_frames`. The rule
  to enforce is *preallocate for the largest block the platform may hand over*
  (iOS's maximum frames per slice, often 4096), never the typical one. Audit
  what is sized "per callback" -- the recorder's capacity, `DrainSizes`, the
  input backlog cap.

**Done 2026-09-25** -- see *The core and the platform* in
`docs/design-notes.md`. The shape that came out:

```rust
Engine::new(shared: EngineShared, input_channels: usize, sample_rate: f64)
Engine::process(&mut self, input: &[f32], output: [&mut [f32]; 2])
```

`engine.rs` is the core; `platform/macos/` (`devices.rs` + `mod.rs`) is the
backend; `platform/mod.rs` is where an iOS backend slots in beside it. The
engine is block-size invariant (checked bit-for-bit across ragged blocks),
`Send`, allocates nothing per callback, and is sized for `MAX_BLOCK_FRAMES` =
4096.

Found on the way, for the steps below:

- **Step 3 -- what is still sized by channel count at launch, outside the
  engine.** `InputLevelState`'s atomics, the `Recorder`, the `LoopBuffer`'s
  per-channel vectors and the `InputChannelCount` managed state are all built
  in `main` from the launch channel count and handed to Tauri as fixed state.
  A restart at a different count has to replace or resize every one of them,
  not just build a new `Engine`. Moving them behind the engine (or making each
  resizable behind its existing mutex) is the first job of step 3.
- **Step 3 -- the beat has to be carried across by hand.** It is a private
  field of the engine now; the restart wants `Engine::beat()` and a way to seed
  a new engine with it (plus the click's `last_beat`, so the first click of the
  new engine is not a spurious one).
- **Step 3 -- the rate.** The engine takes its rate at construction, but
  `get_loop_spacing` (called by the engine every callback), the calibration,
  the stretch, the decoders, the recorder, `max_input_backlog` and several
  commands still read the global `sample_rate()`. Those are the readers to
  convert.
- **Step 3 -- the simplest safe swap is to stop the unit**, install a render
  callback owning the new engine, and start it again: nothing is shared with
  the audio thread, so there is no lock for it to wait on. The engine being
  `Send` is what lets it be built off-thread first.
- **Step 4 -- splitting an oversized block lives in the macOS backend.** iOS
  should set `kAudioUnitProperty_MaximumFramesPerSlice` to at most
  `MAX_BLOCK_FRAMES`, but will want the same split loop defensively; lift it
  into the engine (a `process` that chunks) rather than copying it.
- **Step 4 -- per-callback costs scale with the callback rate.** At a 256-frame
  IO buffer that is ~8x the callbacks of macOS's 2048: the config lock, the
  drum-sample map lock, the section walk and the display locks each run that
  much more often. All O(1) or small, none measured on a phone. The bleed
  readout's smoothing is per callback and will read smoother at small blocks;
  display only.
- **Step 4 -- RemoteIO input.** Pull it with `AudioUnitRender` inside the render
  callback into a buffer list preallocated for `MAX_BLOCK_FRAMES`, interleaved
  so it is exactly the `input` slice `process` takes, and render straight into
  the two output buffers. No queue, no backlog cap.

### 3. Restart the audio engine in-process

Device changes stop needing an app relaunch -- on the Mac now, and it is the
same path an iOS route change (headphones in/out) will take.

- Stop the unit, build a fresh core off-thread at the new channel count and
  rate, start again. A few tens of ms of silence during a device change is
  acceptable.
- **The sample rate becomes engine state**, not the process-global `OnceLock`
  in `constants.rs` -- which also clears the hazard the AU notes flag.
- **Carried across**: the beat, the config (already shared). **Cleared on a
  rate change**: the loop buffer. **Re-resampled off-thread**: the kit and the
  file player's samples.
- **The frontend is told** when the channel count changes (event + re-fetch),
  since channel labels and every pane's `channels` are indexed by it.
- The device picker applies immediately instead of "at the next launch".

**Done 2026-09-26** -- see *Restarting the audio in-process* in
`docs/design-notes.md`. `audio_host.rs` owns what is running; `restart` opens
the new units, prepares everything at the new rate while the old engine plays,
stops, swaps and starts an engine seeded from `engine::Carry`. The rate lives
in `AudioStatus` and is passed as an argument everywhere; the global is gone.
Callers: `restart_audio` (the picker) and the supervisor thread (Core Audio's
device list, both defaults and the input's rate). Frontend listens for
`audio-restarted` / `audio-restart-failed`.

Found on the way, for step 4:

- **The route change is a `restart` with a different resolver.** On macOS
  "should we restart" is `resolve_choice(prefs) != running choice` or the
  input's rate moved. On iOS it becomes "the session's route or sample rate
  changed", read from `AVAudioSession` after the notification -- the rest of
  `AudioHost::restart` (prepare, stop, swap, start, events) is platform-free
  already. `DeviceChoice`, `DeviceId`, `RateWatch`, `resolve_choice`,
  `device_rate` and `watch_*` are the platform surface to reimplement;
  `AudioSetup` is what the backend returns.
- **Notifications must only signal.** The Swift plugin should hand Rust a hint
  (the same `HintSender` channel works) rather than calling restart on the
  notification's thread; the supervisor's 300 ms debounce suits route changes,
  which also arrive in bursts.
- **Open-before-stop may not hold on iOS.** macOS opens the new AUHAL units
  while the old ones run, which is why a failed switch leaves audio playing.
  RemoteIO is one unit per session; expect stop-then-open there, and a failed
  open to mean silence plus `audio-restart-failed` until the next route change.
- **Interruptions are a pause, not a restart**, unless the route changed while
  interrupted. Stopping the unit and starting it again with the same engine
  would keep the bleed filter; today every restart builds a new engine and loses
  it, which is fine for a device change and wasteful for a phone call.
- **The rate can differ between input and output on a route** (Bluetooth HFP is
  8/16 kHz). The input-wins rule and `to_device_stereo`'s one rate still apply;
  the Bluetooth refusal belongs here.
- **Channels are indices and the buses follow the inputs**, so a route that
  changes the input count relabels panes' channels (`ch 2` becomes drums). On a
  phone that will happen on every headset plug; worth naming the buses
  independently of the input count before then.

### 4. The iOS backend

- Swift plugin: `AVAudioSession` category `playAndRecord`, preferred rate and
  IO buffer duration, activation, interruption and route-change
  notifications → tell Rust to stop/restart the engine (step 3's path).
- Rust: a RemoteIO unit (`coreaudio-rs` 0.11 has `IOType::RemoteIO` and an
  iOS input path), render callback into the core.
- Rate read from the session *after* activation, and re-read on every route
  change.
- Latency: seed `buffer_compensation` from the session's reported input/output
  latency; keep *measure latency* -- only it sees the air path.
- Bluetooth output warned about or refused: its latency drifts, and a
  compensation can only absorb a constant.
- Info.plist: `NSMicrophoneUsageDescription` carries over.

### 5. Run it on the devices

`tauri ios dev` on the iPad and iPhone, desktop UI as-is. Needs an **Apple
Development** certificate (Xcode makes one from the account -- the Developer ID
Application certificate is Mac-only), the devices registered (automatic via
Xcode), and Developer Mode on (iOS 16+). The simulator says nothing about
latency or the mic: devices from day one.

If the phone struggles with `get_samples` at 100 Hz, *decimated sample
transport* (per-column peaks from Rust) is the fix, and helps the Mac too.

## Later

Touch UI (panel as a drawer, help without hover, tap targets, drum-grid drag),
the sandbox (security-scoped bookmarks for `filePath` and drum samples, stores
in the container), TestFlight, and the updater coming out on iOS.

## Progress

- [x] 1. Tauri v2 migration (2026-09-25; in-app testing by the owner still to do)
- [x] 2. Core / platform split (2026-09-25; in-app listening by the owner still to do)
- [x] 3. In-process engine restart (2026-09-26; exercised through the real path, not yet listened to by the owner)
- [ ] 4. iOS backend
- [ ] 5. On the devices
