//! Short-time FFT of the input channels, for the spectrogram display.
//!
//! The render callback delivers 2048 frames, so WINDOW 1024 / HOP 256 is
//! exactly 8 hops per callback with no partial-hop bookkeeping across the
//! boundary. 1024 is 23 ms -- the standard onset-detection window, and the
//! reason the numbers are these and not a longer window with a prettier bass
//! end (which would blur the transients this is eventually meant to find).
//!
//! Everything here obeys the audio thread rules: the planner and the scratch
//! buffers are built once, `resize` is called once per callback, and the
//! per-frame entry point is a store and an index bump.

use realfft::num_complex::Complex32;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub const WINDOW: usize = 1024;
pub const HOP: usize = 256;
pub const BINS: usize = 64;

/// Bin edges span this, which is about as much as a 44.1k stream has to say.
/// The bottom is above the 43 Hz resolution floor of a 1024-point window, so
/// the lowest group still covers more than one FFT bin.
const FREQ_LOW: f64 = 30.0;
const FREQ_HIGH: f64 = 16_000.0;

/// The dB window the u8 scale covers: 0 is -100 dB or quieter, 255 is 0 dB.
/// Deliberately fixed and wide -- the frontend applies its own gain and floor,
/// so tuning the picture never has to push config back to the audio thread.
const DB_FLOOR: f32 = -100.0;

/// Analysing every channel of a 16-input interface would cost 16 FFTs a hop to
/// look at one, and nothing draws more than a pane at a time.
pub const MAX_ANALYSIS_CHANNELS: usize = 4;

pub struct Analyzer {
    fft: Arc<dyn RealToComplex<f32>>,
    /// Hann, precomputed -- applied to a copy of the ring on every hop.
    window: Vec<f32>,
    /// One `WINDOW`-long ring per channel, flattened: `ring[ch * WINDOW + i]`.
    ring: Vec<f32>,
    channels: usize,
    /// Where the next sample goes, shared by every channel.
    pos: usize,
    /// Frames since the last hop.
    since_hop: usize,
    /// First index of each output group, `BINS + 1` long, so group b covers
    /// `edges[b]..edges[b + 1]` of the magnitude spectrum.
    edges: Vec<usize>,
    // Reused across hops. `input` is the windowed copy the FFT consumes (it
    // writes into its argument), `spectrum` and `scratch` are realfft's.
    input: Vec<f32>,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
}

impl Analyzer {
    pub fn new(sample_rate: f64) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(WINDOW);
        let spectrum = fft.make_output_vec();
        let scratch = fft.make_scratch_vec();
        Analyzer {
            window: (0..WINDOW)
                .map(|i| {
                    let phase = 2.0 * std::f64::consts::PI * (i as f64) / (WINDOW as f64);
                    (0.5 - 0.5 * phase.cos()) as f32
                })
                .collect(),
            edges: log_bin_edges(sample_rate),
            ring: Vec::new(),
            channels: 0,
            pos: 0,
            since_hop: 0,
            input: vec![0.0; WINDOW],
            spectrum,
            scratch,
            fft,
        }
    }

    /// Called once per callback, next to `bus_delay.resize`: the only place
    /// this allocates, and only when the channel count actually moved.
    pub fn resize(&mut self, channels: usize) {
        if self.channels == channels {
            return;
        }
        self.channels = channels;
        self.ring.clear();
        self.ring.resize(channels * WINDOW, 0.0);
        self.reset();
    }

    /// Drops the history without touching the allocation. A beat reset or an
    /// unpause leaves a gap in the stream, and a window stitched across it is
    /// a spectral edge that was never played.
    pub fn reset(&mut self) {
        for s in self.ring.iter_mut() {
            *s = 0.0;
        }
        self.pos = 0;
        self.since_hop = 0;
    }

    /// One frame in, one sample per channel. Deliberately trivial: this runs
    /// 44,100 times a second.
    pub fn push(&mut self, frame: &[f32]) -> bool {
        for ch in 0..self.channels {
            self.ring[ch * WINDOW + self.pos] = frame.get(ch).copied().unwrap_or(0.0);
        }
        self.pos = (self.pos + 1) % WINDOW;
        self.since_hop += 1;
        if self.since_hop < HOP {
            return false;
        }
        self.since_hop = 0;
        true
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// Runs one channel's FFT over the current ring and appends `BINS` bytes to
    /// `out`. Call once per channel, in channel order, on the frame where
    /// `push` returned true.
    ///
    /// The window it describes is centred `WINDOW / 2` frames behind that
    /// frame, which is what the caller's beat stamp has to account for.
    pub fn analyze_into(&mut self, channel: usize, out: &mut Vec<u8>) {
        let base = channel * WINDOW;
        // The ring's oldest sample is at `pos`, so unrolling it starts there.
        for i in 0..WINDOW {
            let src = base + (self.pos + i) % WINDOW;
            self.input[i] = self.ring[src] * self.window[i];
        }
        // realfft only fails on a length mismatch, and these are its own
        // vectors, so it can't here.
        let _ = self
            .fft
            .process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch);

        for b in 0..BINS {
            let (lo, hi) = (self.edges[b], self.edges[b + 1]);
            // Max rather than mean across a group: a group at the top spans
            // dozens of FFT bins, and averaging a narrow partial across them
            // buries it under its own neighbours. A spectrogram is read for
            // where the energy *is*, so the peak is the honest summary.
            let mut peak = 0.0f32;
            for k in lo..hi {
                let c = self.spectrum[k];
                let mag = c.re * c.re + c.im * c.im;
                if mag > peak {
                    peak = mag;
                }
            }
            // Normalised by the window length so full scale is about 0 dB
            // regardless of WINDOW. `mag` is squared, hence 10*log10.
            let norm = peak / ((WINDOW as f32) * 0.5).powi(2);
            let db = if norm > 0.0 {
                10.0 * norm.log10()
            } else {
                DB_FLOOR
            };
            let scaled = (db - DB_FLOOR) / -DB_FLOOR * 255.0;
            out.push(scaled.clamp(0.0, 255.0) as u8);
        }
    }
}

/// Log-spaced group boundaries over the `WINDOW / 2 + 1` magnitude bins.
/// Precomputed: the spacing only depends on the sample rate, which never
/// changes while running.
///
/// Every group is forced to advance by at least one FFT bin, so no group can be
/// empty and draw as permanent silence. Below about 1.8 kHz log spacing asks for
/// less than the window's 43 Hz resolution, so the bottom two thirds of the axis
/// come out one bin per group -- linear, not log. That works out at roughly the
/// same rows per octave as true log spacing over this range, and it avoids the
/// banding that several groups sharing one bin would draw.
fn log_bin_edges(sample_rate: f64) -> Vec<usize> {
    let n_mag = WINDOW / 2 + 1;
    let hz_per_bin = sample_rate / (WINDOW as f64);
    let (lo, hi) = (FREQ_LOW.ln(), FREQ_HIGH.ln());
    let mut edges = Vec::with_capacity(BINS + 1);
    let mut last = 0usize;
    for b in 0..=BINS {
        let hz = (lo + (hi - lo) * (b as f64) / (BINS as f64)).exp();
        let bin = (hz / hz_per_bin).round() as usize;
        let bin = bin.clamp(last, n_mag);
        // Every group has to hold at least one bin, including the last, so the
        // top edge can't be pushed past the end.
        let bin = bin.max(last + usize::from(b > 0)).min(n_mag);
        edges.push(bin);
        last = bin;
    }
    edges
}
