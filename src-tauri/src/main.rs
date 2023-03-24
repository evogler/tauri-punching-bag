#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod constants;
mod get_loop_buffer_size;
mod io_channels;
mod read_audio_file;
mod structs;
mod types;
mod util;

extern crate coreaudio;

use crate::commands::{get_samples, reset_beat, set_config, set_mp3_buffer};
use crate::constants::{default_config, SAMPLE_RATE};
use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::io_channels::{get_input_output_channels, make_buffers, start_input_audio_unit};
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    BeatResetState, ConfigState, LogState, LoopBuffer, LoopBufferState, Mp3Buffer, Mp3BufferState,
    SampleOutputBuffer, SoundingSample,
};
use crate::types::{Args, S};
use crate::util::{beat_bisect, mod_add};
use rand::Rng;
use std::{
    collections::HashMap,
    sync::atomic::AtomicBool,
    sync::{Arc, Mutex},
};

fn main() -> Result<(), coreaudio::Error> {
    let context = tauri::generate_context!();
    let app_config_dir = tauri::api::path::config_dir();
    let rd = tauri::api::path::resource_dir(&context.package_info(), &tauri::utils::Env::default());
    let binding = rd.unwrap();
    let resource_dir = binding.to_str().unwrap();
    // let resource_dir = rd.unwrap().to_str().unwrap();
    // tauri::api::path::config_dir()

    // access an asset file within the tauri app

    // load mp3
    let mut mp3_loaded = false;
    let path = "/Users/eric/Music/Logic/tauri-file.wav".into();
    println!("app_config_dir: {:?}", app_config_dir);
    println!("resource_dir: {:?}", &resource_dir);
    let data = get_samples_from_filename(&path);
    let mp3_arc: Arc<Mutex<Mp3Buffer>>;
    if let Ok(data) = data {
        mp3_loaded = true;
        mp3_arc = Arc::new(Mutex::new(Mp3Buffer {
            buffer: data,
            pos: 0,
        }));
    } else {
        mp3_arc = Arc::new(Mutex::new(Mp3Buffer {
            buffer: vec![],
            pos: 0,
        }));
    }

    let mp3 = mp3_arc.clone();
    let mp3_state = Mp3BufferState(mp3_arc.clone());

    // load samples
    let mut sample_buffers = HashMap::new();
    let ride_path = &format!("{}/{}", resource_dir, "samples/ride_cropped.wav");
    sample_buffers.insert(
        "ride".to_string(),
        Arc::new(get_samples_from_filename(ride_path).unwrap()),
    );
    let mut sounding_samples = vec![];
    sounding_samples.push(SoundingSample {
        sample: sample_buffers.get("ride").unwrap().clone(),
        pos: 0,
    });

    // setup audio
    let (mut input_audio_unit, mut output_audio_unit, io_log) =
        get_input_output_channels().unwrap();
    let buffers = make_buffers();

    let mut click_sound_counter: i32 = 0;
    let mut rng = rand::thread_rng();

    let log_state = LogState(Arc::new(Mutex::new(io_log)));

    let config = default_config();
    let config_state = ConfigState(Arc::new(Mutex::new(config)));
    let config1 = config_state.0.clone();

    let sample_output_buffer = SampleOutputBuffer {
        buffer: Default::default(),
    };
    let sample_output_buffer_clone = sample_output_buffer.buffer.clone();

    let loop_buffer_size: usize;
    {
        let c = config1.lock().unwrap();
        loop_buffer_size = get_loop_buffer_size(&c);
    }
    let loop_buffer = LoopBuffer {
        buffer: vec![0f32; loop_buffer_size],
        pos: 0,
    };
    let loop_buffer_mutex_arc = Arc::new(Mutex::new(loop_buffer));
    let loop_buffer_clone = loop_buffer_mutex_arc.clone();
    let loop_buffer_state = LoopBufferState(loop_buffer_mutex_arc.clone());

    let should_reset_beat_arc = Arc::new(AtomicBool::new(false));
    let should_reset_beat = should_reset_beat_arc.clone();
    let should_reset_beat_state = BeatResetState(should_reset_beat_arc.clone());

    let mut beat: f64 = 0.0;
    let mut last_beat: isize = 0;

    start_input_audio_unit(
        &mut input_audio_unit,
        buffers.producer_left,
        buffers.producer_right,
    )
    .unwrap();

    output_audio_unit.set_render_callback(move |args: Args| {
        let Args {
            num_frames,
            mut data,
            ..
        } = args;
        let buffer_left = buffers.consumer_left.lock().unwrap();
        let buffer_right = buffers.consumer_right.lock().unwrap();
        let mut buffers = vec![buffer_left, buffer_right];
        let config = config1.lock().unwrap();
        let mut loop_buffer = loop_buffer_clone.lock().unwrap();
        let beats_per_sample: f64 = config.bpm / SAMPLE_RATE / 60f64;
        let mut mp3 = mp3.lock().unwrap();

        if should_reset_beat.load(std::sync::atomic::Ordering::Relaxed) {
            beat = 0.0;
            mp3.pos = 0;
            should_reset_beat_arc.store(false, std::sync::atomic::Ordering::Relaxed);
        }

        if let Ok(mut state_vec) = sample_output_buffer_clone.lock() {
            for i in 0..num_frames {
                // Default other channels to copy value from first channel as a fallback
                let zero: S = 0 as S;
                let f: S = *buffers[0].front().unwrap_or(&zero);
                for (ch, channel) in data.channels_mut().enumerate() {
                    let sample: S = buffers[ch].pop_front().unwrap_or(f) * config.audio_in_gain;
                    let mut audio_out = 0.0;
                    let mut visual_out = 0.0;
                    if config.audio_monitor_on {
                        audio_out += sample;
                    }
                    if config.visual_monitor_on {
                        visual_out += sample;
                    }

                    let p = loop_buffer.pos;

                    let compensated_loop_buffer_pos = mod_add(
                        loop_buffer.pos,
                        config.buffer_compensation * 2,
                        loop_buffer.buffer.len(),
                    );

                    if config.looping_on {
                        audio_out += loop_buffer.buffer[compensated_loop_buffer_pos];
                        visual_out += loop_buffer.buffer[loop_buffer.pos];
                        loop_buffer.buffer[p] = sample;
                    } else {
                        loop_buffer.buffer[p] = 0.0;
                    }

                    channel[i] = audio_out * 12.0;

                    // mp3_sample = mp3_sample * 0.995 + mp3[mp3_pos] * 0.005;
                    if mp3_loaded && config.play_file {
                        channel[i] += mp3.buffer[mp3.pos];
                        // channel[i] += mp3_sample;
                    }
                    if ch == 0 || ch == 1 {
                        mp3.pos += 1;
                    }
                    if mp3.pos >= mp3.buffer.len() {
                        mp3.pos = 0;
                    }

                    loop_buffer.pos += 1;
                    if loop_buffer.pos >= loop_buffer.buffer.len() {
                        loop_buffer.pos = 0;
                    }

                    for j in (0..sounding_samples.len()).rev() {
                        if sounding_samples[j].pos < sounding_samples[j].sample.len() {
                            if config.drum_on {
                                channel[i] += sounding_samples[j].sample[sounding_samples[j].pos];
                            }
                            sounding_samples[j].pos += 1;
                        } else {
                            sounding_samples.remove(j);
                        }
                    }

                    let visual_beat =
                        (beat - (config.buffer_compensation as f64) * beats_per_sample) as f32;
                    state_vec.push((visual_beat, visual_out.abs()));

                    // let adjusted_beat = beat_bisect(&config.audio_subdivisions, beat);
                    let mut audio_times = config
                        .audio_subdivisions
                        .notes
                        .iter()
                        .map(|n| n.time)
                        .collect::<Vec<f64>>();
                    audio_times.push(config.audio_subdivisions.end);

                    let adjusted_beat = beat_bisect(&audio_times, beat);
                    if adjusted_beat != last_beat {
                        sounding_samples.push(SoundingSample {
                            sample: sample_buffers.get("ride").unwrap().clone(),
                            pos: 0,
                        });
                        if config.audio_subdivisions.notes.len() < 2
                            || (adjusted_beat % ((config.audio_subdivisions.notes.len()) as isize)
                                == 0)
                        {
                            click_sound_counter = 400;
                        } else {
                            click_sound_counter = 100;
                        }
                        last_beat = adjusted_beat;
                    }
                    if click_sound_counter > 0 {
                        click_sound_counter -= 1;
                        let in_loop = beat % (config.beats_to_loop * 2.0) < config.beats_to_loop;
                        if config.click_on {
                            if !config.click_toggle || in_loop {
                                let mut r = rng.gen::<f32>() * (config.click_volume as f32);
                                if r > 1.0 {
                                    r = 1.0;
                                }
                                channel[i] += r;
                            }
                        }
                    }
                }
                beat += beats_per_sample;
            }
        }
        Ok(())
    })?;
    output_audio_unit.start()?;

    tauri::Builder::default()
        .manage(sample_output_buffer)
        .manage(config_state)
        .manage(loop_buffer_state)
        .manage(mp3_state)
        .manage(should_reset_beat_state)
        .manage(log_state)
        .invoke_handler(tauri::generate_handler![
            get_samples,
            set_config,
            reset_beat,
            set_mp3_buffer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
