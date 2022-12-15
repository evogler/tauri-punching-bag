extern crate coreaudio;

use crate::constants::{SAMPLE_FORMAT, SAMPLE_RATE};
use crate::structs::Buffers;
use crate::types::{Args, S};
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{
    audio_unit_from_device_id, get_audio_device_ids, get_default_device_id, get_device_name,
    get_supported_physical_stream_formats,
};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::*;
use coreaudio::Error;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub fn get_input_output_channels() -> Result<(AudioUnit, AudioUnit, Vec<String>), Error> {
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

pub fn start_input_audio_unit(
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

pub fn make_buffers() -> Buffers {
    let buffer_left = Arc::new(Mutex::new(VecDeque::<S>::new()));
    let buffer_right = Arc::new(Mutex::new(VecDeque::<S>::new()));
    Buffers {
        producer_left: buffer_left.clone(),
        consumer_left: buffer_left.clone(),
        producer_right: buffer_right.clone(),
        consumer_right: buffer_right.clone(),
    }
}
