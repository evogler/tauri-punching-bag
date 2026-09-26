#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod analysis;
mod bleed;
mod commands;
mod constants;
mod engine;
mod calibration;
mod filter;
mod get_loop_buffer_size;
mod prefs;
mod presets;
mod io_channels;
mod loop_guard;
mod read_audio_file;
mod recorder;
mod stretch;
mod structs;
mod types;
mod util;

extern crate coreaudio;

use crate::bleed::{BleedResult, BleedTraining};
use crate::commands::{
    cancel_bleed_training, get_bleed_status, get_input_levels, get_kit, get_loop_guard, start_bleed_training,
    cancel_calibration, get_active_devices, get_analysis, get_audio_prefs,
    get_calibration_status, get_input_channel_count, get_sample_rate, get_samples,
    export_presets, get_presets, import_presets, list_audio_devices, load_drum_sample,
    get_recording_status, quarantine_presets, reset_beat, restart_app, set_audio_prefs, set_config,
    set_mp3_buffer, set_presets, start_calibration, start_recording, stop_recording,
};
use crate::calibration::Calibration;
use crate::constants::{default_config, max_input_backlog, sample_rate};
use crate::engine::{Engine, EngineShared};
use crate::get_loop_buffer_size::get_loop_buffer_size;
use crate::io_channels::{
    get_input_output_channels, make_buffers, start_input_audio_unit, watch_device_changes,
};
use crate::read_audio_file::get_samples_from_filename;
use crate::structs::{
    AnalysisOutputBuffer, BeatResetState, BleedState, CalibrationState, ConfigState, DrumSamples,
    LoopGuardState, InputLevelState, KitSound, KitState,
    InputChannelCount, LogState, LoopBuffer, LoopBufferState, Mp3Buffer, Mp3BufferState,
    ConfigReady, RecorderState, SampleOutputBuffer,
};
use crate::types::Args;
use std::{
    collections::HashMap,
    sync::atomic::AtomicBool,
    sync::{Arc, Mutex},
};
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

// Restarting is the quickest way out of a wedged audio device -- the render
// callback and the input stream are set up once, at launch, so there is no
// other way to rebuild them. The settings survive it: the frontend writes the
// session to local storage on every config change, and reads it back on boot.
const RESTART_MENU_ID: &str = "restart";

// The default menu is kept whole and added to rather than replaced. Building
// one from scratch would drop Edit, and with it cut/copy/paste in every text
// field in the settings panel.
fn menu_with_restart(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let app_name = &app.package_info().name;
    // The app submenu, found by title rather than by position -- the default
    // only puts it first on macOS.
    let app_submenu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu) if submenu.text().ok().as_ref() == Some(app_name) => {
            Some(submenu)
        }
        _ => None,
    });
    if let Some(submenu) = app_submenu {
        // Just under About, above Services: an action on the app itself.
        submenu.insert(&PredefinedMenuItem::separator(app)?, 1)?;
        submenu.insert(
            &MenuItem::with_id(app, RESTART_MENU_ID, "Restart", true, Some("cmd+shift+r"))?,
            2,
        )?;
    }
    Ok(menu)
}

/// Emitted when the launch-time update check fails, so the updates section can
/// say so. v1 put this on its own updater event stream, which v2 does not have.
const UPDATE_ERROR_EVENT: &str = "update-check-failed";

// The launch-time check, with native dialogs. v1 did all of this itself under
// `updater.dialog: true`; v2's updater plugin has no dialog of its own, so this
// reproduces it -- the same two questions, the same wording, in the same order.
// A friend who just wants the new version never has to open the panel.
async fn check_for_update_at_launch(app: AppHandle) {
    let update = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let update = match update {
        Ok(Some(update)) => update,
        Ok(None) => return,
        Err(e) => {
            let _ = app.emit(UPDATE_ERROR_EVENT, e.to_string());
            return;
        }
    };
    let name = app.package_info().name.clone();
    let body = update.body.clone().unwrap_or_default();
    let install = app
        .dialog()
        .message(format!(
            "{} {} is now available -- you have {}.\n\nWould you like to install it now?\n\nRelease Notes:\n{}",
            name, update.version, update.current_version, body
        ))
        .title(format!("A new version of {} is available!", name))
        .buttons(MessageDialogButtons::OkCancelCustom("Yes".into(), "No".into()))
        .blocking_show();
    if !install {
        return;
    }
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        let _ = app.emit(UPDATE_ERROR_EVENT, e.to_string());
        return;
    }
    let restart = app
        .dialog()
        .message("The installation was successful, do you want to restart the application now?")
        .title("Ready to Restart")
        .buttons(MessageDialogButtons::OkCancelCustom("Yes".into(), "No".into()))
        .blocking_show();
    if restart {
        app.restart();
    }
}

// A missing or malformed manifest is an empty kit rather than a failed launch;
// any voice naming a kit sound then shows as not found.
fn load_kit(resource_dir: &str) -> Vec<KitSound> {
    let path = format!("{}/samples/kit.json", resource_dir);
    match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
    {
        Ok(kit) => kit,
        Err(e) => {
            println!("built-in kit manifest {} unusable: {}", path, e);
            vec![]
        }
    }
}

fn main() -> Result<(), coreaudio::Error> {
    let context = tauri::generate_context!();
    let app_config_dir = dirs::config_dir();
    let rd = tauri::utils::platform::resource_dir(context.package_info(), &tauri::utils::Env::default());
    let binding = rd.unwrap();
    let resource_dir = binding.to_str().unwrap();
    // let resource_dir = rd.unwrap().to_str().unwrap();
    // tauri::api::path::config_dir()

    // access an asset file within the tauri app

    // setup audio, and it has to come first.
    //
    // Everything that decodes a file converts it to the *device* rate, and the
    // device rate is not known until the input device has been opened. Loading
    // the built-in kit ahead of this read `sample_rate()` before it had been
    // set, which used to freeze the process at the 44.1 kHz fallback: the
    // samples were resampled to a rate the hardware was not running at, and
    // then the input unit was opened at 44.1 against a 48 kHz microphone, which
    // AUHAL answers with silence. Nothing above this line may read the rate.
    //
    // Device choice is read from disk, not from the config: the units are opened
    // before any window exists, so localStorage is unreachable here.
    // `config_dir()/<identifier>`, which is what `app.path().app_config_dir()`
    // resolves to once the app exists -- and what v1's `app_config_dir` did, so
    // a v1 install's prefs and presets are found after the upgrade. Computed by
    // hand because the devices are opened before there is an app to ask.
    let prefs_dir = dirs::config_dir()
        .map(|dir| dir.join(&context.config().identifier))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let audio_prefs = prefs::load(&prefs_dir);
    // There is no window to show this in and there never will be, so the
    // message is the whole report. A bare `unwrap` here was a backtrace naming
    // a line number and an enum variant -- nothing about which device, or which
    // role it was being asked to play.
    let setup = match get_input_output_channels(&audio_prefs) {
        Ok(setup) => setup,
        Err(message) => {
            eprintln!("audio setup failed: {}", message);
            eprintln!(
                "Choose different devices in {}, or delete it to go back to the system defaults.",
                prefs_dir.join("audio-prefs.json").display()
            );
            std::process::exit(1);
        }
    };

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
    // The built-in kit, described by `samples/kit.json`: an id, a name and a
    // file, three separate things. The id is what a preset stores, so it must
    // never change once shipped; the name is only what is shown; the file is
    // whatever the sample happens to be called. Samples are filed under the id
    // so a voice can refer to one without knowing where the app was installed.
    // A sound that fails to load is skipped rather than unwrapped -- a voice
    // naming it then shows as missing, which beats not launching.
    let kit = load_kit(resource_dir);
    for sound in &kit {
        let path = format!("{}/samples/{}", resource_dir, sound.file);
        match get_samples_from_filename(&path) {
            Ok(samples) => {
                sample_buffers.insert(sound.id.clone(), Arc::new(samples));
            }
            Err(e) => println!("built-in sample {} failed to load: {:?}", sound.id, e),
        }
    }
    let kit_state = KitState(kit);
    let drum_samples_arc = Arc::new(Mutex::new(sample_buffers));
    let drum_samples_state = DrumSamples(drum_samples_arc.clone());
    let (mut input_audio_unit, mut output_audio_unit, input_channels, io_log) = (
        setup.input_unit,
        setup.output_unit,
        setup.input_channels,
        setup.log,
    );
    let active_devices = setup.active;
    let buffers = make_buffers(input_channels);
    let consumers = buffers.consumers.clone();

    // A measuring run, and its verdict. Two mutexes rather than one for the
    // same reason the calibration has two: the callback touches the counters
    // every callback and the result only when a run ends.
    let bleed_training_arc = Arc::new(Mutex::new(BleedTraining::default()));
    let bleed_result_arc = Arc::new(Mutex::new(BleedResult::default()));
    let loop_guard_arc = Arc::new(Mutex::new((0.0f32, 0.0f32)));
    let loop_guard_state = LoopGuardState(loop_guard_arc.clone());
    // Peak input per channel, for the setup's microphone check -- raised by
    // the audio core once per callback, read and zeroed by the command.
    let input_level_arc: Arc<Vec<std::sync::atomic::AtomicU32>> = Arc::new(
        (0..input_channels)
            .map(|_| std::sync::atomic::AtomicU32::new(0))
            .collect(),
    );
    let input_level_state = InputLevelState(input_level_arc.clone());
    let bleed_live_arc = Arc::new(Mutex::new((0.0f32, 0.0f32)));
    let bleed_state = BleedState(
        bleed_training_arc.clone(),
        bleed_result_arc.clone(),
        bleed_live_arc.clone(),
    );

    // Writing the session to disk. Nothing about it reaches the audio thread
    // except an atomic flag and a buffer to append to -- see `recorder.rs`.
    let recorder = Arc::new(crate::recorder::Recorder::new(input_channels));
    let recorder_state = RecorderState(recorder.clone());

    let log_state = LogState(Arc::new(Mutex::new(io_log)));

    let config = default_config();
    let config_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let config_state = ConfigState(Arc::new(Mutex::new(config)));

    let sample_output_buffer = SampleOutputBuffer {
        buffer: Default::default(),
        drained: Default::default(),
    };

    let calibration_arc = Arc::new(Mutex::new(Calibration::default()));
    let calibration_result_arc = Arc::new(Mutex::new(
        crate::calibration::CalibrationResult::default(),
    ));
    let calibration_state = CalibrationState(calibration_arc.clone(), calibration_result_arc.clone());

    let analysis_output_buffer = AnalysisOutputBuffer {
        buffer: Default::default(),
        drained: Default::default(),
    };

    let loop_buffer_size: usize;
    {
        let c = config_state.0.lock().unwrap();
        loop_buffer_size = get_loop_buffer_size(&c);
    }
    let loop_buffer = LoopBuffer {
        channels: vec![vec![0f32; loop_buffer_size]; input_channels],
        pos: 0,
    };
    let loop_buffer_mutex_arc = Arc::new(Mutex::new(loop_buffer));
    let loop_buffer_state = LoopBufferState(loop_buffer_mutex_arc.clone());

    let should_reset_beat_arc = Arc::new(AtomicBool::new(false));
    let should_reset_beat_state = BeatResetState(should_reset_beat_arc.clone());

    // The render callback's state, sized for this device's channel count and
    // rate. Everything it shares with the commands is one of the handles
    // above; the same `Arc`s go to Tauri as managed state below.
    let mut engine = Engine::new(
        EngineShared {
            config: config_state.0.clone(),
            config_ready: config_ready.clone(),
            reset_beat: should_reset_beat_arc.clone(),
            loop_buffer: loop_buffer_mutex_arc.clone(),
            mp3: mp3.clone(),
            drum_samples: drum_samples_arc.clone(),
            calibration: calibration_arc.clone(),
            bleed_training: bleed_training_arc.clone(),
            bleed_live: bleed_live_arc.clone(),
            loop_guard_live: loop_guard_arc.clone(),
            input_levels: input_level_arc.clone(),
            recorder: recorder.clone(),
            samples: sample_output_buffer.buffer.clone(),
            analysis: analysis_output_buffer.buffer.clone(),
        },
        input_channels,
        sample_rate(),
    );
    // Assembled here, per block, from the per-channel queues: the core takes
    // one interleaved block rather than knowing there are queues at all.
    let mut input_block = vec![0f32; 4096 * input_channels];

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

        // Every channel drained, whatever the core goes on to do with the
        // block: `make_buffers` hands out the same queue to both ends, so an
        // undrained one grows without bound and replays the backlog afterwards.
        let c_in = buffers.len();
        debug_assert_eq!(c_in, engine.input_channels());
        for i in 0..num_frames {
            for (ch, buffer) in buffers.iter_mut().enumerate() {
                input_block[i * c_in + ch] = buffer.pop_front().unwrap_or(0.0);
            }
        }
        drop(buffers);

        let mut channels = data.channels_mut();
        if let (Some(left), Some(right)) = (channels.next(), channels.next()) {
            engine.process(&input_block[..num_frames * c_in], [left, right]);
        }
        Ok(())
    })?;
    output_audio_unit.start()?;

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            watch_device_changes(app.handle().clone());
            tauri::async_runtime::spawn(check_for_update_at_launch(app.handle().clone()));
            Ok(())
        })
        .menu(menu_with_restart)
        .on_menu_event(|app, event| {
            if event.id() == RESTART_MENU_ID {
                // Relaunches the bundle and exits this process. On macOS
                // `restart` reads Info.plist to find the binary, so the .app
                // comes back rather than the bare executable -- which matters
                // here, since only the bundle has the microphone grant (see the
                // packaging notes in CLAUDE.md).
                app.restart();
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
        .manage(bleed_state)
        .manage(loop_guard_state)
        .manage(input_level_state)
        .manage(kit_state)
        .manage(drum_samples_state)
        .manage(ConfigReady(config_ready))
        .manage(recorder_state)
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
            get_bleed_status,
            get_loop_guard,
            get_input_levels,
            get_kit,
            start_bleed_training,
            cancel_bleed_training,
            cancel_calibration,
            load_drum_sample,
            get_presets,
            set_presets,
            quarantine_presets,
            import_presets,
            export_presets,
            start_recording,
            stop_recording,
            get_recording_status,
        ])
        .run(context)
        .expect("error while running tauri application");

    println!("next line after tauri builder");

    Ok(())
}
