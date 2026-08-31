#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod analysis;
mod commands;
mod constants;
mod get_loop_buffer_size;
mod io_channels;
mod read_audio_file;
mod structs;
mod types;
mod util;

extern crate coreaudio;

use crate::analysis::{Analyzer, OnsetParams, BINS, MAX_ANALYSIS_CHANNELS};
use crate::commands::{
    get_analysis, get_input_channel_count, get_samples, load_drum_sample, reset_beat, set_config,
    set_mp3_buffer,
};
use crate::constants::{default_config, MAX_INPUT_BACKLOG, SAMPLE_RATE};
use crate::get_loop_buffer_size::{get_loop_buffer_size, get_loop_spacing, loop_echo_count};
use crate::io_channels::{get_input_output_channels, make_buffers, start_input_audio_unit};
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    AnalysisOutputBuffer, BeatResetState, BusDelay, ConfigState, DrumSamples, InputChannelCount,
    LogState, LoopBuffer, LoopBufferState, Mp3Buffer, Mp3BufferState, SampleOutputBuffer,
    SoundingSample,
};
use crate::types::{Args, S};
use crate::util::{beat_bisect, mod_add};
use rand::Rng;
use std::{
    collections::HashMap,
    sync::atomic::AtomicBool,
    sync::{Arc, Mutex},
};

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
    let mut mp3_loaded = false;
    let path = "/Users/eric/Music/Logic/tauri-file.wav".into();
    println!("app_config_dir: {:?}", app_config_dir);
    println!("resource_dir: {:?}", &resource_dir);
    let data = get_samples_from_filename(&path);
    let mp3_arc: Arc<Mutex<Mp3Buffer>>;
    if let Ok(data) = data {
        mp3_loaded = true;
        mp3_arc = Arc::new(Mutex::new(Mp3Buffer {
            buffer: data,
            pos: 0,
        }));
    } else {
        mp3_arc = Arc::new(Mutex::new(Mp3Buffer {
            buffer: vec![],
            pos: 0,
        }));
    }

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
    let (mut input_audio_unit, mut output_audio_unit, input_channels, io_log) =
        get_input_output_channels().unwrap();
    let buffers = make_buffers(input_channels);
    let consumers = buffers.consumers.clone();
    // Reused every frame so the audio callback never allocates.
    let mut input_frame = vec![0f32; input_channels];
    let mut loop_visual = vec![0f32; input_channels];
    // The drums and the click are generated here rather than captured, so they
    // have to be held back to land on the same visual beat as the input.
    let mut bus_delay = BusDelay::new();
    // The FFT planner and its scratch space are built here, once, so the
    // callback only ever runs the transform.
    let mut analyzer = Analyzer::new(SAMPLE_RATE);

    let mut click_sound_counter: i32 = 0;
    let mut rng = rand::thread_rng();

    let log_state = LogState(Arc::new(Mutex::new(io_log)));

    let config = default_config();
    let config_state = ConfigState(Arc::new(Mutex::new(config)));
    let config1 = config_state.0.clone();

    let sample_output_buffer = SampleOutputBuffer {
        buffer: Default::default(),
    };
    let sample_output_buffer_clone = sample_output_buffer.buffer.clone();

    let analysis_output_buffer = AnalysisOutputBuffer {
        buffer: Default::default(),
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
            let excess = buffer.len().saturating_sub(MAX_INPUT_BACKLOG);
            buffer.drain(..excess);
        }

        let config = config1.lock().unwrap();
        let mut loop_buffer = loop_buffer_clone.lock().unwrap();
        let beats_per_sample: f64 = config.bpm / SAMPLE_RATE / 60f64;
        let mut mp3 = mp3.lock().unwrap();

        if should_reset_beat.load(std::sync::atomic::Ordering::Relaxed) {
            beat = 0.0;
            mp3.pos = 0;
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
            min_gap_frames: (config.onset_min_gap.max(0.0) / 1000.0 * SAMPLE_RATE) as usize,
            offset_frames: config.onset_offset / 1000.0 * SAMPLE_RATE,
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
                // One sample per input channel, then a mono sum of them for
                // everything downstream that still works on a single signal --
                // the monitor and the looper. For one channel this is exactly
                // what the old code did.
                // Summed per output side rather than into one mono value, which
                // is what lets a channel sit anywhere in the stereo field.
                let mut monitor_out: [S; 2] = [0.0, 0.0];
                for ch in 0..input_frame.len() {
                    let sample = buffers[ch].pop_front().unwrap_or(0.0) * config.audio_in_gain;
                    input_frame[ch] = sample;
                    let (left, right) = pan_gains[ch];
                    monitor_out[0] += sample * left;
                    monitor_out[1] += sample * right;
                }

                let visual_beat =
                    beat - (config.buffer_compensation as f64) * beats_per_sample;

                // Per frame, not per output channel -- this advances the ring.
                if let Some(frames) = analysis_out.as_deref_mut() {
                    if analyzer.push(&input_frame) {
                        // The hop that just completed describes the window
                        // centred half a window behind this frame, so its stamp
                        // is this frame's visual beat less that half window --
                        // read from the analyzer, since the window is a
                        // setting. Stamping it here instead would draw every
                        // column a half window late, which is ~92 pixels at
                        // 0.25x16 and 140bpm with the default 1024, and reads
                        // as the FFT being wrong rather than the stamp.
                        frames.beats.push(
                            visual_beat
                                - (analyzer.window_len() as f64 / 2.0) * beats_per_sample,
                        );
                        analyzer.note_hop_beat(
                            visual_beat
                                - (analyzer.window_len() as f64 / 2.0) * beats_per_sample,
                        );
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
                                visual_sum += buf[(p + loop_len - back) % loop_len] * gain;
                                audio_sum +=
                                    buf[(audio_from + loop_len - back) % loop_len] * gain;
                            }
                            loop_visual[ch] = visual_sum;
                            let (left, right) = pan_gains[ch];
                            loop_out[0] += audio_sum * left;
                            loop_out[1] += audio_sum * right;
                            // A plain history -- every repeat comes from a tap,
                            // so nothing is mixed back in here.
                            loop_buffer.channels[ch][p] =
                                input_frame.get(ch).copied().unwrap_or(0.0);
                        } else {
                            loop_visual[ch] = 0.0;
                            loop_buffer.channels[ch][p] = 0.0;
                        }
                    }
                    loop_buffer.pos = (p + 1) % loop_len;
                }

                // Alternating halves of a double-length loop: the metronome
                // plays for one loop and is silent for the next, so you play
                // the second half against what you just recorded. Once per
                // frame -- the drums read it too, and their trigger is out here.
                let in_loop = beat % (config.beats_to_loop * 2.0) < config.beats_to_loop;
                let toggled_off = config.click_toggle && !in_loop;

                // Triggers, once per frame rather than once per output channel.
                let click_beat = beat_bisect(&click_times, beat);
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
                        let hit =
                            beat_bisect(&voice_times[v], beat + offset_beats - voice.shift);
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
                            if !toggled_off {
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

                    // mp3_sample = mp3_sample * 0.995 + mp3[mp3_pos] * 0.005;
                    if mp3_loaded && config.play_file {
                        channel[i] += mp3.buffer[mp3.pos];
                        // channel[i] += mp3_sample;
                    }
                    if ch == 0 || ch == 1 {
                        mp3.pos += 1;
                    }
                    if mp3.pos >= mp3.buffer.len() {
                        mp3.pos = 0;
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
                            if !toggled_off {
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
                let [drum_visual, click_visual] = bus_delay.push([drum_frame, click_frame]);

                state_vec.beats.push(visual_beat);
                for &ch in config.visible_channels.iter() {
                    // Channels past the input count are the synthetic buses, in
                    // the order the frontend labels them: drums, then click.
                    let value = if ch < input_frame.len() {
                        let mut v = loop_visual[ch];
                        if config.visual_monitor_on {
                            v += input_frame[ch];
                        }
                        v
                    } else if ch == input_frame.len() {
                        drum_visual
                    } else {
                        click_visual
                    };
                    state_vec.values.push(value.abs());
                }

                beat += beats_per_sample;
            }
        }
        Ok(())
    })?;
    output_audio_unit.start()?;

    tauri::Builder::default()
        .manage(sample_output_buffer)
        .manage(analysis_output_buffer)
        .manage(config_state)
        .manage(loop_buffer_state)
        .manage(mp3_state)
        .manage(should_reset_beat_state)
        .manage(log_state)
        .manage(InputChannelCount(input_channels))
        .manage(drum_samples_state)
        .invoke_handler(tauri::generate_handler![
            get_samples,
            get_analysis,
            set_config,
            reset_beat,
            set_mp3_buffer,
            get_input_channel_count,
            load_drum_sample,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
