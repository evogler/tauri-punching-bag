import {
  JsConfig,
  JsConfigKey,
  RustConfig,
  RustConfigKey,
  defaultJsConfig,
  defaultRustConfig,
  isJsConfigKey,
  isRustConfigKey,
} from "./config";

const STORAGE_KEY = "tpb.presets.v1";
const SESSION_KEY = "tpb.session.v1";

// Derived from the window size on every resize, so a preset must not restore
// stale values over them.
const TRANSIENT_JS_KEYS: JsConfigKey[] = ["canvasHeight", "canvasWidth"];

// Transport state rather than configuration -- saving a preset while paused
// shouldn't make loading it later pause the app.
const TRANSIENT_RUST_KEYS: RustConfigKey[] = ["paused"];

export type Preset = {
  rust: Partial<RustConfig>;
  js: Partial<JsConfig>;
};

export type Presets = Record<string, Preset>;

const pickKnownKeys = <T,>(
  obj: Record<string, unknown>,
  isKnownKey: (k: string) => boolean,
  skip: string[] = []
) => {
  const out: Record<string, unknown> = {};
  for (const key in obj) {
    if (isKnownKey(key) && !skip.includes(key)) out[key] = obj[key];
  }
  return out as T;
};

export const makePreset = (
  rustConfig: RustConfig,
  jsConfig: JsConfig
): Preset => ({
  rust: pickKnownKeys<Partial<RustConfig>>(
    rustConfig,
    isRustConfigKey,
    TRANSIENT_RUST_KEYS
  ),
  js: pickKnownKeys<Partial<JsConfig>>(jsConfig, isJsConfigKey, TRANSIENT_JS_KEYS),
});

// Drops keys that no longer exist in the config, so presets saved by an older
// build still load. Keys added since the preset was saved keep their current
// value.
const sanitizePreset = (preset: unknown): Preset | null => {
  if (typeof preset !== "object" || preset === null) return null;
  const { rust, js } = preset as Record<string, unknown>;
  return {
    rust: pickKnownKeys<Partial<RustConfig>>(
      typeof rust === "object" && rust !== null
        ? (rust as Record<string, unknown>)
        : {},
      isRustConfigKey,
      TRANSIENT_RUST_KEYS
    ),
    js: pickKnownKeys<Partial<JsConfig>>(
      typeof js === "object" && js !== null
        ? (js as Record<string, unknown>)
        : {},
      isJsConfigKey,
      TRANSIENT_JS_KEYS
    ),
  };
};

export const readPresets = (): Presets => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const presets: Presets = {};
    for (const [name, preset] of Object.entries(parsed)) {
      const sanitized = sanitizePreset(preset);
      if (sanitized) presets[name] = sanitized;
    }
    return presets;
  } catch (e) {
    console.error("failed to read presets", e);
    return {};
  }
};

export const writePresets = (presets: Presets) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch (e) {
    console.error("failed to write presets", e);
  }
};

export const defaultPreset = (): Preset =>
  makePreset(defaultRustConfig, defaultJsConfig);

// The settings in use when the app last closed, so relaunching picks up where
// you left off. Stored as a preset and sanitized the same way, so a session left
// by an older build can't drag dead keys back in. Transient keys are excluded by
// makePreset, which is why relaunching never comes back paused or with a stale
// canvas size.
export const readSession = (): Preset | null => {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return sanitizePreset(JSON.parse(raw));
  } catch (e) {
    console.error("failed to read session", e);
    return null;
  }
};

export const writeSession = (preset: Preset) => {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(preset));
  } catch (e) {
    console.error("failed to write session", e);
  }
};
