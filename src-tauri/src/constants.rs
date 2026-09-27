use crate::analysis::DEFAULT_WINDOW;
use crate::engine::MAX_BLOCK_FRAMES;
use crate::structs::{Config, DrumVoice, Note, ParserRhythm};
/// What a device that will not say its own rate is assumed to run at. Only a
/// fallback for that one case: the real rate is whatever the input device is
/// running at, and it belongs to the audio setup that is running now -- see
/// `AudioStatus` in `audio_host.rs`.
///
/// There used to be a process-global `sample_rate()` here, a `OnceLock` set
/// once at launch. Two things ended it. The device can change while the app
/// runs (step 3 of `docs/ios-port.md`), so the rate is no longer a property
/// of the process; and a read before audio setup used to *freeze* the 44.1
/// kHz fallback -- the built-in kit decoded ahead of the device made the whole
/// process run at the wrong rate, which AUHAL answers with silence. Now every
/// function that needs a rate takes one as an argument, so nothing *can* read
/// it before audio setup has learned it: there is nothing to read.
pub const DEFAULT_SAMPLE_RATE: f64 = 44100.0;

/// The synthetic buses' channel ids. Fixed, in a range far above any input
/// count, so the drums are the drums whatever device is open -- they used to
/// sit at `inputs + 0/1/2` and so moved whenever the input count did. Must
/// match `BUS_DRUMS` / `BUS_CLICK` / `BUS_FILE` in src/config.ts.
pub const BUS_DRUMS: usize = 1000;
pub const BUS_CLICK: usize = 1001;
pub const BUS_FILE: usize = 1002;

/// Frames of *display* backlog the callback will hold before it stops pushing.
/// Only reachable if the frontend stops draining -- a wedged UI shouldn't be
/// able to grow the buffer without bound, and with it the capacity the next
/// drain reserves. One second, drained in a single poll once the UI recovers.
pub fn max_visual_backlog(sample_rate: f64) -> usize {
    sample_rate as usize
}

/// What a drain leaves behind for the callback to fill, in frames. The callback
/// holds the buffer's lock for its whole run, so it pushes whole blocks between
/// drains -- and a poll can land with no callback since the last one, so the
/// floor cannot lean on the last drain having been a typical size. Two of the
/// *largest* block the engine takes, never of the one the device happens to
/// use: sized from the typical block, a platform that hands over more would put
/// the audio thread back in the allocator. `get_samples` multiplies this by the
/// row width, since a frame is one value per visible channel.
pub const VISUAL_RESERVE_FRAMES: usize = 2 * MAX_BLOCK_FRAMES;

/// The same for the analysis stream, in hops. A hop is 64 frames at the
/// shortest window, so one of the largest blocks is 64 of them; this is four
/// of those without reserving a frame-sized vector for a hop-sized stream.
/// `get_analysis` multiplies it out by `BINS` and `MAX_ANALYSIS_CHANNELS` for
/// the magnitudes, which are that wide per hop.
pub const ANALYSIS_RESERVE_HOPS: usize = 4 * MAX_BLOCK_FRAMES / 64;

/// Onsets are sparse, and the picker cannot report two on one channel closer
/// than its peak radius -- at the shortest window that is a few per channel in
/// one of the largest blocks -- so this is a flat reserve rather than anything
/// derived.
pub const ONSET_RESERVE: usize = 64;

// Every echo needs a whole loop of history behind it, so the buffer grows with
// this. 16 echoes of 4 beats at 91bpm is ~30MB across four channels, which is
// about as far as it's worth going.
pub const MAX_LOOP_ECHOES: usize = 16;

pub fn default_config() -> Config {
    return Config {
        bpm: 91.0,
        beats_to_loop: 4.0,
        loop_echoes: 1.0,
        loop_echo_gain: 1.0,
        audio_in_gain: 1.0,
        high_pass_on: false,
        // Ten times a low guitar string, which is about where a second pole has
        // put the fundamental far enough down to stop dominating the picture.
        high_pass_hz: 800.0,
        high_pass_audio: false,
        bleed_cancel_on: false,
        bleed_track_on: true,
        bleed_cancel_audio_on: false,
        loop_feedback_guard_on: false,
        looping_on: false,
        loop_record_cycle_on: false,
        // One entry, so the plain case is "4 beats off, 4 beats on" -- matching
        // the default loop length, which is what makes a phrase come back
        // exactly during the stretch that isn't recording it.
        loop_record_cycle: vec![4.0],
        click_on: true,
        sections_on: false,
        sections: vec![],
        section_order: vec![],
        click_volume: 0.3,
        click_shift: 0.0,
        drum_on: true,
        play_file: true,
        file_volume: 1.0,
        file_beats: 0.0,
        file_offset_ms: 0.0,
        file_shift: 0.0,
        file_stretch: false,
        file_repeat_on: false,
        file_repeat_start: 0.0,
        file_repeat_end: 4.0,
        visual_monitor_on: true,
        audio_monitor_on: false,
        buffer_compensation: 4330,
        paused: false,
        analysis_on: true,
        analysis_band_low: 30.0,
        analysis_band_high: 16000.0,
        analysis_window: DEFAULT_WINDOW,
        // Measured -- see the note beside `onsetThreshold` in config.ts.
        onset_threshold: 0.4,
        onset_min_gap: 40.0,
        onset_offset: -4.0,
        packed_channels: vec![0],
        channel_pans: vec![],
        audio_subdivisions: ParserRhythm {
            start: 0.0,
            end: 1.0,
            notes: vec![Note { time: 0.0 }, Note { time: 0.5 }],
        },
        drums: vec![DrumVoice {
            path: "ride".to_string(),
            on: true,
            volume: 1.0,
            offset: 0.0,
            shift: 0.0,
            gains: vec![1.0],
            chances: vec![],
            rhythm: ParserRhythm {
                start: 0.0,
                end: 1.0,
                notes: vec![Note { time: 0.0 }, Note { time: 0.5 }],
            },
        }],
        test_object: ParserRhythm {
            start: 0.0,
            end: 0.0,
            notes: vec![],
        },
    };
}

