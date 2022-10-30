#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod read_audio_file;

extern crate coreaudio;

use read_audio_file::get_samples_from_filename;

use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{audio_unit_from_device_id, get_default_device_id};
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::*;
use coreaudio::Error;
use rand::Rng;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

struct SampleOutputBuffer {
    buffer: Arc<Mutex<Vec<(f32, f32)>>>,
}

struct LoopBuffer {
    buffer: Vec<f32>,
    pos: usize,
}

struct LoopBufferState(Arc<Mutex<LoopBuffer>>);

#[derive(Clone)]
struct Config {
    bpm: f64,
    beats_to_loop: f64,
    looping_on: bool,
    click_on: bool,
    click_toggle: bool,
    visual_monitor_on: bool,
    audio_monitor_on: bool,
    buffer_compensation: usize,
    subdivision: f64,
}
struct ConfigState(Arc<Mutex<Config>>);

const SAMPLE_RATE: f64 = 44100.0;

type S = f32;
const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

type Args = render_callback::Args<data::NonInterleaved<S>>;

fn get_loop_buffer_size(config: &Config) -> usize {
    let mut res = config.beats_to_loop / config.bpm * SAMPLE_RATE * 60.0 * 2.0;
    if res < 0.0 {
        res = 0.0;
    }
    res as usize
}

fn mod_add(a: usize, b: usize, max: usize) -> usize {
    let mut res = a + b;
    while res >= max {
        res -= max;
    }
    res
}

#[tauri::command]
fn get_samples(state: State<SampleOutputBuffer>) -> Result<Vec<(f32, f32)>, String> {
    if let Ok(mut samples) = state.buffer.lock() {
        let res = samples.to_vec();
        samples.clear();
        return Ok(res);
    } else {
        return Err("get_samples failed.".into());
    }
}

#[tauri::command]
fn set_config(
    app_handle: tauri::AppHandle,
    bpm: f64,
    beatstoloop: f64,
    loopingon: bool,
    clickon: bool,
    clicktoggle: bool,
    visualmonitoron: bool,
    audiomonitoron: bool,
    buffercompensation: usize,
    subdivision: f64,
) {
    println!("set_config called");
    let config_state: tauri::State<ConfigState> = app_handle.state();
    let mut config = config_state.0.lock().unwrap();

    let should_update_loop_buffer = bpm != config.bpm
        || beatstoloop != config.beats_to_loop
        || buffercompensation != config.buffer_compensation;
    config.bpm = bpm;
    config.beats_to_loop = beatstoloop;
    config.looping_on = loopingon;
    config.click_on = clickon;
    config.click_toggle = clicktoggle;
    config.audio_monitor_on = audiomonitoron;
    config.visual_monitor_on = visualmonitoron;
    config.buffer_compensation = buffercompensation;
    config.subdivision = subdivision;

    if should_update_loop_buffer {
        println!("hi!");
        // let c = config_state.0.clone();
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

fn get_input_output_channels() -> Result<(AudioUnit, AudioUnit), Error> {
    let mut input_audio_unit =
        audio_unit_from_device_id(get_default_device_id(true).unwrap(), true)?;
    let mut output_audio_unit =
        audio_unit_from_device_id(get_default_device_id(false).unwrap(), false)?;

    // input_audio_unit.set_property(id, scope, elem, maybe_data);

    let format_flag = match SAMPLE_FORMAT {
        SampleFormat::F32 => LinearPcmFlags::IS_FLOAT,
        SampleFormat::I32 | SampleFormat::I16 | SampleFormat::I8 => {
            LinearPcmFlags::IS_SIGNED_INTEGER
        }
        _ => {
            unimplemented!("Other formats are not implemented for this example.");
        }
    };

    // Using IS_NON_INTERLEAVED everywhere because data::Interleaved is commented out / not implemented
    let in_stream_format = StreamFormat {
        sample_rate: SAMPLE_RATE,
        sample_format: SAMPLE_FORMAT,
        flags: format_flag | LinearPcmFlags::IS_PACKED | LinearPcmFlags::IS_NON_INTERLEAVED,
        // audio_unit.set_input_callback is hardcoded to 1 buffer, and when using non_interleaved
        // we are forced to 1 channel
        channels: 1,
    };

    let out_stream_format = StreamFormat {
        sample_rate: SAMPLE_RATE,
        sample_format: SAMPLE_FORMAT,
        flags: format_flag | LinearPcmFlags::IS_PACKED | LinearPcmFlags::IS_NON_INTERLEAVED,
        // you can change this to 1
        channels: 2,
    };

    println!("input={:#?}", &in_stream_format);
    println!("output={:#?}", &out_stream_format);
    println!("input_asbd={:#?}", &in_stream_format.to_asbd());
    println!("output_asbd={:#?}", &out_stream_format.to_asbd());

    let id = kAudioUnitProperty_StreamFormat;
    let asbd = in_stream_format.to_asbd();
    input_audio_unit.set_property(id, Scope::Output, Element::Input, Some(&asbd))?;

    let asbd = out_stream_format.to_asbd();
    output_audio_unit.set_property(id, Scope::Input, Element::Output, Some(&asbd))?;

    Ok((input_audio_unit, output_audio_unit))
}

fn start_input_audio_unit(
    input_audio_unit: &mut AudioUnit,
    producer_left: Arc<Mutex<VecDeque<f32>>>,
    producer_right: Arc<Mutex<VecDeque<f32>>>,
) -> Result<(), Error> {
    input_audio_unit.set_input_callback(move |args| {
        let Args {
            num_frames,
            mut data,
            ..
        } = args;
        let buffer_left = producer_left.lock().unwrap();
        let buffer_right = producer_right.lock().unwrap();
        let mut buffers = vec![buffer_left, buffer_right];
        for i in 0..num_frames {
            for (ch, channel) in data.channels_mut().enumerate() {
                let value: S = channel[i];
                buffers[ch].push_back(value);
            }
        }
        Ok(())
    })?;
    input_audio_unit.start()?;
    Ok(())
}

struct Buffers {
    producer_left: Arc<Mutex<VecDeque<f32>>>,
    consumer_left: Arc<Mutex<VecDeque<f32>>>,
    producer_right: Arc<Mutex<VecDeque<f32>>>,
    consumer_right: Arc<Mutex<VecDeque<f32>>>,
}

fn make_buffers() -> Buffers {
    let buffer_left = Arc::new(Mutex::new(VecDeque::<S>::new()));
    let buffer_right = Arc::new(Mutex::new(VecDeque::<S>::new()));
    Buffers {
        producer_left: buffer_left.clone(),
        consumer_left: buffer_left.clone(),
        producer_right: buffer_right.clone(),
        consumer_right: buffer_right.clone(),
    }
}
fn main() -> Result<(), coreaudio::Error> {
    let path = "/Users/eric/Music/Logic/ICHTY180.wav".into();
    let mp3 = get_samples_from_filename(&path).unwrap();
    let mut mp3_pos: usize = 0;

    println!("Read mp3 file with length: {}.", mp3.len());

    let (mut input_audio_unit, mut output_audio_unit) = get_input_output_channels().unwrap();
    let buffers = make_buffers();

    let mut click_sound_counter: i32 = 0;
    let mut rng = rand::thread_rng();

    let config = Config {
        bpm: 180.0,
        beats_to_loop: 4.0,
        looping_on: true,
        click_on: true,
        click_toggle: false,
        visual_monitor_on: true,
        audio_monitor_on: true,
        buffer_compensation: 1250,
        subdivision: 3.0,
    };
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

    let mut beat: f64 = 0.0;
    let mut last_beat: usize = 0;

    // let mp3_bpm: f64;
    // mp3_bpm = config.clone().bpm;
    let mp3_bpm = 180.0f64;

    let mp3_loop_len = ((SAMPLE_RATE * 60.0 / mp3_bpm) * (2.0 * 4.0 * 32.0)) as usize;
    if mp3_loop_len > mp3.len() {
        panic!("trying to loop past EOF");
    }

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

        if let Ok(mut state_vec) = sample_output_buffer_clone.lock() {
            for i in 0..num_frames {
                // Default other channels to copy value from first channel as a fallback
                let zero: S = 0 as S;
                let f: S = *buffers[0].front().unwrap_or(&zero);
                for (ch, channel) in data.channels_mut().enumerate() {
                    let sample: S = buffers[ch].pop_front().unwrap_or(f);
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
                        config.buffer_compensation,
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
                    channel[i] += mp3[mp3_pos];
                    mp3_pos += 1;
                    if mp3_pos >= mp3_loop_len {
                        mp3_pos = 0;
                    }

                    loop_buffer.pos += 1;
                    if loop_buffer.pos >= loop_buffer.buffer.len() {
                        loop_buffer.pos = 0;
                    }

                    let visual_beat =
                        (beat - (config.buffer_compensation as f64) * beats_per_sample) as f32;
                    state_vec.push((visual_beat, visual_out.abs()));

                    let adjusted_beat = (beat * config.subdivision) as usize;
                    if adjusted_beat != last_beat {
                        if adjusted_beat % (config.subdivision as usize) == 0 {
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
                                channel[i] += rng.gen::<f32>() * 0.3;
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
        .invoke_handler(tauri::generate_handler![get_samples, set_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
