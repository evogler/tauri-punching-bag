//! Holding the looper's spectrum flat, band by band.
//!
//! With the bleed cancelled the loop decays almost everywhere -- a clap is gone
//! in about five passes. What is left is one narrow range where the residual
//! coupling is still at or above unity, so that band grows while everything
//! else dies. It is an ordinary howl with a two-minute time constant, and the
//! reason it takes minutes rather than seconds is that the excess gain is tiny:
//! twenty decibels over forty passes is a quarter of a decibel a pass.
//!
//! The usual answer is to hunt the ringing frequency with a peak detector and
//! drop a notch on it. This does something narrower and more direct, because
//! this app knows something a PA does not: the loop is *its own signal*, so it
//! can simply watch each band's energy and require that it not grow. No
//! detection heuristics, no telling a howl from a sustained note, no chasing:
//! the rule is "the loop may not gain energy", and the correction is exactly
//! the excess.
//!
//! **It will fight a part you are deliberately building up.** That is inherent
//! -- crescendo and runaway look identical from inside a band -- and it is the
//! trade the owner asked for, on the grounds that building a part up through a
//! laptop microphone and speaker is too much to ask for anyway. The streak
//! requirement below is what keeps an ordinary phrase from tripping it.

use std::f32::consts::PI;

/// Third-octave, 60 Hz to about 12 kHz. Third-octave because that is roughly
/// the width a feedback peak occupies once the room has finished with it, and
/// narrow enough that cutting one costs the loop very little.
pub const BANDS: usize = 24;
const BASE_HZ: f32 = 60.0;
const Q: f32 = 4.0;

/// How often the bands are compared. A second is long enough that an ordinary
/// phrase averages out and short enough to catch a runaway well before it is
/// loud.
const INTERVAL_SECONDS: f64 = 1.0;

/// Growth over one interval that counts as growth at all.
const GROW_DB: f32 = 0.5;
/// Consecutive growing intervals before anything is cut. Feedback grows every
/// interval without exception; playing does not.
const STREAK: u32 = 3;
/// Cut per qualifying interval. A fixed step rather than the measured excess:
/// one noisy measurement then cannot gouge a hole, and three seconds of real
/// growth still buys a decibel.
const STEP_DB: f32 = 1.0;
/// Given back per quiet interval, so a cut made for a room you have since left
/// fades instead of standing forever.
const RELEASE_DB: f32 = 0.05;
/// As deep as it will ever go in one band.
const MAX_CUT_DB: f32 = 24.0;

/// A band has to carry at least this much of the loudest band's energy before
/// its growth counts for anything -- 30 dB down.
///
/// Without it the guard cuts silence. A band holding nothing but arithmetic
/// noise still has a *ratio* between one interval and the next, and that ratio
/// is arbitrary, so it trips the streak test as readily as a real howl. Found
/// by test: against a 1 kHz ring it confidently cut 60 Hz, where there was no
/// signal at all.
const FLOOR: f64 = 1e-3;

/// And the loop as a whole has to be audible at all. An interval's worth of
/// energy below this is somewhere under -70 dBFS, which is not a loop that is
/// feeding back; it is one that has finished. Without it the guard goes on
/// comparing bands of near-silence against each other after the loop has died,
/// and cuts whichever band's numerical noise happened to rise.
const SILENCE: f64 = 1e-6;

/// Transposed direct form II: one multiply-add per coefficient and two state
/// words, which is the cheapest shape that is also numerically well behaved.
#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

struct Band {
    hz: f32,
    /// Precomputed once: only the gain moves afterwards, so recomputing the
    /// correction costs arithmetic rather than trigonometry.
    cos_w0: f32,
    alpha: f32,
    analysis: Biquad,
    correct: Biquad,
    energy: f64,
    prev: f64,
    streak: u32,
    cut_db: f32,
}

impl Band {
    fn new(hz: f32, sample_rate: f32) -> Self {
        let w0 = 2.0 * PI * hz / sample_rate;
        let (sin_w0, cos_w0) = w0.sin_cos();
        let alpha = sin_w0 / (2.0 * Q);
        // Constant-peak-gain bandpass, for measuring only.
        let a0 = 1.0 + alpha;
        let analysis = Biquad {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * cos_w0 / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        };
        let mut band = Band {
            hz,
            cos_w0,
            alpha,
            analysis,
            correct: Biquad::default(),
            energy: 0.0,
            prev: 0.0,
            streak: 0,
            cut_db: 0.0,
        };
        band.set_cut(0.0);
        band
    }

    /// Peaking EQ. At 0 dB the numerator and denominator are identical, so the
    /// filter is an exact pass-through and a band that is not being held costs
    /// the loop nothing at all.
    fn set_cut(&mut self, db: f32) {
        self.cut_db = db;
        let a = 10f32.powf(-db / 40.0);
        let a0 = 1.0 + self.alpha / a;
        self.correct.b0 = (1.0 + self.alpha * a) / a0;
        self.correct.b1 = -2.0 * self.cos_w0 / a0;
        self.correct.b2 = (1.0 - self.alpha * a) / a0;
        self.correct.a1 = -2.0 * self.cos_w0 / a0;
        self.correct.a2 = (1.0 - self.alpha / a) / a0;
    }
}

pub struct LoopGuard {
    bands: Vec<Band>,
    interval: usize,
    counter: usize,
}

impl LoopGuard {
    pub fn new(sample_rate: f64) -> Self {
        let sr = sample_rate as f32;
        LoopGuard {
            bands: (0..BANDS)
                .map(|k| Band::new(BASE_HZ * 2f32.powf(k as f32 / 3.0), sr))
                .collect(),
            interval: (INTERVAL_SECONDS * sample_rate) as usize,
            counter: 0,
        }
    }

    /// Everything given back at once. The cuts describe a room and a volume, so
    /// they mean nothing across a restart of the transport.
    pub fn reset(&mut self) {
        for b in self.bands.iter_mut() {
            b.energy = 0.0;
            b.prev = 0.0;
            b.streak = 0;
            b.set_cut(0.0);
            b.analysis.z1 = 0.0;
            b.analysis.z2 = 0.0;
            b.correct.z1 = 0.0;
            b.correct.z2 = 0.0;
        }
        self.counter = 0;
    }

    /// Measures the signal *going in* and returns it corrected.
    ///
    /// Measuring before the correction rather than after is what makes this
    /// settle rather than oscillate: the loop buffer records what the
    /// microphone hears, which is the corrected output coming back through the
    /// air, so a working cut shows up here as the growth stopping. Measuring
    /// after the cut would hide the very thing the cut was made for, and the
    /// band would be released and re-cut for ever.
    pub fn process(&mut self, x: f32) -> f32 {
        let mut y = x;
        for b in self.bands.iter_mut() {
            let band = b.analysis.process(x);
            b.energy += (band as f64) * (band as f64);
            y = b.correct.process(y);
        }
        self.counter += 1;
        if self.counter >= self.interval {
            self.counter = 0;
            self.settle();
        }
        y
    }

    /// One band is deepened per interval: the loudest of those that have been
    /// growing. Everything else is released.
    ///
    /// **Cutting every band that sees the growth is the trap here**, and it is
    /// not obvious until you print the numbers. A ringing tone is far louder
    /// than anything else in the loop, so it shows up through the skirts of
    /// *every* analysis filter, and all twenty-four bands report growth
    /// together. Cutting each of them turns a surgical notch into a broadband
    /// duck -- measured, all 24 came down by the same 2.9 dB, and the ring
    /// itself was no more attenuated than the music around it. Sending the cut
    /// to the peak is what makes it a notch.
    fn settle(&mut self) {
        let loudest = self.bands.iter().fold(0.0f64, |m, b| m.max(b.energy));
        let floor = (loudest * FLOOR).max(SILENCE);
        let live = loudest > SILENCE;
        let mut target: Option<usize> = None;
        let mut target_energy = 0.0f64;
        for (i, b) in self.bands.iter_mut().enumerate() {
            let grew = live
                && b.prev > floor
                && b.energy > floor
                && 10.0 * (b.energy / b.prev).log10() > GROW_DB as f64;
            b.streak = if grew { b.streak + 1 } else { 0 };
            if b.streak >= STREAK && b.energy > target_energy {
                target_energy = b.energy;
                target = Some(i);
            }
        }
        for (i, b) in self.bands.iter_mut().enumerate() {
            let cut = if Some(i) == target {
                b.cut_db + STEP_DB
            } else {
                b.cut_db - RELEASE_DB
            };
            b.set_cut(cut.clamp(0.0, MAX_CUT_DB));
            b.prev = b.energy;
            b.energy = 0.0;
        }
    }

    /// The deepest cut in force, and where it is, for the panel -- a guard that
    /// cannot say what it is doing is one you cannot tell from a broken one.
    pub fn worst(&self) -> (f32, f32) {
        self.bands
            .iter()
            .fold((0.0, 0.0), |acc: (f32, f32), b| {
                if b.cut_db > acc.1 {
                    (b.hz, b.cut_db)
                } else {
                    acc
                }
            })
    }
}

