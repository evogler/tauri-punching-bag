//! The log file, and the alert a launch failure raises.
//!
//! A bundled Mac app's stdout and stderr go nowhere a friend could find them,
//! so everything the app says about itself -- startup, devices, audio restarts,
//! a refused config push, a panic -- also goes to `microtime.log` in the app
//! config dir (`~/Library/Application Support/com.vogler.dev/`), where the
//! setup tab can reveal it.
//!
//! A `log` facade logger of our own rather than `tauri-plugin-log`, because the
//! plugin only exists once the Tauri builder runs, and the failures most worth
//! having in a file happen before that: the audio devices are opened, and can
//! refuse, before there is an app at all. Installing this first thing in `run`
//! catches those too, and Tauri's own `log::` output (the updater's, say) lands
//! in the same file for free.
//!
//! **Never call this from the audio thread.** A line takes a lock, formats into
//! a fresh `String` and writes to disk -- all three of the things a render
//! callback must not do. Nothing in `engine.rs` or the platform callbacks logs,
//! and nothing should. The one exception is a panic, which runs the hook on
//! whichever thread panicked: at that point the audio is already lost, and a
//! record of why is worth more than the callback's deadline.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const FILE_NAME: &str = "microtime.log";
const OLD_FILE_NAME: &str = "microtime.1.log";
/// One file is kept at up to this size and one previous one beside it, so the
/// log can never take more than twice this -- and 2 MB is still small enough
/// to attach to an email.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

struct Sink {
    file: File,
    path: PathBuf,
    written: u64,
}

static SINK: OnceLock<Mutex<Option<Sink>>> = OnceLock::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();

fn sink() -> &'static Mutex<Option<Sink>> {
    SINK.get_or_init(|| Mutex::new(None))
}

/// Where the log is written, once `init` has found a directory for it.
pub fn path() -> Option<&'static PathBuf> {
    PATH.get()
}

fn open(path: &Path) -> Option<Sink> {
    // Rotated at open as well as while running, so a log that grew to the cap
    // in one session starts the next one fresh rather than rotating on its
    // first line.
    if std::fs::metadata(path).map(|m| m.len() >= MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_file_name(OLD_FILE_NAME));
    }
    let file = OpenOptions::new().create(true).append(true).open(path).ok()?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some(Sink {
        file,
        path: path.to_path_buf(),
        written,
    })
}

fn write_to_file(sink: &mut Option<Sink>, line: &str) {
    let Some(s) = sink.as_mut() else { return };
    if s.written + line.len() as u64 > MAX_BYTES {
        let path = s.path.clone();
        let _ = std::fs::rename(&path, path.with_file_name(OLD_FILE_NAME));
        *sink = open(&path);
    }
    if let Some(s) = sink.as_mut() {
        if s.file.write_all(line.as_bytes()).is_ok() {
            s.written += line.len() as u64;
        }
    }
}

/// Local wall-clock time, because the question a log answers is "what
/// happened when it went wrong at about eight", asked by someone who will not
/// convert from UTC.
fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
        return format!("{}", now.as_secs());
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        now.subsec_millis()
    )
}

struct Logger;

// Our own crate is `app_lib`; everything else (tauri, wry, the updater) is
// only interesting when it warns.
fn is_ours(target: &str) -> bool {
    target == "app_lib" || target.starts_with("app_lib::")
}

fn wanted(level: log::Level, target: &str) -> bool {
    if is_ours(target) {
        // Debug reaches the terminal under `tauri dev`; see `log` below.
        level <= log::Level::Debug
    } else {
        level <= log::Level::Warn
    }
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        wanted(metadata.level(), metadata.target())
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        // The terminal gets what `println!` / `eprintln!` used to print, so
        // `yarn dev` and the iOS unified log look as they always did.
        if record.level() <= log::Level::Warn {
            eprintln!("{}", message);
        } else {
            println!("{}", message);
        }
        // Debug stays out of the file: it is where the whole config dump on
        // every keystroke goes, and that would fill the file in minutes.
        if record.level() > log::Level::Info {
            return;
        }
        let line = if is_ours(record.target()) {
            format!("{} {:<5} {}\n", timestamp(), record.level(), message)
        } else {
            format!("{} {:<5} [{}] {}\n", timestamp(), record.level(), record.target(), message)
        };
        let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
        write_to_file(&mut guard, &line);
    }

    fn flush(&self) {
        if let Ok(mut guard) = sink().lock() {
            if let Some(s) = guard.as_mut() {
                let _ = s.file.flush();
            }
        }
    }
}

static LOGGER: Logger = Logger;

/// Installs the logger and the panic hook. `dir` is the app config dir; with
/// none (iOS, or a machine with no config dir) lines still reach stdout and
/// stderr exactly as before, and simply are not kept.
pub fn init(dir: Option<&Path>, version: &str) {
    if let Some(dir) = dir {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join(FILE_NAME);
        if let Some(s) = open(&path) {
            *sink().lock().unwrap_or_else(|e| e.into_inner()) = Some(s);
            let _ = PATH.set(path);
        }
    }
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
    }
    log::info!(
        "---- Microtime {} starting ({} {}) ----",
        version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let line = format!(
            "{} PANIC on thread {}: {}\n{}\n",
            timestamp(),
            thread.name().unwrap_or("<unnamed>"),
            info,
            std::backtrace::Backtrace::force_capture()
        );
        // `try_lock`, never `lock`: a panic raised while this thread already
        // holds the sink -- inside a write -- would otherwise deadlock here
        // and the process would hang instead of dying.
        if let Ok(mut guard) = sink().try_lock() {
            write_to_file(&mut guard, &line);
            if let Some(s) = guard.as_mut() {
                let _ = s.file.flush();
            }
        }
        default_hook(info);
    }));
}

/// A failure before any window exists, said out loud and then exited on.
///
/// The bundled app has no terminal, so `eprintln!` alone meant a friend saw the
/// icon bounce in the Dock and vanish, with nothing anywhere to say why. This
/// logs the message, raises a native alert naming it and where the log is, and
/// exits.
///
/// `rfd`'s blocking alert rather than `NSAlert` by hand or `osascript`: it is
/// already in the tree through the dialog plugin, it is built for exactly this
/// -- a modal with no event loop running yet -- and it sets the activation
/// policy itself so the alert comes to the front of an app that has not
/// finished launching. `osascript` would put the alert in another process,
/// behind whatever the user was looking at. On iOS there is no such thing as
/// an alert without a window, so this only logs and exits, as it always did.
pub fn fatal(title: &str, message: &str) -> ! {
    log::error!("{}: {}", title, message);
    #[cfg(target_os = "macos")]
    {
        let body = match path() {
            Some(log) => format!("{}\n\nThe log is at {}", message, log.display()),
            None => message.to_string(),
        };
        alert(title, &body);
    }
    log::logger().flush();
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
pub fn alert(title: &str, body: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(title)
        .set_description(body)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
