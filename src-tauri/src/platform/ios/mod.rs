//! The iOS backend: one RemoteIO unit, on whatever route `AVAudioSession` has
//! chosen.
//!
//! There is no device to pick on iOS -- the system routes, and the app asks.
//! So the "device" here is the session's current route, reported by the Swift
//! plugin (`plugins/audio-session`) as a snapshot at configuration and again
//! with every notification. This module keeps the latest snapshot, and
//! everything `audio_host.rs` asks of a backend is answered from it:
//!
//! - `resolve_choice` is the route's ports, its rate and its input count, so a
//!   route change is a restart exactly as a device change is on the Mac --
//!   step 3's path, with the session deciding when.
//! - `get_input_output_channels` opens nothing. RemoteIO is one unit per
//!   session and cannot be opened beside the old one, so `start` opens it,
//!   after the old unit has stopped; a failure there is silence, reported.
//! - An interruption is not a restart. See `Hint::Suspend` / `Hint::Resume`.
//!
//! See *The iOS backend* in `docs/design-notes.md`.

mod remote_io;

pub use remote_io::Running;

use crate::engine::Engine;
use crate::platform::{Hint, HintSender};
use crate::prefs::AudioPrefs;
use serde::Serialize;
use std::sync::Mutex;
use tauri_plugin_audio_session::{PortInfo, Preferences, SessionEvent, SessionSnapshot};

/// What the session is asked for. 48 kHz is what every current iPhone and iPad
/// runs its hardware at, so asking for it avoids a conversion rather than
/// forcing one. 256 frames (5.3 ms) is small enough to play against and large
/// enough that the per-block costs -- the config lock, the section walk -- run
/// at ~190 callbacks a second rather than ~370; the session may round it.
const PREFERENCES: Preferences = Preferences {
    sample_rate: 48000.0,
    io_buffer_duration: 256.0 / 48000.0,
    // As little system processing of the microphone as iOS offers: no
    // automatic gain, no voice EQ. Onsets, the bleed canceller and the picture
    // all want the signal as it arrived. The cost to try on a device: some
    // iPhones play the speaker quieter in this mode. "default" is the other
    // choice.
    mode: "measurement",
};

/// More input channels than any analysis or pane would use; an interface
/// offering more is taken at this many.
const MAX_INPUT_CHANNELS: usize = 8;

/// The session as last reported. `None` until `start_session` has configured
/// it, which is before anything is started.
static SESSION: Mutex<Option<SessionSnapshot>> = Mutex::new(None);

fn session() -> Option<SessionSnapshot> {
    SESSION.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Nothing to identify on iOS: the route is the device, and it is compared
/// through `DeviceChoice`.
pub type DeviceId = ();

/// The Mac watches the input device's rate; on iOS a rate change arrives as a
/// route change, whose snapshot the choice compares. Never constructed.
pub struct RateWatch;

pub fn watch_rate(_device: DeviceId, _hint: &'static HintSender) -> Option<RateWatch> {
    None
}

pub fn device_rate(_device: DeviceId) -> Option<f64> {
    None
}

/// What a route resolves to, compared to decide whether a restart has anything
/// to do. Ports as well as the rate and the input count, although RemoteIO
/// follows a route change by itself: a different speaker or microphone is a
/// different acoustic path, so the bleed measurement and any latency run in
/// progress no longer describe it, and the latency figure is looked up again
/// for the new pair. A restart is what does all three.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceChoice {
    pub input: String,
    pub output: String,
    pub rate_bits: u64,
    pub input_channels: usize,
}

/// What `start` needs beyond the engine: whether there is a microphone at all.
/// The rate is the engine's own.
pub struct Units {
    input_enabled: bool,
}

pub struct AudioSetup {
    pub units: Units,
    pub input_channels: usize,
    pub log: Vec<String>,
    pub active: ActiveDevices,
    pub sample_rate: f64,
    pub choice: DeviceChoice,
    pub input_device_id: DeviceId,
}

/// Which ports the route is using, in the shape the panel already reads for
/// the Mac's devices, plus what only iOS can report.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDevices {
    /// `portType:uid` of the route's first input -- also what the latency
    /// figure is stored against in `pairCompensations`.
    pub input_uid: String,
    pub input_name: String,
    pub output_uid: String,
    pub output_name: String,
    /// Never true on iOS; kept so the panel reads one shape.
    pub input_fell_back: bool,
    pub output_fell_back: bool,
    pub input_fallback_reason: String,
    pub output_fallback_reason: String,
    /// The round trip the session reports, in frames at the session's rate:
    /// the panel starts a pair with no stored figure here rather than at the
    /// Mac's default. See `seed_compensation`.
    pub suggested_compensation: Option<f64>,
    /// Non-empty when the output is Bluetooth or AirPlay, whose latency drifts.
    pub output_warning: String,
    /// Non-empty when the microphone is refused or absent.
    pub input_warning: String,
    pub io_buffer_frames: f64,
    pub input_latency_ms: f64,
    pub output_latency_ms: f64,
}

/// The iOS analogue of a device UID. `AVAudioSessionPortDescription.uid` is
/// stable per port and per accessory (a pair of AirPods keeps theirs), and the
/// type in front keeps `audio-prefs.json` legible: `MicrophoneBuiltIn:...`,
/// `Headphones:...`, `BluetoothA2DPOutput:...`.
fn port_key(port: Option<&PortInfo>) -> String {
    port.map(|p| format!("{}:{}", p.port_type, p.uid)).unwrap_or_default()
}

/// The round trip, from what the session says, in frames: both hardware
/// latencies plus two IO buffers -- one for the input to fill before the
/// callback sees it, one for the output rendered in that callback to wait
/// behind the buffer already playing. Neither latency includes the air, which
/// is why *measure latency* stays: this is where a pair starts, not where it
/// has to end. `None` for a session that reported nothing usable.
pub fn seed_compensation(s: &SessionSnapshot) -> Option<f64> {
    let seconds = s.input_latency + s.output_latency + 2.0 * s.io_buffer_duration;
    let frames = (seconds * s.sample_rate).round();
    (frames.is_finite() && frames > 0.0).then_some(frames)
}

const BLUETOOTH_PORTS: [&str; 3] = ["BluetoothA2DPOutput", "BluetoothLE", "BluetoothHFP"];

fn output_warning(outputs: &[PortInfo]) -> String {
    if outputs.iter().any(|p| BLUETOOTH_PORTS.contains(&p.port_type.as_str())) {
        "Bluetooth output: its latency is long and drifts as the radio renegotiates, so no \
         compensation holds -- the click and the picture will wander against your playing. \
         Use wired headphones or the speaker to practise."
            .into()
    } else if outputs.iter().any(|p| p.port_type == "AirPlay") {
        "AirPlay output: the latency is far too long and too variable to play against.".into()
    } else {
        String::new()
    }
}

fn input_warning(s: &SessionSnapshot) -> String {
    if s.record_permission == "denied" {
        "Microphone access is off, so the input is silent. Turn it on in Settings > Privacy & \
         Security > Microphone."
            .into()
    } else if s.input_channels == 0 {
        "This route has no microphone, so the input is silent.".into()
    } else {
        String::new()
    }
}

fn active_devices(s: &SessionSnapshot) -> ActiveDevices {
    let input = s.inputs.first();
    let output = s.outputs.first();
    ActiveDevices {
        input_uid: port_key(input),
        input_name: input.map(|p| p.name.clone()).unwrap_or_else(|| "no input".into()),
        output_uid: port_key(output),
        output_name: output.map(|p| p.name.clone()).unwrap_or_else(|| "no output".into()),
        suggested_compensation: seed_compensation(s),
        output_warning: output_warning(&s.outputs),
        input_warning: input_warning(s),
        io_buffer_frames: (s.io_buffer_duration * s.sample_rate).round(),
        input_latency_ms: s.input_latency * 1000.0,
        output_latency_ms: s.output_latency * 1000.0,
        ..Default::default()
    }
}

fn input_channels(s: &SessionSnapshot) -> usize {
    s.input_channels.clamp(1, MAX_INPUT_CHANNELS)
}

fn choice(s: &SessionSnapshot) -> DeviceChoice {
    DeviceChoice {
        input: port_key(s.inputs.first()),
        output: port_key(s.outputs.first()),
        rate_bits: s.sample_rate.to_bits(),
        input_channels: input_channels(s),
    }
}

/// Before the session is configured -- `main` sizes everything before the app
/// exists -- the rate asked for stands in, and the first real start converts
/// from it if the session granted another.
fn provisional() -> SessionSnapshot {
    SessionSnapshot {
        sample_rate: PREFERENCES.sample_rate,
        io_buffer_duration: PREFERENCES.io_buffer_duration,
        input_channels: 1,
        output_channels: 2,
        ..Default::default()
    }
}

pub fn resolve_choice(_prefs: &AudioPrefs) -> Result<DeviceChoice, String> {
    Ok(choice(&session().unwrap_or_else(provisional)))
}

/// The route as it is now, as a setup. Opens nothing -- see `start`.
pub fn get_input_output_channels(_prefs: &AudioPrefs) -> Result<AudioSetup, String> {
    let s = session().unwrap_or_else(provisional);
    let log = vec![format!("{:#?}", s)];
    Ok(AudioSetup {
        units: Units {
            input_enabled: s.input_channels > 0,
        },
        input_channels: input_channels(&s),
        log,
        active: active_devices(&s),
        sample_rate: s.sample_rate,
        choice: choice(&s),
        input_device_id: (),
    })
}

pub fn start(units: Units, engine: Engine) -> Result<Running, String> {
    remote_io::start(engine, units.input_enabled)
        .map_err(|e| format!("the audio could not start: {}", e))
}

/// No device list on iOS: the route is the system's choice, and the panel
/// shows it rather than offering a picker.
#[derive(Serialize, Debug, Clone)]
pub struct AudioDeviceInfo {}

pub fn list_devices() -> Vec<AudioDeviceInfo> {
    vec![]
}

fn store(snapshot: SessionSnapshot) {
    *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = Some(snapshot);
}

/// Configure and activate the session, and route its notifications into hints
/// for the supervisor. **Blocks** until Swift answers -- on a first launch,
/// until the microphone prompt is answered -- so it runs on its own thread.
pub fn start_session(app: &tauri::AppHandle, hint: &'static HintSender) -> Result<(), String> {
    let snapshot = tauri_plugin_audio_session::configure(app, &PREFERENCES, move |event: SessionEvent| {
        // On Swift's queue: store and signal, nothing else.
        log::info!(
            "audio session: {} {} (active {}, {} Hz, {:?} -> {:?})",
            event.kind,
            event.reason,
            event.active,
            event.snapshot.sample_rate,
            event.snapshot.inputs.first().map(|p| &p.name),
            event.snapshot.outputs.first().map(|p| &p.name),
        );
        store(event.snapshot);
        let h = match event.kind.as_str() {
            "routeChange" => Some(Hint::Devices),
            "interruptionBegan" => Some(Hint::Suspend),
            "interruptionEnded" | "becameActive" if event.active => Some(Hint::Resume),
            "mediaServicesReset" => Some(Hint::Reset),
            _ => None,
        };
        if let Some(h) = h {
            let _ = hint.send(h);
        }
    })?;
    log::info!(
        "audio session: {} Hz, IO buffer {:.2} ms, latency in {:.2} ms out {:.2} ms, {} in / {} out, mic {}, mode {}",
        snapshot.sample_rate,
        snapshot.io_buffer_duration * 1000.0,
        snapshot.input_latency * 1000.0,
        snapshot.output_latency * 1000.0,
        snapshot.input_channels,
        snapshot.output_channels,
        snapshot.record_permission,
        snapshot.mode,
    );
    store(snapshot);
    Ok(())
}
