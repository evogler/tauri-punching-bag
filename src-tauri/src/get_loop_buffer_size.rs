use crate::constants::{MAX_LOOP_ECHOES, SAMPLE_RATE};
use crate::structs::Config;

// Ten minutes a pass, far past anything musical, so a nonsense bpm or
// beats_to_loop is clamped instead of asking for an impossible allocation.
const MAX_LOOP_FRAMES: f64 = SAMPLE_RATE * 600.0;

// Frames between one echo and the next -- a single `beats_to_loop` pass.
pub fn get_loop_spacing(config: &Config) -> usize {
    // Frames, not interleaved slots: each channel gets its own buffer, so the
    // position advances once per frame. buffer_compensation is already in
    // frames, which is why it no longer needs doubling at the read.
    let mut res = config.beats_to_loop / config.bpm * SAMPLE_RATE * 60.0;
    if !(res > 0.0) {
        // Catches NaN as well as negatives. A bpm of 0 sends this to infinity,
        // and `as usize` saturates to usize::MAX -- an allocation panic rather
        // than a glitch. The frontend rejects a bpm of 0 twice over, but this
        // is the last thing standing between a hand-edited config and a crash.
        res = 0.0;
    }
    res.min(MAX_LOOP_FRAMES) as usize
}

pub fn loop_echo_count(config: &Config) -> usize {
    (config.loop_echoes.max(1.0) as usize).min(MAX_LOOP_ECHOES)
}

pub fn get_loop_buffer_size(config: &Config) -> usize {
    // One spacing per echo: the oldest tap reads a whole run back, so the
    // history has to be that long.
    get_loop_spacing(config) * loop_echo_count(config)
}
