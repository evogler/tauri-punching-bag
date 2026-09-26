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
    get_input_output_channels, list_devices, resolve_choice, watch_device_changes, watch_rate,
    ActiveDevices, AudioDeviceInfo, AudioSetup, DeviceChoice, HintSender, RateWatch,
};
use crate::engine::{Engine, MAX_BLOCK_FRAMES};
use crate::types::S;
use coreaudio::audio_unit::render_callback::{self, data};
use coreaudio::audio_unit::{AudioUnit, SampleFormat};
use coreaudio::Error;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub type Args = render_callback::Args<data::NonInterleaved<S>>;

/// What identifies a device while it is plugged in. Opaque to `audio_host.rs`,
/// which only stores and compares it.
pub type DeviceId = coreaudio::sys::AudioDeviceID;

// Input is interleaved while output stays non-interleaved. coreaudio-rs rejects
// non-interleaved input above one channel (NonInterleavedInputOnlySupportsMono)
// but places no such limit on the interleaved path, so this is what makes more
// than one input channel possible at all.
pub type InputArgs = render_callback::Args<data::Interleaved<S>>;

pub const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

// make_queues hands the same VecDeque to the input callback's push_back and
// the render callback's pop_front, so anything that stalls the render side --
// the bound device going away, or slow clock drift when input and output are
// separate devices -- would grow it forever. Cap the backlog and drop the
// oldest excess. A quarter second is well above the few thousand
// samples it normally holds, so this never fires in normal running.
pub fn max_input_backlog(sample_rate: f64) -> usize {
    (sample_rate * 0.25) as usize
}

/// The rate a device is running at now, for the supervisor's "has the input
/// device's rate moved under us" check.
pub fn device_rate(device: DeviceId) -> Option<f64> {
    devices::get_device_sample_rate(device)
}

/// What AUHAL is asked for, in frames per callback. A request, not a promise
/// -- the render callback splits anything past `MAX_BLOCK_FRAMES` rather than
/// trusting it -- but it should fit, or every callback pays for the split.
pub const DEVICE_BUFFER_FRAMES: u32 = 2048;
const _: () = assert!(DEVICE_BUFFER_FRAMES as usize <= MAX_BLOCK_FRAMES);

/// The running units. Dropping this stops the audio -- `AudioUnit`'s drop stops
/// the unit, which waits for a render in progress, and then frees the render
/// callback and with it the engine, on the dropping thread rather than the
/// audio one. `AudioHost` holds it and replaces it on a restart.
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
    let backlog = max_input_backlog(engine.sample_rate());
    let queues = make_queues(input_channels, backlog);
    let consumers = queues.clone();
    // Assembled here, per block, from the per-channel queues: the core takes
    // one interleaved block rather than knowing there are queues at all. Sized
    // for the largest block the engine takes, never for the one AUHAL is
    // asked for -- see `MAX_BLOCK_FRAMES`.
    let mut input_block = vec![0f32; MAX_BLOCK_FRAMES * input_channels];

    start_input_audio_unit(&mut input_audio_unit, queues)?;

    output_audio_unit.set_render_callback(move |args: Args| {
        let Args {
            num_frames,
            mut data,
            ..
        } = args;
        let c_in = input_channels;
        let mut channels = data.channels_mut();
        // The output format is set to two non-interleaved channels in
        // `devices.rs`, so there are always exactly these two.
        let (Some(left), Some(right)) = (channels.next(), channels.next()) else {
            return Ok(());
        };

        // Split rather than trusted: a device that hands over more than the
        // engine is sized for is processed in pieces. The engine is block-size
        // invariant, so this changes nothing about what comes out.
        let mut done = 0;
        while done < num_frames {
            let n = (num_frames - done).min(MAX_BLOCK_FRAMES);
            {
                let mut queues = consumers.lock().unwrap();
                if done == 0 {
                    // Keeps the shared input queue from growing without bound
                    // if this callback ever falls behind the input one. Also
                    // trims the startup gap, since the input unit is started
                    // before this one.
                    for queue in queues.iter_mut() {
                        let excess = queue.len().saturating_sub(backlog);
                        queue.drain(..excess);
                    }
                }
                // Every channel drained, whatever the engine goes on to do
                // with the block -- paused, calibrating, measuring the bleed:
                // `make_queues` hands out the same queue to both ends, so an
                // undrained one grows without bound and replays the backlog
                // afterwards. A short queue reads as silence.
                for i in 0..n {
                    for (ch, queue) in queues.iter_mut().enumerate() {
                        input_block[i * c_in + ch] = queue.pop_front().unwrap_or(0.0);
                    }
                }
            }
            // The lock is released before the engine runs, so the input
            // callback never waits on the render.
            engine.process(
                &input_block[..n * c_in],
                [&mut left[done..done + n], &mut right[done..done + n]],
            );
            done += n;
        }
        Ok(())
    })?;
    output_audio_unit.start()?;
    Ok(Running {
        _input: input_audio_unit,
        _output: output_audio_unit,
    })
}

fn start_input_audio_unit(input_audio_unit: &mut AudioUnit, producers: Queues) -> Result<(), Error> {
    input_audio_unit.set_input_callback(move |args: InputArgs| {
        let InputArgs {
            num_frames, data, ..
        } = args;
        let channels = data.channels;
        let mut queues = producers.lock().unwrap();
        // The buffer arrives interleaved -- frame 0 channel 0, frame 0 channel 1,
        // ... -- so split it back out into one queue per channel.
        for frame in 0..num_frames {
            for ch in 0..channels {
                if let Some(queue) = queues.get_mut(ch) {
                    // Full only if the render side has stopped draining
                    // altogether -- the device went away. Dropping the oldest
                    // is what the backlog cap does anyway, and it keeps the
                    // queue inside the capacity it was built with instead of
                    // reallocating on this thread.
                    if queue.len() == queue.capacity() {
                        queue.pop_front();
                    }
                    queue.push_back(data.buffer[frame * channels + ch]);
                }
            }
        }
        Ok(())
    })?;
    input_audio_unit.start()?;
    Ok(())
}

// One queue per input channel, behind *one* lock: the input callback pushes a
// frame to every channel together and the render callback pops them together,
// so the channels can never be seen out of step with each other. One lock also
// means neither callback builds a `Vec` of guards, which was an allocation on
// both audio threads every callback.
//
// The same `Arc` goes to both ends -- see `max_input_backlog` for why that
// matters.
type Queues = Arc<Mutex<Vec<VecDeque<S>>>>;

fn make_queues(channels: usize, backlog: usize) -> Queues {
    // The backlog cap plus the most either side can add or take between two
    // trims, so a queue in ordinary running never outgrows what it starts with.
    let capacity = backlog + 2 * MAX_BLOCK_FRAMES;
    Arc::new(Mutex::new(
        (0..channels).map(|_| VecDeque::with_capacity(capacity)).collect(),
    ))
}

