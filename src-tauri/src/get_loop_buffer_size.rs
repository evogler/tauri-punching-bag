use crate::constants::SAMPLE_RATE;
use crate::structs::Config;

pub fn get_loop_buffer_size(config: &Config) -> usize {
    let mut res = config.beats_to_loop / config.bpm * SAMPLE_RATE * 60.0 * 2.0;
    if res < 0.0 {
        res = 0.0;
    }
    res as usize
}
