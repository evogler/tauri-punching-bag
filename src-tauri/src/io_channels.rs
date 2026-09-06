extern crate coreaudio;

use crate::constants::{sample_rate, set_sample_rate, DEFAULT_SAMPLE_RATE, SAMPLE_FORMAT};
use crate::prefs::AudioPrefs;
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
use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::CStr;
use std::os::raw::c_char;
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

/// A device's persistent identifier. `AudioDeviceID` is a runtime handle --
/// reassigned across reboots and on replug -- and names are not unique (two of
/// the same interface are indistinguishable), so the UID is the only thing safe
/// to write to disk. `coreaudio-rs` doesn't expose it; this is the same
/// property read as `get_device_name`, which returns a CFString rather than a
/// number.
pub fn get_device_uid(device_id: AudioDeviceID) -> Option<String> {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let uid_ref: CFStringRef = null();
    let data_size = std::mem::size_of::<CFStringRef>();
    unsafe {
        let status = AudioObjectGetPropertyData(
            device_id,
            &property_address as *const _,
            0,
            null(),
            &data_size as *const _ as *mut _,
            &uid_ref as *const _ as *mut _,
        );
        if status != kAudioHardwareNoError as i32 || uid_ref.is_null() {
            return None;
        }
        // CFStringGetCStringPtr can return null for strings that aren't already
        // in the requested encoding, so copy rather than trusting the pointer.
        let mut buf = [0 as c_char; 256];
        let ok = CFStringGetCString(
            uid_ref,
            buf.as_mut_ptr(),
            buf.len() as _,
            kCFStringEncodingUTF8,
        );
        if ok == 0 {
            return None;
        }
        Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
    }
}

/// What the device picker shows. `input_channels` is 0 for output-only devices,
/// which is how the frontend filters the input list.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub uid: String,
    pub name: String,
    pub input_channels: usize,
    pub sample_rate: f64,
    pub is_default_input: bool,
    pub is_default_output: bool,
}

pub fn list_devices() -> Vec<AudioDeviceInfo> {
    let default_in = get_default_device_id(true);
    let default_out = get_default_device_id(false);
    get_audio_device_ids()
        .unwrap_or_default()
        .into_iter()
        // A device with no UID cannot be persisted, so it cannot be offered.
        .filter_map(|id| {
            get_device_uid(id).map(|uid| AudioDeviceInfo {
                uid,
                name: get_device_name(id).unwrap_or_else(|_| "unknown".to_string()),
                input_channels: get_device_input_channels(id),
                sample_rate: get_device_sample_rate(id).unwrap_or(0.0),
                is_default_input: Some(id) == default_in,
                is_default_output: Some(id) == default_out,
            })
        })
        .collect()
}

/// Which devices the process actually opened, which is not always which ones
/// were asked for -- an interface can be unplugged between runs. The frontend
/// shows this rather than the preference so a silent fallback to the built-in
/// mic is visible instead of mysterious.
#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDevices {
    pub input_uid: String,
    pub input_name: String,
    pub output_uid: String,
    pub output_name: String,
    /// A saved device was named and could not be found.
    pub input_fell_back: bool,
    pub output_fell_back: bool,
}

/// Resolve a saved UID back to a live device. Returns None when nothing
/// matches, which the caller turns into "use the system default".
fn device_for_uid(uid: &str) -> Option<AudioDeviceID> {
    if uid.is_empty() {
        return None;
    }
    get_audio_device_ids()
        .unwrap_or_default()
        .into_iter()
        .find(|id| get_device_uid(*id).as_deref() == Some(uid))
}

/// Emitted when the set of devices changes. The picker re-enumerates on this
/// rather than on a timer, so plugging an interface in while the app is running
/// shows up in the dropdown without the user having to know to look again.
pub const DEVICES_CHANGED_EVENT: &str = "devices-changed";

/// Core Audio's own notification that a device appeared or went away. Runs on a
/// Core Audio thread -- *not* the render thread, and it only emits a Tauri
/// event, so there is nothing here that could stall audio.
extern "C" fn devices_changed_listener(
    _object: AudioObjectID,
    _count: u32,
    _addresses: *const AudioObjectPropertyAddress,
    context: *mut std::ffi::c_void,
) -> OSStatus {
    unsafe {
        if let Some(app) = (context as *const tauri::AppHandle).as_ref() {
            use tauri::Manager;
            let _ = app.emit_all(DEVICES_CHANGED_EVENT, ());
        }
    }
    kAudioHardwareNoError as OSStatus
}

/// Registers the listener for the lifetime of the process. The `AppHandle` is
/// deliberately leaked: Core Audio holds the pointer until the listener is
/// removed, and it never is -- there is no unregister path because the only
/// time this stops mattering is at exit.
pub fn watch_device_changes(app: tauri::AppHandle) {
    let property_address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMaster,
    };
    let context = Box::into_raw(Box::new(app)) as *mut std::ffi::c_void;
    let status = unsafe {
        AudioObjectAddPropertyListener(
            kAudioObjectSystemObject,
            &property_address as *const _,
            Some(devices_changed_listener),
            context,
        )
    };
    if status != kAudioHardwareNoError as i32 {
        // Not fatal: the picker still refreshes when it is opened and when the
        // window regains focus, which covers the common "plug in, click back
        // into the app" path on its own.
        println!("could not watch for device changes ({})", status);
    }
}

/// Everything audio setup produces. A struct rather than a tuple because it
/// grew a fifth member and the call site was getting hard to read.
pub struct AudioSetup {
    pub input_unit: AudioUnit,
    pub output_unit: AudioUnit,
    pub input_channels: usize,
    pub log: Vec<String>,
    pub active: ActiveDevices,
}

pub fn get_input_output_channels(prefs: &AudioPrefs) -> Result<AudioSetup, Error> {
    let devices = get_audio_device_ids();
    devices.unwrap().iter().for_each(|d| {
        println!("device: {:?}", get_device_name(*d));
        println!("{:?}", get_supported_physical_stream_formats(*d));
    });

    // A saved device that is no longer present falls back to the system default
    // rather than refusing to start -- but it says so, and `ActiveDevices`
    // carries the fact to the panel. Recording from the built-in mic while the
    // user believes their interface is selected is exactly the kind of silent
    // wrong answer that wastes an afternoon.
    let default_input_id = get_default_device_id(true).unwrap();
    let default_output_id = get_default_device_id(false).unwrap();
    let requested_input = device_for_uid(&prefs.input_uid);
    let requested_output = device_for_uid(&prefs.output_uid);
    let input_fell_back = !prefs.input_uid.is_empty() && requested_input.is_none();
    let output_fell_back = !prefs.output_uid.is_empty() && requested_output.is_none();
    if input_fell_back {
        println!("saved input device {} not found, using default", prefs.input_uid);
    }
    if output_fell_back {
        println!("saved output device {} not found, using default", prefs.output_uid);
    }
    let input_device_id = requested_input.unwrap_or(default_input_id);
    let output_device_id = requested_output.unwrap_or(default_output_id);
    let active = ActiveDevices {
        input_uid: get_device_uid(input_device_id).unwrap_or_default(),
        input_name: get_device_name(input_device_id).unwrap_or_else(|_| "unknown".to_string()),
        output_uid: get_device_uid(output_device_id).unwrap_or_default(),
        output_name: get_device_name(output_device_id).unwrap_or_else(|_| "unknown".to_string()),
        input_fell_back,
        output_fell_back,
    };
    println!("using input {:?}, output {:?}", active.input_name, active.output_name);
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

    Ok(AudioSetup {
        input_unit: input_audio_unit,
        output_unit: output_audio_unit,
        input_channels,
        log: result_log,
        active,
    })
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
