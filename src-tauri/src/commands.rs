use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    BeatResetState, Config, ConfigState, LogState, LoopBufferState, Mp3BufferState, Payload,
    SampleOutputBuffer,
};
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
pub fn get_samples(state: State<SampleOutputBuffer>) -> Result<Vec<(f32, f32)>, String> {
    if let Ok(mut samples) = state.buffer.lock() {
        let res = samples.to_vec();
        samples.clear();
        return Ok(res);
    } else {
        return Err("get_samples failed.".into());
    }
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
        || new_config.buffer_compensation != config.buffer_compensation;
    *config = new_config;

    if should_update_loop_buffer {
        println!("updating loop buffer");
        let c = config.clone();
        let new_buffer_size = get_loop_buffer_size(&c);
        let loop_buffer_state: tauri::State<LoopBufferState> = app_handle.state();
        let mut loop_buffer = loop_buffer_state.0.lock().unwrap();
        // loop_buffer.buffer.clear();
        loop_buffer.buffer.resize(new_buffer_size, 0.0);
        loop_buffer.pos = 0;
        println!("new_buffer_size: {}", new_buffer_size);
    }
}
