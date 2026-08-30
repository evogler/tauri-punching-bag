use crate::constants::{MAX_LOOP_ECHOES, SAMPLE_RATE};
use crate::structs::Config;

// Frames between one echo and the next -- a single `beats_to_loop` pass.
pub fn get_loop_spacing(config: &Config) -> usize {
    // Frames, not interleaved slots: each channel gets its own buffer, so the
    // position advances once per frame. buffer_compensation is already in
    // frames, which is why it no longer needs doubling at the read.
    let mut res = config.beats_to_loop / config.bpm * SAMPLE_RATE * 60.0;
    if res < 0.0 {
        res = 0.0;
    }
    res as usize
}

pub fn loop_echo_count(config: &Config) -> usize {
    (config.loop_echoes.max(1.0) as usize).min(MAX_LOOP_ECHOES)
}

pub fn get_loop_buffer_size(config: &Config) -> usize {
    // One spacing per echo: the oldest tap reads a whole run back, so the
    // history has to be that long.
    get_loop_spacing(config) * loop_echo_count(config)
}
