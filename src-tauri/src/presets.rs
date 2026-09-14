use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The preset store, beside `audio-prefs.json` in the app config dir.
///
/// Rust deliberately does not know what a preset *is*. It moves text: the
/// format, the migrations and every decision about what is a valid preset stay
/// on the frontend, where the config types already live. All this file owns is
/// that the bytes survive.
///
/// Presets used to live in localStorage, which is a WebKit database inside the
/// app container -- readable by nothing and reachable by nobody. This directory
/// is the one the app already asks people to be able to look at.
fn store_path(dir: &Path) -> PathBuf {
    dir.join("presets.json")
}

/// An empty string means "no store yet", which is what the frontend migrates
/// the old localStorage presets into. Distinguished from an *unreadable* file,
/// which is an error: silently answering "no presets" for a file that is right
/// there is how a store gets overwritten with nothing.
pub fn load(dir: &Path) -> Result<String, String> {
    let path = store_path(dir);
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))
}

/// Written to a temporary file and renamed, because this is now the only copy
/// of someone's presets. `audio-prefs.json` can afford a half-written file --
/// the worst case is re-choosing a device -- and this cannot.
pub fn save(dir: &Path, text: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("presets.json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {}", tmp.display(), e))?;
    std::fs::rename(&tmp, store_path(dir)).map_err(|e| e.to_string())
}

/// Moved aside rather than replaced. A store that will not parse still holds
/// everything someone saved, and the next ordinary save would write an empty
/// one straight over it. Returns the name it was given, so the panel can say
/// where the old one went instead of only that something was wrong.
pub fn quarantine(dir: &Path) -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("presets.corrupt-{}.json", stamp);
    std::fs::rename(store_path(dir), dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Import and export both go through Rust rather than the `fs` API, whose
/// allowlist scope is `$RESOURCE/*`. The path comes from a native dialog the
/// user just clicked through, which is the same trust `load_drum_sample` and
/// `set_mp3_buffer` already run on.
pub fn read_file(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{}: {}", path, e))
}

pub fn write_file(path: &str, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| format!("{}: {}", path, e))
}
