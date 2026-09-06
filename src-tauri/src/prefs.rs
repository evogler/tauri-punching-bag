use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Machine-local audio facts, deliberately kept *out* of the js config.
///
/// The split is: the config describes the music and the picture, this file
/// describes the hardware in front of it. Two reasons it can't just be a config
/// key. First, the device has to be chosen before `get_input_output_channels`
/// runs, which is before any window exists -- Rust cannot read localStorage, so
/// startup needs its own store. Second, a preset carrying a device UID or
/// someone else's latency measurement would be noise at best: presets are
/// musical settings and travel between machines, these do not.
///
/// The panel still owns the editing. The frontend writes here through
/// `set_audio_prefs` whenever the choice changes, so this file is a mirror of
/// what the UI already shows rather than a second thing to keep in sync.
#[derive(Serialize, Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioPrefs {
    /// Empty means "whatever macOS calls the default".
    #[serde(default)]
    pub input_uid: String,
    #[serde(default)]
    pub output_uid: String,
    /// `buffer_compensation`, in frames, keyed `input uid -> output uid`.
    ///
    /// **The pair, not the input alone.** What this number compensates for is
    /// the round trip: the click leaves at frame F, reaches your ears at
    /// F + L_out, you play in time with what you *hear*, and the mic hands
    /// those frames over at F + L_out + L_in. Both halves are in it, so
    /// swapping headphones for the interface's own output changes the answer.
    ///
    /// Frames rather than milliseconds because that is the unit the config key
    /// has always been in -- and because a device implies its own sample rate,
    /// a per-device frame count absorbs the 44.1/48 difference on its own.
    ///
    /// Nested rather than a joined `"in|out"` string so the file stays legible
    /// by hand, and named `pairCompensations` rather than reusing the old
    /// input-only `compensations`: serde drops the unknown field, so a file
    /// written before this reverts to the default instead of being silently
    /// reinterpreted with different semantics. Rename rather than redefine --
    /// the same rule the config keys follow.
    #[serde(default)]
    pub pair_compensations: HashMap<String, HashMap<String, f64>>,
}

fn prefs_path(dir: &Path) -> PathBuf {
    dir.join("audio-prefs.json")
}

/// Never fails: a missing, unreadable or malformed file means defaults, which
/// is "use the system default device". Refusing to start because a preferences
/// file got corrupted would be a worse outcome than picking the wrong mic.
pub fn load(dir: &Path) -> AudioPrefs {
    match std::fs::read_to_string(prefs_path(dir)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            println!("audio prefs unreadable ({}), using defaults", e);
            AudioPrefs::default()
        }),
        Err(_) => AudioPrefs::default(),
    }
}

pub fn save(dir: &Path, prefs: &AudioPrefs) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(prefs_path(dir), text).map_err(|e| e.to_string())
}
