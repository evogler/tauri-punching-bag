#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

extern crate coreaudio;
use atomic_float::AtomicF64;
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{audio_unit_from_device_id, get_default_device_id};
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::*;
use rand::Rng;
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::State;

struct Storage {
    store: Arc<Mutex<Vec<(f32, f32)>>>,
}

struct Bpm(Arc<AtomicF64>);

const SAMPLE_RATE: f64 = 44100.0;

type S = f32;
const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

#[tauri::command]
fn get_samples(state: State<Storage>) -> Result<Vec<(f32, f32)>, String> {
    if let Ok(mut samples) = state.store.lock() {
        let res = samples.to_vec();
        samples.clear();
        return Ok(res);
    } else {
        return Err("get_samples failed.".into());
    }
}

#[tauri::command]
fn set_bpm(bpm_state: State<Bpm>, bpm: f64) {
    bpm_state.0.store(bpm, Ordering::Relaxed);
}

fn main() -> Result<(), coreaudio::Error> {
    let mut input_audio_unit =
        audio_unit_from_device_id(get_default_device_id(true).unwrap(), true)?;
    let mut output_audio_unit =
        audio_unit_from_device_id(get_default_device_id(false).unwrap(), false)?;

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

    let buffer_left = Arc::new(Mutex::new(VecDeque::<S>::new()));
    let producer_left = buffer_left.clone();
    let consumer_left = buffer_left.clone();
    let buffer_right = Arc::new(Mutex::new(VecDeque::<S>::new()));
    let producer_right = buffer_right.clone();
    let consumer_right = buffer_right.clone();

    // seed roughly 1 second of data to create a delay in the feedback loop for easier testing
    // for buffer in vec![buffer_left, buffer_right] {
    // let mut buffer = buffer.lock().unwrap();
    // for _ in 0..(out_stream_format.sample_rate as i32) {
    // for _ in 0..32 {
    //    buffer.push_back(0 as S);
    //}
    // }

    type Args = render_callback::Args<data::NonInterleaved<S>>;

    let mut click_sound_counter: i32 = 0;
    let mut rng = rand::thread_rng();

    let state = Storage {
        store: Default::default(),
    };
    let state_arc_clone = state.store.clone();

    let bpm_atomic_arc = Arc::new(AtomicF64::new(180.0));
    let bpm = bpm_atomic_arc.clone();
    let bpm_state: Bpm = Bpm(bpm_atomic_arc.clone());
    let mut beat: f64 = 0.0;
    let mut last_beat: u32 = 0;

    let beats_to_loop = 16f64;
    let loop_buffer_size =
        (beats_to_loop / bpm.load(Ordering::Relaxed) * SAMPLE_RATE * 60.0 * 2.0) as usize;
    println!("loop_buffer_size: {}", loop_buffer_size);
    let mut loop_buffer = vec![0f32; loop_buffer_size];
    let mut loop_buffer_pos = 0;

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

    output_audio_unit.set_render_callback(move |args: Args| {
        let Args {
            num_frames,
            mut data,
            ..
        } = args;
        let buffer_left = consumer_left.lock().unwrap();
        let buffer_right = consumer_right.lock().unwrap();
        let mut buffers = vec![buffer_left, buffer_right];
        let beats_per_sample: f64 = bpm.load(Ordering::Relaxed) / SAMPLE_RATE / 60f64;

        if let Ok(mut state_vec) = state_arc_clone.lock() {
            for i in 0..num_frames {
                // Default other channels to copy value from first channel as a fallback
                let zero: S = 0 as S;
                let f: S = *buffers[0].front().unwrap_or(&zero);
                for (ch, channel) in data.channels_mut().enumerate() {
                    let sample: S = buffers[ch].pop_front().unwrap_or(f);
                    let out = sample + loop_buffer[loop_buffer_pos];
                    channel[i] = out * 12.0;
                    loop_buffer[loop_buffer_pos] = sample;
                    loop_buffer_pos += 1;
                    if loop_buffer_pos >= loop_buffer_size {
                        loop_buffer_pos = 0;
                    }

                    state_vec.push((beat as f32, out.abs()));

                    if (beat as u32) > last_beat {
                        click_sound_counter = 100;
                        last_beat = beat as u32;
                    }
                    if click_sound_counter > 0 {
                        channel[i] += rng.gen::<f32>() * 0.3;
                        click_sound_counter -= 1;
                    }
                }
                beat += beats_per_sample;
            }
        }
        Ok(())
    })?;
    output_audio_unit.start()?;

    tauri::Builder::default()
        .manage(state)
        .manage(bpm_state)
        .invoke_handler(tauri::generate_handler![get_samples, set_bpm])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
