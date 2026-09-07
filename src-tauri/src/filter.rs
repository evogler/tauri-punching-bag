//! A high-pass over the input, for the picture rather than for the sound.
//!
//! At the zoom levels this app is used at -- a few samples to a pixel column --
//! the waveform is drawn nearly raw, so the slow humps on screen are cycles of
//! a note's fundamental rather than its envelope. Transients are broadband and
//! a sustained note is dominated by its fundamental, so tilting the display
//! toward the high end shows where notes *start*, which is the thing being
//! played against a grid.

use std::f64::consts::PI;

/// Each pole is set below the cutoff being asked for, so that the *pair* is
/// 3 dB down where the label says.
///
/// Two identical one-poles are each 3 dB down at their own corner, so putting
/// both at the requested frequency lands the cascade 6 dB down there -- and the
/// number in the panel would not mean what the same number means anywhere else,
/// including `analysisBandLow` right beside it. Solving
/// `(f^2/(f^2+f1^2))^2 = 1/2` for the per-pole corner gives
/// `f1 = f * sqrt(sqrt(2) - 1)`.
const POLE_SCALE: f64 = 0.6435942529055826;

/// Two cascaded one-poles: 12 dB/octave.
///
/// The order is chosen by arithmetic, not taste. A note's fundamental commonly
/// sits 20-30 dB above the transient content of the same note, so at ten times
/// the fundamental a single pole (6 dB/octave) buys only ~20 dB and the humps
/// still win. A second pole puts the fundamental a further 20 dB down, which is
/// the difference between the filter doing its job and looking like it does
/// nothing.
///
/// Written as `x - lowpass(x)` rather than as a biquad because a one-pole
/// lowpass has one state variable, one coefficient, and cannot go unstable for
/// any `k` in 0..1 -- which matters when the cutoff is an expression the user is
/// halfway through typing.
/// Measured at 44.1 kHz with an 800 Hz cutoff, against the passband: -3.0 dB at
/// 800, -8.5 at 400, -17.6 at 200, -28.8 at 100, -32.1 at 82 -- a guitar's low
/// E pushed well under the transient content of its own note, which is the
/// whole point.
pub struct HighPass {
    /// One lowpass state per pole. What the filter passes is whatever is left of
    /// the input after the lowpass is taken away.
    stages: [f32; 2],
    k: f32,
}

impl HighPass {
    pub fn new() -> Self {
        // k = 0 is a pass-through, which is the right thing to be until a
        // cutoff has been set.
        Self {
            stages: [0.0; 2],
            k: 0.0,
        }
    }

    /// Recomputed once per callback, never per frame.
    ///
    /// Both degenerate answers are deliberately safe rather than guarded
    /// against upstream: a nonsense cutoff gives `k = 0` and passes the signal
    /// through untouched, and a cutoff at or past Nyquist gives `k = 1` and
    /// removes everything. Neither can produce a NaN, and neither depends on
    /// the frontend having validated anything.
    pub fn set_cutoff(&mut self, hz: f64, sample_rate: f64) {
        let k = if hz.is_finite() && hz > 0.0 && sample_rate > 0.0 {
            // exp() rather than the usual 2*pi*fc/sr approximation, which stops
            // being one as the cutoff approaches Nyquist -- and this is a field
            // anything can be typed into.
            1.0 - (-2.0 * PI * hz * POLE_SCALE / sample_rate).exp()
        } else {
            0.0
        };
        self.k = (k as f32).clamp(0.0, 1.0);
    }

    pub fn process(&mut self, x: f32) -> f32 {
        let mut v = x;
        for lp in self.stages.iter_mut() {
            *lp += (v - *lp) * self.k;
            v -= *lp;
        }
        v
    }
}
