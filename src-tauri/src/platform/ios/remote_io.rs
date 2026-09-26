//! The RemoteIO unit and its render callback.
//!
//! One unit, one callback: RemoteIO asks for output on bus 0, and inside that
//! same callback the input is pulled from bus 1 with `AudioUnitRender` into a
//! buffer allocated up front. So input and output share one clock by
//! construction and there is no queue at all -- the macOS backend's per-channel
//! queues and their backlog cap exist only because AUHAL gives each direction
//! its own callback.
//!
//! Written on `coreaudio-sys` directly rather than `coreaudio-rs`'s `AudioUnit`,
//! whose iOS input path is a *separate* input callback sized through the
//! deprecated C `AudioSession` API, and which reallocates its buffer on the
//! audio thread whenever the slice size changes. It also keeps the unit handle
//! private, and `AudioUnitRender` needs it.
//!
//! **The callback allocates nothing, frees nothing and takes no lock of its
//! own** -- the engine's rules are the only ones it adds to. Everything it
//! touches is in `RenderState`, built before the unit starts and freed only
//! after it has stopped.

use crate::engine::{Engine, MAX_BLOCK_FRAMES};
use coreaudio::sys;
use std::os::raw::c_void;
use std::ptr::null_mut;

const BUS_OUTPUT: u32 = 0;
const BUS_INPUT: u32 = 1;
const SAMPLE_BYTES: u32 = 4;

struct RenderState {
    unit: sys::AudioUnit,
    engine: Engine,
    /// `MAX_BLOCK_FRAMES` frames, `input_channels` wide, interleaved: exactly
    /// the slice `Engine::process` takes.
    input: Vec<f32>,
    input_channels: usize,
    /// False when the route has no input at all; the engine is then fed
    /// silence rather than a failed pull.
    input_enabled: bool,
}

/// The running unit. Dropping it stops the unit -- `AudioOutputUnitStop` waits
/// out a render in progress -- and only then frees the callback's state, engine
/// and all, on the dropping thread.
pub struct Running {
    unit: sys::AudioUnit,
    state: *mut RenderState,
}

// The raw pointers are owned: the unit handle and the boxed state move with
// this value and are only touched by the audio thread while the unit runs,
// which `Drop` stops before freeing either.
unsafe impl Send for Running {}

impl Running {
    /// Stop rendering, keeping the engine. For an interruption: the system has
    /// stopped the unit already, and this keeps our side in step.
    pub fn suspend(&mut self) {
        unsafe {
            sys::AudioOutputUnitStop(self.unit);
        }
    }

    /// Start again with the same engine, once the session is active again.
    pub fn resume(&mut self) -> Result<(), String> {
        check(unsafe { sys::AudioOutputUnitStart(self.unit) }, "start the audio unit")
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        unsafe {
            sys::AudioOutputUnitStop(self.unit);
            sys::AudioUnitUninitialize(self.unit);
            sys::AudioComponentInstanceDispose(self.unit);
            drop(Box::from_raw(self.state));
        }
    }
}

fn check(status: sys::OSStatus, what: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("could not {} (OSStatus {})", what, status))
    }
}

fn float_format(rate: f64, channels: u32, interleaved: bool) -> sys::AudioStreamBasicDescription {
    let mut flags = sys::kAudioFormatFlagIsFloat | sys::kAudioFormatFlagIsPacked;
    // Non-interleaved means one buffer per channel, each of one-channel frames.
    let (frame_channels, bytes_per_frame) = if interleaved {
        (channels, SAMPLE_BYTES * channels)
    } else {
        flags |= sys::kAudioFormatFlagIsNonInterleaved;
        (channels, SAMPLE_BYTES)
    };
    sys::AudioStreamBasicDescription {
        mSampleRate: rate,
        mFormatID: sys::kAudioFormatLinearPCM,
        mFormatFlags: flags,
        mBytesPerPacket: bytes_per_frame,
        mFramesPerPacket: 1,
        mBytesPerFrame: bytes_per_frame,
        mChannelsPerFrame: frame_channels,
        mBitsPerChannel: SAMPLE_BYTES * 8,
        mReserved: 0,
    }
}

unsafe fn set<T>(unit: sys::AudioUnit, id: u32, scope: u32, element: u32, value: &T, what: &str) -> Result<(), String> {
    check(
        sys::AudioUnitSetProperty(
            unit,
            id,
            scope,
            element,
            value as *const T as *const c_void,
            std::mem::size_of::<T>() as u32,
        ),
        what,
    )
}

/// Open, configure and start a RemoteIO unit at `rate`, with `engine` as its
/// render callback. **Only once the session is active**: RemoteIO follows the
/// session, and there is only one of it -- which is also why a restart stops
/// the old unit before opening this one, and a failure here means silence
/// until the next route change or the app coming back to the front.
pub fn start(engine: Engine, input_enabled: bool) -> Result<Running, String> {
    let input_channels = engine.input_channels();
    let rate = engine.sample_rate();
    unsafe {
        let description = sys::AudioComponentDescription {
            componentType: sys::kAudioUnitType_Output,
            componentSubType: sys::kAudioUnitSubType_RemoteIO,
            componentManufacturer: sys::kAudioUnitManufacturer_Apple,
            componentFlags: 0,
            componentFlagsMask: 0,
        };
        let component = sys::AudioComponentFindNext(null_mut(), &description);
        if component.is_null() {
            return Err("no RemoteIO audio unit on this system".into());
        }
        let mut unit: sys::AudioUnit = null_mut();
        check(sys::AudioComponentInstanceNew(component, &mut unit), "create the RemoteIO unit")?;

        // From here on the unit exists and must be disposed of on any failure.
        let configured = (|| -> Result<*mut RenderState, String> {
            let on: u32 = 1;
            let off: u32 = 0;
            set(
                unit,
                sys::kAudioOutputUnitProperty_EnableIO,
                sys::kAudioUnitScope_Input,
                BUS_INPUT,
                if input_enabled { &on } else { &off },
                "enable the microphone",
            )?;
            // What the callback hands over: stereo, one buffer per side.
            set(
                unit,
                sys::kAudioUnitProperty_StreamFormat,
                sys::kAudioUnitScope_Input,
                BUS_OUTPUT,
                &float_format(rate, 2, false),
                "set the output format",
            )?;
            if input_enabled {
                // What the pull hands back: every input channel, interleaved,
                // into our own buffer -- so the unit need not allocate one.
                set(
                    unit,
                    sys::kAudioUnitProperty_StreamFormat,
                    sys::kAudioUnitScope_Output,
                    BUS_INPUT,
                    &float_format(rate, input_channels as u32, true),
                    "set the input format",
                )?;
                set(
                    unit,
                    sys::kAudioUnitProperty_ShouldAllocateBuffer,
                    sys::kAudioUnitScope_Output,
                    BUS_INPUT,
                    &off,
                    "hand the unit our input buffer",
                )?;
            }
            // The contract the input buffer is sized to. A request for more is
            // answered with silence rather than overrunning it -- see `render`.
            let max_frames = MAX_BLOCK_FRAMES as u32;
            set(
                unit,
                sys::kAudioUnitProperty_MaximumFramesPerSlice,
                sys::kAudioUnitScope_Global,
                BUS_OUTPUT,
                &max_frames,
                "set the largest block",
            )?;

            let state = Box::into_raw(Box::new(RenderState {
                unit,
                engine,
                input: vec![0f32; MAX_BLOCK_FRAMES * input_channels],
                input_channels,
                input_enabled,
            }));
            let callback = sys::AURenderCallbackStruct {
                inputProc: Some(render),
                inputProcRefCon: state as *mut c_void,
            };
            if let Err(e) = set(
                unit,
                sys::kAudioUnitProperty_SetRenderCallback,
                sys::kAudioUnitScope_Input,
                BUS_OUTPUT,
                &callback,
                "install the render callback",
            ) {
                drop(Box::from_raw(state));
                return Err(e);
            }
            Ok(state)
        })();
        let state = match configured {
            Ok(state) => state,
            Err(e) => {
                sys::AudioComponentInstanceDispose(unit);
                return Err(e);
            }
        };
        let running = Running { unit, state };
        // Dropping `running` on either failure uninitialises and disposes.
        check(sys::AudioUnitInitialize(unit), "initialise the RemoteIO unit")?;
        check(sys::AudioOutputUnitStart(unit), "start the RemoteIO unit")?;
        Ok(running)
    }
}

/// The render callback. Pulls the input for this block, then runs the engine
/// straight into the unit's two output buffers.
unsafe extern "C" fn render(
    ref_con: *mut c_void,
    flags: *mut sys::AudioUnitRenderActionFlags,
    time_stamp: *const sys::AudioTimeStamp,
    _bus: u32,
    frames: u32,
    data: *mut sys::AudioBufferList,
) -> sys::OSStatus {
    let state = &mut *(ref_con as *mut RenderState);
    let n = frames as usize;
    let buffers = std::slice::from_raw_parts_mut(
        (*data).mBuffers.as_mut_ptr(),
        (*data).mNumberBuffers as usize,
    );
    // Two non-interleaved sides, as the output format says. Anything else, or
    // a block past what the input buffer holds, is a unit breaking its
    // contract: answer with silence rather than read or write out of bounds.
    let well_formed = buffers.len() == 2
        && n <= MAX_BLOCK_FRAMES
        && buffers
            .iter()
            .all(|b| !b.mData.is_null() && b.mDataByteSize as usize >= n * SAMPLE_BYTES as usize);
    if !well_formed {
        for b in buffers.iter_mut() {
            if !b.mData.is_null() {
                std::ptr::write_bytes(b.mData as *mut u8, 0, b.mDataByteSize as usize);
            }
        }
        return 0;
    }

    let c_in = state.input_channels;
    let input = &mut state.input[..n * c_in];
    let pulled = state.input_enabled && {
        // A stack-built list pointing at our own buffer: no allocation, and
        // the unit writes the interleaved frames straight where the engine
        // reads them.
        let mut list = sys::AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [sys::AudioBuffer {
                mNumberChannels: c_in as u32,
                mDataByteSize: (n * c_in) as u32 * SAMPLE_BYTES,
                mData: input.as_mut_ptr() as *mut c_void,
            }],
        };
        sys::AudioUnitRender(state.unit, flags, time_stamp, BUS_INPUT, frames, &mut list) == 0
    };
    if !pulled {
        // No microphone, no permission, or a pull that failed mid-route-change:
        // the engine carries on against silence, which is what a muted input
        // looks like everywhere else in the app.
        input.fill(0.0);
    }

    let left = std::slice::from_raw_parts_mut(buffers[0].mData as *mut f32, n);
    let right = std::slice::from_raw_parts_mut(buffers[1].mData as *mut f32, n);
    state.engine.process(&state.input[..n * c_in], [left, right]);
    0
}
