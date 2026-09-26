//! What is running, and restarting it in-process: onto other devices, another
//! input count or another rate, without relaunching the app.
//!
//! Step 3 of `docs/ios-port.md`. Before this a device change meant `restart`,
//! because the render closure owned every per-channel buffer by value and the
//! rate was a process-global fixed at launch. Now the engine is a value that
//! can be built off the audio thread (step 2), the rate is handed to whatever
//! needs it (`AudioStatus`), and a restart is: open the new units, prepare
//! everything that depends on the new rate while the old engine still plays,
//! stop the old units, swap, start the new ones. The silence is the stop and
//! the swap -- tens of milliseconds -- not the preparation.
//!
//! Two callers, one path. The picker calls `restart_audio` after writing the
//! prefs; the supervisor thread calls it when Core Audio says the device list,
//! a system default or the input's rate has changed. iOS route changes
//! (headphones in and out) will take the same path in step 4.
//!
//! **Nothing here runs on the audio thread, and the audio thread takes no lock
//! that a restart holds.** The swap happens while the units are stopped, so the
//! engine cannot be waiting on anything this does; the new engine is built with
//! its own handles before it is started. See `docs/design-notes.md`, *Restarting
//! the audio in-process*, for what happens to everything in flight.

use crate::bleed::{BleedPhase, BleedResult};
use crate::calibration::{CalibrationPhase, CalibrationResult};
use crate::engine::{Carry, Engine, EngineShared};
use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::platform::{self, DeviceChoice, DeviceId, HintSender, RateWatch};
use crate::prefs;
use crate::read_audio_file::{decode_audio_file, to_device_stereo, AudioFile};
use crate::stretch::{desired_ratio, request as request_stretch};
use crate::structs::AudioStatus;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Emitted after every restart that changed anything, with what is running now
/// and what the restart had to throw away. The frontend re-reads the channel
/// labels, the rate and the active devices from it.
pub const AUDIO_RESTARTED_EVENT: &str = "audio-restarted";
/// Emitted when a restart could not bring the audio back, with the reason.
pub const AUDIO_RESTART_FAILED_EVENT: &str = "audio-restart-failed";

/// How long the notifications have to go quiet before the supervisor looks. A
/// single plug event fires the device list, then one or both defaults, then
/// sometimes the list again, within tens of milliseconds; restarting on the
/// first would restart two or three times.
const DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioRestarted {
    pub status: AudioStatus,
    pub rate_changed: bool,
    pub channels_changed: bool,
    /// A recording could not continue into a file of another width or rate,
    /// so it was finished; its status says why.
    pub recording_stopped: bool,
    pub calibration_cancelled: bool,
    /// The bleed measurement is a property of the old device pair and lived in
    /// the old engine, so it is gone -- see `reset_bleed`.
    pub bleed_reset: bool,
    pub reason: String,
}

/// Everything the host shares with the rest of the process, beyond the
/// engine's own handles.
pub struct HostHandles {
    pub input_levels: Arc<Mutex<Arc<Vec<AtomicU32>>>>,
    pub drum_sources: Arc<Mutex<HashMap<String, Arc<AudioFile>>>>,
    pub bleed_result: Arc<Mutex<BleedResult>>,
    pub calibration_result: Arc<Mutex<CalibrationResult>>,
}

struct Inner {
    running: Option<platform::Running>,
    choice: Option<DeviceChoice>,
    /// The input device actually opened, whose rate is compared against the
    /// running one. `None` until something has started.
    input_device: Option<DeviceId>,
    rate_watch: Option<RateWatch>,
}

pub struct AudioHost {
    /// Serialises restarts, and holds what is running. Only ever taken by a
    /// restart and by launch -- never a command, never the audio thread.
    inner: Mutex<Inner>,
    /// Held by a restart for its whole length, and briefly by every command
    /// that builds state from the running device: loading a drum sample or the
    /// file (converted to the rate), starting a recording (sized by the input
    /// count, headed with the rate), a calibration or a bleed measurement
    /// (sized by the rate). So none of those can be half done at the old rate
    /// and land after the restart has converted everything to the new one.
    /// The audio thread never takes it.
    pub gate: Mutex<()>,
    /// The engine's handles. `input_levels` is replaced on every start; the
    /// rest are the same `Arc`s for the life of the process.
    shared: Mutex<EngineShared>,
    pub status: Arc<Mutex<AudioStatus>>,
    handles: HostHandles,
    prefs_dir: PathBuf,
    hint: &'static HintSender,
}

pub struct AudioHostState(pub Arc<AudioHost>);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // A poisoned lock still holds a usable value; a restart that refuses to run
    // because some other thread panicked would leave the app silent for good.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AudioHost {
    pub fn new(
        shared: EngineShared,
        status: Arc<Mutex<AudioStatus>>,
        handles: HostHandles,
        prefs_dir: PathBuf,
        hint: &'static HintSender,
    ) -> Self {
        AudioHost {
            inner: Mutex::new(Inner {
                running: None,
                choice: None,
                input_device: None,
                rate_watch: None,
            }),
            gate: Mutex::new(()),
            shared: Mutex::new(shared),
            status,
            handles,
            prefs_dir,
            hint,
        }
    }

    pub fn rate(&self) -> f64 {
        lock(&self.status).sample_rate
    }

    /// The first start, from a setup `main` has already opened and sized
    /// everything for. The same `begin` a restart ends with.
    pub fn launch(&self, setup: platform::AudioSetup) -> Result<(), String> {
        let mut inner = lock(&self.inner);
        self.begin(&mut inner, setup, Carry::default())
    }

    /// Build an engine for `setup` and start it. The engine is built here, on
    /// this thread, and moved into the render callback -- the audio thread
    /// never constructs anything.
    fn begin(&self, inner: &mut Inner, setup: platform::AudioSetup, carry: Carry) -> Result<(), String> {
        let platform::AudioSetup {
            input_unit,
            output_unit,
            input_channels,
            sample_rate,
            choice,
            input_device_id,
            ..
        } = setup;
        let shared = lock(&self.shared).clone();
        let engine = Engine::new(shared, input_channels, sample_rate, carry);
        let running = platform::start(input_unit, output_unit, engine)
            .map_err(|e| format!("the audio units would not start ({:?})", e))?;
        inner.running = Some(running);
        inner.choice = Some(choice);
        inner.input_device = Some(input_device_id);
        // Dropped before the new one is registered, so there is never a moment
        // with two listeners on one device sending the same notification twice.
        inner.rate_watch = None;
        inner.rate_watch = platform::watch_rate(input_device_id, self.hint);
        Ok(())
    }

    /// Restart if the devices the prefs resolve to now are not what is running,
    /// or the input's rate has moved. `Ok(None)` when there was nothing to do.
    /// `reason` is only carried to the frontend.
    pub fn restart(&self, app: &AppHandle, reason: &str) -> Result<Option<AudioRestarted>, String> {
        let mut inner = lock(&self.inner);
        let prefs = prefs::load(&self.prefs_dir);
        let wanted = platform::resolve_choice(&prefs)?;
        let running_rate = self.rate();
        // A device that has gone answers `None`, which is not a rate change --
        // the choice comparison is what notices it went.
        let rate_moved = inner
            .input_device
            .and_then(platform::device_rate)
            .map_or(false, |r| r != running_rate);
        if inner.running.is_some() && inner.choice.as_ref() == Some(&wanted) && !rate_moved {
            return Ok(None);
        }
        let _gate = lock(&self.gate);

        // Opened while the old units still play, so a device that will not
        // open costs nothing: the error goes to the panel and the audio
        // carries on as it was. Every fallback `get_input_output_channels`
        // makes at launch -- a missing device, one that cannot do its role,
        // one that refuses to open -- it makes here too, and says so the same
        // way, in `ActiveDevices`.
        let setup = platform::get_input_output_channels(&prefs)?;
        let rate = setup.sample_rate;
        let channels = setup.input_channels;
        let old = lock(&self.status).clone();
        let rate_changed = rate != old.sample_rate;
        let channels_changed = channels != old.input_channels;

        // Everything at the new rate, prepared while the old engine still
        // plays. The conversion is from each sample's *source*, never from the
        // last conversion, so repeated changes cannot compound.
        let prepared = if rate_changed {
            Some((self.convert_drums(rate), self.convert_file(old.sample_rate, rate)))
        } else {
            None
        };

        // The old engine goes here: `Running`'s drop stops both units --
        // `AudioOutputUnitStop` waits out a render in progress -- and frees the
        // callback, engine and all, on this thread. From here to `begin` the
        // audio is silent, and nothing below waits on anything slow.
        drop(inner.running.take());
        inner.rate_watch = None;
        let mut carry = lock(&self.shared).carry.load();

        let calibration_cancelled = self.cancel_calibration();
        let bleed_reset = self.reset_bleed();
        let recorder = lock(&self.shared).recorder.clone();
        let recording_stopped = match recorder.recording_format() {
            Some((r, inputs)) if r != rate || inputs.map_or(false, |n| n != channels) => {
                recorder.stop_because(&format!(
                    "stopped because the audio device changed ({} input{} at {} Hz); what was recorded until then is saved",
                    channels,
                    if channels == 1 { "" } else { "s" },
                    rate
                ));
                true
            }
            _ => false,
        };
        recorder.set_input_channels(channels);

        let levels: Arc<Vec<AtomicU32>> = Arc::new((0..channels).map(|_| AtomicU32::new(0)).collect());
        let old_levels = std::mem::replace(&mut *lock(&self.handles.input_levels), levels.clone());
        lock(&self.shared).input_levels = levels;

        let status = AudioStatus {
            active: setup.active.clone(),
            input_channels: channels,
            sample_rate: rate,
        };
        let clear_loop = rate_changed || channels_changed;
        if clear_loop {
            carry.loop_written = 0;
        }
        let shared = lock(&self.shared).clone();
        let (old_loop, old_drums, old_file, stretch) = {
            // The config lock is held across the rate change and everything
            // sized from it, which is what `set_config` relies on: it reads the
            // rate under this lock to resize the loop buffer, so it sees either
            // the old rate and the old buffer or the new rate and the new one.
            let config = lock(&shared.config);
            *lock(&self.status) = status.clone();
            // A loop recorded at another rate would play back at the wrong
            // pitch and against a different bar, and one recorded per channel
            // has nowhere to go when the channels change. Allocated here with
            // the units stopped, so nobody waits on it but `set_config`.
            let old_loop = if clear_loop {
                let size = get_loop_buffer_size(&config, rate);
                let mut lb = lock(&shared.loop_buffer);
                lb.pos = 0;
                Some(std::mem::replace(&mut lb.channels, vec![vec![0f32; size]; channels]))
            } else {
                None
            };
            let (mut old_drums, mut old_file) = (None, None);
            if let Some((drums, file)) = prepared {
                old_drums = Some(std::mem::replace(&mut *lock(&shared.drum_samples), drums));
                if let Some((natural, buffer)) = file {
                    let mut mp3 = lock(&shared.mp3);
                    let old_frames = mp3.frames();
                    let new_frames = buffer.len() / 2;
                    // A render in flight is from the old natural at the old
                    // rate; bumping the generation is what drops it.
                    mp3.generation += 1;
                    mp3.ratio = 1.0;
                    // Only read when no length in beats is declared, and then
                    // it is a position in frames -- scaled so the free-running
                    // file carries on from the same moment.
                    if old_frames > 0 {
                        mp3.pos = mp3.pos * new_frames as f64 / old_frames as f64;
                    }
                    old_file = Some((
                        std::mem::replace(&mut mp3.natural, Arc::new(natural)),
                        std::mem::replace(&mut mp3.buffer, buffer),
                    ));
                }
            }
            let natural_frames = lock(&shared.mp3).natural.len() / 2;
            let stretch = desired_ratio(&config, natural_frames, rate);
            (old_loop, old_drums, old_file, stretch)
        };
        // Freed with no lock held -- a loop buffer can be tens of megabytes.
        drop((old_loop, old_drums, old_file, old_levels));

        let result = self.begin(&mut inner, setup, carry);
        // Whether or not it started, the file has to be stretched for what is
        // now loaded; an unchanged ratio returns at once.
        request_stretch(app, stretch, rate);
        result?;

        Ok(Some(AudioRestarted {
            status,
            rate_changed,
            channels_changed,
            recording_stopped,
            calibration_cancelled,
            bleed_reset,
            reason: reason.to_string(),
        }))
    }

    /// Every drum sample, converted from its source at `rate`. The sources map
    /// is copied out (a few `Arc`s) so no lock is held while converting.
    fn convert_drums(&self, rate: f64) -> HashMap<String, Arc<Vec<f32>>> {
        let sources: Vec<(String, Arc<AudioFile>)> = lock(&self.handles.drum_sources)
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        sources
            .into_iter()
            .map(|(key, source)| (key, Arc::new(to_device_stereo(&source, rate))))
            .collect()
    }

    /// The file at `rate`: decoded again from its path, since a song is too big
    /// to keep a second copy of just for this. If the path no longer reads --
    /// moved, on a volume that is gone -- the loaded file is converted instead,
    /// which is one extra linear interpolation and says so, rather than the
    /// file going silent. `None` when no file is loaded. Returns the new
    /// natural buffer and a copy of it to play until the stretch lands.
    fn convert_file(&self, old_rate: f64, rate: f64) -> Option<(Vec<f32>, Vec<f32>)> {
        let mp3_arc = lock(&self.shared).mp3.clone();
        let (path, natural) = {
            let mp3 = lock(&mp3_arc);
            (mp3.path.clone(), mp3.natural.clone())
        };
        if natural.is_empty() {
            return None;
        }
        let converted = match decode_audio_file(&path) {
            Ok(file) => to_device_stereo(&file, rate),
            Err(e) => {
                println!(
                    "could not decode {} again ({}); converting the loaded copy from {} Hz instead",
                    path, e, old_rate
                );
                to_device_stereo(
                    &AudioFile {
                        samples: (*natural).clone(),
                        rate: old_rate,
                        channels: 2,
                    },
                    rate,
                )
            }
        };
        let buffer = converted.clone();
        Some((converted, buffer))
    }

    /// A latency measurement across a device change measures neither pair, and
    /// a finished-but-unread one is for the old pair -- applying it would write
    /// the old pair's round trip onto the new one. Both are dropped, and the
    /// panel is told why rather than seeing the run vanish.
    fn cancel_calibration(&self) -> bool {
        let shared = lock(&self.shared).clone();
        let mut cal = lock(&shared.calibration);
        if !(cal.active || cal.finished) {
            return false;
        }
        cal.cancel();
        drop(cal);
        *lock(&self.handles.calibration_result) = CalibrationResult {
            phase: CalibrationPhase::Failed,
            progress: 1.0,
            message: "the audio devices changed during the measurement -- run it again".into(),
            ..Default::default()
        };
        true
    }

    /// The bleed filter lives in the engine and describes one speaker, one
    /// microphone and one rate, so a restart always loses it -- the new engine
    /// starts untrained, which is a pass-through, not a wrong subtraction. The
    /// result the panel shows has to stop saying "done", or it claims a
    /// cancellation nothing is doing.
    fn reset_bleed(&self) -> bool {
        let shared = lock(&self.shared).clone();
        let was_running = {
            let mut train = lock(&shared.bleed_training);
            let active = train.active;
            train.cancel();
            active
        };
        let mut result = lock(&self.handles.bleed_result);
        if !was_running && result.phase == BleedPhase::Idle {
            return false;
        }
        *result = BleedResult {
            phase: BleedPhase::Failed,
            message: "the audio devices changed, so the bleed measurement no longer applies -- measure again".into(),
            ..Default::default()
        };
        true
    }

    /// `restart`, with the outcome sent to the frontend. What both callers use.
    pub fn restart_and_report(&self, app: &AppHandle, reason: &str) -> Result<AudioStatus, String> {
        match self.restart(app, reason) {
            Ok(Some(event)) => {
                println!(
                    "audio restarted ({}): {} -> {}, {} input(s) at {} Hz",
                    reason,
                    event.status.active.input_name,
                    event.status.active.output_name,
                    event.status.input_channels,
                    event.status.sample_rate
                );
                let _ = app.emit(AUDIO_RESTARTED_EVENT, event.clone());
                Ok(event.status)
            }
            Ok(None) => Ok(lock(&self.status).clone()),
            Err(message) => {
                println!("audio restart failed ({}): {}", reason, message);
                let _ = app.emit(AUDIO_RESTART_FAILED_EVENT, message.clone());
                Err(message)
            }
        }
    }
}

/// The thread that turns Core Audio's notifications into restarts. The
/// listeners only send on the channel; this waits for them to go quiet, then
/// asks the host whether anything it cares about actually changed -- most
/// notifications (a device the prefs do not name coming or going) change
/// nothing, and `restart` returns at once.
pub fn spawn_supervisor(host: Arc<AudioHost>, app: AppHandle, hints: Receiver<()>) {
    let spawned = std::thread::Builder::new()
        .name("audio-supervisor".into())
        .spawn(move || {
            while hints.recv().is_ok() {
                loop {
                    match hints.recv_timeout(DEBOUNCE) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let _ = host.restart_and_report(&app, "the system's audio devices changed");
            }
        });
    if let Err(e) = spawned {
        println!("could not start the audio supervisor ({}); device changes need a relaunch", e);
    }
}
