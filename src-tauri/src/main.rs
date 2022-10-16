#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

extern crate coreaudio;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{audio_unit_from_device_id, get_default_device_id};
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::*;

use rand::Rng;
use std::sync::atomic::AtomicI64;
use tauri::State;

const SAMPLE_RATE: f64 = 44100.0;

type S = f32;
const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

// #[tauri::command]
// fn increment_counter(state: State<AtomicI64>) -> Result<i64, String> {
//     let mut n = 0;
//     let mut rng = rand::thread_rng();
//     for _i in 0..1_000_000 {
//         let r = rng.gen();
//         if r {
//             n += 1;
//         }
//     }
//     Ok(state.fetch_add(n, Ordering::SeqCst) + n)
// }

#[tauri::command]
// fn get_array(state: State<Vec<f32>>) -> Result<Vec<f32>, String> {
fn get_array(state: State<&Arc<Mutex<Vec<f32>>>>) -> Result<Vec<f32>, String> {
    // xxx clear_samples = true;
    // let mut newvec = samples.clone().to_vec();
    // state;
    if let Ok(mut x) = state.lock() {
        return Ok(x.to_vec());
    } else {
        return Err("get_array failed".to_string());
    }
}

fn main() -> Result<(), coreaudio::Error> {
    // let mut samples = Arc::new(Vec::new());
    let mut clear_samples: Arc<bool> = Arc::new(false);

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

    let mut counter: i32 = 0;
    let mut rng = rand::thread_rng();

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

        // let mut samples: Arc<Vec<f32>> = Arc::clone(&samples);

        for i in 0..num_frames {
            // Default other channels to copy value from first channel as a fallback
            let zero: S = 0 as S;
            let f: S = *buffers[0].front().unwrap_or(&zero);
            for (ch, channel) in data.channels_mut().enumerate() {
                let sample: S = buffers[ch].pop_front().unwrap_or(f);
                channel[i] = sample * 2.0;
                // samples.push(sample);

                if counter < 100 {
                    channel[i] += rng.gen::<f32>() * 0.3;
                }
                counter += 1;
                if counter >= 22050 {
                    counter = 0;
                }
            }
        }
        Ok(())
    })?;
    output_audio_unit.start()?;

    println!("after audio code, going to launch tauri");

    // let state_thing = AtomicI64::from(5);

    let real_vec = vec![[1, 2, 3]];
    // let state = Arc::new(Mutex::new(real_vec));

    tauri::Builder::default()
        // .manage(AtomicI64::from(5))
        // .manage(&state)
        .manage(Arc::new(Mutex::new(real_vec)))
        // .manage(Vec::new<u32>())
        .invoke_handler(tauri::generate_handler![get_array,])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
