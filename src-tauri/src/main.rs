#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// The whole app is the library (`lib.rs`), because iOS links it as a static
// library into an Xcode project and calls `run` from there. On the Mac this
// binary is all there is to the entry point.
fn main() {
    app_lib::run()
}
