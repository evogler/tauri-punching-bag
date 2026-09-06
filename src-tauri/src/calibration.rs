//! Round-trip latency measurement: emit a known sound, find it in the input,
//! and the frame difference is `buffer_compensation`.
//!
//! The long explanation of *why* it is built this way -- the chirp, the matched
//! filter, why not the onset detector -- is in `docs/calibration.md`.

use crate::constants::sample_rate;
use serde::Serialize;
use std::f64::consts::PI;

/// Probe shape. A 20 ms sweep rather than a click: a click's energy is flat, so
/// most of it lands where a small speaker cannot reproduce it, and what comes
/// back has the low end missing and a peak several milliseconds wide. A sweep
/// puts its energy where speakers and microphones are efficient, and matched
/// filtering compresses it back to a peak about `1 / bandwidth` wide -- here
/// ~133 us, or six frames.
const PROBE_MS: f64 = 20.0;
const PROBE_F0: f64 = 500.0;
const PROBE_F1: f64 = 8000.0;

/// Five probes so the estimate can be a *median*. A door closing during one of
/// them shifts that estimate and gets outvoted, rather than quietly becoming
/// the answer.
pub const PROBE_COUNT: usize = 5;
const PROBE_SPACING_MS: f64 = 400.0;

/// How far behind a probe we look for it. Also the "is this plausible" bound:
/// half a second of round trip is already pathological.
const MAX_LATENCY_MS: f64 = 500.0;
/// Recorded after the last probe so the final one has a full search window.
const TAIL_MS: f64 = 600.0;

/// Captured peak must clear this or there is nothing to measure. Roughly
/// "audible above a quiet room" rather than a precise figure.
const MIN_INPUT_PEAK_DB: f64 = -45.0;
/// Correlation peak against the median of the correlation magnitudes. Below
/// this the filter found noise, not the probe.
const MIN_PEAK_RATIO: f64 = 8.0;
/// Probe-to-probe disagreement, in milliseconds, beyond which something moved.
const MAX_SPREAD_MS: f64 = 5.0;
/// A reflection can occasionally beat the direct arrival, so take the first
/// peak that reaches this fraction of the maximum rather than the maximum.
const FIRST_PEAK_FRACTION: f32 = 0.5;

fn ms_to_frames(ms: f64) -> usize {
    (ms / 1000.0 * sample_rate()) as usize
}

/// Hann-windowed linear sweep. Windowed so the probe doesn't start and end with
/// a step, which would put a click either side of the thing we're measuring.
fn make_chirp() -> Vec<f32> {
    let n = ms_to_frames(PROBE_MS).max(2);
    let dur = n as f64 / sample_rate();
    (0..n)
        .map(|i| {
            let t = i as f64 / sample_rate();
            // Instantaneous frequency sweeps f0 -> f1, so phase is its integral.
            let phase = 2.0 * PI * (PROBE_F0 * t + (PROBE_F1 - PROBE_F0) * t * t / (2.0 * dur));
            let window = 0.5 - 0.5 * (2.0 * PI * i as f64 / (n as f64 - 1.0)).cos();
            (window * phase.sin()) as f32
        })
        .collect()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CalibrationPhase {
    Idle,
    Running,
    Done,
    Failed,
}

/// Everything the panel shows -- deliberately including the measurements behind
/// a *failure*, so "no signal" and "signal but no lock" are told apart without
/// guessing. A calibration that cannot explain itself is one the user can only
/// retry blindly.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationResult {
    pub phase: CalibrationPhase,
    pub progress: f64,
    pub frames: f64,
    pub ms: f64,
    pub spread_ms: f64,
    pub peak_ratio: f64,
    pub input_peak_db: f64,
    pub probes_detected: usize,
    pub probes_total: usize,
    pub message: String,
    /// Thresholds, so the UI can draw "how far from confident" rather than a
    /// bare pass/fail.
    pub min_input_peak_db: f64,
    pub min_peak_ratio: f64,
    pub max_spread_ms: f64,
}

impl Default for CalibrationResult {
    fn default() -> Self {
        Self {
            phase: CalibrationPhase::Idle,
            progress: 0.0,
            frames: 0.0,
            ms: 0.0,
            spread_ms: 0.0,
            peak_ratio: 0.0,
            input_peak_db: -120.0,
            probes_detected: 0,
            probes_total: PROBE_COUNT,
            message: String::new(),
            min_input_peak_db: MIN_INPUT_PEAK_DB,
            min_peak_ratio: MIN_PEAK_RATIO,
            max_spread_ms: MAX_SPREAD_MS,
        }
    }
}

/// The audio thread's half. Everything here is sized once in `start`, so the
/// callback only ever indexes: no allocation, no arithmetic beyond a table
/// lookup and a store.
pub struct Calibration {
    pub active: bool,
    /// Frames elapsed since `start`. Doubles as the write index.
    pub pos: usize,
    /// The input channel being measured.
    pub channel: usize,
    chirp: Vec<f32>,
    /// Where each probe begins, in `pos` frames.
    emit_at: Vec<usize>,
    capture: Vec<f32>,
    total: usize,
    /// Set by the callback when `pos` reaches `total`; the command picks it up.
    pub finished: bool,
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            active: false,
            pos: 0,
            channel: 0,
            chirp: vec![],
            emit_at: vec![],
            capture: vec![],
            total: 0,
            finished: false,
        }
    }
}

impl Calibration {
    /// Allocates the whole run up front, off the audio thread.
    pub fn start(&mut self, channel: usize) {
        let spacing = ms_to_frames(PROBE_SPACING_MS);
        let lead = ms_to_frames(50.0);
        self.chirp = make_chirp();
        self.emit_at = (0..PROBE_COUNT).map(|k| lead + k * spacing).collect();
        self.total = lead + (PROBE_COUNT - 1) * spacing + ms_to_frames(TAIL_MS);
        self.capture = vec![0.0; self.total];
        self.channel = channel;
        self.pos = 0;
        self.finished = false;
        self.active = true;
    }

    pub fn cancel(&mut self) {
        self.active = false;
        self.finished = false;
        self.pos = 0;
        // Capacity is dropped deliberately: nothing reads it after a cancel,
        // and holding a few hundred KB for a run that may never come back is
        // worse than reallocating in `start`, which is off the audio thread.
        self.capture = vec![];
    }

    pub fn progress(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            (self.pos as f64 / self.total as f64).min(1.0)
        }
    }

    /// One frame. Returns the probe sample to write to *every* output channel.
    /// Called from the render callback: index, store, return.
    #[inline]
    pub fn step(&mut self, input: f32) -> f32 {
        if self.pos >= self.total {
            self.finished = true;
            self.active = false;
            return 0.0;
        }
        self.capture[self.pos] = input;
        let mut out = 0.0;
        for &start in self.emit_at.iter() {
            if self.pos >= start && self.pos < start + self.chirp.len() {
                out = self.chirp[self.pos - start];
                break;
            }
        }
        self.pos += 1;
        out
    }

    /// Hands the capture over without copying it -- the same swap-don't-copy
    /// rule the display buffers follow, so the callback never waits on a
    /// memcpy of a second of audio.
    pub fn take_capture(&mut self) -> (Vec<f32>, Vec<usize>, Vec<f32>) {
        (
            std::mem::take(&mut self.capture),
            self.emit_at.clone(),
            self.chirp.clone(),
        )
    }
}

struct ProbeMeasurement {
    lag: usize,
    peak_ratio: f64,
}

/// Matched filter. Correlation does not care that the speaker, the room and the
/// microphone have all coloured the probe on the way round: those convolve with
/// it, and the correlation still peaks where the known signal *arrives*.
fn measure_probe(chirp: &[f32], capture: &[f32], start: usize, max_lag: usize) -> Option<ProbeMeasurement> {
    let n = chirp.len();
    if start + n >= capture.len() {
        return None;
    }
    let lags = max_lag.min(capture.len().saturating_sub(start + n));
    if lags == 0 {
        return None;
    }
    let mut corr = vec![0f32; lags];
    for (lag, slot) in corr.iter_mut().enumerate() {
        let window = &capture[start + lag..start + lag + n];
        let mut acc = 0f32;
        for j in 0..n {
            acc += chirp[j] * window[j];
        }
        *slot = acc.abs();
    }

    let max = corr.iter().cloned().fold(0f32, f32::max);
    if !(max > 0.0) {
        return None;
    }
    // The *first* arrival, not the loudest: in a live room an early reflection
    // can occasionally exceed the direct path, and the direct path is the one
    // that answers "how long did it take to get here".
    let threshold = max * FIRST_PEAK_FRACTION;
    let crossing = corr.iter().position(|&v| v >= threshold)?;
    // Crossing the threshold finds the *leading edge* of the arrival, which
    // sits a few frames before its apex -- a systematic early bias. Climb to
    // the top of that same peak: still the first arrival, now its centre.
    let mut lag = crossing;
    while lag + 1 < corr.len() && corr[lag + 1] > corr[lag] {
        lag += 1;
    }

    let mut sorted: Vec<f32> = corr.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2].max(f32::MIN_POSITIVE);
    Some(ProbeMeasurement {
        lag,
        peak_ratio: (corr[lag] / median) as f64,
    })
}

fn median_of(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// Runs off the audio thread, after the capture is complete.
pub fn analyze(capture: &[f32], emit_at: &[usize], chirp: &[f32]) -> CalibrationResult {
    let mut result = CalibrationResult {
        phase: CalibrationPhase::Failed,
        progress: 1.0,
        ..Default::default()
    };

    let peak = capture.iter().fold(0f32, |m, v| m.max(v.abs()));
    result.input_peak_db = if peak > 0.0 {
        20.0 * (peak as f64).log10()
    } else {
        -120.0
    };

    let max_lag = ms_to_frames(MAX_LATENCY_MS);
    let mut lags: Vec<f64> = vec![];
    let mut ratios: Vec<f64> = vec![];
    for &start in emit_at.iter() {
        if let Some(m) = measure_probe(chirp, capture, start, max_lag) {
            if m.peak_ratio >= MIN_PEAK_RATIO {
                lags.push(m.lag as f64);
            }
            ratios.push(m.peak_ratio);
        }
    }
    result.probes_detected = lags.len();
    if !ratios.is_empty() {
        result.peak_ratio = median_of(&mut ratios.clone());
    }

    // Reported in the order the user can act on: level first, because a signal
    // too quiet to measure makes every other number meaningless.
    if result.input_peak_db < MIN_INPUT_PEAK_DB {
        result.message = format!(
            "input too quiet ({:.0} dB, needs {:.0}). Turn the output up, or move the microphone closer.",
            result.input_peak_db, MIN_INPUT_PEAK_DB
        );
        return result;
    }
    if lags.len() < 3 {
        result.message = format!(
            "found {} of {} probes (need 3). Strongest match was {:.1}x the noise floor, needs {:.0}x.",
            result.probes_detected, PROBE_COUNT, result.peak_ratio, MIN_PEAK_RATIO
        );
        return result;
    }

    let spread_frames = lags.iter().cloned().fold(f64::MIN, f64::max)
        - lags.iter().cloned().fold(f64::MAX, f64::min);
    result.spread_ms = spread_frames / sample_rate() * 1000.0;
    let median = median_of(&mut lags.clone());
    result.frames = median;
    result.ms = median / sample_rate() * 1000.0;

    if result.spread_ms > MAX_SPREAD_MS {
        result.message = format!(
            "probes disagree by {:.1} ms (limit {:.0}). Something moved, or the room is too live.",
            result.spread_ms, MAX_SPREAD_MS
        );
        return result;
    }

    result.phase = CalibrationPhase::Done;
    result.message = format!(
        "{:.0} frames ({:.1} ms), {} of {} probes agreeing within {:.2} ms.",
        result.frames, result.ms, result.probes_detected, PROBE_COUNT, result.spread_ms
    );
    result
}

