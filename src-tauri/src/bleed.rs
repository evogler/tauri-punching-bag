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

/// Tracking step. Small: this is refining a filter that already fits, not
/// finding one, and every frame it runs on is a frame it was allowed to run on.
const TRACK_MU: f32 = 0.05;

/// How much better the filter has to be explaining what it hears than not,
/// before it is allowed to learn from the frame -- 10 dB of explanation.
///
/// Above 1 by necessity rather than taste: a diverged filter predicts something
/// large that is not there, so its error grows with its prediction and the
/// ratio sits near 1, which makes anything above 1 self-arresting. Ten rather
/// than three by measurement. Swept against a moved path, with the filter left
/// to run through thirty seconds of practising:
///
/// ```text
///              silent      bursts   loud bursts   never stops
///   guard 3   27.3 dB     8.9 dB      23.3 dB       3.9 dB
///   guard 10  27.3 dB    23.6 dB       6.4 dB       6.4 dB
///   guard 30   6.4 dB     6.4 dB       6.4 dB       6.4 dB
/// ```
///
/// 6.4 dB is the frozen filter, i.e. tracking declining to do anything. Three
/// tracks in more situations and is *worse than frozen* in the last column;
/// thirty never opens at all. Ten either tracks or holds, and never makes the
/// picture worse than leaving it alone -- which is the property worth having,
/// given that the two designs before this one were both abandoned for failing
/// exactly there.
const TRACK_GUARD: f32 = 10.0;

/// Pull back toward the measured answer, per adapting frame. Tiny, so it never
/// fights real tracking; it is here so that "wanders somewhere strange" decays
/// into "the filter you measured" rather than persisting.
const TRACK_HOME: f32 = 2e-4;

/// Per sample decay on both of the powers the guard compares: each rises
/// instantly to a new peak and falls back over ~300 ms at 44.1 kHz.
///
/// **Instant attack is the difference between tracking and damage.** A 20 ms
/// average takes 20 ms to notice that you have started playing, and adapts hard
/// on every one of those frames with your signal in the error -- 880 bad
/// updates at the top of every phrase, and they accumulate. Measured with
/// one-second bursts: 6.4 dB frozen against **-2.6 dB tracking**, which is
/// worse than not bothering.
///
/// **Both sides have to be the same statistic**, which is the other half of it.
/// Peak against average is not a comparison: the peak of a residual runs well
/// above its mean, so the guard reads as though nothing is explained and never
/// opens at all. Measured that way the filter simply stopped tracking -- safe,
/// and useless.
const TRACK_DECAY: f32 = 1.0 - 7.6e-5;

/// Smoothing on the live figures, per callback. They are read by a human at
/// 4 Hz and would otherwise be unreadable.
const REPORT_SMOOTHING: f32 = 0.2;

/// Per sample decay on the reference's peak energy, ~5 s at 44.1 kHz -- long
/// enough to span several beats, so it describes "how loud does this app get"
/// rather than "how loud is it this instant".
const TRACK_POWER_DECAY: f32 = 1.0 - 4.5e-6;

/// The reference has to carry at least this fraction of its recent peak energy
/// before anything is learned from the frame, and this fraction of that peak is
/// added to the NLMS denominator besides.
///
/// **Without it the filter blows up, and the training path cannot show you.**
/// NLMS divides the step by the window's own energy, which is exactly right
/// while the probe is running because the probe never stops. At runtime the
/// reference goes near-silent between one drum's decay and the next click, and
/// a step divided by almost nothing is almost anything: measured, the filter
/// diverged, its residual went huge, and the guard then read the wreckage as
/// "nothing is explained" and froze it there. 6.4 dB frozen against -12 dB.
const TRACK_MIN_POWER: f32 = 0.1;
const TRACK_REG: f32 = 0.01;

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
    /// Peak of `power` over the last few seconds. What stops a near-silent
    /// reference from producing an enormous NLMS step -- see `TRACK_MIN_POWER`.
    power_peak: f32,
    track_mu: f32,
    track_guard: f32,
    trained: bool,
    /// What the measurement produced, kept so tracking has somewhere to fall
    /// back to. The measurement is the prior; tracking is a bounded refinement
    /// around it, never a fresh search.
    measured: Vec<f32>,
    /// Per channel, smoothed power of what the filter explains and of what it
    /// does not. Their ratio is the whole of the guard.
    pred_pow: Vec<f32>,
    err_pow: Vec<f32>,
    /// The live meter, accumulated only over frames the guard let through --
    /// which are by construction the frames with little of you in them, and so
    /// the only frames on which a reduction figure means anything.
    seen: f64,
    left: f64,
    adapted: u32,
    frames: u32,
    track_db: f32,
    track_duty: f32,
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
            power_peak: 0.0,
            track_mu: TRACK_MU,
            track_guard: TRACK_GUARD,
            trained: false,
            measured: vec![0.0; channels * taps],
            pred_pow: vec![0.0; channels],
            err_pow: vec![0.0; channels],
            seen: 0.0,
            left: 0.0,
            adapted: 0,
            frames: 0,
            track_db: 0.0,
            track_duty: 0.0,
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
        self.measured.copy_from_slice(&self.weights);
        self.pred_pow.iter_mut().for_each(|v| *v = 0.0);
        self.err_pow.iter_mut().for_each(|v| *v = 0.0);
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
        self.power_peak = (self.power_peak * TRACK_POWER_DECAY).max(self.power);
    }

    /// Runtime: predict this channel's echo and take it off, and -- if `track`
    /// -- follow the path as it moves.
    ///
    /// `gain` is `audio_in_gain`, which the picture has been scaled by and the
    /// probe was not. Applied here rather than folded into the weights so that
    /// turning the input trim up does not silently invalidate a measurement.
    ///
    /// **Tracking exists because the path genuinely moves.** Hands over the
    /// keyboard are 5-15 cm from both transducers on a laptop and reflect a
    /// return only a fraction of a millisecond behind the direct arrival, so
    /// they are not a perturbation of the response, they are part of it. So is
    /// the lid angle, and where you are sitting.
    ///
    /// **The guard is the whole of why this is safe, and it is only available
    /// because the filter was measured first.** Adapt only on frames where the
    /// filter already explains far more than it leaves behind: such a frame has
    /// almost nothing of *you* in it by construction, which is exactly the
    /// judgement a from-scratch adaptive filter cannot make and the reason the
    /// continuous version had to be thrown away. Playing raises the residual
    /// and the update stops; a path that moves too far at once also stops it,
    /// which degrades to the frozen filter rather than to a wrong one.
    pub fn cancel(&mut self, ch: usize, input: f32, gain: f32, track: bool) -> f32 {
        if ch >= self.channels || !self.trained {
            return input;
        }
        let Self {
            taps,
            hist,
            pos,
            weights,
            measured,
            power,
            power_peak,
            track_mu,
            track_guard,
            pred_pow,
            err_pow,
            seen,
            left,
            adapted,
            frames,
            ..
        } = self;
        let x = &hist[*pos + 1..=*pos + *taps];
        let w = &mut weights[ch * *taps..(ch + 1) * *taps];
        let predicted: f32 = w.iter().zip(x.iter()).map(|(a, b)| a * b).sum();
        let echo = predicted * gain;
        let out = input - echo;

        if !track || gain <= 0.0 {
            return out;
        }
        *frames += 1;
        // Peak-hold with a slow decay, on both sides. See `TRACK_DECAY`.
        pred_pow[ch] = (pred_pow[ch] * TRACK_DECAY).max(echo * echo);
        err_pow[ch] = (err_pow[ch] * TRACK_DECAY).max(out * out);
        // Loud enough to be worth learning from, and explained well enough to
        // be safe to learn from. The first is about the reference, the second
        // about you.
        if *power > TRACK_MIN_POWER * *power_peak
            && *power_peak > EPS
            && pred_pow[ch] > *track_guard * err_pow[ch]
        {
            *adapted += 1;
            // The only frames on which a reduction figure means anything, for
            // the same reason they are the only ones worth learning from.
            *seen += (input as f64) * (input as f64);
            *left += (out as f64) * (out as f64);
            let step = *track_mu * (out / gain) / (*power + TRACK_REG * *power_peak);
            let home = &measured[ch * *taps..(ch + 1) * *taps];
            for ((wi, xi), m) in w.iter_mut().zip(x.iter()).zip(home.iter()) {
                *wi += step * xi + TRACK_HOME * (m - *wi);
            }
        }
        out
    }

    /// Once per callback, never per frame: dB removed on the frames the guard
    /// judged, and the fraction of frames it let through.
    pub fn tracking_report(&mut self) -> (f32, f32) {
        if self.seen > 0.0 && self.left > 0.0 {
            let db = (10.0 * (self.seen / self.left).log10()) as f32;
            self.track_db += (db - self.track_db) * REPORT_SMOOTHING;
        }
        if self.frames > 0 {
            let duty = self.adapted as f32 / self.frames as f32;
            self.track_duty += (duty - self.track_duty) * REPORT_SMOOTHING;
        }
        self.seen = 0.0;
        self.left = 0.0;
        self.adapted = 0;
        self.frames = 0;
        (self.track_db, self.track_duty)
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
    /// Live, from the tracking guard rather than from the measurement: dB
    /// removed on the frames it could judge, and how much of the time it is
    /// judging. Zero duty means it is holding the measured filter, which is
    /// what it does the whole time you are playing.
    pub live_db: f32,
    pub live_duty: f32,
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
            live_db: 0.0,
            live_duty: 0.0,
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




