//! Time stretching that doesn't move the pitch, for playing a file along with a
//! grid at a tempo that isn't the file's own.
//!
//! WSOLA -- overlap-add, with a similarity search picking where each grain is
//! cut from. Chosen over a phase vocoder (which `realfft` would have made just
//! as easy) because most of what gets loaded here is percussive, and a phase
//! vocoder smears transients. Smeared transients are precisely what this app
//! exists to let you see and hear the position of.
//!
//! **Nothing here runs on the audio thread.** The ratio only changes on a
//! config event, so the whole file is re-rendered off-thread and the result is
//! swapped in; the render callback keeps reading a plain buffer at a position
//! derived from the beat, exactly as it does unstretched.

use crate::constants::sample_rate;
use std::f64::consts::PI;

/// Grain length. Long enough to hold a period of anything with pitch worth
/// preserving, short enough that a transient isn't smeared across it.
const WINDOW_MS: f64 = 30.0;

/// How far the similarity search may move a grain from where the ideal
/// (constant-rate) analysis position would put it. This is the whole of what
/// makes WSOLA better than plain overlap-add: it lets consecutive grains land
/// in phase with each other instead of fighting.
const SEARCH_MS: f64 = 10.0;

/// Correlating every other sample. The search is over a ±10 ms window of
/// ordinary audio, not a needle in a haystack, and halving the taps halves the
/// cost of the only expensive part of this.
const CORRELATION_STRIDE: usize = 2;

/// Beyond this the artifacts stop being subtle, so there is no point spending
/// seconds rendering one. The panel warns well before here.
pub const MIN_RATIO: f64 = 0.25;
pub const MAX_RATIO: f64 = 4.0;

/// Interleaved in, interleaved out. `ratio` is how much *longer* the result is:
/// above 1 is slower, below 1 is faster, and the pitch is unchanged either way.
///
/// Both buffers are treated as **circular**, because this file is going to be
/// looped: wrapping the overlap-add across the end is what makes the loop point
/// seamless instead of a fade to silence every cycle.
pub fn wsola(input: &[f32], channels: usize, ratio: f64) -> Vec<f32> {
    let ch = channels.max(1);
    let in_frames = input.len() / ch;
    if !ratio.is_finite() || ratio <= 0.0 || (ratio - 1.0).abs() < 1e-9 {
        return input.to_vec();
    }

    let window = (((WINDOW_MS / 1000.0 * sample_rate()) as usize) / 2) * 2;
    let hop = window / 2;
    let search = (SEARCH_MS / 1000.0 * sample_rate()) as usize;

    // Too short to have grains cut out of it, and too short to have any
    // periodicity for the search to find. A file this small is a click.
    if hop == 0 || in_frames < window + 2 * search {
        return input.to_vec();
    }

    // Rounded to a whole number of hops so the circular overlap-add closes on
    // itself rather than rippling at the seam. The rounding changes the length
    // by at most half a hop, which is *not* a sync error: the read position is
    // a fraction of whatever length the buffer turns out to be, so the file
    // still fits `fileBeats` exactly -- it just plays a hair off the requested
    // rate. See the note in CLAUDE.md.
    let hops = ((in_frames as f64 * ratio) / hop as f64).round().max(2.0) as usize;
    let out_frames = hops * hop;

    // Hann at 50% overlap sums to exactly 1, so no normalisation pass is needed.
    let hann: Vec<f32> = (0..window)
        .map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / window as f64).cos()) as f32)
        .collect();

    // Analysis advances slower than synthesis to stretch, faster to compress.
    let analysis_hop = hop as f64 / ratio;

    let mut out = vec![0.0f32; out_frames * ch];
    let mut ideal = 0.0f64;
    // Where the previous grain's *natural continuation* would have begun. The
    // next grain is chosen to sound like that, which is what keeps successive
    // grains in phase.
    let mut continuation = 0usize;

    for k in 0..hops {
        let target = (ideal as usize) % in_frames;
        let pos = if k == 0 {
            0
        } else {
            best_offset(input, ch, in_frames, continuation, target, search, hop)
        };

        let start = k * hop;
        for i in 0..window {
            let src = (pos + i) % in_frames;
            let dst = (start + i) % out_frames;
            let w = hann[i];
            for c in 0..ch {
                out[dst * ch + c] += input[src * ch + c] * w;
            }
        }

        continuation = (pos + hop) % in_frames;
        ideal += analysis_hop;
    }

    out
}

/// The grain start within ±`search` of `target` whose opening best matches what
/// the previous grain was about to become. Plain cross-correlation rather than
/// a normalised one: over a ±10 ms window the energy barely moves, and the
/// normalisation costs more than it buys.
fn best_offset(
    input: &[f32],
    ch: usize,
    in_frames: usize,
    continuation: usize,
    target: usize,
    search: usize,
    overlap: usize,
) -> usize {
    let mono = |frame: usize| -> f32 {
        let base = (frame % in_frames) * ch;
        let mut sum = 0.0;
        for c in 0..ch {
            sum += input[base + c];
        }
        sum
    };

    let mut best = target;
    let mut best_score = f32::NEG_INFINITY;
    let lo = target as isize - search as isize;
    for d in 0..=(2 * search) {
        let cand = (lo + d as isize).rem_euclid(in_frames as isize) as usize;
        let mut score = 0.0f32;
        let mut i = 0;
        while i < overlap {
            score += mono(continuation + i) * mono(cand + i);
            i += CORRELATION_STRIDE;
        }
        if score > best_score {
            best_score = score;
            best = cand;
        }
    }
    best
}


/// How long the render waits before starting. The frontend pushes a config on
/// every keystroke, so typing "1", "12", "120" into the bpm field is three
/// requests; this lets the first two be superseded before any work is done.
const DEBOUNCE_MS: u64 = 200;

/// What the file wants to be stretched by, given the tempo it is being played
/// against. 1.0 means leave it alone -- which is what an undeclared length, a
/// missing file or the switch being off all come to.
pub fn desired_ratio(config: &crate::structs::Config, natural_frames: usize) -> f64 {
    if !config.file_stretch || config.file_beats <= 0.0 || natural_frames == 0 {
        return 1.0;
    }
    let natural_seconds = natural_frames as f64 / sample_rate();
    let target_seconds = config.file_beats * 60.0 / config.bpm;
    if !(natural_seconds > 0.0) || !(target_seconds > 0.0) || !target_seconds.is_finite() {
        return 1.0;
    }
    (target_seconds / natural_seconds).clamp(MIN_RATIO, MAX_RATIO)
}

/// Asks for the playing buffer to be re-rendered at `ratio`, off-thread. Cheap
/// and idempotent: an unchanged ratio returns immediately, and a superseded
/// request is dropped rather than raced.
pub fn request(app: &tauri::AppHandle, ratio: f64) {
    use tauri::Manager;
    let arc = {
        let state: tauri::State<crate::structs::Mp3BufferState> = app.state();
        state.0.clone()
    };

    let (generation, natural) = {
        let mut mp3 = match arc.lock() {
            Ok(m) => m,
            Err(e) => e.into_inner(),
        };
        if (mp3.ratio - ratio).abs() < 1e-6 || mp3.natural.is_empty() {
            return;
        }
        mp3.generation += 1;
        (mp3.generation, mp3.natural.clone())
    };

    let app = app.clone();
    std::thread::spawn(move || {
        if ratio != 1.0 {
            std::thread::sleep(std::time::Duration::from_millis(DEBOUNCE_MS));
            // Superseded while we waited: someone is still typing.
            if current_generation(&arc) != generation {
                return;
            }
            let _ = app.emit_all("file-stretch", StretchState { stretching: true, ratio });
        }

        // Rendered *outside* the lock, and the old buffer is dropped outside it
        // too: the render callback holds this mutex for its whole run, so
        // anything done inside it is time the audio thread waits. Same rule as
        // the display buffers.
        let next = if ratio == 1.0 {
            (*natural).clone()
        } else {
            wsola(&natural, 2, ratio)
        };

        let old = {
            let mut mp3 = match arc.lock() {
                Ok(m) => m,
                Err(e) => e.into_inner(),
            };
            if mp3.generation != generation {
                return;
            }
            mp3.ratio = ratio;
            Some(std::mem::replace(&mut mp3.buffer, next))
        };
        drop(old);

        let _ = app.emit_all("file-stretch", StretchState { stretching: false, ratio });
    });
}

fn current_generation(arc: &std::sync::Arc<std::sync::Mutex<crate::structs::Mp3Buffer>>) -> u64 {
    match arc.lock() {
        Ok(m) => m.generation,
        Err(e) => e.into_inner().generation,
    }
}

#[derive(Clone, serde::Serialize)]
pub struct StretchState {
    pub stretching: bool,
    pub ratio: f64,
}
