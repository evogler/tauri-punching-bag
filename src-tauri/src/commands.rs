use crate::analysis::{BINS, MAX_ANALYSIS_CHANNELS};
use crate::calibration::{analyze, CalibrationPhase, CalibrationResult};
use crate::constants::{sample_rate, ANALYSIS_RESERVE_HOPS, ONSET_RESERVE, VISUAL_RESERVE_FRAMES};
use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::io_channels::{list_devices, ActiveDevices, AudioDeviceInfo};
use crate::prefs::{load as load_prefs, save as save_prefs, AudioPrefs};
use crate::presets;
use crate::read_audio_file::{decode_audio_file, get_samples_from_filename, to_device_stereo};
use crate::stretch::{desired_ratio, request as request_stretch};
use crate::structs::{
    AnalysisFrames, AnalysisOutputBuffer, BeatResetState, BleedState, CalibrationState, Config,
    ConfigState, LoopGuardState,
    DrumSamples, InputChannelCount, LogState, LoopBufferState, Mp3BufferState, Payload,
    SampleOutputBuffer, VisualSamples,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Manager, State};

/// What the loader found, so the panel can say what it is and work out what
/// tempo a given number of beats implies. `sourceRate` is the file's own rate;
/// the buffer itself has already been converted to the device's.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// Frames *after* conversion, so seconds and beats are computed against the
    /// rate the callback actually plays at.
    pub frames: usize,
    pub seconds: f64,
    pub source_rate: f64,
    pub source_channels: usize,
    pub device_rate: f64,
}

#[tauri::command]
pub fn set_mp3_buffer(app_handle: tauri::AppHandle, filename: String) -> Result<FileInfo, String> {
    // An empty path is "no file", which a config carrying no file has to be
    // able to say. Without it, loading a preset that has none left Rust playing
    // whatever was loaded before -- against the new preset's beats and stretch,
    // which is what made it come back sounding stretched.
    if filename.is_empty() {
        let mp3_buffer_state: tauri::State<Mp3BufferState> = app_handle.state();
        // Emptied by swapping in and dropping *after* unlocking: the render
        // callback holds this mutex for its whole run, so freeing a file's worth
        // of samples inside it is time the audio thread waits. Same reason the
        // stretch swap does it this way.
        let (old_buffer, old_natural);
        {
            let mut mp3_buffer = mp3_buffer_state.0.lock().unwrap();
            old_buffer = std::mem::take(&mut mp3_buffer.buffer);
            old_natural = std::mem::replace(&mut mp3_buffer.natural, Arc::new(vec![]));
            mp3_buffer.ratio = 1.0;
            // So a render already in flight for the old file is dropped rather
            // than landing on top of the empty one.
            mp3_buffer.generation += 1;
            mp3_buffer.pos = 0.0;
        }
        drop(old_buffer);
        drop(old_natural);
        return Ok(FileInfo {
            frames: 0,
            seconds: 0.0,
            source_rate: 0.0,
            source_channels: 0,
            device_rate: sample_rate(),
        });
    }
    let decoded = decode_audio_file(&filename)?;
    let samples = to_device_stereo(&decoded);
    let frames = samples.len() / 2;

    let mp3_buffer_state: tauri::State<Mp3BufferState> = app_handle.state();
    {
        let mut mp3_buffer = mp3_buffer_state.0.lock().unwrap();
        mp3_buffer.natural = Arc::new(samples);
        mp3_buffer.buffer = (*mp3_buffer.natural).clone();
        // A new file means the ratio the old one was rendered at says nothing.
        mp3_buffer.ratio = 1.0;
        mp3_buffer.generation += 1;
    // Only matters when no length in beats has been declared; above zero the
    // position is derived from the beat and this is ignored. Loading no longer
    // resets the beat: the file is phase-locked to the clock now, so restarting
    // the clock to line a file up is neither needed nor wanted mid-practice.
        mp3_buffer.pos = 0.0;
    }

    // The tempo hasn't changed but the file has, so whatever stretch the config
    // implies has to be rendered for the new one.
    {
        let config_state: tauri::State<ConfigState> = app_handle.state();
        let config = config_state.0.lock().unwrap();
        let ratio = desired_ratio(&config, frames);
        drop(config);
        request_stretch(&app_handle, ratio);
    }

    Ok(FileInfo {
        frames,
        seconds: if sample_rate() > 0.0 {
            frames as f64 / sample_rate()
        } else {
            0.0
        },
        source_rate: decoded.rate,
        source_channels: decoded.channels,
        device_rate: sample_rate(),
    })
}

#[tauri::command]
pub fn get_samples(state: State<SampleOutputBuffer>) -> Result<VisualSamples, String> {
    // Allocated *before* the lock, from what the last drain took: the callback
    // holds this mutex for its whole run, so anything done inside it is time the
    // audio thread waits. Leaving `mem::take`'s zero-capacity vectors behind
    // made the callback itself grow them from nothing every drain, which is an
    // allocation on the audio thread and got worse per channel a pane added.
    let mut spare = spare_vecs(&state.drained);
    if let Ok(mut samples) = state.buffer.lock() {
        // Hand over the collected vectors and leave the pre-sized ones behind,
        // so the audio callback isn't blocked copying them.
        std::mem::swap(&mut samples.beats, &mut spare.0);
        std::mem::swap(&mut samples.values, &mut spare.1);
        state.drained.beats.store(spare.0.len(), Ordering::Relaxed);
        state.drained.values.store(spare.1.len(), Ordering::Relaxed);
        return Ok(VisualSamples {
            cycle: samples.cycle,
            channels: samples.channels,
            beats: spare.0,
            values: spare.1,
        });
    } else {
        return Err("get_samples failed.".into());
    }
}

/// Twice the last drain, floored at what one exchange can plausibly need --
/// enough that the callback never has to grow the vector, and self-adjusting
/// when a pane adds a channel.
fn reserve_for(last: &std::sync::atomic::AtomicUsize, floor: usize) -> usize {
    (last.load(Ordering::Relaxed) * 2).max(floor)
}

fn spare_vecs(drained: &crate::structs::DrainSizes) -> (Vec<f64>, Vec<f32>) {
    (
        Vec::with_capacity(reserve_for(&drained.beats, VISUAL_RESERVE_FRAMES)),
        Vec::with_capacity(reserve_for(&drained.values, VISUAL_RESERVE_FRAMES)),
    )
}

/// The spectrogram stream, drained exactly the way `get_samples` is: hand the
/// vectors over and leave empty ones behind, so the audio callback never waits
/// on a copy. Separate from `get_samples` so the per-frame path is untouched by
/// anything analysis does.
#[tauri::command]
pub fn get_analysis(state: State<AnalysisOutputBuffer>) -> Result<AnalysisFrames, String> {
    // Same reasoning as get_samples: sized before the lock so the callback
    // never grows these itself. Smaller per drain -- a hop rather than a frame
    // -- but pushed from the same thread.
    let hops = reserve_for(&state.drained.beats, ANALYSIS_RESERVE_HOPS);
    let mut spare_beats = Vec::with_capacity(hops);
    let mut spare_mags = Vec::with_capacity(reserve_for(
        &state.drained.values,
        ANALYSIS_RESERVE_HOPS * BINS,
    ));
    // Both follow the hop count rather than a counter of their own: `flux` is
    // exactly one f32 a hop a channel, and onsets are sparse.
    let mut spare_flux = Vec::with_capacity(hops * MAX_ANALYSIS_CHANNELS);
    let mut spare_onsets = Vec::with_capacity(ONSET_RESERVE);
    if let Ok(mut frames) = state.buffer.lock() {
        std::mem::swap(&mut frames.beats, &mut spare_beats);
        std::mem::swap(&mut frames.mags, &mut spare_mags);
        std::mem::swap(&mut frames.flux, &mut spare_flux);
        std::mem::swap(&mut frames.onsets, &mut spare_onsets);
        state
            .drained
            .beats
            .store(spare_beats.len(), Ordering::Relaxed);
        state
            .drained
            .values
            .store(spare_mags.len(), Ordering::Relaxed);
        return Ok(AnalysisFrames {
            channels: frames.channels,
            bins: frames.bins,
            beats: spare_beats,
            mags: spare_mags,
            onsets: spare_onsets,
            flux: spare_flux,
        });
    } else {
        return Err("get_analysis failed.".into());
    }
}

#[tauri::command]
pub fn get_input_channel_count(state: State<InputChannelCount>) -> usize {
    state.0
}

/// The rate the input device is running at, adopted at startup. The frontend
/// works in beats and never needs this to draw -- it is for the two places that
/// have to name a frequency or a duration in the UI: the Nyquist ceiling on the
/// flux band inputs and the millisecond label on the fft window dropdown.
#[tauri::command]
pub fn get_sample_rate() -> f64 {
    sample_rate()
}

/// Everything Core Audio will tell us about the devices on this machine, for
/// the picker. Re-enumerated on each call rather than cached, so plugging an
/// interface in and reopening the dropdown finds it.
#[tauri::command]
pub fn list_audio_devices() -> Vec<AudioDeviceInfo> {
    list_devices()
}

/// Which devices are actually open, which can differ from what was asked for --
/// see `ActiveDevices::input_fell_back`.
#[tauri::command]
pub fn get_active_devices(state: State<ActiveDevices>) -> ActiveDevices {
    state.inner().clone()
}

fn prefs_dir(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    tauri::api::path::app_config_dir(&app_handle.config())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

#[tauri::command]
pub fn get_audio_prefs(app_handle: tauri::AppHandle) -> AudioPrefs {
    load_prefs(&prefs_dir(&app_handle))
}

/// Written whenever the panel changes a device or a compensation. Takes the
/// whole object rather than a field so the file is never a partial write of a
/// state the UI never showed.
#[tauri::command]
pub fn set_audio_prefs(app_handle: tauri::AppHandle, prefs: AudioPrefs) -> Result<(), String> {
    save_prefs(&prefs_dir(&app_handle), &prefs)
}

/// The preset store. Text in, text out: the format lives on the frontend, next
/// to the config types it describes, and Rust has no business parsing it.
#[tauri::command]
pub fn get_presets(app_handle: tauri::AppHandle) -> Result<String, String> {
    presets::load(&prefs_dir(&app_handle))
}

#[tauri::command]
pub fn set_presets(app_handle: tauri::AppHandle, text: String) -> Result<(), String> {
    presets::save(&prefs_dir(&app_handle), &text)
}

/// Called when the frontend cannot parse the store. Renames it rather than
/// letting the next save write an empty one over it, and answers with the name
/// it was given so the panel can say where to look.
#[tauri::command]
pub fn quarantine_presets(app_handle: tauri::AppHandle) -> Result<String, String> {
    presets::quarantine(&prefs_dir(&app_handle))
}

/// Both halves of import/export. The path comes from a native dialog, which is
/// the same trust `load_drum_sample` runs on -- and the `fs` allowlist is
/// scoped to `$RESOURCE/*`, so the JS API could not reach it anyway.
#[tauri::command]
pub fn import_presets(path: String) -> Result<String, String> {
    presets::read_file(&path)
}

#[tauri::command]
pub fn export_presets(path: String, text: String) -> Result<(), String> {
    presets::write_file(&path, &text)
}

/// Device changes only take effect at startup: the render closure owns every
/// per-channel buffer by value, so swapping a device under it would mean
/// putting all of that behind a lock the audio thread could wait on. Relaunch
/// instead. `restart` reads Info.plist, so the *bundle* comes back and keeps
/// its microphone grant.
#[tauri::command]
pub fn restart_app(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

/// The deepest band the loop guard is holding down, and by how much. Polled by
/// the panel: a guard that cannot say what it is doing is one you cannot tell
/// from a broken one.
#[tauri::command]
pub fn get_loop_guard(state: State<LoopGuardState>) -> (f32, f32) {
    *state.0.lock().unwrap()
}

/// The built-in kit: ids, display names and files, from `samples/kit.json`.
#[tauri::command]
pub fn get_kit(state: State<crate::structs::KitState>) -> Vec<crate::structs::KitSound> {
    state.0.clone()
}

/// Peak input level per channel since the last call, then zeroed. What the
/// setup's microphone check polls; the callback only ever raises the slots.
#[tauri::command]
pub fn get_input_levels(state: State<crate::structs::InputLevelState>) -> Vec<f32> {
    state
        .0
        .iter()
        .map(|slot| f32::from_bits(slot.swap(0, Ordering::Relaxed)))
        .collect()
}

/// Starts a bleed measurement: a couple of seconds of noise through the
/// speaker with everything else muted, fitting the filter against what comes
/// back. Everything it needs already exists on the audio thread; this only
/// flips the switch.
#[tauri::command]
pub fn start_bleed_training(state: State<BleedState>) {
    *state.1.lock().unwrap() = crate::bleed::BleedResult {
        phase: crate::bleed::BleedPhase::Running,
        ..Default::default()
    };
    let frames = (crate::bleed::TRAIN_SECONDS * crate::constants::sample_rate()) as usize;
    state.0.lock().unwrap().start(frames);
}

#[tauri::command]
pub fn cancel_bleed_training(state: State<BleedState>) {
    state.0.lock().unwrap().cancel();
    *state.1.lock().unwrap() = crate::bleed::BleedResult::default();
}

/// Polled by the panel while a run is in flight, and read once afterwards for
/// the verdict.
#[tauri::command]
pub fn get_bleed_status(state: State<BleedState>) -> crate::bleed::BleedResult {
    let mut train = state.0.lock().unwrap();
    // The audio thread signals that a run is over and leaves the verdict to be
    // written here, where a `String` may be allocated.
    if train.finished {
        train.finished = false;
        *state.1.lock().unwrap() = train.result();
    }
    let mut result = state.1.lock().unwrap().clone();
    let (live_db, live_duty) = *state.2.lock().unwrap();
    result.live_db = live_db;
    result.live_duty = live_duty;
    if train.active {
        result.phase = crate::bleed::BleedPhase::Running;
        result.progress = train.progress();
    }
    result
}

/// Begins a run. Everything it needs is allocated here, off the audio thread;
/// the callback only indexes into it afterwards.
#[tauri::command]
pub fn start_calibration(state: State<CalibrationState>, channel: usize) {
    *state.1.lock().unwrap() = CalibrationResult {
        phase: CalibrationPhase::Running,
        ..Default::default()
    };
    state.0.lock().unwrap().start(channel);
}

#[tauri::command]
pub fn cancel_calibration(state: State<CalibrationState>) {
    state.0.lock().unwrap().cancel();
    *state.1.lock().unwrap() = CalibrationResult::default();
}

/// Polled by the panel while a run is in flight. When the callback signals it
/// has finished, the capture is *swapped* out under the lock -- O(1), never a
/// memcpy of a second of audio while the audio thread waits -- and the
/// correlation runs here, outside it.
#[tauri::command]
pub fn get_calibration_status(state: State<CalibrationState>) -> CalibrationResult {
    let taken = {
        let mut cal = state.0.lock().unwrap();
        if cal.finished {
            cal.finished = false;
            Some(cal.take_capture())
        } else {
            let running = cal.active;
            let progress = cal.progress();
            drop(cal);
            let mut last = state.1.lock().unwrap();
            if running {
                last.phase = CalibrationPhase::Running;
                last.progress = progress;
            }
            return last.clone();
        }
    };
    let (capture, emit_at, chirp) = taken.unwrap();
    let result = analyze(&capture, &emit_at, &chirp);
    *state.1.lock().unwrap() = result.clone();
    result
}

/// Decodes a file and files it under its own path, which is how a drum voice
/// refers to it. Decoding here rather than in the audio thread means the render
/// callback only ever does a map lookup.
#[tauri::command]
pub fn load_drum_sample(state: State<DrumSamples>, path: String) -> Result<usize, String> {
    // Already there -- a kit sound loaded at startup, or a file loaded before.
    // Answering from the map means the frontend never has to know which names
    // are built in before asking, so there is no race with fetching the kit.
    if let Some(existing) = state.0.lock().map_err(|_| "sample map poisoned".to_string())?.get(&path) {
        return Ok(existing.len());
    }
    let samples = get_samples_from_filename(&path)?;
    let len = samples.len();
    let mut map = state
        .0
        .lock()
        .map_err(|_| "sample map poisoned".to_string())?;
    map.insert(path, Arc::new(samples));
    Ok(len)
}

#[tauri::command]
pub fn reset_beat(state: State<BeatResetState>) -> Result<(), String> {
    state.0.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub fn set_config(app_handle: tauri::AppHandle, new_config: Config) {
    let logs: tauri::State<LogState> = app_handle.state();
    let logs = logs.0.lock().unwrap();

    app_handle
        .emit_all(
            "log",
            Payload {
                message: logs.to_vec(),
            },
        )
        .unwrap();
    println!("set_config called: {:?}", new_config);
    let config_state: tauri::State<ConfigState> = app_handle.state();
    let mut config = config_state.0.lock().unwrap();

    let should_update_loop_buffer = new_config.bpm != config.bpm
        || new_config.beats_to_loop != config.beats_to_loop
        || new_config.loop_echoes != config.loop_echoes
        || new_config.buffer_compensation != config.buffer_compensation;
    *config = new_config;

    if should_update_loop_buffer {
        println!("updating loop buffer");
        let c = config.clone();
        let new_buffer_size = get_loop_buffer_size(&c);
        let loop_buffer_state: tauri::State<LoopBufferState> = app_handle.state();
        let mut loop_buffer = loop_buffer_state.0.lock().unwrap();
        for channel in loop_buffer.channels.iter_mut() {
            channel.resize(new_buffer_size, 0.0);
        }
        loop_buffer.pos = 0;
        println!("new_buffer_size: {}", new_buffer_size);
    }

    // Tempo, length in beats and the switch itself all move the stretch ratio,
    // so this is checked on every push -- `request_stretch` returns immediately
    // when the ratio hasn't actually moved, which is nearly always.
    let natural_frames = {
        let mp3_state: tauri::State<Mp3BufferState> = app_handle.state();
        let mp3 = mp3_state.0.lock().unwrap();
        mp3.natural.len() / 2
    };
    let ratio = desired_ratio(&config, natural_frames);
    // Dropped before asking: the render callback takes the config lock and then
    // the file lock, so this side must never hold the two in the other order.
    drop(config);
    request_stretch(&app_handle, ratio);
}
