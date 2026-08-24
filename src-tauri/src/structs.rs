use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    collections::VecDeque,
    sync::atomic::AtomicBool,
    sync::{Arc, Mutex},
};
pub struct BeatResetState(pub Arc<AtomicBool>);

pub struct Mp3Buffer {
    pub buffer: Vec<f32>,
    pub pos: usize,
}

pub struct Mp3BufferState(pub Arc<Mutex<Mp3Buffer>>);

// The visual stream, flattened rather than a Vec of per-frame Vecs so the audio
// callback never allocates per frame.
//
// The beat is f64, not f32: it counts up from launch and never wraps, so at f32
// precision the gap between representable values outgrows a screen pixel after a
// while and the display stops being redrawn densely enough to paint over the
// previous pass.
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct VisualSamples {
    /// How many values in `values` belong to each entry in `beats`.
    pub channels: usize,
    pub beats: Vec<f64>,
    pub values: Vec<f32>,
}

pub struct SampleOutputBuffer {
    pub buffer: Arc<Mutex<VisualSamples>>,
}

/// How many input channels the capture device actually gave us.
pub struct InputChannelCount(pub usize);

pub struct LoopBuffer {
    pub buffer: Vec<f32>,
    pub pos: usize,
}

pub struct LoopBufferState(pub Arc<Mutex<LoopBuffer>>);

pub struct LogState(pub Arc<Mutex<Vec<String>>>);

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Note {
    pub time: f64,
    // sounds: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ParserRhythm {
    pub notes: Vec<Note>,
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Config {
    pub bpm: f64,
    pub beats_to_loop: f64,
    pub audio_in_gain: f32,
    pub looping_on: bool,
    pub click_on: bool,
    pub click_toggle: bool,
    pub click_volume: f64,
    pub drum_on: bool,
    pub play_file: bool,
    pub visual_monitor_on: bool,
    pub audio_monitor_on: bool,
    pub buffer_compensation: usize,
    pub paused: bool,
    /// Which input channels get sent to the display. Only these are pushed, so
    /// a 16-input interface doesn't cost 16 channels of JSON to watch two.
    pub visible_channels: Vec<usize>,
    pub audio_subdivisions: ParserRhythm,
    pub drums: Vec<DrumVoice>,
    pub test_object: ParserRhythm,
}
pub struct ConfigState(pub Arc<Mutex<Config>>);

#[derive(Clone, serde::Serialize)]
pub struct Payload {
    pub message: Vec<String>,
}

pub struct SoundingSample {
    pub sample: Arc<Vec<f32>>,
    pub pos: usize,
    pub volume: f32,
}

/// Decoded drum samples, keyed the same way a voice names them: either a
/// built-in name like "ride" or the absolute path it was loaded from.
pub struct DrumSamples(pub Arc<Mutex<HashMap<String, Arc<Vec<f32>>>>>);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DrumVoice {
    pub path: String,
    pub on: bool,
    pub volume: f64,
    /// Milliseconds to start the sample *early*. A file with leading silence, or
    /// a sound whose attack builds slowly, still lands its transient on the beat
    /// if it starts that far ahead of it. Negative starts it late.
    pub offset: f64,
    pub rhythm: ParserRhythm,
}

// One queue per input channel. Producers and consumers are clones of the same
// Arcs -- see MAX_INPUT_BACKLOG for why that matters.
pub struct Buffers {
    pub producers: Vec<Arc<Mutex<VecDeque<f32>>>>,
    pub consumers: Vec<Arc<Mutex<VecDeque<f32>>>>,
}
