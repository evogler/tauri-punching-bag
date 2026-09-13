#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod analysis;
mod commands;
mod constants;
mod calibration;
mod filter;
mod get_loop_buffer_size;
mod prefs;
mod io_channels;
mod read_audio_file;
mod stretch;
mod structs;
mod types;
mod util;

extern crate coreaudio;

use crate::analysis::{Analyzer, OnsetParams, BINS, MAX_ANALYSIS_CHANNELS};
use crate::commands::{
    cancel_calibration, get_active_devices, get_analysis, get_audio_prefs,
    get_calibration_status, get_input_channel_count, get_sample_rate, get_samples,
    list_audio_devices, load_drum_sample, reset_beat, restart_app, set_audio_prefs, set_config,
    set_mp3_buffer, start_calibration,
};
use crate::calibration::Calibration;
use crate::constants::{default_config, max_input_backlog, max_visual_backlog, sample_rate};
use crate::filter::HighPass;
use crate::get_loop_buffer_size::{get_loop_buffer_size, get_loop_spacing, loop_echo_count};
use crate::io_channels::{
    get_input_output_channels, make_buffers, start_input_audio_unit, watch_device_changes,
};
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    AnalysisOutputBuffer, BeatResetState, BusDelay, CalibrationState, ConfigState, DrumSamples,
    InputChannelCount, LogState, LoopBuffer, LoopBufferState, Mp3Buffer, Mp3BufferState,
    SampleOutputBuffer, SoundingSample,
};
use crate::types::{Args, S};
use crate::util::{beat_bisect, display_start, mod_add, section_at, section_bounds};
use rand::Rng;
use std::{
    collections::HashMap,
    sync::atomic::AtomicBool,
    sync::{Arc, Mutex},
};
use tauri::{CustomMenuItem, Manager, Menu, MenuEntry, MenuItem};

// Restarting is the quickest way out of a wedged audio device -- the render
// callback and the input stream are set up once, at launch, so there is no
// other way to rebuild them. The settings survive it: the frontend writes the
// session to local storage on every config change, and reads it back on boot.
const RESTART_MENU_ID: &str = "restart";

// The default menu is kept whole and added to rather than replaced. Building
// one from scratch would drop Edit, and with it cut/copy/paste in every text
// field in the settings panel.
fn menu_with_restart(app_name: &str) -> Menu {
    let mut menu = Menu::os_default(app_name);
    // The app submenu, found by title rather than by position -- os_default
    // only puts it first on macOS.
    let app_submenu = menu.items.iter_mut().find_map(|entry| match entry {
        MenuEntry::Submenu(submenu) if submenu.title == app_name => Some(submenu),
        _ => None,
    });
    if let Some(submenu) = app_submenu {
        // Just under About, above Services: an action on the app itself.
        submenu
            .inner
            .items
            .insert(1, MenuEntry::NativeItem(MenuItem::Separator));
        submenu.inner.items.insert(
            2,
            MenuEntry::CustomItem(
                CustomMenuItem::new(RESTART_MENU_ID, "Restart").accelerator("cmd+shift+r"),
            ),
        );
    }
    menu
}

fn main() -> Result<(), coreaudio::Error> {
    let context = tauri::generate_context!();
    let app_config_dir = tauri::api::path::config_dir();
    let rd = tauri::api::path::resource_dir(&context.package_info(), &tauri::utils::Env::default());
    let binding = rd.unwrap();
    let resource_dir = binding.to_str().unwrap();
    // let resource_dir = rd.unwrap().to_str().unwrap();
    // tauri::api::path::config_dir()

    // access an asset file within the tauri app

    // load mp3
    let path = "/Users/eric/Music/Logic/tauri-file.wav".into();
    println!("app_config_dir: {:?}", app_config_dir);
    println!("resource_dir: {:?}", &resource_dir);
    let data = get_samples_from_filename(&path);
    // Whether a file is loaded is asked of the buffer every callback, not
    // captured here: this path is one person's machine, and a startup flag meant
    // that anywhere it didn't exist, picking a file loaded the samples and then
    // never played them.
    let natural = Arc::new(data.unwrap_or_default());
    let mp3_arc = Arc::new(Mutex::new(Mp3Buffer {
        buffer: (*natural).clone(),
        pos: 0.0,
        natural,
        generation: 0,
        ratio: 1.0,
    }));

    let mp3 = mp3_arc.clone();
    let mp3_state = Mp3BufferState(mp3_arc.clone());

    // load samples
    let mut sample_buffers: HashMap<String, Arc<Vec<f32>>> = HashMap::new();
    let ride_path = &format!("{}/{}", resource_dir, "samples/ride_cropped.wav");
    // Bundled samples are filed under a plain name so a voice can refer to one
    // without knowing where the app was installed.
    sample_buffers.insert(
        "ride".to_string(),
        Arc::new(get_samples_from_filename(ride_path).unwrap()),
    );
    let drum_samples_arc = Arc::new(Mutex::new(sample_buffers));
    let drum_samples_state = DrumSamples(drum_samples_arc.clone());
    let drum_samples = drum_samples_arc.clone();
    let mut sounding_samples: Vec<SoundingSample> = vec![];
    // One entry per drum voice: the subdivision it last fired on, so a hit
    // happens on the crossing rather than every frame. isize::MIN means "not
    // primed yet", which stops a newly added voice firing immediately.
    let mut drum_last_beats: Vec<isize> = vec![];
    // Gain per echo, resolved once per callback so the per-frame tap loop isn't
    // raising loop_echo_gain to a power for every frame and channel.
    let mut tap_gains: Vec<f32> = vec![];

    // setup audio
    // Device choice is read from disk, not from the config: the units are opened
    // before any window exists, so localStorage is unreachable here.
    let prefs_dir = tauri::api::path::app_config_dir(context.config())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let audio_prefs = prefs::load(&prefs_dir);
    let setup = get_input_output_channels(&audio_prefs).unwrap();
    let (mut input_audio_unit, mut output_audio_unit, input_channels, io_log) = (
        setup.input_unit,
        setup.output_unit,
        setup.input_channels,
        setup.log,
    );
    let active_devices = setup.active;
    let buffers = make_buffers(input_channels);
    let consumers = buffers.consumers.clone();
    // Reused every frame so the audio callback never allocates.
    // Three views of the same instant: what the device gave us, what the
    // picture is drawn from, and what is sounded. They differ only when the
    // high pass is on -- see the filter module.
    let mut input_raw = vec![0f32; input_channels];
    let mut input_frame = vec![0f32; input_channels];
    let mut input_audio = vec![0f32; input_channels];
    let mut loop_visual = vec![0f32; input_channels];
    // Reused across callbacks so the section walk never allocates; it only
    // grows when a section is added.
    let mut bounds: Vec<(f64, usize)> = Vec::new();
    // How many frames have been written to the loop buffer since the cycle last
    // restarted, saturating at its length. Clearing the buffer on a restart
    // would be a multi-megabyte memset on the audio thread; suppressing the
    // taps that would read across the restart is the same thing in O(1).
    let mut loop_written: usize = 0;
    let mut cycle_count: u64 = 0;
    // One filter for the live signal and one for the looper's summed echoes.
    // Sized here rather than per callback because a device change needs a
    // relaunch anyway, so the channel count cannot move under them.
    let mut input_high_pass: Vec<HighPass> =
        (0..input_channels).map(|_| HighPass::new()).collect();
    let mut loop_high_pass: Vec<HighPass> =
        (0..input_channels).map(|_| HighPass::new()).collect();
    // The drums and the click are generated here rather than captured, so they
    // have to be held back to land on the same visual beat as the input.
    let mut bus_delay = BusDelay::new();
    // The FFT planner and its scratch space are built here, once, so the
    // callback only ever runs the transform.
    let mut analyzer = Analyzer::new(sample_rate());

    let mut click_sound_counter: i32 = 0;
    // Peak-hold envelope of what the speaker emitted, for the bleed
    // subtraction. Instant attack and an exponential release: long enough to
    // cover the room's tail on a click, far short of a beat at any tempo worth
    // practising at, so it cannot duck the gap between hits.
    let mut bleed_env: f32 = 0.0;
    // 15 ms. Long enough that one setting of the amount covers a whole click
    // and the room's tail behind it -- at 3 ms the envelope falls away under
    // the burst and the amount needed triples -- and short enough that it has
    // decayed to nothing well before the next beat at any tempo. Simulated: a
    // hit 100 ms after a click keeps its full height.
    let bleed_release = (-1.0f64 / (0.015 * sample_rate())).exp() as f32;
    // How far ahead of the echo to arm the envelope. See `peek_lead`.
    let bleed_lead = (0.005 * sample_rate()) as usize;
    let mut rng = rand::thread_rng();

    let log_state = LogState(Arc::new(Mutex::new(io_log)));

    let config = default_config();
    let config_state = ConfigState(Arc::new(Mutex::new(config)));
    let config1 = config_state.0.clone();

    let sample_output_buffer = SampleOutputBuffer {
        buffer: Default::default(),
        drained: Default::default(),
    };
    let sample_output_buffer_clone = sample_output_buffer.buffer.clone();

    let calibration_arc = Arc::new(Mutex::new(Calibration::default()));
    let calibration_result_arc = Arc::new(Mutex::new(
        crate::calibration::CalibrationResult::default(),
    ));
    let calibration_state = CalibrationState(calibration_arc.clone(), calibration_result_arc.clone());
    let calibration = calibration_arc.clone();

    let analysis_output_buffer = AnalysisOutputBuffer {
        buffer: Default::default(),
        drained: Default::default(),
    };
    let analysis_output_buffer_clone = analysis_output_buffer.buffer.clone();

    let loop_buffer_size: usize;
    {
        let c = config1.lock().unwrap();
        loop_buffer_size = get_loop_buffer_size(&c);
    }
    let loop_buffer = LoopBuffer {
        channels: vec![vec![0f32; loop_buffer_size]; input_channels],
        pos: 0,
    };
    let loop_buffer_mutex_arc = Arc::new(Mutex::new(loop_buffer));
    let loop_buffer_clone = loop_buffer_mutex_arc.clone();
    let loop_buffer_state = LoopBufferState(loop_buffer_mutex_arc.clone());

    let should_reset_beat_arc = Arc::new(AtomicBool::new(false));
    let should_reset_beat = should_reset_beat_arc.clone();
    let should_reset_beat_state = BeatResetState(should_reset_beat_arc.clone());

    let mut beat: f64 = 0.0;
    let mut last_beat: isize = 0;

    start_input_audio_unit(&mut input_audio_unit, buffers.producers).unwrap();

    output_audio_unit.set_render_callback(move |args: Args| {
        let Args {
            num_frames,
            mut data,
            ..
        } = args;
        let mut buffers: Vec<_> = consumers.iter().map(|c| c.lock().unwrap()).collect();

        // Keeps the shared input queue from growing without bound if this
        // callback ever falls behind the input one. Also trims the startup gap,
        // since the input unit is started before this one.
        for buffer in buffers.iter_mut() {
            let excess = buffer.len().saturating_sub(max_input_backlog());
            buffer.drain(..excess);
        }

        let config = config1.lock().unwrap();
        let mut loop_buffer = loop_buffer_clone.lock().unwrap();
        let beats_per_sample: f64 = config.bpm / sample_rate() / 60f64;
        let mut mp3 = mp3.lock().unwrap();

        if should_reset_beat.load(std::sync::atomic::Ordering::Relaxed) {
            beat = 0.0;
            mp3.pos = 0.0;
            // A window stitched across the jump is a spectral edge nobody
            // played, and it would read as a phantom transient.
            analyzer.reset();
            should_reset_beat_arc.store(false, std::sync::atomic::Ordering::Relaxed);
        }

        // Paused freezes everything that moves -- the beat, the file position, the
        // loop buffer -- so resuming picks up exactly where it stopped, and no
        // visual samples are produced so the display holds still.
        //
        // The input still has to be drained. make_buffers hands out the same
        // queue as both producer and consumer, so leaving it alone while the
        // input unit keeps pushing would grow it without bound and then play
        // back a pause-length backlog of stale audio on resume.
        if config.paused {
            // Same reason as the beat reset: the frames either side of a pause
            // aren't adjacent, so the history can't carry across it.
            analyzer.reset();
            for buffer in buffers.iter_mut() {
                let drop_count = num_frames.min(buffer.len());
                buffer.drain(..drop_count);
            }
            for i in 0..num_frames {
                for channel in data.channels_mut() {
                    channel[i] = 0.0;
                }
            }
            return Ok(());
        }

        // Calibration takes the callback over completely. It is measuring how
        // long the app's own sound takes to come back, so it has to be the only
        // thing making sound -- drums, the looper or the monitor mixed in would
        // all correlate against the probe. Locked once here, like the display
        // buffers, never per frame.
        {
            let mut cal = calibration.lock().unwrap();
            if cal.active {
                // The frames either side of a calibration run aren't adjacent
                // to what came before, same as a pause.
                analyzer.reset();
                for i in 0..num_frames {
                    // Every channel is drained whether or not it is the one
                    // being measured: make_buffers hands out the same queue to
                    // both ends, so an undrained channel grows without bound
                    // and replays the backlog afterwards.
                    let mut measured = 0.0;
                    for (ch, buffer) in buffers.iter_mut().enumerate() {
                        let sample = buffer.pop_front().unwrap_or(0.0);
                        if ch == cal.channel {
                            measured = sample;
                        }
                    }
                    let probe = cal.step(measured);
                    for channel in data.channels_mut() {
                        channel[i] = probe;
                    }
                }
                return Ok(());
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
            let map = drum_samples.lock().unwrap();
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
            section_bounds(&config.sections, &config.section_order, &mut bounds);
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
        let bleed_cancel_on = config.bleed_cancel_on;
        let bleed_cancel_amount = config.bleed_cancel_amount;
        for hp in input_high_pass.iter_mut().chain(loop_high_pass.iter_mut()) {
            hp.set_cutoff(config.high_pass_hz, sample_rate());
        }

        // Resolved once per callback like everything else the frame loop needs.
        // The buffer is already interleaved stereo at the device rate, so a
        // frame is two values and no conversion happens down here.
        let file_frames = mp3.frames();
        let file_on = file_frames > 0 && config.play_file;
        let file_gain = config.file_volume as S;
        // Positive is *earlier*, i.e. further into the file, matching a drum
        // voice's offset.
        let file_offset_frames = config.file_offset_ms / 1000.0 * sample_rate();
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
            min_gap_frames: (config.onset_min_gap.max(0.0) / 1000.0 * sample_rate()) as usize,
            offset_frames: config.onset_offset / 1000.0 * sample_rate(),
        };

        let loop_spacing = get_loop_spacing(&config);
        tap_gains.resize(loop_echo_count(&config), 0.0);
        {
            let feedback = config.loop_echo_gain.clamp(0.0, 1.0) as f32;
            let mut gain = 1.0f32;
            for tap in tap_gains.iter_mut() {
                *tap = gain;
                gain *= feedback;
            }
        }

        // Locked once per callback alongside the sample buffer, so the frame
        // loop only ever pushes into it.
        let mut analysis_out = if analysis_channels > 0 {
            analysis_output_buffer_clone.lock().ok()
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

        if let Ok(mut state_vec) = sample_output_buffer_clone.lock() {
            // Changing which channels are shown changes the row width of the
            // flattened stream, so anything collected under the old width has to
            // go rather than be misread as the new one.
            if state_vec.channels != config.visible_channels.len() {
                state_vec.channels = config.visible_channels.len();
                state_vec.beats.clear();
                state_vec.values.clear();
            }

            for i in 0..num_frames {
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
                if sections_on && beat >= cycle_beats {
                    beat = 0.0;
                    mp3.pos = 0.0;
                    // A window stitched across the jump is a spectral edge
                    // nobody played, the same as at a manual reset.
                    analyzer.reset();
                    // Nothing recorded before the restart may be played back:
                    // it was at the old tempo, against a different bar.
                    loop_written = 0;
                    loop_buffer.pos = 0;
                    cycle_count += 1;
                    state_vec.cycle = cycle_count;
                }
                let section = if sections_on {
                    section_at(&bounds, beat, cycle_beats)
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
                // deliberately: the output also carries the monitor and the
                // looper's echoes, and subtracting those would take your own
                // playing out of your own trace.
                let emitted = {
                    let [d, c, f] = bus_delay.peek_lead(bleed_lead);
                    (d + c + f).abs()
                };
                // Run whether or not it is switched on, like the filters and
                // for the same reason -- an envelope caught up mid-phrase is
                // one that was never stale.
                bleed_env = emitted.max(bleed_env * bleed_release);
                let duck = if bleed_cancel_on {
                    bleed_env * bleed_cancel_amount
                } else {
                    0.0
                };

                let mut monitor_out: [S; 2] = [0.0, 0.0];
                for ch in 0..input_frame.len() {
                    let raw = buffers[ch].pop_front().unwrap_or(0.0) * config.audio_in_gain;
                    // Run whether or not it is switched on, so the state can
                    // never be stale: turning the filter on mid-phrase would
                    // otherwise start it from silence and put a step into both
                    // the picture and, if the audio is following, the sound.
                    let filtered = input_high_pass[ch].process(raw);
                    input_raw[ch] = raw;
                    input_frame[ch] = if high_pass_on { filtered } else { raw };
                    // Take the known bleed off the magnitude, keeping the sign
                    // so the value still sums with the looper's echoes below.
                    // Floored at zero rather than let through negative, which
                    // would draw the click straight back at whatever the
                    // overshoot was.
                    if duck > 0.0 {
                        let v = input_frame[ch];
                        let shown = v.abs() - duck;
                        input_frame[ch] = if shown > 0.0 { shown.copysign(v) } else { 0.0 };
                    }
                    let audio = if high_pass_audio { filtered } else { raw };
                    input_audio[ch] = audio;
                    let (left, right) = pan_gains[ch];
                    monitor_out[0] += audio * left;
                    monitor_out[1] += audio * right;
                }

                let visual_beat = beat - (config.buffer_compensation as f64) * beats_per_sample;
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
                                if (p + loop_len - v_at) % loop_len <= loop_written {
                                    visual_sum += buf[v_at] * gain;
                                }
                                if (p + loop_len - a_at) % loop_len <= loop_written {
                                    audio_sum += buf[a_at] * gain;
                                }
                            }
                            loop_visual[ch] = visual_sum;
                            let (left, right) = pan_gains[ch];
                            loop_out[0] += audio_sum * left;
                            loop_out[1] += audio_sum * right;
                            // A plain history -- every repeat comes from a tap,
                            // so nothing is mixed back in here.
                            loop_buffer.channels[ch][p] =
                                input_audio.get(ch).copied().unwrap_or(0.0);
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
                    loop_written = (loop_written + 1).min(loop_len);
                }

                // Triggers, once per frame rather than once per output channel.
                // Subtracting the shift reads the rhythm from earlier in the
                // cycle, so a positive shift moves the click later -- the same
                // sign and the same mechanism as a drum voice's.
                let click_beat = beat_bisect(&click_times, beat - config.click_shift);
                if click_beat != last_beat {
                    click_sound_counter = if config.audio_subdivisions.notes.len() < 2
                        || (click_beat % (config.audio_subdivisions.notes.len() as isize) == 0)
                    {
                        400
                    } else {
                        100
                    };
                    last_beat = click_beat;
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
                        let hit = beat_bisect(&voice_times[v], beat + offset_beats - voice.shift);
                        if drum_last_beats[v] == isize::MIN {
                            drum_last_beats[v] = hit;
                        } else if hit != drum_last_beats[v] {
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
                                || section_at(&bounds, beat + offset_beats, cycle_beats)
                                    .map_or(false, |i| config.sections[i].drums.contains(&v));
                            if sounds_here {
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
                        let phase = (beat - config.file_shift).rem_euclid(file_cycle);
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

                for (ch, channel) in data.channels_mut().enumerate() {
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

                    if click_sound_counter > 0 {
                        click_sound_counter -= 1;
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
                }

                // Delayed by the compensation so they sit on the beat they
                // sounded on, not the one the input stamp is shifted to.
                let [drum_visual, click_visual, file_visual] =
                    bus_delay.push([drum_frame, click_frame, file_bus]);

                // A wedged frontend must not be able to grow this without bound:
                // it would cost memory, make the next drain's reserve enormous,
                // and eventually push the callback back into the allocator.
                // Dropping the newest frames leaves a gap the display catches up
                // from in one poll, which beats stalling the audio thread.
                if drawn && state_vec.beats.len() < max_visual_backlog() {
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

                beat += beats_per_sample;
            }
        }
        Ok(())
    })?;
    output_audio_unit.start()?;

    // Built here rather than inline in the chain: the menu needs the product
    // name, which only the generated context knows.
    let context = tauri::generate_context!();

    tauri::Builder::default()
        .setup(|app| {
            watch_device_changes(app.handle());
            Ok(())
        })
        .menu(menu_with_restart(&context.package_info().name))
        .on_menu_event(|event| {
            if event.menu_item_id() == RESTART_MENU_ID {
                // Relaunches the bundle and exits this process. On macOS
                // `api::process::restart` reads Info.plist to find the binary,
                // so the .app comes back rather than the bare executable --
                // which matters here, since only the bundle has the microphone
                // grant (see the packaging notes in CLAUDE.md).
                event.window().app_handle().restart();
            }
        })
        .manage(sample_output_buffer)
        .manage(analysis_output_buffer)
        .manage(config_state)
        .manage(loop_buffer_state)
        .manage(mp3_state)
        .manage(should_reset_beat_state)
        .manage(log_state)
        .manage(InputChannelCount(input_channels))
        .manage(active_devices)
        .manage(calibration_state)
        .manage(drum_samples_state)
        .invoke_handler(tauri::generate_handler![
            get_samples,
            get_analysis,
            set_config,
            reset_beat,
            set_mp3_buffer,
            get_input_channel_count,
            get_sample_rate,
            list_audio_devices,
            get_audio_prefs,
            set_audio_prefs,
            get_active_devices,
            restart_app,
            start_calibration,
            get_calibration_status,
            cancel_calibration,
            load_drum_sample,
        ])
        .run(context)
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
