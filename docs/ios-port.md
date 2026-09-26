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

- [ ] 1. Tauri v2 migration
- [ ] 2. Core / platform split
- [ ] 3. In-process engine restart
- [ ] 4. iOS backend
- [ ] 5. On the devices
