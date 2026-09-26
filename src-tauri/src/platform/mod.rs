//! The platform half of the audio: which device, at what rate, and how a block
//! of input and a block of output reach `engine::Engine::process`. Everything
//! real-time and musical is in the engine; everything here is the device.
//!
//! Two backends, one surface. `audio_host.rs` reaches devices only through
//! what this module re-exports, and each backend provides the same names:
//! `AudioSetup` (what a setup resolved to, and the units to start), `Units`,
//! `start`, `Running`, `DeviceChoice` / `resolve_choice` (what the supervisor
//! compares to decide whether to restart), `ActiveDevices`, `list_devices`.
//!
//! - **macOS**: two AUHAL units, input reaching the render callback through a
//!   per-channel queue.
//! - **iOS**: one RemoteIO unit whose single callback pulls the input and
//!   renders the output, with no queue; the device is whatever route
//!   `AVAudioSession` has chosen, configured in Swift
//!   (`plugins/audio-session`).

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "ios")]
mod ios;

#[cfg(target_os = "ios")]
pub use ios::*;

/// Why the supervisor in `audio_host.rs` should look at the audio again.
///
/// **Whatever sends one only ever sends.** Core Audio's listeners run on its
/// notification threads and the iOS session's on Swift's, and stopping an
/// audio unit from either is the shape of a deadlock rather than a restart. The
/// supervisor thread does the work, once a burst of notifications has gone
/// quiet.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Hint {
    /// The devices, a default, a route or a rate may have changed: restart if
    /// what the prefs or the session resolve to is not what is running.
    Devices,
    /// An interruption began (a call, Siri, an alarm). The system has already
    /// stopped the unit; stop it on our side too, keeping the engine.
    #[cfg(target_os = "ios")]
    Suspend,
    /// The session is active again: start the unit that was stopped, with the
    /// same engine -- then restart only if the route moved meanwhile.
    #[cfg(target_os = "ios")]
    Resume,
    /// Media services were reset: every audio object in the process is dead,
    /// so the unit is rebuilt whatever the comparison says.
    #[cfg(target_os = "ios")]
    Reset,
}

pub type HintSender = std::sync::mpsc::Sender<Hint>;
