use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    collections::VecDeque,
    sync::atomic::{AtomicBool, AtomicUsize},
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

/// The lengths the last drain took, kept *outside* the mutex so `get_samples`
/// can size the replacement vectors before it takes the lock. The point is that
/// the audio callback never reaches for the allocator: `mem::take` leaves a
/// vector with no capacity behind, and the callback would then grow it from
/// zero every drain -- a cost that scales with how many channels the panes ask
/// for, and that lands on the one thread that cannot afford to wait on a malloc
/// the IPC thread happens to be holding.
pub struct DrainSizes {
    pub beats: AtomicUsize,
    pub values: AtomicUsize,
}

impl Default for DrainSizes {
    fn default() -> Self {
        Self {
            beats: AtomicUsize::new(0),
            values: AtomicUsize::new(0),
        }
    }
}

#[derive(Default)]
pub struct SampleOutputBuffer {
    pub buffer: Arc<Mutex<VisualSamples>>,
    pub drained: Arc<DrainSizes>,
}

// The spectrogram stream. A second stream and a second command rather than
// widening `VisualSamples`, so the per-frame path stays exactly as it was: this
// one carries a hop every 256 frames, not a value every frame.
//
// Magnitudes are u8 decibels over a fixed -100..0 dB range -- 64 float bins at
// 172 hops/sec would roughly double the JSON, and 256 brightness levels is all
// a display can use. The frontend applies its own gain and floor on top, so
// tuning the picture never pushes config back across.
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct AnalysisFrames {
    /// How many input channels were analysed, and so how many `bins`-long runs
    /// belong to each entry in `beats`.
    pub channels: usize,
    pub bins: usize,
    /// One per hop, at the *window centre*, in input time -- already shifted by
    /// the buffer compensation the way the sample stream is.
    pub beats: Vec<f64>,
    /// Flattened for the same reason as `VisualSamples::values`. Read as
    /// `mags[(hop * channels + ch) * bins + bin]`.
    pub mags: Vec<u8>,
    /// Onsets picked from the flux this batch, sparse rather than one per hop.
    /// Each carries its own beat, so it needs no alignment with `beats` -- and
    /// that beat is sub-hop, since a hop is far coarser than a screen pixel at
    /// the zoom levels this tool is used at.
    pub onsets: Vec<Onset>,
    /// Spectral flux, `beats.len() * channels` long: `flux[hop * channels + ch]`.
    /// It rides here rather than in the sample stream because this one already
    /// carries a per-hop stamp at the window centre -- putting a half-window-old
    /// value on a per-frame sample would need every other channel delayed to
    /// match it. f32 rather than u8: it is one number a hop, not 64, and a
    /// threshold will eventually be set against it.
    pub flux: Vec<f32>,
}

/// One detected attack: when, on which *device input* channel, and how far the
/// flux stood above its local median. Reported `peak_radius` hops after the fact
/// -- the picker needs the candidate's neighbours on both sides -- so it reaches
/// the display just behind the sweep cursor.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Onset {
    pub beat: f64,
    pub channel: usize,
    pub strength: f32,
}

#[derive(Default)]
pub struct AnalysisOutputBuffer {
    pub buffer: Arc<Mutex<AnalysisFrames>>,
    /// `beats` and `mags`; `flux` follows the hop count and `onsets` are sparse.
    pub drained: Arc<DrainSizes>,
}

/// How many input channels the capture device actually gave us.
pub struct InputChannelCount(pub usize);

// One recording per input channel, all sharing a position. Per channel rather
// than a mono sum so a looped take plays back on the channel it was played on.
pub struct LoopBuffer {
    pub channels: Vec<Vec<f32>>,
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
    // How many times a phrase comes back, each one `beats_to_loop` after the
    // last. 1 is the single repeat the looper started as.
    pub loop_echoes: f64,
    // Gain per echo, compounding: echo k plays at loop_echo_gain^(k-1). At 1
    // every echo is full volume and the run just stops; below that it fades out
    // across the run. Not feedback in the recursive sense -- the taps are
    // finite, so nothing accumulates and nothing can run away.
    //
    // Named "gain" rather than "feedback" because 0 is not "no effect" -- it
    // silences every echo after the first, which reads as the echo count being
    // ignored. An earlier build called this loop_feedback and defaulted it to 0;
    // the rename is what stops a session saved by that build from restoring the
    // 0 over this default and doing exactly that.
    pub loop_echo_gain: f64,
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
    /// Whether the render callback runs the spectrogram FFTs at all. Off skips
    /// the work and pushes nothing, so a pane that isn't a spectrogram costs
    /// nothing on the audio thread.
    pub analysis_on: bool,
    /// The band, in Hz, the flux is summed over. Restricting it is how a bass
    /// note is kept from registering on a detector watching a snare; the
    /// defaults span everything the bin edges cover, so out of the box it is
    /// the whole picture. Resolved to a range of bin groups once per callback.
    pub analysis_band_low: f64,
    pub analysis_band_high: f64,
    /// How far above the local median of the flux a peak has to stand to count
    /// as an onset. Relative, not absolute, so one number works across
    /// dynamics -- see the flux normalisation in analysis.rs.
    pub onset_threshold: f64,
    /// Milliseconds an onset suppresses further ones on the same channel. A
    /// single attack spreads across a few hops, and the peak test alone would
    /// report the shoulders of a broad one.
    pub onset_min_gap: f64,
    /// Milliseconds to nudge every reported onset, positive later. A trim on
    /// top of the structural correction in `analysis.rs`, which is measured on
    /// an instant attack -- a slow-attack instrument reads differently. The
    /// drum bus is the reference to calibrate against: its trigger times are
    /// known exactly, because the callback generates them.
    pub onset_offset: f64,
    /// FFT window in frames, one of `ANALYSIS_WINDOWS`. Frequency resolution
    /// against time resolution: the hop, and so the spectrogram's column width
    /// and the flux's precision, is always a quarter of it. Anything not in
    /// that list snaps to the nearest that is.
    pub analysis_window: usize,
    /// Which input channels get sent to the display. Only these are pushed, so
    /// a 16-input interface doesn't cost 16 channels of JSON to watch two.
    pub visible_channels: Vec<usize>,
    /// Stereo position per input channel, -1 hard left to 1 hard right. Sparse:
    /// a channel with no entry sits centred.
    pub channel_pans: Vec<f64>,
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
    /// Beats to push this part later in the cycle, so every voice doesn't start
    /// on one. Unlike `offset` this is musical placement, so it's in beats and
    /// doesn't move when the tempo does. Defaulted: voices saved before it
    /// existed deserialize without it.
    #[serde(default)]
    pub shift: f64,
    /// Gain multipliers applied per hit and cycled by hit index, on top of
    /// `volume`. Deliberately not tied to the rhythm's length: a list that
    /// doesn't divide evenly into it drifts, which is the point. Empty means no
    /// modulation. Defaulted for voices saved before it existed.
    #[serde(default)]
    pub gains: Vec<f64>,
    pub rhythm: ParserRhythm,
}

// One queue per input channel. Producers and consumers are clones of the same
// Arcs -- see MAX_INPUT_BACKLOG for why that matters.
pub struct Buffers {
    pub producers: Vec<Arc<Mutex<VecDeque<f32>>>>,
    pub consumers: Vec<Arc<Mutex<VecDeque<f32>>>>,
}

/// A short delay line for the synthetic display buses.
///
/// The sample stream is stamped with a beat shifted back by
/// `buffer_compensation`, so input captured that long ago is drawn where it was
/// actually played. The drums and the click aren't captured -- they're generated
/// in the callback and heard now -- so that same shift would draw them early by
/// the full compensation. Holding them back by it puts each one back on its own
/// beat without moving anything else.
pub struct BusDelay {
    slots: Vec<[f32; 2]>,
    pos: usize,
}

impl BusDelay {
    pub fn new() -> Self {
        BusDelay {
            slots: Vec::new(),
            pos: 0,
        }
    }

    /// Called once per callback, not per frame: this is the only place it
    /// allocates, and only when the compensation actually changed.
    pub fn resize(&mut self, frames: usize) {
        if self.slots.len() == frames {
            return;
        }
        self.slots.clear();
        self.slots.resize(frames, [0.0, 0.0]);
        self.pos = 0;
    }

    /// Takes this frame's buses and returns the pair from `frames` ago. With no
    /// compensation set there's nothing to line up, so it passes straight
    /// through.
    pub fn push(&mut self, frame: [f32; 2]) -> [f32; 2] {
        if self.slots.is_empty() {
            return frame;
        }
        let out = self.slots[self.pos];
        self.slots[self.pos] = frame;
        self.pos = (self.pos + 1) % self.slots.len();
        out
    }
}
