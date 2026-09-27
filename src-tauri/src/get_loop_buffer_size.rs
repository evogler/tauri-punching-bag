use crate::constants::MAX_LOOP_ECHOES;
use crate::structs::Config;

// Ten minutes a pass, far past anything musical, so a nonsense bpm or
// beats_to_loop is clamped instead of asking for an impossible allocation.
// A fn rather than a const because the rate is the device's, and the device
// can change while the app runs.
fn max_loop_frames(sample_rate: f64) -> f64 {
    sample_rate * 600.0
}

// Frames between one echo and the next -- a single `beats_to_loop` pass.
pub fn get_loop_spacing(config: &Config, sample_rate: f64) -> usize {
    // Frames, not interleaved slots: each channel gets its own buffer, so the
    // position advances once per frame. buffer_compensation is already in
    // frames, which is why it no longer needs doubling at the read.
    let mut res = config.beats_to_loop / config.bpm * sample_rate * 60.0;
    if !(res > 0.0) {
        // Catches NaN as well as negatives. A bpm of 0 sends this to infinity,
        // and `as usize` saturates to usize::MAX -- an allocation panic rather
        // than a glitch. The frontend rejects a bpm of 0 twice over, but this
        // is the last thing standing between a hand-edited config and a crash.
        res = 0.0;
    }
    res.min(max_loop_frames(sample_rate)) as usize
}

pub fn loop_echo_count(config: &Config) -> usize {
    (config.loop_echoes.max(1.0) as usize).min(MAX_LOOP_ECHOES)
}

pub fn get_loop_buffer_size(config: &Config, sample_rate: f64) -> usize {
    // One spacing per echo: the oldest tap reads a whole run back, so the
    // history has to be that long.
    get_loop_spacing(config, sample_rate) * loop_echo_count(config)
}

/// Whether a new config changes what a recorded frame *means*: its length in
/// frames, how far back the taps read, or where against the bar it was played.
/// Exactly these void the take (`LoopBuffer::remeasure`); anything else -- a
/// reroll that leaves them alone, a section switch, the looper's own on/off --
/// keeps it playing.
pub fn loop_meaning_changed(old: &Config, new: &Config) -> bool {
    new.bpm != old.bpm
        || new.beats_to_loop != old.beats_to_loop
        || new.loop_echoes != old.loop_echoes
        || new.buffer_compensation != old.buffer_compensation
}
