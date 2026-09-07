import {
  JsConfig,
  JsConfigKey,
  NumberExpr,
  NumberListExpr,
  RustConfig,
  RustConfigKey,
  RustExprKey,
  ViewConfig,
  MAX_VIEW_SIDE,
  numExpr,
  copyView,
  defaultJsConfig,
  defaultRustConfig,
  defaultViewConfig,
  isJsConfigKey,
  isRustConfigKey,
  usableRhythmVal,
} from "./config";
import { formatNumberList } from "./expression";

const STORAGE_KEY = "tpb.presets.v1";
const SESSION_KEY = "tpb.session.v1";

// Empty since the canvas size stopped being config at all -- each pane measures
// its own box. Kept because the mechanism is what a transient js key needs, and
// the next one shouldn't have to rediscover that presets would otherwise
// restore it.
const TRANSIENT_JS_KEYS: JsConfigKey[] = [];

// Transport state rather than configuration -- saving a preset while paused
// shouldn't make loading it later pause the app.
const TRANSIENT_RUST_KEYS: RustConfigKey[] = ["paused"];

export type Preset = {
  rust: Partial<RustConfig>;
  js: Partial<JsConfig>;
};

export type Presets = Record<string, Preset>;

// The settings that are now per-view used to sit at the top level of the js
// config, back when there was only one pane. `pickKnownKeys` drops keys it
// doesn't recognise, so without this an upgrade would silently reset someone's
// rows, margins and grids to the defaults.
const LEGACY_VIEW_KEYS: (keyof ViewConfig)[] = [
  "beatsPerRow",
  "marginLeft",
  "marginRight",
  "grids",
  "visualGain",
  "barColorMode",
  "refreshAtCycleEnd",
  "splitChannels",
];

// Same hazard as the view fields: a session written before these took
// expressions stores a bare number, and restore merges it *over* the default
// object. Wrapped rather than renamed so saved bpm and buffer compensation
// survive the upgrade.
const RUST_EXPR_KEYS: RustExprKey[] = [
  "bpm",
  "beatsToLoop",
  "loopEchoes",
  "loopEchoGain",
  "clickVolume",
  "clickShift",
  "audioInGain",
  "bufferCompensation",
  "analysisBandLow",
  "analysisBandHigh",
  "onsetThreshold",
  "onsetMinGap",
  "onsetOffset",
  "fileVolume",
  "fileBeats",
  "fileOffsetMs",
  "fileShift",
  "fileRepeatStart",
  "fileRepeatEnd",
];

// Keeps what was typed -- so the field still shows it, and still goes red --
// but swaps in a value the audio thread will accept. Without this, a session
// saved while a rhythm field held something degenerate comes back rejecting
// every config push, with no way to type your way out of it.
const sanitizeRhythm = (rhythm: unknown, fallback: unknown): unknown => {
  if (typeof rhythm !== "object" || rhythm === null) return fallback;
  const val = (rhythm as { val?: unknown }).val;
  if (Array.isArray(val) || usableRhythmVal(val)) return rhythm;
  return { ...(rhythm as object), val: (fallback as { val?: unknown })?.val };
};

const migrateRust = (rust: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...rust };
  for (const key of RUST_EXPR_KEYS) {
    if (typeof out[key] === "number") out[key] = numExpr(out[key] as number);
  }
  if ("audioSubdivisions" in out)
    out.audioSubdivisions = sanitizeRhythm(
      out.audioSubdivisions,
      defaultRustConfig.audioSubdivisions
    );
  if (Array.isArray(out.drums))
    out.drums = (out.drums as unknown[]).map((d) =>
      typeof d === "object" && d !== null
        ? {
            ...d,
            rhythm: sanitizeRhythm(
              (d as { rhythm?: unknown }).rhythm,
              defaultRustConfig.drums[0].rhythm
            ),
          }
        : d
    );
  return out;
};

const clampSide = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.min(MAX_VIEW_SIDE, Math.max(1, Math.floor(n)))
    : 1;

// `beatsPerRow`, the margins and `visualGain` were plain numbers before they
// took expressions. Restore merges saved values *over* the defaults, so the old
// shape lands on top of the new one and `Math.max(...beatsPerRow)` comes back
// NaN -- a blank pane, the loopFeedback trap again. Wrapped here rather than
// renamed out of the way, because a rename would throw away saved layouts.
const wrapNumber = (val: unknown, fallback: NumberExpr): NumberExpr => {
  if (typeof val === "number" && Number.isFinite(val))
    return { inputText: String(val), val };
  return typeof val === "object" && val !== null && "val" in val
    ? (val as NumberExpr)
    : fallback;
};

const wrapList = (val: unknown, fallback: NumberListExpr): NumberListExpr => {
  if (Array.isArray(val))
    return { inputText: formatNumberList(val as number[]), val };
  return typeof val === "object" && val !== null && "val" in val
    ? (val as NumberListExpr)
    : fallback;
};

// Merging over the defaults is what lets a view saved by an older build pick up
// keys added since, the same way the top-level config already worked.
const normalizeView = (
  view: unknown,
  // What the session's channels were when every pane shared one list. A view
  // saved before the split has none of its own, and defaulting it to channel 0
  // would quietly drop whatever was on screen.
  legacyChannels: number[]
): ViewConfig => {
  const base = { ...defaultViewConfig(), channels: legacyChannels };
  if (typeof view !== "object" || view === null) return base;
  const merged = { ...base, ...(view as Partial<ViewConfig>) };
  return {
    ...merged,
    channels: Array.isArray(merged.channels) ? merged.channels : base.channels,
    beatsPerRow: wrapList(merged.beatsPerRow, base.beatsPerRow),
    marginLeft: wrapNumber(merged.marginLeft, base.marginLeft),
    marginRight: wrapNumber(merged.marginRight, base.marginRight),
    visualGain: wrapNumber(merged.visualGain, base.visualGain),
  };
};

// Folds a pre-views js config into one view, then squares the list up with the
// arrangement so `views.length === viewCols * viewRows` always holds.
const migrateViews = (
  js: Record<string, unknown>,
  legacyChannels: number[]
): Record<string, unknown> => {
  const out = { ...js };

  if (!Array.isArray(out.views)) {
    const legacy: Partial<ViewConfig> = {};
    for (const key of LEGACY_VIEW_KEYS) {
      if (key in out) (legacy as Record<string, unknown>)[key] = out[key];
    }
    out.views = [{ ...defaultViewConfig(), channels: legacyChannels, ...legacy }];
    out.viewCols = 1;
    out.viewRows = 1;
  }

  const views = (out.views as unknown[]).map((v) =>
    normalizeView(v, legacyChannels)
  );
  const cols = clampSide(out.viewCols);
  const rows = clampSide(out.viewRows);
  const wanted = cols * rows;
  // A new pane starts from the first one rather than the defaults -- adding a
  // column is nearly always "show me this again, but against another grid".
  while (views.length < wanted) views.push(copyView(views[0] ?? defaultViewConfig()));
  views.length = wanted;

  out.views = views;
  out.viewCols = cols;
  out.viewRows = rows;
  return out;
};

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
  const rustOut = migrateRust(
    typeof rust === "object" && rust !== null
      ? (rust as Record<string, unknown>)
      : {}
  );
  // The panes' channel lists are migrated from the rust side's, which is where
  // channel visibility lived before it became per-pane.
  const legacyChannels = Array.isArray(rustOut.visibleChannels)
    ? (rustOut.visibleChannels as number[])
    : defaultRustConfig.visibleChannels;
  return {
    rust: pickKnownKeys<Partial<RustConfig>>(
      rustOut,
      isRustConfigKey,
      TRANSIENT_RUST_KEYS
    ),
    js: pickKnownKeys<Partial<JsConfig>>(
      migrateViews(
        typeof js === "object" && js !== null
          ? (js as Record<string, unknown>)
          : {},
        legacyChannels
      ),
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
