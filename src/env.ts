import { isTauri } from "@tauri-apps/api/core";

// True only in a plain browser (`yarn start`), where there's no Rust backend to
// call, so samples are faked. Inside the Tauri app -- dev or release -- Tauri
// marks the page and we always use real samples. `isTauri` rather than naming
// the global: v1's was `__TAURI_IPC__`, v2 has none by that name, and a check
// against the old one silently put the whole real app into browser mode.
export const BROWSER_DEBUG_MODE = !isTauri();
