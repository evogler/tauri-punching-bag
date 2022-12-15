use crate::structs::{Config, Note, ParserRhythm};
use coreaudio::audio_unit::SampleFormat;
pub const SAMPLE_RATE: f64 = 44100.0;
pub const SAMPLE_FORMAT: SampleFormat = SampleFormat::F32;

pub fn default_config() -> Config {
    return Config {
        bpm: 91.0,
        beats_to_loop: 4.0,
        looping_on: false,
        click_on: true,
        click_toggle: false,
        click_volume: 0.3,
        drum_on: true,
        play_file: true,
        visual_monitor_on: true,
        audio_monitor_on: false,
        buffer_compensation: 4330,
        audio_subdivisions: ParserRhythm {
            start: 0.0,
            end: 1.0,
            notes: vec![Note { time: 0.0 }, Note { time: 0.5 }],
        },
        test_object: ParserRhythm {
            start: 0.0,
            end: 0.0,
            notes: vec![],
        },
    };
}
