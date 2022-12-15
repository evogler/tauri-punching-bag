use coreaudio::{
    audio_unit::{
        render_callback::{self, data},
        AudioUnit,
    },
    Error,
};

pub type S = f32;

pub type Args = render_callback::Args<data::NonInterleaved<S>>;
