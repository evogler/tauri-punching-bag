use crate::analysis::DEFAULT_WINDOW;
use crate::structs::{Config, DrumVoice, Note, ParserRhythm};
use coreaudio::audio_unit::SampleFormat;
/// Fallback only. The real rate is whatever the input device is running at --
/// see `sample_rate()`.
pub const DEFAULT_SAMPLE_RATE: f64 = 44100.0;

/// The rate everything downstream is expressed in, learned from the input
/// device at startup by `get_input_output_channels` and never changed after.
///
/// It cannot be a `const`: a MacBook's built-in microphone runs at 48 kHz, and
/// asking AUHAL to hand us 44.1 kHz from it produces *silence* rather than a
/// converted stream or an error -- an input of all zeroes with nothing in any
/// log, which is indistinguishable from a missing microphone grant. Adopting
/// the device's own rate is the only reliable option.
///
/// A `OnceLock` rather than a parameter threaded through every caller because
/// this is genuinely a property of the process, fixed before the first audio
/// callback runs, and read from both the audio thread and the command handlers.
static SAMPLE_RATE_HZ: std::sync::OnceLock<f64> = std::sync::OnceLock::new();

pub fn sample_rate() -> f64 {
    *SAMPLE_RATE_HZ.get_or_init(|| DEFAULT_SAMPLE_RATE)
}

/// Called once, from audio setup, before anything reads `sample_rate()`. A
/// second call is ignored rather than fatal -- the rate is already baked into
/// buffer sizes by then, so changing it underneath them would be worse.
pub fn set_sample_rate(hz: f64) {
    if !(hz > 0.0) {
        return;
    }
    if SAMPLE_RATE_HZ.set(hz).is_err() {
        println!("sample rate already fixed at {}, ignoring {}", sample_rate(), hz);
    }
}
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

/// Frames of *display* backlog the callback will hold before it stops pushing.
/// Only reachable if the frontend stops draining -- a wedged UI shouldn't be
/// able to grow the buffer without bound, and with it the capacity the next
/// drain reserves. One second, drained in a single poll once the UI recovers.
pub fn max_visual_backlog() -> usize {
    sample_rate() as usize
}

/// What a drain leaves behind for the callback to fill. The callback holds the
/// buffer's lock for its whole run, so a drain always gets at least one
/// callback's worth (2048 frames); twice that is the headroom that keeps the
/// audio thread from ever having to grow the vector itself.
pub const VISUAL_RESERVE_FRAMES: usize = 4096;

/// The same for the analysis stream, in hops. A hop is 64 frames at the
/// shortest window, so one callback is at most 32 of them; this is generous
/// without reserving a frame-sized vector for a hop-sized stream.
pub const ANALYSIS_RESERVE_HOPS: usize = 256;

/// Onsets are sparse -- a handful a batch at most -- so this is a flat reserve
/// rather than anything derived.
pub const ONSET_RESERVE: usize = 64;

// Every echo needs a whole loop of history behind it, so the buffer grows with
// this. 16 echoes of 4 beats at 91bpm is ~30MB across four channels, which is
// about as far as it's worth going.
pub const MAX_LOOP_ECHOES: usize = 16;

pub fn default_config() -> Config {
    return Config {
        bpm: 91.0,
        beats_to_loop: 4.0,
        loop_echoes: 1.0,
        loop_echo_gain: 1.0,
        audio_in_gain: 1.0,
        looping_on: false,
        click_on: true,
        click_toggle: false,
        click_volume: 0.3,
        drum_on: true,
        play_file: true,
        file_volume: 1.0,
        file_beats: 0.0,
        file_offset_ms: 0.0,
        file_shift: 0.0,
        visual_monitor_on: true,
        audio_monitor_on: false,
        buffer_compensation: 4330,
        paused: false,
        analysis_on: true,
        analysis_band_low: 30.0,
        analysis_band_high: 16000.0,
        analysis_window: DEFAULT_WINDOW,
        onset_threshold: 0.05,
        onset_min_gap: 40.0,
        onset_offset: 0.0,
        visible_channels: vec![0],
        channel_pans: vec![],
        audio_subdivisions: ParserRhythm {
            start: 0.0,
            end: 1.0,
            notes: vec![Note { time: 0.0 }, Note { time: 0.5 }],
        },
        drums: vec![DrumVoice {
            path: "ride".to_string(),
            on: true,
            volume: 1.0,
            offset: 0.0,
            shift: 0.0,
            gains: vec![1.0],
            rhythm: ParserRhythm {
                start: 0.0,
                end: 1.0,
                notes: vec![Note { time: 0.0 }, Note { time: 0.5 }],
            },
        }],
        test_object: ParserRhythm {
            start: 0.0,
            end: 0.0,
            notes: vec![],
        },
    };
}
