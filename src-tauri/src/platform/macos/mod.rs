//! The macOS backend: two AUHAL units, one per direction.
//!
//! Input and output are *separate* units here, each with its own callback, so
//! the input callback splits what it is given into one queue per channel and
//! the render callback takes a block back off those queues and hands it to the
//! engine. The queues are the whole of what is macOS-specific about the
//! stream; the engine never learns they exist.
//!
//! Device discovery, stream formats and the sample rate are in `devices.rs`.

mod devices;

pub use devices::{
    get_input_output_channels, list_devices, watch_device_changes, ActiveDevices,
    AudioDeviceInfo,
};

use crate::constants::sample_rate;
use crate::engine::Engine;
use crate::types::S;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, SampleFormat};
use coreaudio::Error;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub type Args = render_callback::Args<data::NonInterleaved<S>>;

// Input is interleaved while output stays non-interleaved. coreaudio-rs rejects
// non-interleaved input above one channel (NonInterleavedInputOnlySupportsMono)
// but places no such limit on the interleaved path, so this is what makes more
// than one input channel possible at all.
pub type InputArgs = render_callback::Args<data::Interleaved<S>>;

pub const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

// make_buffers hands the same unbounded VecDeque to the input callback's
// push_back and the render callback's pop_front, so anything that stalls the
// render side -- the bound device going away, or slow clock drift when input
// and output are separate devices -- would grow it forever. Cap the backlog and
// drop the oldest excess. A quarter second is well above the few thousand
// samples it normally holds, so this never fires in normal running.
pub fn max_input_backlog() -> usize {
    (sample_rate() * 0.25) as usize
}

/// The running units. Dropping this stops the audio, so `main` holds it for
/// the life of the process.
pub struct Running {
    _input: AudioUnit,
    _output: AudioUnit,
}

/// Start both units, with `engine` as the render callback. The engine must
/// have been built for `setup`'s channel count and rate.
pub fn start(
    mut input_audio_unit: AudioUnit,
    mut output_audio_unit: AudioUnit,
    mut engine: Engine,
) -> Result<Running, Error> {
    let input_channels = engine.input_channels();
    let buffers = make_buffers(input_channels);
    let consumers = buffers.consumers.clone();
    // Assembled here, per block, from the per-channel queues: the core takes
    // one interleaved block rather than knowing there are queues at all.
    let mut input_block = vec![0f32; 4096 * input_channels];

    start_input_audio_unit(&mut input_audio_unit, buffers.producers)?;

    output_audio_unit.set_render_callback(move |args: Args| {
        let Args {
            num_frames,
            mut data,
            ..
        } = args;
        let mut buffers: Vec<_> = consumers.iter().map(|c| c.lock().unwrap()).collect();

        // Keeps the shared input queue from growing without bound if this
        // callback ever falls behind the input one. Also trims the startup gap,
        // since the input unit is started before this one.
        for buffer in buffers.iter_mut() {
            let excess = buffer.len().saturating_sub(max_input_backlog());
            buffer.drain(..excess);
        }

        // Every channel drained, whatever the core goes on to do with the
        // block: `make_buffers` hands out the same queue to both ends, so an
        // undrained one grows without bound and replays the backlog afterwards.
        let c_in = buffers.len();
        for i in 0..num_frames {
            for (ch, buffer) in buffers.iter_mut().enumerate() {
                input_block[i * c_in + ch] = buffer.pop_front().unwrap_or(0.0);
            }
        }
        drop(buffers);

        let mut channels = data.channels_mut();
        if let (Some(left), Some(right)) = (channels.next(), channels.next()) {
            engine.process(&input_block[..num_frames * c_in], [left, right]);
        }
        Ok(())
    })?;
    output_audio_unit.start()?;
    Ok(Running {
        _input: input_audio_unit,
        _output: output_audio_unit,
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

// One queue per input channel. Producers and consumers are clones of the same
// Arcs -- see `max_input_backlog` for why that matters.
pub struct Buffers {
    pub producers: Vec<Arc<Mutex<VecDeque<f32>>>>,
    pub consumers: Vec<Arc<Mutex<VecDeque<f32>>>>,
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
