use crate::structs::{Config, DrumVoice, Note, ParserRhythm};
use coreaudio::audio_unit::SampleFormat;
pub const SAMPLE_RATE: f64 = 44100.0;
pub const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

// make_buffers hands the same unbounded VecDeque to the input callback's
// push_back and the render callback's pop_front, so anything that stalls the
// render side -- the bound device going away, or slow clock drift when input
// and output are separate devices -- would grow it forever. Cap the backlog and
// drop the oldest excess. A quarter second is well above the few thousand
// samples it normally holds, so this never fires in normal running.
pub const MAX_INPUT_BACKLOG: usize = 11_025;

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
        visual_monitor_on: true,
        audio_monitor_on: false,
        buffer_compensation: 4330,
        paused: false,
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
