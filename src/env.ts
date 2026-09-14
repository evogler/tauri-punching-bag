// True only in a plain browser (`yarn start`), where there's no Rust backend to
// call, so samples are faked. Inside the Tauri app -- dev or release -- the IPC
// global is injected and we always use real samples.
export const BROWSER_DEBUG_MODE = !("__TAURI_IPC__" in window);
