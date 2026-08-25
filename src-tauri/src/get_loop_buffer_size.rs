use crate::constants::SAMPLE_RATE;
use crate::structs::Config;

pub fn get_loop_buffer_size(config: &Config) -> usize {
    // Frames, not interleaved slots: each channel gets its own buffer, so the
    // position advances once per frame. buffer_compensation is already in
    // frames, which is why it no longer needs doubling at the read.
    let mut res = config.beats_to_loop / config.bpm * SAMPLE_RATE * 60.0;
    if res < 0.0 {
        res = 0.0;
    }
    res as usize
}
