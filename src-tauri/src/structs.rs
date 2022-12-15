use serde::{Deserialize, Serialize};
use std::{
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

pub struct SampleOutputBuffer {
    pub buffer: Arc<Mutex<Vec<(f32, f32)>>>,
}

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
    pub looping_on: bool,
    pub click_on: bool,
    pub click_toggle: bool,
    pub click_volume: f64,
    pub drum_on: bool,
    pub play_file: bool,
    pub visual_monitor_on: bool,
    pub audio_monitor_on: bool,
    pub buffer_compensation: usize,
    pub audio_subdivisions: ParserRhythm,
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
}

pub struct Buffers {
    pub producer_left: Arc<Mutex<VecDeque<f32>>>,
    pub consumer_left: Arc<Mutex<VecDeque<f32>>>,
    pub producer_right: Arc<Mutex<VecDeque<f32>>>,
    pub consumer_right: Arc<Mutex<VecDeque<f32>>>,
}
