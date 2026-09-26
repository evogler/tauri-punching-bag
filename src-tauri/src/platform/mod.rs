//! The platform half of the audio: which device, at what rate, and how a block
//! of input and a block of output reach `engine::Engine::process`. Everything
//! real-time and musical is in the engine; everything here is the device.
//!
//! macOS only today. iOS (step 4 of `docs/ios-port.md`) is a second backend
//! beside this one -- a RemoteIO unit whose single callback hands input and
//! output over together and calls the engine directly, with no queue between
//! them -- and the rest of the app reaches devices only through what this
//! module re-exports.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::*;
