extern crate coreaudio;

use crate::constants::{sample_rate, set_sample_rate, DEFAULT_SAMPLE_RATE, SAMPLE_FORMAT};
use crate::structs::Buffers;
use crate::types::{InputArgs, S};
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{
    audio_unit_from_device_id, get_audio_device_ids, get_default_device_id, get_device_name,
    get_supported_physical_stream_formats,
};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::*;
use coreaudio::Error;
use std::collections::VecDeque;
use std::ptr::null;
use std::sync::{Arc, Mutex};

/// How many input channels a device actually offers. Core Audio reports this as
/// a stream configuration -- a buffer list whose per-buffer channel counts sum to
/// the total -- rather than as a plain number.
pub fn get_device_input_channels(device_id: AudioDeviceID) -> usize {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementWildcard,
    };
    let data_size = 0u32;
    unsafe {
        let status = AudioObjectGetPropertyDataSize(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
        );
        if status != kAudioHardwareNoError as i32 {
            return 0;
        }
        let mut bytes: Vec<u8> = vec![0; data_size as usize];
        let list = bytes.as_mut_ptr() as *mut AudioBufferList;
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            list as *mut _,
        );
        if status != kAudioHardwareNoError as i32 {
            return 0;
        }
        let count = (*list).mNumberBuffers as usize;
        let buffers = std::slice::from_raw_parts((*list).mBuffers.as_ptr(), count);
        buffers.iter().map(|b| b.mNumberChannels as usize).sum()
    }
}

/// The rate a device is actually running at. Core Audio calls this the
/// *nominal* rate; it is the one the hardware is clocked to right now, which is
/// what Audio MIDI Setup shows and what the user can change underneath us.
pub fn get_device_sample_rate(device_id: AudioDeviceID) -> Option<f64> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementWildcard,
    };
    let mut rate: f64 = 0.0;
    let mut data_size = std::mem::size_of::<f64>() as u32;
    unsafe {
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &mut data_size as *mut _,
            &mut rate as *mut _ as *mut _,
        );
        if status != kAudioHardwareNoError as i32 || !(rate > 0.0) {
            return None;
        }
    }
    Some(rate)
}

pub fn get_input_output_channels() -> Result<(AudioUnit, AudioUnit, usize, Vec<String>), Error> {
    let devices = get_audio_device_ids();
    devices.unwrap().iter().for_each(|d| {
        println!("device: {:?}", get_device_name(*d));
        println!("{:?}", get_supported_physical_stream_formats(*d));
    });

    let input_device_id = get_default_device_id(true).unwrap();
    let output_device_id = get_default_device_id(false).unwrap();
    let input_channels = get_device_input_channels(input_device_id).max(1);
    println!("input device offers {} channel(s)", input_channels);

    // Take the input device's rate rather than imposing one. AUHAL will not
    // convert on the way in: point it at a 48 kHz microphone while asking for
    // 44.1 kHz and it returns zeroes, silently. Everything downstream --
    // beats_per_sample, the loop buffer, the analyzer -- is derived from this,
    // so it has to be settled before any of them are built.
    let device_rate = get_device_sample_rate(input_device_id).unwrap_or(DEFAULT_SAMPLE_RATE);
    set_sample_rate(device_rate);
    let out_device_rate = get_device_sample_rate(output_device_id).unwrap_or(device_rate);
    println!(
        "input device rate {} Hz, output device rate {} Hz",
        device_rate, out_device_rate
    );
    if (out_device_rate - device_rate).abs() > f64::EPSILON {
        // One rate has to win: the render callback advances `beat` and pops one
        // input sample per *output* frame, so the two sides are assumed locked.
        // Input wins because it is the side that refuses to convert; AUHAL does
        // resample on the way out, which is the ordinary "play 44.1 on a 48 kHz
        // device" path. Separate devices still drift -- see the aggregate-device
        // note in CLAUDE.md.
        println!(
            "input and output devices disagree on rate; running at {} Hz and letting the output unit convert",
            device_rate
        );
    }

    let mut input_audio_unit = audio_unit_from_device_id(input_device_id, true)?;
    let mut output_audio_unit = audio_unit_from_device_id(output_device_id, false)?;

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

    // Interleaved on the way in: set_input_callback allocates a single buffer, so
    // non-interleaved caps input at one channel. Interleaved packs every channel
    // into that one buffer, which is what lets us capture more than one.
    let make_in_format = |channels: u32| StreamFormat {
        sample_rate: sample_rate(),
        sample_format: SAMPLE_FORMAT,
        flags: format_flag | LinearPcmFlags::IS_PACKED,
        channels,
    };
    let in_stream_format = make_in_format(input_channels as u32);

    let out_stream_format = StreamFormat {
        sample_rate: sample_rate(),
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
    // If the device won't accept every channel it claims, fall back to mono
    // rather than refusing to start.
    let mut input_channels = input_channels;
    if input_audio_unit
        .set_property(id, Scope::Output, Element::Input, Some(&asbd))
        .is_err()
    {
        println!(
            "device rejected {} input channels, falling back to mono",
            input_channels
        );
        input_channels = 1;
        let asbd = make_in_format(1).to_asbd();
        input_audio_unit.set_property(id, Scope::Output, Element::Input, Some(&asbd))?;
    }

    let asbd = out_stream_format.to_asbd();
    output_audio_unit.set_property(id, Scope::Input, Element::Output, Some(&asbd))?;

    // set audiounit buffer size to 32 samples, or however
    let id = kAudioDevicePropertyBufferFrameSize;
    let buffer_size: u32 = 2048;
    input_audio_unit.set_property(id, Scope::Output, Element::Input, Some(&buffer_size))?;
    output_audio_unit.set_property(id, Scope::Input, Element::Output, Some(&buffer_size))?;

    Ok((
        input_audio_unit,
        output_audio_unit,
        input_channels,
        result_log,
    ))
}

pub fn start_input_audio_unit(
    input_audio_unit: &mut AudioUnit,
    producers: Vec<Arc<Mutex<VecDeque<S>>>>,
) -> Result<(), Error> {
    input_audio_unit.set_input_callback(move |args: InputArgs| {
        let InputArgs {
            num_frames, data, ..
        } = args;
        let channels = data.channels;
        let mut queues: Vec<_> = producers.iter().map(|p| p.lock().unwrap()).collect();
        // The buffer arrives interleaved -- frame 0 channel 0, frame 0 channel 1,
        // ... -- so split it back out into one queue per channel.
        for frame in 0..num_frames {
            for ch in 0..channels {
                if let Some(queue) = queues.get_mut(ch) {
                    queue.push_back(data.buffer[frame * channels + ch]);
                }
            }
        }
        Ok(())
    })?;
    input_audio_unit.start()?;
    Ok(())
}

pub fn make_buffers(channels: usize) -> Buffers {
    let queues: Vec<Arc<Mutex<VecDeque<S>>>> = (0..channels)
        .map(|_| Arc::new(Mutex::new(VecDeque::<S>::new())))
        .collect();
    Buffers {
        producers: queues.clone(),
        consumers: queues,
    }
}
