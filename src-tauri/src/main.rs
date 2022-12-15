#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod beat_bisect;
mod read_audio_file;

extern crate coreaudio;

use beat_bisect::beat_bisect;
use read_audio_file::get_samples_from_filename;

use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{
    audio_unit_from_device_id, get_audio_device_ids, get_default_device_id, get_device_name,
    get_supported_physical_stream_formats,
};
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::*;
use coreaudio::Error;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicBool;
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

struct Mp3Buffer {
    buffer: Vec<f32>,
    pos: usize,
}

struct Mp3BufferState(Arc<Mutex<Mp3Buffer>>);

struct BeatResetState(Arc<AtomicBool>);

struct LogState(Arc<Mutex<Vec<String>>>);

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Note {
    time: f64,
    // sounds: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ParserRhythm {
    notes: Vec<Note>,
    start: f64,
    end: f64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Config {
    bpm: f64,
    beats_to_loop: f64,
    looping_on: bool,
    click_on: bool,
    click_toggle: bool,
    click_volume: f64,
    drum_on: bool,
    play_file: bool,
    visual_monitor_on: bool,
    audio_monitor_on: bool,
    buffer_compensation: usize,
    audio_subdivisions: ParserRhythm,
    test_object: ParserRhythm,
}
struct ConfigState(Arc<Mutex<Config>>);

#[derive(Clone, serde::Serialize)]
struct Payload {
    message: Vec<String>,
}

struct SoundingSample {
    sample: Arc<Vec<f32>>,
    pos: usize,
}

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
fn reset_beat(state: State<BeatResetState>) -> Result<(), String> {
    state.0.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn set_config(app_handle: tauri::AppHandle, new_config: Config) {
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

#[tauri::command]
fn set_mp3_buffer(app_handle: tauri::AppHandle, filename: String) {
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

fn get_input_output_channels() -> Result<(AudioUnit, AudioUnit, Vec<String>), Error> {
    let devices = get_audio_device_ids();
    devices.unwrap().iter().for_each(|d| {
        println!("device: {:?}", get_device_name(*d));
        println!("{:?}", get_supported_physical_stream_formats(*d));
    });

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

    let mut result_log = vec![];
    println!("input={:#?}", &in_stream_format);
    println!("output={:#?}", &out_stream_format);
    println!("input_asbd={:#?}", &in_stream_format.to_asbd());
    println!("output_asbd={:#?}", &out_stream_format.to_asbd());
    result_log.push(format!("{:#?}", &in_stream_format));
    result_log.push(format!("{:#?}", &out_stream_format));
    result_log.push(format!("{:#?}", &in_stream_format.to_asbd()));
    result_log.push(format!("{:#?}", out_stream_format.to_asbd()));

    let id = kAudioUnitProperty_StreamFormat;
    let asbd = in_stream_format.to_asbd();
    input_audio_unit.set_property(id, Scope::Output, Element::Input, Some(&asbd))?;

    let asbd = out_stream_format.to_asbd();
    output_audio_unit.set_property(id, Scope::Input, Element::Output, Some(&asbd))?;

    // set audiounit buffer size to 32 samples, or however
    let id = kAudioDevicePropertyBufferFrameSize;
    let buffer_size: u32 = 2048;
    input_audio_unit.set_property(id, Scope::Output, Element::Input, Some(&buffer_size))?;
    output_audio_unit.set_property(id, Scope::Input, Element::Output, Some(&buffer_size))?;

    Ok((input_audio_unit, output_audio_unit, result_log))
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
    let mut mp3_loaded = false;
    let path = "/Users/eric/Music/Logic/tauri-file.wav".into();
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

    let mut sample_buffers = HashMap::new();
    sample_buffers.insert(
        "ride".to_string(),
        Arc::new(
            get_samples_from_filename(
                &"/Users/eric/Workspace/tauri-punching-bag/src-tauri/samples/ride_cropped.wav"
                    .into(),
            )
            .unwrap(),
        ),
    );
    let mut sounding_samples = vec![];
    sounding_samples.push(SoundingSample {
        sample: sample_buffers.get("ride").unwrap().clone(),
        pos: 0,
    });

    let (mut input_audio_unit, mut output_audio_unit, io_log) =
        get_input_output_channels().unwrap();
    let buffers = make_buffers();

    let mut click_sound_counter: i32 = 0;
    let mut rng = rand::thread_rng();

    let log_state = LogState(Arc::new(Mutex::new(io_log)));

    let config = Config {
        bpm: 91.0,
        beats_to_loop: 4.0,
        looping_on: false,
        click_on: true,
        click_toggle: false,
        click_volume: 0.3,
        drum_on: true,
        play_file: true,
        visual_monitor_on: true,
        audio_monitor_on: false,
        buffer_compensation: 4330,
        audio_subdivisions: ParserRhythm {
            start: 0.0,
            end: 1.0,
            notes: vec![Note { time: 0.0 }, Note { time: 0.5 }],
        },
        test_object: ParserRhythm {
            start: 0.0,
            end: 0.0,
            notes: vec![],
        },
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

    let should_reset_beat_arc = Arc::new(AtomicBool::new(false));
    let should_reset_beat = should_reset_beat_arc.clone();
    let should_reset_beat_state = BeatResetState(should_reset_beat_arc.clone());

    let mut beat: f64 = 0.0;
    let mut last_beat: isize = 0;

    // let mut mp3_sample = 0f32;

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
