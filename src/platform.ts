import { invoke } from "@tauri-apps/api/core";
import { BROWSER_DEBUG_MODE } from "./env";

// Which platform the app is running on, asked of Rust once before the first
// render. The user agent will not do: an iPad's webview claims to be a Mac.
// Module-level like the sample rate, because it never changes while the app
// runs and several components that have no props for it need to ask.
let current = "macos";

export const initPlatform = async () => {
  if (BROWSER_DEBUG_MODE) return;
  try {
    current = await invoke<string>("get_platform");
  } catch {
    // An older backend without the command is the Mac.
  }
};

/** iOS hides what it cannot do rather than breaking it: the device picker
 *  (the system routes), the global shortcut and the updater. */
export const isIOS = () => current === "ios";
