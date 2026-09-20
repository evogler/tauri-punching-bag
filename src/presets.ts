import {
  JsConfig,
  JsConfigKey,
  NumberExpr,
  NumberListExpr,
  RustConfig,
  RustConfigKey,
  RustExprKey,
  ViewConfig,
  MAX_ROW_COLUMNS,
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
import { Rect, fitViews, readingOrderRect } from "./paneLayout";
import { invoke } from "@tauri-apps/api";

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

// Keys that describe the *machine* rather than the music. A preset travels
// between machines and between input/output pairs, where a latency figure
// measured somewhere else is noise -- `audio-prefs.json` already holds this one
// per device pair, which is the right home for it.
//
// Excluded from presets and the session, and carried *across* a preset load
// rather than reset with everything else. Both halves are needed: without the
// exclusion a preset overwrote the measured value, and the write-back effect
// then saved that number into `audio-prefs.json` for the current pair --
// clobbering a calibration you would have to measure again. Without the
// carry-across, merging over the defaults resets it to 4330 and the same effect
// saves *that*.
export const LOCAL_RUST_KEYS: RustConfigKey[] = ["bufferCompensation"];

// What a preset load must not touch: the transport it was started from, and
// anything belonging to this machine.
export const KEPT_RUST_KEYS: RustConfigKey[] = [
  ...TRANSIENT_RUST_KEYS,
  ...LOCAL_RUST_KEYS,
];

export type Preset = {
  rust: Partial<RustConfig>;
  js: Partial<JsConfig>;
};

/// A preset as it is stored: the settings, plus the metadata the list needs.
///
/// An array with the name as a property rather than a map keyed by name,
/// because a map had nowhere to put the metadata -- and the metadata is what
/// the sort orders and the duplicate detection are built on.
export type StoredPreset = Preset & {
  /** Stable across edits: "this is the same preset, changed". */
  id: string;
  name: string;
  /** ISO. */
  created: string;
  /** ISO. Stamped on load, so "recently used" means something. */
  lastUsed?: string;
};

/// One format for the store and for an exported file, so import has a single
/// parser and "export everything" and "export this one" differ only in how
/// many entries they carry. `app` and `exported` are for whoever opens the
/// file a year from now; nothing reads them.
export type PresetFile = {
  format: string;
  version: number;
  app?: string;
  exported?: string;
  presets: StoredPreset[];
};

export const PRESET_FORMAT = "tauri-punching-bag presets";
export const PRESET_VERSION = 1;

// Written into the first file this ever produces. A format with no version has
// nothing for a migration to key off, and redefining a shape in place is the
// mistake this codebase has already made twice (`loopFeedback`, `beatsPerRow`).

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
  "highPassHz",
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
  // The old onset threshold of 0.05 was wrong by roughly an order of magnitude
  // -- see the note beside `onsetThreshold` in config.ts -- so a session or a
  // preset carrying it is carrying a number nobody chose. Restore merges saved
  // values *over* the defaults, which would otherwise leave every existing
  // install with the flood of false onsets the new default exists to fix: the
  // `loopFeedback` trap, arrived at from the value side rather than the
  // meaning side. Only *exactly* the old default is replaced -- any other
  // number was typed on purpose.
  const oldThreshold = out.onsetThreshold as NumberExpr | undefined;
  if (oldThreshold && oldThreshold.val === 0.05)
    out.onsetThreshold = defaultRustConfig.onsetThreshold;

  // Same treatment, same reason: the onset trim defaulted to 0 while every
  // sound measured came back late, so a saved 0 is not a choice to leave the
  // bias in -- it is what the default was before anyone measured it. Exactly
  // 0 moves; any other number, including a 0 somebody typed back deliberately,
  // is indistinguishable from that and is the price of the rule.
  const oldOffset = out.onsetOffset as NumberExpr | undefined;
  if (oldOffset && oldOffset.val === 0)
    out.onsetOffset = defaultRustConfig.onsetOffset;

  if ("audioSubdivisions" in out)
    out.audioSubdivisions = sanitizeRhythm(
      out.audioSubdivisions,
      defaultRustConfig.audioSubdivisions
    );
  // `clickToggle` was two halves of a double-length loop: sound for
  // `beatsToLoop`, silence for the next. That is two sections, so a session
  // that had it on comes back doing the same thing rather than silently losing
  // the practice setup. Retired rather than kept alongside: two mechanisms both
  // gating the click and the drums is exactly the tangle sections exist to
  // avoid.
  if (out.clickToggle && !Array.isArray(out.sections)) {
    const beats = wrapNumber(out.beatsToLoop, numExpr(4));
    const drums = Array.isArray(out.drums)
      ? (out.drums as unknown[]).map((_, i) => i)
      : [];
    out.sections = [
      { on: true, beats, click: true, show: true, drums },
      { on: true, beats, click: false, show: true, drums: [] },
    ];
    out.sectionsOn = true;
  }
  if ("sectionOrder" in out)
    out.sectionOrder = wrapList(out.sectionOrder, { inputText: "", val: [] });
  // A hand-written preset can put a bare array here; restore merges it *over*
  // the default object, which is the loopFeedback trap in its list form.
  if ("loopRecordCycle" in out)
    out.loopRecordCycle = wrapList(
      out.loopRecordCycle,
      defaultRustConfig.loopRecordCycle
    );
  // A hand-written preset, or one saved before the length took expressions.
  if (Array.isArray(out.sections))
    out.sections = (out.sections as unknown[]).map((sec) =>
      typeof sec === "object" && sec !== null
        ? {
            ...sec,
            beats: wrapNumber((sec as { beats?: unknown }).beats, numExpr(4)),
          }
        : sec
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

// A pane saved before the rows could be wrapped has no `rowColumns` at all, and
// the merge over the defaults already gives it 1. This is for a stored value of
// the wrong shape or an absurd one -- the layout would divide the pane's width
// by it, so a 0 or a NaN is a pane with no pixels in it.
const clampRowColumns = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n)
    ? Math.min(MAX_ROW_COLUMNS, Math.max(1, Math.floor(n)))
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

// The fallback is widened because the row colour patterns are declared as
// `NumberListExpr | number[]` -- the bare-array branch a pre-expression session
// lands on -- so a *default* can arrive as either shape too.
const wrapList = (
  val: unknown,
  fallback: NumberListExpr | number[]
): NumberListExpr => {
  if (Array.isArray(val))
    return { inputText: formatNumberList(val as number[]), val };
  if (typeof val === "object" && val !== null && "val" in val)
    return val as NumberListExpr;
  return Array.isArray(fallback)
    ? { inputText: formatNumberList(fallback), val: fallback }
    : fallback;
};

// Whether a stored pane says where it sits. Partial placement is not a shape
// anything ever wrote, so all four fields are required together: mixing a saved
// `col` with a derived `row` would put a pane somewhere nobody asked for.
const PLACEMENT_KEYS: (keyof Rect)[] = ["col", "row", "colSpan", "rowSpan"];
export const hasPlacement = (view: unknown) =>
  typeof view === "object" &&
  view !== null &&
  PLACEMENT_KEYS.every((k) =>
    Number.isFinite((view as Record<string, unknown>)[k] as number)
  );

// Merging over the defaults is what lets a view saved by an older build pick up
// keys added since, the same way the top-level config already worked.
const normalizeView = (
  view: unknown,
  // What the session's channels were when every pane shared one list. A view
  // saved before the split has none of its own, and defaulting it to channel 0
  // would quietly drop whatever was on screen.
  legacyChannels: number[],
  // Where this pane sat before placement existed: its position in the array,
  // read left to right and then down. The defaults put every pane in the top
  // left cell, and merging a placement-less saved pane over that would stack
  // the whole layout in one corner -- the `loopFeedback` trap, in the one place
  // where it would be visible immediately and destructive to a hand-built
  // layout. Derived rather than defaulted for exactly that reason.
  fallback: Rect
): ViewConfig => {
  const base = { ...defaultViewConfig(), channels: legacyChannels };
  if (typeof view !== "object" || view === null) return { ...base, ...fallback };
  const merged = { ...base, ...(view as Partial<ViewConfig>) };
  return {
    ...merged,
    ...(hasPlacement(view) ? {} : fallback),
    // A pane saved before names existed has none, and the merge above already
    // gives it the default; the guard is for a stored value of the wrong shape,
    // which the draw path would otherwise hand to `fillText`.
    name: typeof merged.name === "string" ? merged.name : base.name,
    channels: Array.isArray(merged.channels) ? merged.channels : base.channels,
    beatsPerRow: wrapList(merged.beatsPerRow, base.beatsPerRow),
    rowColumns: clampRowColumns(merged.rowColumns),
    rowColorPattern: wrapList(merged.rowColorPattern, base.rowColorPattern),
    rowColorPatternDown: wrapList(
      merged.rowColorPatternDown,
      base.rowColorPatternDown
    ),
    marginLeft: wrapNumber(merged.marginLeft, base.marginLeft),
    marginRight: wrapNumber(merged.marginRight, base.marginRight),
    visualGain: wrapNumber(merged.visualGain, base.visualGain),
  };
};

// Folds a pre-views js config into one view, gives every pane a placement, and
// puts the result through the one function that enforces the layout invariant.
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

  const raw = out.views as unknown[];
  const cols = clampSide(out.viewCols);
  const rows = clampSide(out.viewRows);
  // A session or preset written before placement existed had exactly one pane
  // per cell, in reading order, and must come back looking identical. One that
  // was written since says where its panes go and must *not* be padded -- an
  // empty cell is a layout, not a gap to fill.
  const legacyLayout = !raw.some(hasPlacement);
  const views = raw.map((v, i) =>
    normalizeView(v, legacyChannels, readingOrderRect(i, cols))
  );
  if (legacyLayout) {
    // A new pane starts from the first one rather than the defaults -- adding a
    // column is nearly always "show me this again, but against another grid".
    while (views.length < cols * rows)
      views.push({
        ...copyView(views[0] ?? defaultViewConfig()),
        ...readingOrderRect(views.length, cols),
      });
  }

  out.views = fitViews(views, cols, rows);
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
    KEPT_RUST_KEYS
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
      KEPT_RUST_KEYS
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

// `crypto.randomUUID` needs a secure context and the webview is served from
// `tauri://localhost`, so this does not reach for it. An id here only has to be
// unique among one person's presets.
export const newPresetId = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Keys in a *sorted* order before hashing. A config built fresh and one
// restored from JSON hold the same values in different key orders, so without
// this every round trip would look like a different preset.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.keys(value as object)
      .sort()
      .reduce<Record<string, unknown>>((out, k) => {
        out[k] = canonical((value as Record<string, unknown>)[k]);
        return out;
      }, {});
  return value;
};

// cyrb53. Not a cryptographic hash and does not need to be -- it answers "are
// these the same settings" over a list of dozens.
const cyrb53 = (text: string) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/// "Are these the same settings, under whatever name?" -- the question an `id`
/// cannot answer, since a preset someone re-saved under a new name has a new
/// id and identical contents.
///
/// **Computed, never stored.** A stored hash is wrong the moment a preset is
/// edited, and a derived value that can go stale is exactly the trap the
/// expression fields' `val` rules exist to avoid.
export const presetHash = (preset: Preset) =>
  cyrb53(JSON.stringify(canonical({ rust: preset.rust, js: preset.js })));

export const makeStored = (name: string, preset: Preset): StoredPreset => ({
  ...preset,
  id: newPresetId(),
  name,
  created: new Date().toISOString(),
});

/// `"groove"` -> `"groove (1)"` -> `"groove (2)"`, incrementing past whatever
/// is taken rather than stopping at the first suffix.
export const uniqueName = (name: string, taken: Iterable<string>) => {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  let i = 1;
  while (used.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
};

export type ParsedPresetFile = {
  presets: StoredPreset[];
  /** Entries that were there and could not be read. */
  skipped: number;
  /** Set when the *file* is unusable, in which case nothing is offered. */
  error?: string;
};

/// A corrupt file is refused; a corrupt *entry* inside a good file is skipped
/// and counted. Nine readable presets out of ten are worth having, and
/// refusing the lot over one hand-edited entry is the worse outcome.
export const parsePresetFile = (text: string): ParsedPresetFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { presets: [], skipped: 0, error: "not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null)
    return { presets: [], skipped: 0, error: "not a preset file" };
  const file = parsed as Partial<PresetFile>;
  if (!Array.isArray(file.presets))
    return { presets: [], skipped: 0, error: "no presets in it" };
  if (typeof file.version === "number" && file.version > PRESET_VERSION)
    return {
      presets: [],
      skipped: 0,
      error: `saved by a newer version of the app (format ${file.version})`,
    };

  const presets: StoredPreset[] = [];
  let skipped = 0;
  for (const entry of file.presets) {
    const raw = entry as Partial<StoredPreset> | null;
    const sanitized = raw ? sanitizePreset(raw) : null;
    if (!sanitized || typeof raw?.name !== "string" || !raw.name.trim()) {
      skipped++;
      continue;
    }
    presets.push({
      ...sanitized,
      id: typeof raw.id === "string" && raw.id ? raw.id : newPresetId(),
      name: raw.name,
      created:
        typeof raw.created === "string" ? raw.created : new Date().toISOString(),
      lastUsed: typeof raw.lastUsed === "string" ? raw.lastUsed : undefined,
    });
  }
  return { presets, skipped };
};

export const formatPresetFile = (presets: StoredPreset[], app?: string) =>
  JSON.stringify(
    {
      format: PRESET_FORMAT,
      version: PRESET_VERSION,
      ...(app ? { app } : {}),
      exported: new Date().toISOString(),
      presets,
    },
    null,
    2
  );

// `yarn start` runs the frontend with no Rust behind it, so the store falls
// back to localStorage there. Deliberately a presence check rather than a
// try/catch around the command: a *failing* command in the real app must not
// silently split the store in two.
const HAS_TAURI = "__TAURI_IPC__" in window;
const FALLBACK_KEY = "tpb.presets.v2";

const readFallback = (): StoredPreset[] => {
  try {
    return parsePresetFile(window.localStorage.getItem(FALLBACK_KEY) ?? "")
      .presets;
  } catch (e) {
    return [];
  }
};

/// The presets the *old* store holds, migrated to the new shape. Read only
/// when `presets.json` does not exist yet, and **the original is left in
/// place**: the cost of the stale copy is nothing, and the cost of the
/// alternative is somebody's presets if anything about the move goes wrong --
/// including running an older build afterwards.
const readLegacyPresets = (): StoredPreset[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const out: StoredPreset[] = [];
    const created = new Date().toISOString();
    for (const [name, preset] of Object.entries(parsed)) {
      const sanitized = sanitizePreset(preset);
      if (sanitized)
        out.push({ ...sanitized, id: newPresetId(), name, created });
    }
    return out;
  } catch (e) {
    console.error("failed to read the old presets", e);
    return [];
  }
};

export type StoreLoad = {
  presets: StoredPreset[];
  /** Shown in the panel. Set when something needed saying, never on success. */
  note?: string;
};

export const loadStore = async (): Promise<StoreLoad> => {
  if (!HAS_TAURI) return { presets: readFallback() };
  let text: string;
  try {
    text = await invoke<string>("get_presets");
  } catch (e) {
    return { presets: [], note: `could not read presets.json: ${e}` };
  }
  if (!text.trim()) {
    const migrated = readLegacyPresets();
    if (migrated.length) await saveStore(migrated);
    return { presets: migrated };
  }
  const parsed = parsePresetFile(text);
  if (parsed.error) {
    // Moved aside rather than replaced: the next ordinary save would otherwise
    // write an empty store straight over everything someone had.
    let moved = "";
    try {
      moved = await invoke<string>("quarantine_presets");
    } catch (e) {
      return {
        presets: [],
        note: `presets.json could not be read (${parsed.error}) and could not be moved aside -- nothing has been saved over it`,
      };
    }
    return {
      presets: [],
      note: `presets.json could not be read (${parsed.error}); the old one is kept as ${moved}`,
    };
  }
  return {
    presets: parsed.presets,
    note: parsed.skipped
      ? `${parsed.skipped} preset${parsed.skipped > 1 ? "s" : ""} in presets.json could not be read and were left out`
      : undefined,
  };
};

export const saveStore = async (presets: StoredPreset[]): Promise<string> => {
  const text = formatPresetFile(presets);
  if (!HAS_TAURI) {
    try {
      window.localStorage.setItem(FALLBACK_KEY, text);
    } catch (e) {
      return `could not save presets: ${e}`;
    }
    return "";
  }
  try {
    await invoke("set_presets", { text });
  } catch (e) {
    return `could not save presets: ${e}`;
  }
  return "";
};

export const readPresetFileAt = (path: string) =>
  invoke<string>("import_presets", { path });

export const writePresetFileAt = (path: string, text: string) =>
  invoke("export_presets", { path, text });

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
