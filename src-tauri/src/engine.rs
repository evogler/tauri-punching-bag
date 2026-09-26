//! The real-time audio core: everything the render callback does, handed a
//! block of input and a block of output to fill, with no idea what device
//! either came from.
//!
//! > *here are n frames of input (interleaved, `input_channels` wide); fill n
//! > frames of output (two non-interleaved sides, left and right).*
//!
//! This used to be one closure in `main.rs`, owning its state by capture. It
//! is a struct now so the platform half can be swapped: on macOS the input
//! arrives in its own AUHAL callback and reaches this through a queue (see
//! `platform::macos`); on iOS RemoteIO hands input and output over in the
//! *same* callback, so the queue goes away and this is called directly. Both
//! are the same call. Everything that has to happen on every platform -- the
//! pause and not-yet-configured silence, the level meter, the calibration and
//! the bleed measurement taking the callback over -- lives here; only
//! queueing and device specifics live in a backend.
//!
//! Nothing in here may allocate, lock anything the IPC thread can hold for
//! long, or touch the disk. The shared state it reads is the same as it always
//! was: the config behind its mutex, read once per block, and the display
//! buffers locked once per block and only ever pushed into.

use crate::analysis::{Analyzer, OnsetParams, BINS, MAX_ANALYSIS_CHANNELS};
use crate::bleed::{BleedCanceller, BleedTraining, LEAD as BLEED_LEAD, TAPS as BLEED_TAPS, TRAIN_LEVEL};
use crate::calibration::Calibration;
use crate::constants::max_visual_backlog;
use crate::filter::HighPass;
use crate::get_loop_buffer_size::{get_loop_spacing, loop_echo_count};
use crate::loop_guard::LoopGuard;
use crate::recorder::Recorder;
use crate::structs::{
    raise_level, AnalysisFrames, BusDelay, Config, LoopBuffer, Mp3Buffer, SoundingSample,
    VisualSamples,
};
use crate::types::S;
use crate::util::{
    beat_bisect, display_start, mod_add, record_cycle_bounds, recording_at, section_at,
    section_bounds,
};
use rand::Rng;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, AtomicU32},
    sync::{Arc, Mutex},
};

/// Everything the core shares with the rest of the process -- the commands
/// write most of these and the core reads them, or the other way round. The
/// same `Arc`s are handed to Tauri as managed state in `main.rs`; this is only
/// the core's set of handles to them.
#[derive(Clone)]
pub struct EngineShared {
    pub config: Arc<Mutex<Config>>,
    /// Silent until the frontend has pushed a config -- see `ConfigReady`.
    pub config_ready: Arc<AtomicBool>,
    pub reset_beat: Arc<AtomicBool>,
    pub loop_buffer: Arc<Mutex<LoopBuffer>>,
    pub mp3: Arc<Mutex<Mp3Buffer>>,
    pub drum_samples: Arc<Mutex<HashMap<String, Arc<Vec<f32>>>>>,
    pub calibration: Arc<Mutex<Calibration>>,
    pub bleed_training: Arc<Mutex<BleedTraining>>,
    pub bleed_live: Arc<Mutex<(f32, f32)>>,
    pub loop_guard_live: Arc<Mutex<(f32, f32)>>,
    pub input_levels: Arc<Vec<AtomicU32>>,
    pub recorder: Arc<Recorder>,
    pub samples: Arc<Mutex<VisualSamples>>,
    pub analysis: Arc<Mutex<AnalysisFrames>>,
}

/// The render callback's state. Built once, before the device starts, and
/// sized from the input channel count -- which cannot change under it, since a
/// device change builds a new one.
pub struct Engine {
    shared: EngineShared,
    input_channels: usize,
    /// Handed over at construction rather than read from the process-global
    /// `sample_rate()`, so the rate can become per-engine state without this
    /// file changing.
    sample_rate: f64,
    sounding_samples: Vec<SoundingSample>,
    // One entry per drum voice: the subdivision it last fired on, so a hit
    // happens on the crossing rather than every frame. isize::MIN means "not
    // primed yet", which stops a newly added voice firing immediately.
    drum_last_beats: Vec<isize>,
    // Gain per echo, resolved once per callback so the per-frame tap loop isn't
    // raising loop_echo_gain to a power for every frame and channel.
    tap_gains: Vec<f32>,
    // Reused every frame so the audio callback never allocates.
    // Three views of the same instant: what the device gave us, what the
    // picture is drawn from, and what is sounded. They differ only when the
    // high pass is on -- see the filter module.
    input_raw: Vec<f32>,
    input_frame: Vec<f32>,
    input_audio: Vec<f32>,
    loop_visual: Vec<f32>,
    // Reused across callbacks so the section walk never allocates; it only
    // grows when a section is added.
    bounds: Vec<(f64, usize)>,
    // The same, for the looper's record cycle, and reused for the same reason.
    record_bounds: Vec<(f64, bool)>,
    // How many frames have been written to the loop buffer since the cycle last
    // restarted, saturating at its length. Clearing the buffer on a restart
    // would be a multi-megabyte memset on the audio thread; suppressing the
    // taps that would read across the restart is the same thing in O(1).
    loop_written: usize,
    cycle_count: u64,
    // One filter for the live signal and one for the looper's summed echoes.
    // Sized at construction because a device change builds a new engine, so
    // the channel count cannot move under them.
    input_high_pass: Vec<HighPass>,
    loop_high_pass: Vec<HighPass>,
    // One per channel, over the *prediction* rather than the signal. The high
    // pass is linear and time-invariant, so filtering the predicted echo is the
    // same as having predicted from a filtered reference -- which is what lets
    // one prediction serve the picture and the sound when only one of them is
    // filtered.
    pred_high_pass: Vec<HighPass>,
    // The drums and the click are generated here rather than captured, so they
    // have to be held back to land on the same visual beat as the input.
    bus_delay: BusDelay,
    // The FFT planner and its scratch space are built here, once, so the
    // callback only ever runs the transform.
    analyzer: Analyzer,
    click_sound_counter: i32,
    // Learns the speaker -> microphone response from the click and subtracts
    // the app's own output back out of the picture. See `bleed.rs`.
    bleed_cancel: BleedCanceller,
    // One per channel, like the high passes: each holds its own filter states.
    loop_guard: Vec<LoopGuard>,
    // Peak input per channel, for the setup's microphone check. Accumulated in
    // a local per frame and published to the atomics once per callback, so the
    // frame loop never touches shared state for it.
    input_peaks: Vec<f32>,
    rng: rand::rngs::ThreadRng,
    beat: f64,
    // The subdivision *before* the first, so a click written on beat 0 sounds
    // at launch. At 0 it equalled `beat_bisect`'s answer for beat 0 and the
    // first click was swallowed -- the same bug as the drums' first-sighting
    // seeding, and inaudible for the same reason: Rust used to be sounding its
    // own defaults by the time anyone's real config arrived. Unlike a drum
    // voice the click is never added mid-phrase, so there is no case this
    // fires spuriously.
    last_beat: isize,
}

impl Engine {
    pub fn new(shared: EngineShared, input_channels: usize, sample_rate: f64) -> Self {
        Engine {
            shared,
            input_channels,
            sample_rate,
            sounding_samples: vec![],
            drum_last_beats: vec![],
            tap_gains: vec![],
            input_raw: vec![0f32; input_channels],
            input_frame: vec![0f32; input_channels],
            input_audio: vec![0f32; input_channels],
            loop_visual: vec![0f32; input_channels],
            bounds: Vec::new(),
            record_bounds: Vec::new(),
            loop_written: 0,
            cycle_count: 0,
            input_high_pass: (0..input_channels).map(|_| HighPass::new()).collect(),
            loop_high_pass: (0..input_channels).map(|_| HighPass::new()).collect(),
            pred_high_pass: (0..input_channels).map(|_| HighPass::new()).collect(),
            bus_delay: BusDelay::new(),
            analyzer: Analyzer::new(sample_rate),
            click_sound_counter: 0,
            bleed_cancel: BleedCanceller::new(input_channels, BLEED_TAPS),
            loop_guard: (0..input_channels).map(|_| LoopGuard::new(sample_rate)).collect(),
            input_peaks: vec![0f32; input_channels],
            rng: rand::thread_rng(),
            beat: 0.0,
            last_beat: -1,
        }
    }

    pub fn input_channels(&self) -> usize {
        self.input_channels
    }

    /// One block. `input` is `n` frames interleaved, `input_channels` wide;
    /// `output` is the two sides of the stereo out, each `n` long, and every
    /// sample of both is written. `n` is whatever the platform handed over.
    pub fn process(&mut self, input: &[S], output: [&mut [S]; 2]) {
        let mut output = output;
        let n = output[0].len();
        let c_in = self.input_channels;
        debug_assert_eq!(output[1].len(), n);
        debug_assert_eq!(input.len(), n * c_in);
        let Engine {
            shared,
            input_channels: _,
            sample_rate,
            sounding_samples,
            drum_last_beats,
            tap_gains,
            input_raw,
            input_frame,
            input_audio,
            loop_visual,
            bounds,
            record_bounds,
            loop_written,
            cycle_count,
            input_high_pass,
            loop_high_pass,
            pred_high_pass,
            bus_delay,
            analyzer,
            click_sound_counter,
            bleed_cancel,
            loop_guard,
            input_peaks,
            rng,
            beat,
            last_beat,
        } = self;
        let sample_rate = *sample_rate;
        let visual_backlog_cap = max_visual_backlog(sample_rate);

        let config = shared.config.lock().unwrap();
        let mut loop_buffer = shared.loop_buffer.lock().unwrap();
        let beats_per_sample: f64 = config.bpm / sample_rate / 60f64;
        let mut mp3 = shared.mp3.lock().unwrap();

        if shared.reset_beat.load(std::sync::atomic::Ordering::Relaxed) {
            *beat = 0.0;
            mp3.pos = 0.0;
            // The cuts describe a room at a volume; nothing recorded before the
            // restart is going to play back, so they describe nothing.
            loop_guard.iter_mut().for_each(|g| g.reset());
            // A window stitched across the jump is a spectral edge nobody
            // played, and it would read as a phantom transient.
            analyzer.reset();
            shared.reset_beat.store(false, std::sync::atomic::Ordering::Relaxed);
        }

        // Ahead of the pause check, unlike the calibration below it: this is
        // measuring the speaker and the room, which have nothing to do with
        // whether the transport is running. Paused, the run would otherwise sit
        // at 0% forever with nothing saying why.
        //
        // Measuring the bleed takes the callback over for the same reason, and
        // one more: anything *you* play during the run is a near-end signal the
        // filter would try to explain away, which is the exact failure that
        // made continuous adaptation unusable. Two and a half seconds of
        // silence is what buys an estimate worth trusting.
        {
            let mut train = shared.bleed_training.lock().unwrap();
            if train.active {
                if train.just_started {
                    train.just_started = false;
                    bleed_cancel.clear();
                }
                analyzer.reset();
                // Normally done further down, which this path returns before.
                bus_delay.resize(config.buffer_compensation);
                for i in 0..n {
                    // Exactly the order the runtime path uses -- peek, push the
                    // canceller, and only then push this frame's output into
                    // the delay. Measuring through the same path the runtime
                    // infers through means the alignment cannot disagree
                    // between them, which is the one error that would be
                    // invisible and fatal.
                    let emitted = {
                        let [d, c, f, l] = bus_delay.peek_lead(BLEED_LEAD);
                        d + c + f + l
                    };
                    bleed_cancel.push(emitted);
                    // Every channel. Draining the input is the backend's job
                    // and it has already been done for this block -- see
                    // `platform::macos` -- so nothing here can leave a queue
                    // growing.
                    for ch in 0..c_in {
                        let sample = input[i * c_in + ch];
                        let residual = bleed_cancel.train(ch, sample);
                        train.observe(sample, residual);
                    }
                    // Full-band noise, not the calibration's 500-8000 Hz sweep:
                    // the click this has to cancel is white, and a chirp
                    // measures nothing outside its own band.
                    let probe = (rng.gen::<f32>() * 2.0 - 1.0) * TRAIN_LEVEL;
                    bus_delay.push([probe, 0.0, 0.0, 0.0]);
                    for channel in output.iter_mut() {
                        channel[i] = probe;
                    }
                    train.step();
                }
                if train.finished {
                    // The probe went through here as a bus; without this it
                    // replays into the drums trace for a whole compensation.
                    bus_delay.clear();
                    // A run that could not clear its own gates leaves the
                    // filter switched out rather than installed and wrong.
                    // Asked as a bool, not as a `BleedResult`: that one carries
                    // a message, and formatting it would allocate here. The
                    // command builds it, and clears `finished` when it has.
                    if train.passed() {
                        bleed_cancel.mark_trained();
                    }
                }
                return;
            }
        }

        // The previous callback's input peaks, published here rather than at
        // the end of the frame loop so every path below -- including the early
        // returns -- goes through it once. A callback late, which a meter
        // polled ten times a second cannot see.
        for (ch, peak) in input_peaks.iter_mut().enumerate() {
            raise_level(&shared.input_levels, ch, *peak);
            *peak = 0.0;
        }

        // Paused freezes everything that moves -- the beat, the file position, the
        // loop buffer -- so resuming picks up exactly where it stopped, and no
        // visual samples are produced so the display holds still.
        //
        // The input still arrives, and is still consumed: the backend hands
        // over a block whatever state the transport is in, which on macOS is
        // what keeps the input queue from growing through a pause and then
        // playing back a pause-length backlog of stale audio on resume.
        // Silent until the frontend has spoken. Rust's `default_config()` is not
        // anybody's saved settings, so sounding it while the window comes up is
        // a beat of the wrong thing on every launch. Treated exactly as a pause
        // rather than as its own path: the input still has to be drained, the
        // levels still have to be metered for the setup wizard's microphone
        // check, and the beat has to stay at zero so the first cycle starts on
        // one. If the webview never loads, the app stays silent -- which is the
        // right way round, since the alternative is playing settings nobody
        // chose.
        let ready = shared.config_ready.load(std::sync::atomic::Ordering::Relaxed);
        if config.paused || !ready {
            // Same reason as the beat reset: the frames either side of a pause
            // aren't adjacent, so the history can't carry across it.
            analyzer.reset();
            // Measured on the way out, so the setup's microphone check works
            // whether or not the transport is running. The block has already
            // been taken off the backend's queue, so this is the whole of what
            // the pause does with it.
            for ch in 0..c_in {
                let mut peak = 0f32;
                for i in 0..n {
                    peak = peak.max((input[i * c_in + ch] * config.audio_in_gain).abs());
                }
                raise_level(&shared.input_levels, ch, peak);
            }
            for i in 0..n {
                for channel in output.iter_mut() {
                    channel[i] = 0.0;
                }
            }
            return;
        }

        // Calibration takes the callback over completely. It is measuring how
        // long the app's own sound takes to come back, so it has to be the only
        // thing making sound -- drums, the looper or the monitor mixed in would
        // all correlate against the probe. Locked once here, like the display
        // buffers, never per frame.
        {
            let mut cal = shared.calibration.lock().unwrap();
            if cal.active {
                // The frames either side of a calibration run aren't adjacent
                // to what came before, same as a pause.
                analyzer.reset();
                for i in 0..n {
                    // Only the channel being measured is read. The others
                    // were drained by the backend with the rest of the block,
                    // which is what used to have to be done here by hand.
                    let measured = if cal.channel < c_in {
                        input[i * c_in + cal.channel]
                    } else {
                        0.0
                    };
                    let probe = cal.step(measured);
                    for channel in output.iter_mut() {
                        channel[i] = probe;
                    }
                }
                return;
            }
        }

        // Resolved once per callback. Building these per frame -- as the click
        // rhythm used to be -- meant tens of thousands of allocations a second
        // on the audio thread.
        let mut click_times: Vec<f64> = config
            .audio_subdivisions
            .notes
            .iter()
            .map(|n| n.time)
            .collect();
        click_times.push(config.audio_subdivisions.end);

        // Centre stays (1, 1) rather than the usual constant-power (0.707,
        // 0.707), so turning panning on doesn't quietly drop every existing
        // setup by 3dB. Panning attenuates the far side instead of boosting the
        // near one.
        let pan_gains: Vec<(S, S)> = (0..input_frame.len())
            .map(|ch| {
                let pan = config.channel_pans.get(ch).copied().unwrap_or(0.0) as S;
                ((1.0 - pan).clamp(0.0, 1.0), (1.0 + pan).clamp(0.0, 1.0))
            })
            .collect();

        let mut voice_times: Vec<Vec<f64>> = Vec::with_capacity(config.drums.len());
        let mut voice_samples: Vec<Option<Arc<Vec<f32>>>> = Vec::with_capacity(config.drums.len());
        {
            let map = shared.drum_samples.lock().unwrap();
            for voice in config.drums.iter() {
                let mut times: Vec<f64> = voice.rhythm.notes.iter().map(|n| n.time).collect();
                times.push(voice.rhythm.end);
                voice_times.push(times);
                voice_samples.push(map.get(&voice.path).cloned());
            }
        }
        // Growing keeps the existing voices primed, so adding one doesn't
        // retrigger the others.
        drum_last_beats.resize(config.drums.len(), isize::MIN);
        bus_delay.resize(config.buffer_compensation);

        // The practice cycle: count-off, groove, pause, whatever is in the
        // list. Resolved once per callback like everything else the frame loop
        // needs.
        let cycle_beats =
            section_bounds(&config.sections, &config.section_order, bounds);
        let sections_on = config.sections_on && cycle_beats > 0.0;
        let display_start = display_start(&config.sections, &bounds, sections_on);

        // Coefficients once per callback, never per frame -- and hoisted here
        // for the same reason the pan gains are.
        let high_pass_on = config.high_pass_on;
        // Only meaningful with the filter on at all, so it is folded in once
        // rather than checked twice in the frame loop.
        let high_pass_audio = high_pass_on && config.high_pass_audio;
        // The buffer holds whatever is *sounded*, so when the audio is left dry
        // the picture's echoes have to be filtered on the way out instead.
        let high_pass_echoes = high_pass_on && !config.high_pass_audio;
        let bleed_cancel_on = config.bleed_cancel_on && bleed_cancel.trained();
        let bleed_audio_on = config.bleed_cancel_audio_on && bleed_cancel.trained();
        let bleed_any_on = bleed_cancel_on || bleed_audio_on;
        let bleed_track_on = bleed_any_on && config.bleed_track_on;
        // Once per callback, like everything else that leaves the audio thread.
        *shared.bleed_live.lock().unwrap() = bleed_cancel.tracking_report();
        let loop_guard_on = config.loop_feedback_guard_on;
        *shared.loop_guard_live.lock().unwrap() = if loop_guard_on {
            loop_guard.first().map_or((0.0, 0.0), |g| g.worst())
        } else {
            (0.0, 0.0)
        };
        for hp in input_high_pass
            .iter_mut()
            .chain(loop_high_pass.iter_mut())
            .chain(pred_high_pass.iter_mut())
        {
            hp.set_cutoff(config.high_pass_hz, sample_rate);
        }

        // Resolved once per callback like everything else the frame loop needs.
        // The buffer is already interleaved stereo at the device rate, so a
        // frame is two values and no conversion happens down here.
        let file_frames = mp3.frames();
        let file_on = file_frames > 0 && config.play_file;
        let file_gain = config.file_volume as S;
        // Positive is *earlier*, i.e. further into the file, matching a drum
        // voice's offset.
        let file_offset_frames = config.file_offset_ms / 1000.0 * sample_rate;
        // The segment to cycle over, in the file's own beats. Off -- or asked
        // for backwards, or with no length in beats to measure against -- it is
        // the whole file, which is the same arithmetic with different numbers.
        let repeat_len = config.file_repeat_end - config.file_repeat_start;
        let (file_from, file_cycle) =
            if config.file_repeat_on && repeat_len > 0.0 && repeat_len.is_finite() {
                (config.file_repeat_start, repeat_len)
            } else {
                (0.0, config.file_beats)
            };
        // Capped because a 16-input interface would otherwise cost 16 FFTs a
        // hop to look at one channel. Zero when analysis is off, which drops
        // the ring and stops any work happening at all.
        let analysis_channels = if config.analysis_on {
            input_frame.len().min(MAX_ANALYSIS_CHANNELS)
        } else {
            0
        };
        // Channels and window together: both invalidate the history, and
        // neither reallocates unless the channel count moved.
        analyzer.configure(analysis_channels, config.analysis_window);
        // Hz to a range of bin groups once per callback, not once per hop: the
        // band only moves when the config does.
        let flux_band = analyzer.band_groups(config.analysis_band_low, config.analysis_band_high);
        // Milliseconds to frames once per callback, for the same reason.
        let onset_params = OnsetParams {
            threshold: config.onset_threshold.max(0.0) as f32,
            min_gap_frames: (config.onset_min_gap.max(0.0) / 1000.0 * sample_rate) as usize,
            offset_frames: config.onset_offset / 1000.0 * sample_rate,
        };

        // Whether the transport is still sitting on beat 0 as this callback
        // begins -- true on the first callback after launch, after `reset_beat`
        // and after a practice-cycle wrap, since `beat` only leaves 0 by
        // accumulating. It is what tells a voice being seen for the first time
        // apart from a voice that has simply not moved yet; see the seeding
        // below.
        let at_transport_start = *beat == 0.0;
        let loop_spacing = get_loop_spacing(&config);
        // Once per callback, next to the tap gains: the cycle only moves when
        // the config does, and the frame loop just asks which phase it is in.
        let record_cycle_on = config.loop_record_cycle_on;
        let record_cycle = record_cycle_bounds(&config.loop_record_cycle, record_bounds);
        tap_gains.resize(loop_echo_count(&config), 0.0);
        {
            let feedback = config.loop_echo_gain.clamp(0.0, 1.0) as f32;
            let mut gain = 1.0f32;
            for tap in tap_gains.iter_mut() {
                *tap = gain;
                gain *= feedback;
            }
        }

        // Locked once per callback, like the display buffers, and only while a
        // recording is actually running: not recording costs one relaxed load.
        // Below the pause and calibration returns on purpose -- neither sounds
        // anything, so neither has anything to record.
        let mut recording = if shared.recorder.armed() {
            Some(shared.recorder.lock_buffer())
        } else {
            None
        };

        // Locked once per callback alongside the sample buffer, so the frame
        // loop only ever pushes into it.
        let mut analysis_out = if analysis_channels > 0 {
            shared.analysis.lock().ok()
        } else {
            None
        };
        if let Some(frames) = analysis_out.as_deref_mut() {
            // The channel count is the row width of the flattened mags, so
            // anything collected under the old one can't be read as the new.
            if frames.channels != analysis_channels || frames.bins != BINS {
                frames.channels = analysis_channels;
                frames.bins = BINS;
                frames.beats.clear();
                frames.mags.clear();
                frames.flux.clear();
                frames.onsets.clear();
            }
        }

        if let Ok(mut state_vec) = shared.samples.lock() {
            // Changing which channels are shown changes the row width of the
            // flattened stream, so anything collected under the old width has to
            // go rather than be misread as the new one.
            if state_vec.channels != config.visible_channels.len() {
                state_vec.channels = config.visible_channels.len();
                state_vec.beats.clear();
                state_vec.values.clear();
            }

            for i in 0..n {
                // The cycle wraps: start the whole thing again. Time really
                // restarts rather than counting on -- there is nothing to be
                // learned from being at beat 7004, and resetting is what puts
                // the drums, the file and the display cursor back on one.
                //
                // The reroll cannot happen here: parameters live in the
                // frontend, which is told by way of `cycle` on the sample
                // stream. That lands a few milliseconds into the new cycle, so
                // the count-off's *first* click sounds at the restart and every
                // interval after it is at the new tempo -- which is the part
                // that carries the tempo.
                if sections_on && *beat >= cycle_beats {
                    *beat = 0.0;
                    mp3.pos = 0.0;
                    // A window stitched across the jump is a spectral edge
                    // nobody played, the same as at a manual reset.
                    analyzer.reset();
                    // Nothing recorded before the restart may be played back:
                    // it was at the old tempo, against a different bar.
                    *loop_written = 0;
                    loop_buffer.pos = 0;
                    *cycle_count += 1;
                    state_vec.cycle = *cycle_count;
                }
                let section = if sections_on {
                    section_at(&bounds, *beat, cycle_beats)
                } else {
                    None
                };
                // Nothing is gated when sections are off, which is what the app
                // did before they existed.
                let click_here = !sections_on
                    || section.map_or(false, |i| config.sections[i].click);

                // One sample per input channel, then a mono sum of them for
                // everything downstream that still works on a single signal --
                // the monitor and the looper. For one channel this is exactly
                // what the old code did.
                // Summed per output side rather than into one mono value, which
                // is what lets a channel sit anywhere in the stereo field.
                // What the speaker emitted `buffer_compensation` frames ago,
                // which is exactly what the microphone is handing us the echo
                // of now -- that compensation *is* the measured round trip.
                // Peeked rather than pushed, because this frame's buses are
                // synthesised further down.
                //
                // The three synthesised buses and not the output channel,
                // deliberately: the output also carries the *monitor*, which
                // is your own live playing on its way to the speaker, and
                // subtracting that would take you out of your own trace. The
                // looper is in it because its return is a genuine echo of the
                // speaker, and on a laptop it is the one that feeds back.
                //
                // Raw, in the domain the probe was measured in. The high pass
                // is applied to the *prediction* instead -- see the channel
                // loop -- because only then can one prediction serve both the
                // picture and the sound.
                let emitted = {
                    let [d, c, f, l] = bus_delay.peek_lead(BLEED_LEAD);
                    d + c + f + l
                };
                // Pushed whether or not it is switched on, so the history is
                // never stale when it is.
                bleed_cancel.push(emitted);

                let mut monitor_out: [S; 2] = [0.0, 0.0];
                for ch in 0..input_frame.len() {
                    let raw = input[i * c_in + ch] * config.audio_in_gain;
                    // Run whether or not it is switched on, so the state can
                    // never be stale: turning the filter on mid-phrase would
                    // otherwise start it from silence and put a step into both
                    // the picture and, if the audio is following, the sound.
                    let filtered = input_high_pass[ch].process(raw);
                    input_raw[ch] = raw;
                    input_peaks[ch] = input_peaks[ch].max(raw.abs());

                    // Subtract the speaker's own output back out, sample by
                    // sample and phase-accurate, leaving whatever was played
                    // underneath it standing. Predicted once, then filtered to
                    // match whichever signal it is about to come off -- the
                    // filter is LTI, so H(h*d) = h*H(d) and the same prediction
                    // is correct in both domains. Run unconditionally, like the
                    // other filters, so its state is never stale.
                    let predicted = bleed_cancel.predict(ch);
                    let predicted_hp = pred_high_pass[ch].process(predicted);
                    if bleed_any_on {
                        bleed_cancel.track(
                            ch,
                            raw,
                            predicted,
                            config.audio_in_gain,
                            bleed_track_on,
                        );
                    }
                    let echo_drawn =
                        (if high_pass_on { predicted_hp } else { predicted }) * config.audio_in_gain;
                    let echo_heard = (if high_pass_audio { predicted_hp } else { predicted })
                        * config.audio_in_gain;

                    input_frame[ch] = if high_pass_on { filtered } else { raw };
                    if bleed_cancel_on {
                        input_frame[ch] -= echo_drawn;
                    }
                    // `input_raw` is deliberately left alone either way: the
                    // analyzer measures what the microphone actually heard.
                    let mut audio = if high_pass_audio { filtered } else { raw };
                    if bleed_audio_on {
                        audio -= echo_heard;
                    }
                    input_audio[ch] = audio;
                    let (left, right) = pan_gains[ch];
                    monitor_out[0] += audio * left;
                    monitor_out[1] += audio * right;
                }

                let visual_beat = *beat - (config.buffer_compensation as f64) * beats_per_sample;
                // Asked of the *visual* beat, not of `beat`: the stream is
                // stamped in input time, so what matters is which section the
                // audio being drawn was played in. It also means the tail of a
                // hidden last section swallows the negative stamps for the
                // first `buffer_compensation` frames after a restart.
                let drawn = !sections_on
                    || section_at(&bounds, visual_beat, cycle_beats)
                        .map_or(false, |i| config.sections[i].show);
                let stamp = visual_beat - display_start;

                // Per frame, not per output channel -- this advances the ring.
                if let Some(frames) = analysis_out.as_deref_mut() {
                    // Deliberately the raw signal: the flux has its own band
                    // limits in `analysisBandLow`/`analysisBandHigh`, done
                    // properly in the frequency domain, and filtering twice
                    // would make its normalisation describe something else.
                    if analyzer.push(&input_raw) {
                        // The analysis always runs, even for a hidden section:
                        // its spectrum differencing is a running state, and
                        // skipping a hop would leave the next one measured
                        // against a window that never happened. What a hidden
                        // section drops is the *output*, truncated back below --
                        // which sets a length and never touches the allocator.
                        let kept = (
                            frames.beats.len(),
                            frames.mags.len(),
                            frames.flux.len(),
                            frames.onsets.len(),
                        );
                        // The hop that just completed describes the window
                        // centred half a window behind this frame, so its stamp
                        // is this frame's visual beat less that half window --
                        // read from the analyzer, since the window is a
                        // setting. Stamping it here instead would draw every
                        // column a half window late, which is ~92 pixels at
                        // 0.25x16 and 140bpm with the default 1024, and reads
                        // as the FFT being wrong rather than the stamp.
                        let hop_beat =
                            stamp - (analyzer.window_len() as f64 / 2.0) * beats_per_sample;
                        frames.beats.push(hop_beat);
                        analyzer.note_hop_beat(hop_beat);
                        for ch in 0..analyzer.channels() {
                            let flux = analyzer.analyze_into(ch, &mut frames.mags, flux_band);
                            frames.flux.push(flux);
                            // Decides the hop a few back, not this one, and
                            // stamps it with that hop's own beat.
                            analyzer.pick_onset(
                                ch,
                                flux,
                                beats_per_sample,
                                onset_params,
                                &mut frames.onsets,
                            );
                        }
                        // The onsets go with it: the picker runs a few hops
                        // behind, so the ones emitted at the top of a drawn
                        // section describe the hidden one before it.
                        if !drawn {
                            frames.beats.truncate(kept.0);
                            frames.mags.truncate(kept.1);
                            frames.flux.truncate(kept.2);
                            frames.onsets.truncate(kept.3);
                        }
                        analyzer.advance_hop();
                    }
                }
                // The loop is read and written once per frame, per channel --
                // not inside the output loop, which would advance the position
                // once per *output* channel and mix every input into one track.
                //
                // `loop_out` is the panned stereo feed; `loop_visual` is kept
                // per channel so each one shows only its own take.
                let mut loop_out: [S; 2] = [0.0, 0.0];
                // Which phase of the record cycle this frame falls in. Asked of
                // the *visual* beat and not of `beat`, because what is about to
                // be written is what was played `buffer_compensation` frames
                // ago: gating on the output clock would record a window ~98 ms
                // off from the beats it names, which is most of a 16th.
                let loop_recording = !record_cycle_on
                    || recording_at(&record_bounds, visual_beat, record_cycle);
                let loop_len = loop_buffer.channels.first().map_or(0, |c| c.len());
                if loop_len > 0 {
                    let p = loop_buffer.pos;
                    // Where the audio taps are read from: shifted by the
                    // compensation so a phrase comes back a whole
                    // `beats_to_loop` after it was *played*, not after it
                    // reached us. The visual taps read from `p` itself, since
                    // the sample stream is already stamped in input time.
                    let audio_from = mod_add(p, config.buffer_compensation, loop_len);
                    for ch in 0..loop_buffer.channels.len() {
                        if config.looping_on {
                            // Each echo is one spacing further back down the
                            // history, at full volume unless loop_echo_gain fades
                            // the run. The taps are finite, so a phrase is gone
                            // the moment it falls off the last one -- and
                            // nothing accumulates the way a recursive feedback
                            // loop does.
                            let buf = &loop_buffer.channels[ch];
                            let mut visual_sum = 0f32;
                            let mut audio_sum = 0f32;
                            for (k, gain) in tap_gains.iter().enumerate() {
                                // Taken mod the buffer for the callback or two
                                // where config has changed but the buffer hasn't
                                // been resized yet: the taps alias briefly
                                // rather than indexing past the end.
                                let back = ((k + 1) * loop_spacing) % loop_len;
                                let v_at = (p + loop_len - back) % loop_len;
                                let a_at = (audio_from + loop_len - back) % loop_len;
                                // How far back each tap actually reads, which
                                // the audio side's compensation offset makes
                                // different from `back`. Anything older than the
                                // restart is silence rather than a phrase played
                                // at the previous tempo.
                                if (p + loop_len - v_at) % loop_len <= *loop_written {
                                    visual_sum += buf[v_at] * gain;
                                }
                                if (p + loop_len - a_at) % loop_len <= *loop_written {
                                    audio_sum += buf[a_at] * gain;
                                }
                            }
                            loop_visual[ch] = visual_sum;
                            // Measured before the correction and corrected
                            // after, which is what lets it settle -- see
                            // `process`. Run whether or not it is switched on,
                            // like the filters: a band comparison started cold
                            // would take three seconds to say anything.
                            let guarded = loop_guard[ch].process(audio_sum);
                            let audio_sum = if loop_guard_on { guarded } else { audio_sum };
                            let (left, right) = pan_gains[ch];
                            loop_out[0] += audio_sum * left;
                            loop_out[1] += audio_sum * right;
                            // A plain history -- every repeat comes from a tap,
                            // so nothing is mixed back in here.
                            //
                            // A record cycle gates the *write*, never the read:
                            // stopping the write is what lets a phrase come
                            // back while you play over it instead of recording
                            // over it. The gap is written as silence rather
                            // than skipped, because the position is reused
                            // every `loop_len` frames -- leaving it means the
                            // taps replay whatever was there a whole buffer
                            // ago, a phrase that never stops coming back, which
                            // is exactly the recursive-feedback looper this one
                            // was deliberately not built as. `loop_written`
                            // needs nothing: every position is still written
                            // every frame, so "this far back is post-restart"
                            // still holds.
                            loop_buffer.channels[ch][p] = if loop_recording {
                                input_audio.get(ch).copied().unwrap_or(0.0)
                            } else {
                                0.0
                            };
                        } else {
                            loop_visual[ch] = 0.0;
                            loop_buffer.channels[ch][p] = 0.0;
                        }
                        // Filtering the summed echoes is *exactly* equivalent to
                        // having filtered them before they were stored: the
                        // filter is linear and time-invariant and the taps are
                        // plain delays, so H(sum g*x[n-d]) = sum g*(Hx)[n-d].
                        // That equivalence is what lets the buffer hold the
                        // sounded signal while the picture still shows the
                        // filtered one. Run unconditionally, like the live
                        // filter and for the same reason.
                        let echoes = loop_high_pass[ch].process(loop_visual[ch]);
                        if high_pass_echoes {
                            loop_visual[ch] = echoes;
                        }
                    }
                    loop_buffer.pos = (p + 1) % loop_len;
                    *loop_written = (*loop_written + 1).min(loop_len);
                }

                // Triggers, once per frame rather than once per output channel.
                // Subtracting the shift reads the rhythm from earlier in the
                // cycle, so a positive shift moves the click later -- the same
                // sign and the same mechanism as a drum voice's.
                let click_beat = beat_bisect(&click_times, *beat - config.click_shift);
                if click_beat != *last_beat {
                    *click_sound_counter = if config.audio_subdivisions.notes.len() < 2
                        || (click_beat % (config.audio_subdivisions.notes.len() as isize) == 0)
                    {
                        400
                    } else {
                        100
                    };
                    *last_beat = click_beat;
                }

                for v in 0..config.drums.len() {
                    let voice = &config.drums[v];
                    if !voice.on {
                        continue;
                    }
                    if let Some(sample) = &voice_samples[v] {
                        // Looking ahead by the offset is what starts the sample
                        // early: its transient then lands on the beat instead of
                        // however far into the file it happens to sit.
                        let offset_beats = voice.offset / 1000.0 * config.bpm / 60.0;
                        // Subtracting the shift reads the rhythm from earlier in
                        // the cycle, which is what puts the part later. Negative
                        // beats are fine -- beat_bisect floors into the cycle.
                        let hit = beat_bisect(&voice_times[v], *beat + offset_beats - voice.shift);
                        // A voice seen for the first time records where the
                        // beat already is rather than firing, so adding a part
                        // half way through a phrase doesn't sound it instantly.
                        // At the *start* of the transport that rule is wrong:
                        // nothing has been missed, and a hit written on beat 0
                        // is one you asked to hear. Seeding one hit earlier
                        // makes the comparison below fire it. This was
                        // inaudible while Rust sounded its own defaults during
                        // launch -- the drums were already mid-phrase by the
                        // time the saved config arrived.
                        if drum_last_beats[v] == isize::MIN {
                            drum_last_beats[v] = if at_transport_start { hit - 1 } else { hit };
                        }
                        if hit != drum_last_beats[v] {
                            // Indexed by hit rather than by position in the
                            // cycle, so a list that doesn't divide evenly into
                            // the rhythm keeps drifting instead of resetting
                            // every bar. rem_euclid because a shift ahead of the
                            // launch beat makes `hit` negative for a moment.
                            let gain = if voice.gains.is_empty() {
                                1.0
                            } else {
                                voice.gains[hit.rem_euclid(voice.gains.len() as isize) as usize]
                            };
                            // Rolled here, at the trigger, which is
                            // `offset_beats` ahead of where the hit sounds --
                            // still exactly once per hit. A lost roll only
                            // silences the sample: `drum_last_beats` advances
                            // below either way, so the hit keeps its slot and
                            // `chances` stays in phase with `gains`.
                            //
                            // `gen` is half-open on [0,1), so the comparison is
                            // its own clamp: 1 or more always passes, 0 or less
                            // never does, and a non-finite chance fails it and
                            // stays silent.
                            let rolled = voice.chances.is_empty()
                                || (rng.gen::<f64>()
                                    < voice.chances[hit
                                        .rem_euclid(voice.chances.len() as isize)
                                        as usize]);
                            // Gated at the trigger, not at the mix: a hit that
                            // started just before the toggle boundary rings out
                            // instead of being chopped off mid-sample. The beat
                            // is still recorded, so coming back doesn't fire a
                            // burst for everything missed.
                            //
                            // Asked about the section this hit will *sound* in
                            // rather than the one the trigger fires in: the
                            // offset fires it `offset_beats` early, so testing
                            // the trigger instant sounded the note at the top of
                            // a silent section and dropped the one at the top of
                            // a sounding section -- exactly the wrong two.
                            let sounds_here = !sections_on
                                || section_at(&bounds, *beat + offset_beats, cycle_beats)
                                    .map_or(false, |i| config.sections[i].drums.contains(&v));
                            if sounds_here && rolled {
                                sounding_samples.push(SoundingSample {
                                    sample: sample.clone(),
                                    pos: 0,
                                    volume: (voice.volume * gain) as f32,
                                });
                            }
                            drum_last_beats[v] = hit;
                        }
                    }
                }

                // The read position is *derived* from the beat rather than
                // accumulated, and that is the whole of the drift fix. An
                // independent counter and the beat clock only ever agree by
                // coincidence: any mismatch between the file's length and its
                // length in beats -- a bounce a few samples long, a tempo that
                // isn't exactly the file's -- used to add up, one wrap at a
                // time, without bound. Recomputing from `beat` means the worst
                // case is a sub-sample rounding rather than a running sum.
                let mut file_frame = [0.0 as S; 2];
                if file_on {
                    let pos = if config.file_beats > 0.0 {
                        // Where in the segment we are, then where that is in the
                        // file. The second wrap is what lets a segment cross the
                        // file's end -- 14..18 of a 16-beat file is the last two
                        // beats and then the first two, which is how you loop a
                        // pickup.
                        let phase = (*beat - config.file_shift).rem_euclid(file_cycle);
                        let file_beat = (file_from + phase).rem_euclid(config.file_beats);
                        file_beat / config.file_beats * file_frames as f64
                    } else {
                        // Length undeclared: free-run at the file's natural
                        // rate, locked to nothing. Advanced once per *frame*
                        // below, not once per output channel, which is what
                        // made a mono file play an octave high.
                        mp3.pos
                    };
                    let pos = (pos + file_offset_frames).rem_euclid(file_frames as f64);
                    // rem_euclid can land on the modulus itself once rounded.
                    let i0 = (pos.floor() as usize).min(file_frames - 1);
                    let frac = (pos - i0 as f64) as S;
                    let i1 = (i0 + 1) % file_frames;
                    for side in 0..2 {
                        let a = mp3.buffer[i0 * 2 + side];
                        let b = mp3.buffer[i1 * 2 + side];
                        // Interpolated because a declared length that isn't the
                        // file's natural one is a varispeed. At the natural rate
                        // `frac` is 0 and this is an exact sample read.
                        file_frame[side] = a + (b - a) * frac;
                    }
                    mp3.pos = (mp3.pos + 1.0) % file_frames as f64;
                }
                // Mono sum, at the gain it sounded at, so the file can be shown
                // as its own channel against what you played.
                let file_bus: S = (file_frame[0] + file_frame[1]) * 0.5 * file_gain;

                // What the drums and the click put out this frame, kept so the
                // display can show them as their own channels -- which is how
                // you line a sample's offset up against the grid by eye. Both
                // follow the audio: muted means nothing to show.
                let mut drum_frame: S = 0.0;
                let mut click_frame: S = 0.0;

                // What the speaker is about to get, kept so the recorder can
                // write it. Filled as each side is finished rather than summed
                // again afterwards, so the file holds exactly what was played.
                let mut out_frame: [S; 2] = [0.0, 0.0];
                for (ch, channel) in output.iter_mut().enumerate() {
                    // Output is stereo; anything beyond that takes the right side.
                    let side = ch.min(1);
                    let mut audio_out = 0.0;
                    if config.audio_monitor_on {
                        audio_out += monitor_out[side];
                    }

                    if config.looping_on {
                        audio_out += loop_out[side];
                    }

                    channel[i] = audio_out * 12.0;

                    if file_on {
                        channel[i] += file_frame[side] * file_gain;
                    }

                    let mut drums: S = 0.0;
                    for j in (0..sounding_samples.len()).rev() {
                        if sounding_samples[j].pos < sounding_samples[j].sample.len() {
                            drums += sounding_samples[j].sample[sounding_samples[j].pos]
                                * sounding_samples[j].volume;
                            sounding_samples[j].pos += 1;
                        } else {
                            sounding_samples.remove(j);
                        }
                    }
                    if config.drum_on {
                        channel[i] += drums;
                        if ch == 0 {
                            drum_frame = drums;
                        }
                    }

                    if *click_sound_counter > 0 {
                        *click_sound_counter -= 1;
                        if config.click_on {
                            if click_here {
                                let mut r = rng.gen::<f32>() * (config.click_volume as f32);
                                if r > 1.0 {
                                    r = 1.0;
                                }
                                channel[i] += r;
                                if ch == 0 {
                                    click_frame = r;
                                }
                            }
                        }
                    }

                    // Everything that goes out is in `channel[i]` by here --
                    // the monitor, the looper, the file, the drums and the
                    // click. Only the two real sides: a device with more takes
                    // a copy of the right one, which would say nothing extra.
                    if ch < 2 {
                        out_frame[ch] = channel[i];
                    }
                }

                // Delayed by the compensation so they sit on the beat they
                // sounded on, not the one the input stamp is shifted to.
                // The looper's contribution to the speaker, at the scale it
                // actually reaches it: `channel[i] = audio_out * 12.0` puts the
                // loop through that multiplier and the drums and click in after
                // it, so the reference has to carry the 12 or it describes a
                // sound nobody made. Summed across the sides, like `file_bus` --
                // exact for a centred mono input, which is the laptop case, and
                // an approximation for anything hard-panned.
                let loop_bus: S = if config.looping_on {
                    (loop_out[0] + loop_out[1]) * 0.5 * 12.0
                } else {
                    0.0
                };
                let [drum_visual, click_visual, file_visual, _] =
                    bus_delay.push([drum_frame, click_frame, file_bus, loop_bus]);

                // One frame to the recorder: every input channel in the domain
                // everything else is sounded in, then the two sides of the mix.
                // Per frame rather than per output channel, and it can only
                // push into a vector that was sized before the recording
                // started -- a full one drops the frame and counts it.
                if let Some(rec) = recording.as_mut() {
                    rec.push_frame(&input_audio, out_frame);
                }

                // A wedged frontend must not be able to grow this without bound:
                // it would cost memory, make the next drain's reserve enormous,
                // and eventually push the callback back into the allocator.
                // Dropping the newest frames leaves a gap the display catches up
                // from in one poll, which beats stalling the audio thread.
                if drawn && state_vec.beats.len() < visual_backlog_cap {
                    state_vec.beats.push(stamp);
                    for &ch in config.visible_channels.iter() {
                        // Channels past the input count are the synthetic buses,
                        // in the order the frontend labels them: drums, click,
                        // then file.
                        let value = if ch < input_frame.len() {
                            let mut v = loop_visual[ch];
                            if config.visual_monitor_on {
                                v += input_frame[ch];
                            }
                            v
                        } else if ch == input_frame.len() {
                            drum_visual
                        } else if ch == input_frame.len() + 1 {
                            click_visual
                        } else {
                            file_visual
                        };
                        state_vec.values.push(value.abs());
                    }
                }

                *beat += beats_per_sample;
            }
        }
    }
}
