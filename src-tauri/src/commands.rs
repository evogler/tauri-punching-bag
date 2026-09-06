use crate::analysis::{BINS, MAX_ANALYSIS_CHANNELS};
use crate::constants::{sample_rate, ANALYSIS_RESERVE_HOPS, ONSET_RESERVE, VISUAL_RESERVE_FRAMES};
use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::io_channels::{list_devices, ActiveDevices, AudioDeviceInfo};
use crate::prefs::{load as load_prefs, save as save_prefs, AudioPrefs};
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    AnalysisFrames, AnalysisOutputBuffer, BeatResetState, Config, ConfigState, DrumSamples,
    InputChannelCount, LogState, LoopBufferState, Mp3BufferState, Payload, SampleOutputBuffer,
    VisualSamples,
};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Manager, State};

#[tauri::command]
pub fn set_mp3_buffer(app_handle: tauri::AppHandle, filename: String) {
    let mp3_buffer_state: tauri::State<Mp3BufferState> = app_handle.state();
    let beat_state_reset: tauri::State<BeatResetState> = app_handle.state();
    let mut mp3_buffer = mp3_buffer_state.0.lock().unwrap();
    let samples = get_samples_from_filename(&filename);
    if let Err(_err) = samples {
        println!("Error while reading file: {}", _err);
    } else {
        let samples = samples.unwrap();
        println!("samples: {}", samples.len());
        mp3_buffer.buffer = samples;
        mp3_buffer.pos = 0;
        beat_state_reset
            .0
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
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

/// Device changes only take effect at startup: the render closure owns every
/// per-channel buffer by value, so swapping a device under it would mean
/// putting all of that behind a lock the audio thread could wait on. Relaunch
/// instead. `restart` reads Info.plist, so the *bundle* comes back and keeps
/// its microphone grant.
#[tauri::command]
pub fn restart_app(app_handle: tauri::AppHandle) {
    app_handle.restart();
}

/// Decodes a file and files it under its own path, which is how a drum voice
/// refers to it. Decoding here rather than in the audio thread means the render
/// callback only ever does a map lookup.
#[tauri::command]
pub fn load_drum_sample(state: State<DrumSamples>, path: String) -> Result<usize, String> {
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
}
