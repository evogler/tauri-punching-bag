#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;
mod constants;
mod get_loop_buffer_size;
mod io_channels;
mod read_audio_file;
mod structs;
mod types;
mod util;

extern crate coreaudio;

use crate::commands::{
    get_input_channel_count, get_samples, load_drum_sample, reset_beat, set_config, set_mp3_buffer,
};
use crate::constants::{default_config, MAX_INPUT_BACKLOG, SAMPLE_RATE};
use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::io_channels::{get_input_output_channels, make_buffers, start_input_audio_unit};
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    BeatResetState, ConfigState, DrumSamples, InputChannelCount, LogState, LoopBuffer,
    LoopBufferState, Mp3Buffer, Mp3BufferState, SampleOutputBuffer, SoundingSample,
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

    // setup audio
    let (mut input_audio_unit, mut output_audio_unit, input_channels, io_log) =
        get_input_output_channels().unwrap();
    let buffers = make_buffers(input_channels);
    let consumers = buffers.consumers.clone();
    // Reused every frame so the audio callback never allocates.
    let mut input_frame = vec![0f32; input_channels];
    let mut loop_visual = vec![0f32; input_channels];

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
                let mut mix: S = 0.0;
                for ch in 0..input_frame.len() {
                    let sample = buffers[ch].pop_front().unwrap_or(0.0) * config.audio_in_gain;
                    input_frame[ch] = sample;
                    mix += sample;
                }

                let visual_beat =
                    beat - (config.buffer_compensation as f64) * beats_per_sample;
                // The loop is read and written once per frame, per channel --
                // not inside the output loop, which would advance the position
                // once per *output* channel and mix every input into one track.
                //
                // `loop_playback` is the summed monitor feed; `loop_visual` is
                // kept per channel so each one shows only its own take.
                let mut loop_playback: S = 0.0;
                let loop_len = loop_buffer.channels.first().map_or(0, |c| c.len());
                if loop_len > 0 {
                    let p = loop_buffer.pos;
                    let compensated = mod_add(p, config.buffer_compensation, loop_len);
                    for ch in 0..loop_buffer.channels.len() {
                        if config.looping_on {
                            // Read this position before overwriting it: that's
                            // the previous time round.
                            loop_visual[ch] = loop_buffer.channels[ch][p];
                            loop_playback += loop_buffer.channels[ch][compensated];
                            loop_buffer.channels[ch][p] =
                                input_frame.get(ch).copied().unwrap_or(0.0);
                        } else {
                            loop_visual[ch] = 0.0;
                            loop_buffer.channels[ch][p] = 0.0;
                        }
                    }
                    loop_buffer.pos = (p + 1) % loop_len;
                }

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
                        let hit = beat_bisect(&voice_times[v], beat + offset_beats);
                        if drum_last_beats[v] == isize::MIN {
                            drum_last_beats[v] = hit;
                        } else if hit != drum_last_beats[v] {
                            sounding_samples.push(SoundingSample {
                                sample: sample.clone(),
                                pos: 0,
                                volume: voice.volume as f32,
                            });
                            drum_last_beats[v] = hit;
                        }
                    }
                }

                // What the drums put out this frame, kept so the display can
                // show them as their own channel for calibrating offsets.
                let mut drum_frame: S = 0.0;

                for (ch, channel) in data.channels_mut().enumerate() {
                    let sample: S = mix;
                    let mut audio_out = 0.0;
                    if config.audio_monitor_on {
                        audio_out += sample;
                    }

                    if config.looping_on {
                        audio_out += loop_playback;
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
                    }
                    if ch == 0 {
                        drum_frame = drums;
                    }

                    if click_sound_counter > 0 {
                        click_sound_counter -= 1;
                        let in_loop = beat % (config.beats_to_loop * 2.0) < config.beats_to_loop;
                        if config.click_on {
                            if !config.click_toggle || in_loop {
                                let mut r = rng.gen::<f32>() * (config.click_volume as f32);
                                if r > 1.0 {
                                    r = 1.0;
                                }
                                channel[i] += r;
                            }
                        }
                    }
                }

                state_vec.beats.push(visual_beat);
                for &ch in config.visible_channels.iter() {
                    // Channels past the input count are the drum bus, which is
                    // how the drums get their own row in the display.
                    let value = if ch < input_frame.len() {
                        let mut v = loop_visual[ch];
                        if config.visual_monitor_on {
                            v += input_frame[ch];
                        }
                        v
                    } else {
                        drum_frame
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
        .manage(config_state)
        .manage(loop_buffer_state)
        .manage(mp3_state)
        .manage(should_reset_beat_state)
        .manage(log_state)
        .manage(InputChannelCount(input_channels))
        .manage(drum_samples_state)
        .invoke_handler(tauri::generate_handler![
            get_samples,
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
