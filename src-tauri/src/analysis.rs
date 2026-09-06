//! Short-time FFT of the input channels, for the spectrogram display and the
//! spectral flux the onset work is built on.
//!
//! The window is a setting, not a constant: frequency resolution and time
//! resolution trade directly against each other, and which side you want
//! depends on what you are looking at. 1024 (23 ms, 43 Hz) is the default and
//! the standard onset-detection size; smaller sharpens transients and coarsens
//! the bass, larger the reverse. The hop is always a quarter of it, so one
//! setting moves both the smear and the column width and the overlap stays at
//! the conventional 4x -- decoupling them adds a knob whose wrong settings
//! blur the flux rather than sharpen it.
//!
//! Everything here obeys the audio thread rules. Every allowed size is planned
//! at startup and every buffer is allocated at `MAX_WINDOW`, so changing the
//! window is recomputation into buffers that already exist, not an allocation:
//! `configure` is called once per callback and only does work when something
//! actually moved, and the per-frame entry point is a store and an index bump.

use crate::structs::Onset;
use realfft::num_complex::Complex32;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

/// The sizes the window setting can take, ascending. Powers of two because the
/// FFT wants them, and bounded at both ends: below 256 there is not enough
/// spectrum left to group into `BINS`, and above 4096 the window is longer than
/// a 16th note at any tempo worth practising.
pub const ANALYSIS_WINDOWS: [usize; 5] = [256, 512, 1024, 2048, 4096];
pub const DEFAULT_WINDOW: usize = 1024;
const MAX_WINDOW: usize = ANALYSIS_WINDOWS[ANALYSIS_WINDOWS.len() - 1];

pub const BINS: usize = 64;

/// Bin edges span this, which is about as much as a 44.1k stream has to say.
const FREQ_LOW: f64 = 30.0;
const FREQ_HIGH: f64 = 16_000.0;

/// Per-bin reference for the flux: the jump, in dB, that counts as a whole
/// unit of onset. 20 dB is a factor of ten in amplitude, which is about what a
/// bin does when a transient lands in it, so a strong attack across the band
/// reads around 1. Dividing by the number of groups actually in the band as
/// well means narrowing the band re-scales nothing -- a two-group band and the
/// full 64 both report roughly 1 for the same attack.
const DB_REF: f32 = 20.0;

/// The dB window the u8 scale covers: 0 is -100 dB or quieter, 255 is 0 dB.
/// Deliberately fixed and wide -- the frontend applies its own gain and floor,
/// so tuning the picture never has to push config back to the audio thread.
const DB_FLOOR: f32 = -100.0;

/// Peak picking, in milliseconds rather than hops so it means the same thing at
/// every window setting -- the hop moves with the window, and a radius fixed in
/// hops would quietly become 70 ms of lookahead at 4096 and 1.5 ms at 256.
///
/// `PEAK_RADIUS_MS` is how far either side of a candidate it has to be the
/// largest; it is also the lookahead, and so the only latency peak picking adds
/// on top of the half window. `MEDIAN_BACK_MS` is the stretch behind the
/// candidate the local median is taken over -- the threshold is relative to
/// that, so a loud passage doesn't fire continuously and a quiet one still
/// registers.
const PEAK_RADIUS_MS: f64 = 20.0;
const MEDIAN_BACK_MS: f64 = 100.0;
const MIN_PEAK_RADIUS: usize = 1;
const MAX_PEAK_RADIUS: usize = 8;
const MIN_MEDIAN_BACK: usize = 4;
const MAX_MEDIAN_BACK: usize = 32;
/// Long enough for the furthest either measure reaches back: the median ends at
/// the candidate, which is itself `radius` hops back.
const ODF_HISTORY: usize = MAX_MEDIAN_BACK + MAX_PEAK_RADIUS + 1;

/// How far *before* the true attack the flux peaks, as a fraction of the
/// window.
///
/// The stamp on a hop names its window's centre, which is right for a
/// spectrogram column but not for an onset: the flux peaks when a transient
/// *enters* the window, not when it reaches the middle of it. Measured across
/// every window size against clicks at known frames, the bias came out at
/// 0.303/0.318/0.321/0.336/0.321 of the window for 256..4096 -- proportional to
/// the window and otherwise constant, so it is corrected here rather than left
/// for the eye. Uncorrected it is ~60 px at 0.25x16 and 140bpm on the default
/// window, which would read as the detector being wrong.
///
/// Empirical, and measured on an instant attack: a slow-attack instrument will
/// sit differently, which is what `onset_offset` is for.
const ONSET_CENTRE_BIAS: f64 = 0.32;

/// What the peak picker is tuned to, resolved from config once per callback.
#[derive(Clone, Copy)]
pub struct OnsetParams {
    /// How far above the local median a peak has to stand.
    pub threshold: f32,
    /// Frames an onset suppresses further ones on the same channel.
    pub min_gap_frames: usize,
    /// A trim, in frames, on top of `ONSET_CENTRE_BIAS`. Positive is later.
    pub offset_frames: f64,
}

/// Analysing every channel of a 16-input interface would cost 16 FFTs a hop to
/// look at one, and nothing draws more than a pane at a time.
pub const MAX_ANALYSIS_CHANNELS: usize = 4;

/// Which entry of `ANALYSIS_WINDOWS` a requested size means. Nearest rather
/// than rejecting: the setting arrives from a dropdown over exactly these
/// values, so anything else is a hand-edited or stale config, and the nearest
/// legal size is a better answer than silently reverting to the default.
fn plan_index(window: usize) -> usize {
    let mut best = 0;
    let mut best_gap = usize::MAX;
    for (i, &w) in ANALYSIS_WINDOWS.iter().enumerate() {
        let gap = w.max(window) - w.min(window);
        if gap < best_gap {
            best_gap = gap;
            best = i;
        }
    }
    best
}

pub struct Analyzer {
    /// One plan per allowed window, built at startup: planning allocates, so it
    /// cannot happen on the audio thread, and there are few enough sizes to
    /// simply have them all ready.
    ffts: Vec<Arc<dyn RealToComplex<f32>>>,
    /// Index into `ffts` and `ANALYSIS_WINDOWS`.
    plan: usize,
    window_len: usize,
    /// A quarter of the window, always -- see the module comment.
    hop: usize,
    sample_rate: f64,
    /// Hann, recomputed into the first `window_len` slots when the window moves.
    window: Vec<f32>,
    /// One ring per channel, flattened at a fixed `MAX_WINDOW` stride:
    /// `ring[ch * MAX_WINDOW + i]`. The stride does not follow `window_len`, so
    /// changing the window never reallocates this.
    ring: Vec<f32>,
    channels: usize,
    /// Where the next sample goes, shared by every channel.
    pos: usize,
    /// Frames since the last hop.
    since_hop: usize,
    /// First index of each output group, `BINS + 1` long, so group b covers
    /// `edges[b]..edges[b + 1]` of the magnitude spectrum. Always `BINS + 1`
    /// entries whatever the window, so it is refilled rather than resized.
    edges: Vec<usize>,
    /// Kept so a band in Hz can be turned into a range of those groups.
    hz_per_bin: f64,
    /// Hops completed since the last reset. The first one has nothing to
    /// difference against -- its "previous" spectrum is the zeroed buffer,
    /// which every bin is far above -- so it reports a flux of 0 rather than a
    /// phantom transient. A count rather than a bool because `analyze_into`
    /// runs once per channel and the flag has to survive all of them.
    hops_since_reset: usize,
    /// Last hop's dB per group, per channel: `prev_db[ch * BINS + b]`. The
    /// flux is the positive part of the difference against this.
    prev_db: Vec<f32>,
    /// Recent flux per channel, `odf[ch * ODF_HISTORY + i]`, written at
    /// `odf_pos`. Peak picking needs a candidate's neighbours on *both* sides,
    /// so it always works `radius` hops behind the newest value.
    odf: Vec<f32>,
    /// The beat each of those hops was stamped with, shared across channels
    /// because the hops are simultaneous. Kept so an onset can be reported at
    /// its own beat rather than at the beat it was decided on.
    odf_beats: Vec<f64>,
    odf_pos: usize,
    /// Hops completed since the last reset, as an index rather than a count:
    /// the current hop is this one. `i64` so the "no onset yet" sentinel can
    /// sit below zero without wrapping.
    hop_index: i64,
    /// Hop the last onset was reported on, per channel, for the minimum gap.
    last_onset_hop: Vec<i64>,
    /// Peak-picking spans in hops, derived from the millisecond constants in
    /// `retune` so they track the window.
    peak_radius: usize,
    median_back: usize,
    /// Scratch for the median. Sorting needs somewhere to put a copy, and the
    /// audio thread can't allocate one per hop.
    median_scratch: Vec<f32>,
    // Reused across hops, all sized for MAX_WINDOW and sliced to the window in
    // use. `input` is the windowed copy the FFT consumes (it writes into its
    // argument), `spectrum` and `scratch` are realfft's. realfft wants `input`
    // and `spectrum` at exactly the transform's length but only requires
    // `scratch` to be long enough, so one scratch covers every plan.
    input: Vec<f32>,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    /// This hop's dB per group, before it is quantised for the spectrogram and
    /// differenced for the flux. A field rather than a local because both
    /// consumers want the f32s and the audio thread can't allocate.
    db: Vec<f32>,
}

impl Analyzer {
    pub fn new(sample_rate: f64) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let ffts: Vec<Arc<dyn RealToComplex<f32>>> = ANALYSIS_WINDOWS
            .iter()
            .map(|&n| planner.plan_fft_forward(n))
            .collect();
        let scratch_len = ffts.iter().map(|f| f.get_scratch_len()).max().unwrap_or(0);
        let plan = plan_index(DEFAULT_WINDOW);
        let mut analyzer = Analyzer {
            ffts,
            plan,
            window_len: ANALYSIS_WINDOWS[plan],
            hop: ANALYSIS_WINDOWS[plan] / 4,
            sample_rate,
            window: vec![0.0; MAX_WINDOW],
            edges: vec![0; BINS + 1],
            hz_per_bin: 0.0,
            hops_since_reset: 0,
            prev_db: Vec::new(),
            odf: Vec::new(),
            odf_beats: vec![0.0; ODF_HISTORY],
            odf_pos: 0,
            hop_index: 0,
            last_onset_hop: Vec::new(),
            peak_radius: MIN_PEAK_RADIUS,
            median_back: MIN_MEDIAN_BACK,
            median_scratch: vec![0.0; ODF_HISTORY],
            ring: Vec::new(),
            channels: 0,
            pos: 0,
            since_hop: 0,
            input: vec![0.0; MAX_WINDOW],
            db: vec![0.0; BINS],
            spectrum: vec![Complex32::new(0.0, 0.0); MAX_WINDOW / 2 + 1],
            scratch: vec![Complex32::new(0.0, 0.0); scratch_len],
        };
        analyzer.retune();
        analyzer
    }

    /// Rebuilds everything that depends on the window length, in place. Called
    /// from `new` and whenever the setting moves; `clear` + `push` on a `Vec`
    /// that already has the capacity does not allocate.
    fn retune(&mut self) {
        let n = self.window_len;
        for i in 0..n {
            let phase = 2.0 * std::f64::consts::PI * (i as f64) / (n as f64);
            self.window[i] = (0.5 - 0.5 * phase.cos()) as f32;
        }
        self.hz_per_bin = self.sample_rate / (n as f64);
        fill_log_bin_edges(&mut self.edges, self.sample_rate, n);
        // In hops, from the millisecond spans, so the picker behaves the same
        // whatever the window is set to.
        let hops_per_ms = self.sample_rate / 1000.0 / (self.hop as f64);
        self.peak_radius = ((PEAK_RADIUS_MS * hops_per_ms).round() as usize)
            .clamp(MIN_PEAK_RADIUS, MAX_PEAK_RADIUS);
        self.median_back = ((MEDIAN_BACK_MS * hops_per_ms).round() as usize)
            .clamp(MIN_MEDIAN_BACK, MAX_MEDIAN_BACK);
    }

    /// Called once per callback, next to `bus_delay.resize`: the only place the
    /// channel buffers are allocated, and only when the count actually moved.
    /// A window change reallocates nothing at all.
    pub fn configure(&mut self, channels: usize, window: usize) {
        let plan = plan_index(window);
        if self.channels == channels && self.plan == plan {
            return;
        }
        if self.channels != channels {
            self.channels = channels;
            self.ring.clear();
            self.ring.resize(channels * MAX_WINDOW, 0.0);
            self.prev_db.clear();
            self.prev_db.resize(channels * BINS, 0.0);
            self.odf.clear();
            self.odf.resize(channels * ODF_HISTORY, 0.0);
            self.last_onset_hop.clear();
            self.last_onset_hop.resize(channels, i64::MIN / 2);
        }
        if self.plan != plan {
            self.plan = plan;
            self.window_len = ANALYSIS_WINDOWS[plan];
            self.hop = self.window_len / 4;
            self.retune();
        }
        // Either change invalidates the history: a ring read at a new length is
        // a different stretch of time, and a spectrum grouped by new edges is
        // not comparable with the last one.
        self.reset();
    }

    /// Drops the history without touching the allocation. A beat reset or an
    /// unpause leaves a gap in the stream, and a window stitched across it is
    /// a spectral edge that was never played.
    pub fn reset(&mut self) {
        for s in self.ring.iter_mut() {
            *s = 0.0;
        }
        // Differencing across the gap would report the whole spectrum arriving
        // at once, so the history goes with the ring and the next hop is
        // treated as the first one again.
        for d in self.prev_db.iter_mut() {
            *d = 0.0;
        }
        // Same reasoning for the onset history: a peak picked across the gap
        // would be measured against a median from before it.
        for f in self.odf.iter_mut() {
            *f = 0.0;
        }
        for b in self.odf_beats.iter_mut() {
            *b = 0.0;
        }
        for h in self.last_onset_hop.iter_mut() {
            *h = i64::MIN / 2;
        }
        self.odf_pos = 0;
        self.hop_index = 0;
        self.pos = 0;
        self.since_hop = 0;
        self.hops_since_reset = 0;
    }

    /// One frame in, one sample per channel. Deliberately trivial: this runs
    /// 44,100 times a second.
    pub fn push(&mut self, frame: &[f32]) -> bool {
        for ch in 0..self.channels {
            self.ring[ch * MAX_WINDOW + self.pos] = frame.get(ch).copied().unwrap_or(0.0);
        }
        self.pos = (self.pos + 1) % self.window_len;
        self.since_hop += 1;
        if self.since_hop < self.hop {
            return false;
        }
        self.since_hop = 0;
        self.hops_since_reset += 1;
        true
    }

    pub fn channels(&self) -> usize {
        self.channels
    }

    /// The window in frames. The caller needs it for the beat stamp: a hop
    /// describes the window centred half of this behind the frame it completes
    /// on, and that offset moves with the setting.
    pub fn window_len(&self) -> usize {
        self.window_len
    }

    /// The half-open range of output groups the flux sums over, from a band in
    /// Hz. Resolved once per callback rather than per hop: it only moves when
    /// the config does.
    ///
    /// Measured against the groups' real spans -- `edges` times the bin
    /// width -- rather than the nominal log spacing, which the
    /// one-bin-minimum rule pulls away from over the bottom of the axis.
    /// Anything that isn't a usable band (reversed, non-finite, or covering no
    /// group at all) falls back to the full range, so a half-typed number can't
    /// silently zero the detector.
    pub fn band_groups(&self, low_hz: f64, high_hz: f64) -> (usize, usize) {
        let full = (0usize, BINS);
        if !(low_hz.is_finite() && high_hz.is_finite() && low_hz < high_hz) {
            return full;
        }
        let mut lo = BINS;
        let mut hi = 0usize;
        for b in 0..BINS {
            let start = self.edges[b] as f64 * self.hz_per_bin;
            let end = self.edges[b + 1] as f64 * self.hz_per_bin;
            if end > low_hz && start < high_hz {
                if b < lo {
                    lo = b;
                }
                hi = b + 1;
            }
        }
        if lo < hi {
            (lo, hi)
        } else {
            full
        }
    }

    /// Runs one channel's FFT over the current ring, appends `BINS` bytes to
    /// `out`, and returns the spectral flux over `band`. Call once per channel,
    /// in channel order, on the frame where `push` returned true.
    ///
    /// The window it describes is centred `window_len / 2` frames behind that
    /// frame, which is what the caller's beat stamp has to account for.
    ///
    /// The flux is the sum of positive change in *dB*, not in magnitude: a
    /// quiet passage and a loud one produce comparable numbers for the same
    /// attack, which is the whole reason a threshold over it can be a single
    /// setting rather than one per dynamic. Unclamped -- it rides across as f32
    /// and the frontend clamps at draw time.
    pub fn analyze_into(&mut self, channel: usize, out: &mut Vec<u8>, band: (usize, usize)) -> f32 {
        let n = self.window_len;
        let base = channel * MAX_WINDOW;
        // The ring's oldest sample is at `pos`, so unrolling it starts there.
        for i in 0..n {
            let src = base + (self.pos + i) % n;
            self.input[i] = self.ring[src] * self.window[i];
        }
        // Sliced to the transform's length: realfft checks the input and output
        // lengths exactly, and only requires the scratch to be long enough.
        // It can only fail on those lengths, and these are its own sizes.
        let _ = self.ffts[self.plan].process_with_scratch(
            &mut self.input[..n],
            &mut self.spectrum[..n / 2 + 1],
            &mut self.scratch,
        );

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
            // whatever the window is set to -- otherwise changing it would move
            // the whole picture's brightness. `mag` is squared, hence 10*log10.
            let norm = peak / ((n as f32) * 0.5).powi(2);
            // Floored here rather than only at the u8 clamp, because the flux
            // reads these too: a bin holding nothing but numerical noise sits
            // around -300 dB and wanders by tens of dB a hop, which would swamp
            // the sum from the bins that are actually carrying a signal. The
            // spectrogram bytes are unaffected -- anything under the floor
            // already quantised to 0.
            let db = if norm > 0.0 {
                10.0 * norm.log10()
            } else {
                DB_FLOOR
            };
            self.db[b] = db.max(DB_FLOOR);
        }

        for b in 0..BINS {
            let scaled = (self.db[b] - DB_FLOOR) / -DB_FLOOR * 255.0;
            out.push(scaled.clamp(0.0, 255.0) as u8);
        }

        // The band is trusted only as far as it is usable: a stale range from
        // the callback before a channel-count change would otherwise index off
        // the end of a group.
        let (lo, hi) = (band.0.min(BINS), band.1.min(BINS));
        let (lo, hi) = if lo < hi { (lo, hi) } else { (0, BINS) };
        let prev = &mut self.prev_db[channel * BINS..(channel + 1) * BINS];
        let mut sum = 0.0f32;
        for b in lo..hi {
            // Only rises count. A note decaying is not an onset, and summing
            // the falls too would make one arrive every time a sound stopped.
            sum += (self.db[b] - prev[b]).max(0.0);
        }
        prev.copy_from_slice(&self.db);
        if self.hops_since_reset <= 1 {
            return 0.0;
        }
        sum / ((hi - lo) as f32 * DB_REF)
    }

    /// The hop in frames. The caller needs it to turn a sub-hop peak offset
    /// into beats.
    pub fn hop_frames(&self) -> usize {
        self.hop
    }

    /// Records the beat this hop was stamped with, before the per-channel work.
    /// Call once per hop.
    pub fn note_hop_beat(&mut self, beat: f64) {
        self.odf_beats[self.odf_pos] = beat;
    }

    /// Finishes a hop: everything written at `odf_pos` is now history. Call
    /// once, after every channel has been through `pick_onset`.
    pub fn advance_hop(&mut self) {
        self.odf_pos = (self.odf_pos + 1) % ODF_HISTORY;
        self.hop_index += 1;
    }

    /// `back` hops before the hop being written now: 0 is this one.
    fn odf_at(&self, channel: usize, back: usize) -> f32 {
        let i = (self.odf_pos + ODF_HISTORY - back) % ODF_HISTORY;
        self.odf[channel * ODF_HISTORY + i]
    }

    /// Files this hop's flux and decides whether the hop `peak_radius` back was
    /// an onset, pushing it to `out` if so. Call once per channel per hop, then
    /// `advance_hop`.
    ///
    /// Three conditions, the standard ones: the candidate is the largest value
    /// within `peak_radius` either side of it, it stands `threshold` above the
    /// median of the `median_back` hops behind it, and it is at least
    /// `min_gap_frames` after the last onset on this channel. The median rather
    /// than a mean because a mean is dragged up by the very peaks being
    /// detected, which suppresses the next one.
    ///
    /// Deciding `peak_radius` hops late is the lookahead, and it is affordable
    /// precisely because the display already runs `buffer_compensation` behind
    /// the audio -- see the latency note in docs/onsets.md.
    pub fn pick_onset(
        &mut self,
        channel: usize,
        flux: f32,
        beats_per_sample: f64,
        params: OnsetParams,
        out: &mut Vec<Onset>,
    ) {
        let slot = channel * ODF_HISTORY + self.odf_pos;
        self.odf[slot] = flux;

        let radius = self.peak_radius;
        let back = self.median_back;
        // Every index the tests below read has to be real history, not the
        // zeroes a reset left behind.
        if self.hop_index < (radius + back + 1) as i64 {
            return;
        }

        let candidate = self.odf_at(channel, radius);
        if !(candidate > 0.0) {
            return;
        }
        // Largest within the radius. `>=` on the earlier side and `>` on the
        // later one, so a plateau reports its first hop rather than every hop.
        for d in 1..=radius {
            if self.odf_at(channel, radius + d) >= candidate
                || self.odf_at(channel, radius - d) > candidate
            {
                return;
            }
        }

        let n = back + 1;
        for i in 0..n {
            self.median_scratch[i] = self.odf_at(channel, radius + i);
        }
        let window = &mut self.median_scratch[..n];
        window.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median = window[n / 2];
        if candidate < median + params.threshold {
            return;
        }

        let candidate_hop = self.hop_index - radius as i64;
        let gap_hops = (params.min_gap_frames as f64 / self.hop as f64).ceil() as i64;
        if candidate_hop - self.last_onset_hop[channel] < gap_hops {
            return;
        }
        self.last_onset_hop[channel] = candidate_hop;

        // Sub-hop placement. A hop is 5.8 ms at the default window, which is
        // ~46 px at 0.25x16 and 140bpm -- coarse enough to be the limit on a
        // tool whose whole point is where an attack sits. Fitting a parabola
        // through the candidate and its two neighbours recovers the peak
        // between them. Clamped to half a hop: beyond that the fit is telling
        // us the peak isn't really here, and the max test above says it is.
        let earlier = self.odf_at(channel, radius + 1);
        let later = self.odf_at(channel, radius - 1);
        let denom = earlier - 2.0 * candidate + later;
        let offset = if denom.abs() > f32::EPSILON {
            (0.5 * (earlier - later) / denom).clamp(-0.5, 0.5)
        } else {
            0.0
        };

        // Window centre, plus the sub-hop peak position, plus the structural
        // lead the flux has on the attack, plus the user's trim.
        let frames = (offset as f64) * (self.hop as f64)
            + ONSET_CENTRE_BIAS * (self.window_len as f64)
            + params.offset_frames;
        out.push(Onset {
            beat: self.odf_beats[(self.odf_pos + ODF_HISTORY - radius) % ODF_HISTORY]
                + frames * beats_per_sample,
            channel,
            strength: candidate - median,
        });
    }
}

/// Log-spaced group boundaries over the `window / 2 + 1` magnitude bins,
/// written into an `edges` that is already `BINS + 1` long so nothing is
/// allocated. Only the sample rate and the window feed it, and neither moves
/// except through `configure`.
///
/// Every group is forced to advance by at least one FFT bin, so no group can be
/// empty and draw as permanent silence. Wherever log spacing asks for less than
/// the window's resolution -- below about 1.8 kHz at a 1024-point window, and
/// proportionally higher at a shorter one -- the bottom of the axis comes out
/// one bin per group, linear rather than log. That is roughly the same rows per
/// octave over that range anyway, and it avoids the banding that several groups
/// sharing one bin would draw. It is also the concrete cost of a shorter
/// window: more of the axis falls into that regime.
fn fill_log_bin_edges(edges: &mut Vec<usize>, sample_rate: f64, window: usize) {
    let n_mag = window / 2 + 1;
    let hz_per_bin = sample_rate / (window as f64);
    let (lo, hi) = (FREQ_LOW.ln(), FREQ_HIGH.ln());
    edges.clear();
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
}
