//! Subtracting the app's own output back out of the picture, sample by sample.
//!
//! The click, the drums and the file all go to the speaker, and on a laptop the
//! speaker is inches from the microphone, so they come back in and draw bars of
//! their own over what you are trying to look at. Between what was emitted and
//! what comes back sits the speaker, the case and the room: an impulse
//! response. Measure it, convolve the emitted signal with it, subtract. Unlike
//! taking the *magnitude* down by a known amount, this removes the bleed and
//! leaves what was played underneath, because it subtracts the actual waveform
//! rather than dimming a span of time.
//!
//! **It is measured once, on purpose, and then frozen.** The obvious design is
//! an adaptive filter running all the time, and it was built and thrown away.
//! What kills it is that playing over the top is not an interruption here, it
//! is the entire activity -- permanent double-talk, in echo-canceller terms.
//! Simulated across four regimes: with the bleed well above the playing it
//! reached 15 dB, with the two comparable 4 dB, and with the playing above the
//! bleed it settled into explaining part of *you* out of the reference and came
//! out 9 dB **worse than doing nothing**. Regularising the step against the
//! unexplained power helped and did not fix it; leakage did not help at all.
//!
//! The fatal part is that the app cannot tell which of those it is in. Energy
//! in against energy out -- the only self-check available without knowing the
//! answer -- reported *plus* 2 dB in the regime where the truth was minus 9.
//! A filter that can quietly make the picture worse and cannot be told it is
//! doing so has no business running unattended.
//!
//! Measuring in silence removes the problem rather than managing it: for two
//! and a half seconds nothing else sounds, so there is no near-end signal to be
//! confused by, the estimate is trustworthy, and the reduction it achieved is
//! measurable and can be shown. It also converges much further, because the
//! probe is continuous full-band noise rather than the 200 frames a beat that a
//! click affords. Afterwards nothing adapts, so nothing can drift.
//!
//! The probe is noise rather than the calibration's sweep because the click it
//! has to cancel is `rng.gen()` -- white, full band -- and a 500-8000 Hz chirp
//! measures nothing outside its own band.

use serde::Serialize;

/// ~11.6 ms at 44.1 kHz: the direct path, the case ringing and the early
/// reflections, which between them are what makes a bar tall. The diffuse tail
/// past that is far below the picture's resolution.
pub const TAPS: usize = 512;

/// How far the window reaches *earlier* than `buffer_compensation` says the
/// echo should be; the rest of it reaches later.
///
/// Deliberately not half. A reflection is always *late* -- there is no such
/// thing as a room returning sound before the direct path -- so the only thing
/// the early side has to cover is the compensation reading long, while the late
/// side has to cover the compensation reading short *and* the whole response.
/// A quarter puts 2.9 ms early and 8.7 ms late. Measured with a 2.2 ms-long
/// response: centred, a compensation 1 ms long lost the tail off the end of the
/// window and cancellation fell from 117 dB to 24.
pub const LEAD: usize = TAPS / 4;

/// Normalised step. Safe below 2, and there is no double-talk to be cautious
/// about while training, so this is chosen for convergence alone.
const MU: f32 = 0.5;

/// Floors the normalisation when the probe is silent. Nothing is learned from
/// silence either way; this only keeps the division finite.
const EPS: f32 = 1e-9;

/// How long the probe runs. Long enough to be hundreds of times the filter
/// length in full-band excitation, short enough to sit through.
pub const TRAIN_SECONDS: f64 = 2.5;

/// Probe amplitude, near the click's own so the speaker is driven about as hard
/// as it will be in use -- a response measured quiet does not describe a
/// speaker being driven loud, which is where its nonlinearity lives.
pub const TRAIN_LEVEL: f32 = 0.25;

/// Gates, in the same spirit as the calibration's: a measurement that cannot
/// explain itself leaves you retrying blindly.
const MIN_INPUT_PEAK_DB: f64 = -50.0;
const MIN_REDUCTION_DB: f32 = 6.0;

pub struct BleedCanceller {
    taps: usize,
    channels: usize,
    /// The reference history, stored twice so the most recent `taps` samples
    /// are always one contiguous slice. The inner loop runs once per frame per
    /// channel and has no business doing modulo arithmetic.
    hist: Vec<f32>,
    pos: usize,
    /// One filter per input channel, laid out `channels * taps`: each
    /// microphone stands somewhere different and hears a different speaker.
    weights: Vec<f32>,
    /// Exact energy of the current window, maintained in O(1) by adding what
    /// arrived and taking off what fell out the back.
    power: f32,
    trained: bool,
}

impl BleedCanceller {
    pub fn new(channels: usize, taps: usize) -> Self {
        BleedCanceller {
            taps,
            channels,
            hist: vec![0.0; taps * 2],
            pos: 0,
            weights: vec![0.0; channels * taps],
            power: 0.0,
            trained: false,
        }
    }

    pub fn trained(&self) -> bool {
        self.trained
    }

    /// Throws the estimate away. Called when a run starts, so a second run
    /// measures the room rather than refining whatever the last one left.
    pub fn clear(&mut self) {
        self.weights.iter_mut().for_each(|w| *w = 0.0);
        self.trained = false;
    }

    pub fn mark_trained(&mut self) {
        self.trained = true;
    }

    /// One frame of what the speaker emitted, already delayed by the round trip.
    pub fn push(&mut self, r: f32) {
        self.pos = if self.pos + 1 == self.taps { 0 } else { self.pos + 1 };
        // Whatever is in the slot about to be overwritten is the sample leaving
        // the window, which is what keeps `power` exact rather than leaky.
        let dropped = self.hist[self.pos];
        self.power = (self.power + r * r - dropped * dropped).max(0.0);
        self.hist[self.pos] = r;
        self.hist[self.pos + self.taps] = r;
    }

    fn window(&self) -> &[f32] {
        &self.hist[self.pos + 1..=self.pos + self.taps]
    }

    /// Runtime: predict this channel's echo and take it off. No adaptation, so
    /// this is immutable and costs one multiply-add per tap.
    ///
    /// `gain` is `audio_in_gain`, which the picture has been scaled by and the
    /// probe was not. Applied here rather than folded into the weights so that
    /// turning the input trim up does not silently invalidate a measurement.
    pub fn cancel(&self, ch: usize, input: f32, gain: f32) -> f32 {
        if ch >= self.channels || !self.trained {
            return input;
        }
        let w = &self.weights[ch * self.taps..(ch + 1) * self.taps];
        let predicted: f32 = w.iter().zip(self.window()).map(|(a, b)| a * b).sum();
        input - predicted * gain
    }

    /// Training: predict, subtract, and take one NLMS step toward explaining
    /// what is left. Returns the residual, which is what the run is scored on.
    pub fn train(&mut self, ch: usize, input: f32) -> f32 {
        if ch >= self.channels {
            return input;
        }
        let Self {
            taps,
            hist,
            pos,
            weights,
            power,
            ..
        } = self;
        let x = &hist[*pos + 1..=*pos + *taps];
        let w = &mut weights[ch * *taps..(ch + 1) * *taps];
        let predicted: f32 = w.iter().zip(x.iter()).map(|(a, b)| a * b).sum();
        let error = input - predicted;
        // NLMS: dividing by the window's own energy is what makes one `MU`
        // correct whatever level the probe comes back at.
        let step = MU * error / (*power + EPS);
        for (wi, xi) in w.iter_mut().zip(x.iter()) {
            *wi += step * xi;
        }
        error
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BleedPhase {
    Idle,
    Running,
    Done,
    Failed,
}

/// Everything the panel shows -- including the measurements behind a failure,
/// so "nothing came back" and "something came back and would not cancel" are
/// told apart rather than guessed at. Same argument as `CalibrationResult`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BleedResult {
    pub phase: BleedPhase,
    pub progress: f64,
    pub db: f32,
    pub input_peak_db: f64,
    pub message: String,
    pub min_db: f32,
    pub min_input_peak_db: f64,
}

impl Default for BleedResult {
    fn default() -> Self {
        BleedResult {
            phase: BleedPhase::Idle,
            progress: 0.0,
            db: 0.0,
            input_peak_db: -120.0,
            message: String::new(),
            min_db: MIN_REDUCTION_DB,
            min_input_peak_db: MIN_INPUT_PEAK_DB,
        }
    }
}

/// The audio thread's side of a run: counters only, locked once per callback.
#[derive(Default)]
pub struct BleedTraining {
    pub active: bool,
    pub left: usize,
    pub total: usize,
    peak: f32,
    before: f64,
    after: f64,
    pub finished: bool,
    /// The command cannot reach the filter -- it lives in the callback -- so
    /// the callback is told to throw the old estimate away here. A second run
    /// has to measure the room, not refine whatever the last one left behind.
    pub just_started: bool,
}

impl BleedTraining {
    pub fn start(&mut self, frames: usize) {
        self.active = true;
        self.just_started = true;
        self.left = frames;
        self.total = frames;
        self.peak = 0.0;
        self.before = 0.0;
        self.after = 0.0;
        self.finished = false;
    }

    pub fn cancel(&mut self) {
        self.active = false;
        self.finished = false;
    }

    pub fn progress(&self) -> f64 {
        if self.total == 0 {
            return 0.0;
        }
        1.0 - self.left as f64 / self.total as f64
    }

    /// Scored over the **second half** of the run only. The first half is the
    /// filter converging, and including it would report the average of a wrong
    /// answer and a right one.
    pub fn observe(&mut self, input: f32, residual: f32) {
        self.peak = self.peak.max(input.abs());
        if self.left * 2 <= self.total {
            self.before += (input as f64) * (input as f64);
            self.after += (residual as f64) * (residual as f64);
        }
    }

    pub fn step(&mut self) {
        self.left = self.left.saturating_sub(1);
        if self.left == 0 {
            self.active = false;
            self.finished = true;
        }
    }

    /// The verdict as a bool, which is all the audio thread is allowed to ask
    /// for: `result` below formats a message, and formatting a message
    /// allocates -- and then dropping the old one frees -- on a thread that
    /// must do neither. Same split as the calibration, which leaves the
    /// correlation to the command.
    pub fn passed(&self) -> bool {
        let peak_db = if self.peak > 0.0 {
            20.0 * (self.peak as f64).log10()
        } else {
            -120.0
        };
        let db = if self.before > 0.0 && self.after > 0.0 {
            (10.0 * (self.before / self.after).log10()) as f32
        } else {
            0.0
        };
        peak_db >= MIN_INPUT_PEAK_DB && db >= MIN_REDUCTION_DB
    }

    /// Built by the command, off the audio thread.
    pub fn result(&self) -> BleedResult {
        let input_peak_db = if self.peak > 0.0 {
            20.0 * (self.peak as f64).log10()
        } else {
            -120.0
        };
        let db = if self.before > 0.0 && self.after > 0.0 {
            (10.0 * (self.before / self.after).log10()) as f32
        } else {
            0.0
        };
        let mut r = BleedResult {
            phase: BleedPhase::Done,
            progress: 1.0,
            db,
            input_peak_db,
            ..Default::default()
        };
        if input_peak_db < MIN_INPUT_PEAK_DB {
            r.phase = BleedPhase::Failed;
            r.message = format!(
                "heard almost nothing back ({input_peak_db:.1} dB). Turn the speaker up, \
                 or check that the output really is a speaker and not headphones."
            );
        } else if db < MIN_REDUCTION_DB {
            r.phase = BleedPhase::Failed;
            r.message = format!(
                "heard the probe but could only remove {db:.1} dB of it (needs {MIN_REDUCTION_DB:.0}). \
                 Usually the round trip: run measure latency first. Playing during the \
                 measurement does it too."
            );
        } else {
            r.message = format!("removing {db:.1} dB of the app's own sound from the picture.");
        }
        r
    }
}


