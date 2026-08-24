use coreaudio::{
    audio_unit::{
        render_callback::{self, data},
        AudioUnit,
    },
    Error,
};

pub type S = f32;

pub type Args = render_callback::Args<data::NonInterleaved<S>>;

// Input is interleaved while output stays non-interleaved. coreaudio-rs rejects
// non-interleaved input above one channel (NonInterleavedInputOnlySupportsMono)
// but places no such limit on the interleaved path, so this is what makes more
// than one input channel possible at all.
pub type InputArgs = render_callback::Args<data::Interleaved<S>>;
