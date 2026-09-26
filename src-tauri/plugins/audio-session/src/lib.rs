//! The iOS audio session, as the app's Rust sees it.
//!
//! The Swift half (`ios/Sources/AudioSessionPlugin.swift`) configures
//! `AVAudioSession` and forwards its notifications; this half calls it and
//! turns what comes back into types. The app's iOS backend
//! (`src-tauri/src/platform/ios`) is the only caller. Nothing here is exposed
//! to the webview, and on every platform but iOS the plugin does nothing at
//! all -- it is only registered there.
//!
//! **Swift never touches an audio unit.** Rust owns the RemoteIO unit and the
//! render callback; this is configuration and notifications only.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// One port of the current route, as `AVAudioSessionPortDescription` has it.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub uid: String,
    pub name: String,
    /// `AVAudioSession.Port`'s raw value: `MicrophoneBuiltIn`, `Speaker`,
    /// `Headphones`, `BluetoothA2DPOutput`, `USBAudio`, ...
    pub port_type: String,
}

/// What the session has actually granted, read after activation. Every
/// notification carries a fresh one, so Rust never asks Swift anything back.
#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub sample_rate: f64,
    /// Seconds.
    pub io_buffer_duration: f64,
    /// Seconds, as the session reports them. Neither includes the air.
    pub input_latency: f64,
    pub output_latency: f64,
    /// 0 when no input is available at all.
    pub input_channels: usize,
    pub output_channels: usize,
    pub inputs: Vec<PortInfo>,
    pub outputs: Vec<PortInfo>,
    /// `granted`, `denied` or `undetermined`.
    pub record_permission: String,
    pub mode: String,
}

/// A notification from the session, with the session as it is afterwards.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    /// `routeChange`, `interruptionBegan`, `interruptionEnded`, `becameActive`
    /// or `mediaServicesReset`.
    pub kind: String,
    /// The route change's reason, or why reactivating failed.
    pub reason: String,
    pub should_resume: bool,
    /// Whether the session is active after this, i.e. whether a stopped unit
    /// can be started again.
    pub active: bool,
    pub snapshot: SessionSnapshot,
}

/// What the app asks the session for.
#[derive(Debug, Clone)]
pub struct Preferences {
    pub sample_rate: f64,
    /// Seconds.
    pub io_buffer_duration: f64,
    /// `measurement` or `default`.
    pub mode: &'static str,
}

#[cfg(target_os = "ios")]
mod ios {
    use super::*;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager};

    tauri::ios_plugin_binding!(init_plugin_audio_session);

    pub struct AudioSession<R: Runtime>(pub(crate) PluginHandle<R>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ConfigurePayload {
        preferred_sample_rate: f64,
        preferred_io_buffer_duration: f64,
        mode: &'static str,
        events: Channel,
    }

    pub fn register<R: Runtime>(
        app: &AppHandle<R>,
        api: tauri::plugin::PluginApi<R, ()>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let handle = api.register_ios_plugin(init_plugin_audio_session)?;
        app.manage(AudioSession(handle));
        Ok(())
    }

    /// Configure and activate the session, and forward every notification to
    /// `on_event` from then on. **Blocks until Swift answers**, which on the
    /// first launch includes the microphone prompt -- so never call it from
    /// the main thread, which the prompt needs.
    ///
    /// `on_event` runs on whatever thread Swift sends from, so it must only
    /// signal: store the snapshot, send on a channel, return.
    pub fn configure<R: Runtime>(
        app: &AppHandle<R>,
        prefs: &Preferences,
        on_event: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Result<SessionSnapshot, String> {
        let session = app
            .try_state::<AudioSession<R>>()
            .ok_or_else(|| "the audio session plugin is not registered".to_string())?;
        let events = Channel::new(move |body| {
            let text = match body {
                InvokeResponseBody::Json(text) => text,
                InvokeResponseBody::Raw(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            };
            match serde_json::from_str::<SessionEvent>(&text) {
                Ok(event) => on_event(event),
                Err(e) => println!("audio session: unreadable event ({}): {}", e, text),
            }
            Ok(())
        });
        session
            .0
            .run_mobile_plugin(
                "configure",
                ConfigurePayload {
                    preferred_sample_rate: prefs.sample_rate,
                    preferred_io_buffer_duration: prefs.io_buffer_duration,
                    mode: prefs.mode,
                    events,
                },
            )
            .map_err(|e| e.to_string())
    }

    #[derive(Serialize)]
    struct KeepAwakePayload {
        on: bool,
    }

    /// Keep the screen from locking (`on`) or let it lock again. Blocks until
    /// Swift answers, which is at once -- the UIKit call is queued onto the
    /// main thread rather than awaited.
    pub fn keep_awake<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
        let session = app
            .try_state::<AudioSession<R>>()
            .ok_or_else(|| "the audio session plugin is not registered".to_string())?;
        session
            .0
            .run_mobile_plugin::<serde_json::Value>("keepAwake", KeepAwakePayload { on })
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "ios")]
pub use ios::{configure, keep_awake};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("audio-session")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            ios::register(_app, _api)?;
            Ok(())
        })
        .build()
}
