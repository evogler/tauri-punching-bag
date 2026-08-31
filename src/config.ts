import parser1 from "./parser1";
import parser2 from "./parser2";
import {
  Params,
  evaluate,
  resolveRhythmText,
  parseNumberList,
} from "./expression";

// How a single input channel is drawn.
export type ChannelStyle = { color: string; alpha: number };

// Channel 0 keeps the old grey so a one-input setup looks exactly as it did.
export const CHANNEL_COLORS = [
  "#cccccc",
  "#ff5533",
  "#33cc66",
  "#ffcc00",
  "#cc66ff",
  "#00ddcc",
  "#ff66aa",
  "#aaff33",
];

// Styles are stored sparsely -- an untouched channel has no entry and falls back
// to the palette, so the list doesn't have to be sized to the device up front.
export const channelStyle = (
  styles: ChannelStyle[],
  index: number
): ChannelStyle =>
  styles[index] ?? {
    color: CHANNEL_COLORS[index % CHANNEL_COLORS.length],
    alpha: 1,
  };

// A drum sound with its own rhythm. `path` is either a built-in name or the
// absolute path the file was loaded from -- the same key Rust files it under.
export type DrumVoice = {
  path: string;
  on: boolean;
  volume: number;
  /// Milliseconds to start the sample early, so its transient lands on the beat
  /// however far into the file the attack actually sits.
  offset: number;
  /// Beats to push this part later in the cycle, so parts don't all land on
  /// one. Optional because voices saved before it existed don't carry it -- read
  /// it through drumShift rather than directly.
  shift?: number;
  /// Gain multipliers applied per hit, cycled by hit index and multiplied with
  /// `volume`. Length is independent of the rhythm's, so a list that doesn't
  /// divide evenly drifts in and out of phase with it. Optional for the same
  /// reason as `shift` -- read it through drumGains.
  gains?: number[];
  rhythm: Rhythm;
};

export const drumShift = (voice: DrumVoice) =>
  typeof voice.shift === "number" ? voice.shift : 0;

export const drumGains = (voice: DrumVoice) =>
  voice.gains && voice.gains.length ? voice.gains : [1];

export const BUILT_IN_DRUMS = ["ride"];

export const channelPan = (pans: number[], index: number) => pans[index] ?? 0;

export const drumLabel = (path: string) =>
  BUILT_IN_DRUMS.includes(path) ? path : path.split("/").pop() || path;

export type Parameter = { name: string; value: number };

// A field written as an expression over the parameters: the text typed, and the
// number it currently evaluates to. Same shape as `Rhythm`, so the recursive
// `unwrapValues` already strips it down to `val` on the way to Rust -- an
// expression-backed field costs nothing there if one ever moves across.
export type Expr<T> = { inputText: string; val: T };
export type NumberExpr = Expr<number>;
export type NumberListExpr = Expr<number[]>;

// The bare-value branches are the second line of defence behind
// `normalizeView`: restore merges saved values *over* the defaults, so a
// session written before these fields took expressions can put a plain number
// where an object is expected (the loopFeedback trap in CLAUDE.md).
export const exprNumber = (field: NumberExpr | number): number =>
  typeof field === "number" ? field : field?.val ?? 0;

export const exprList = (field: NumberListExpr | number[]): number[] =>
  Array.isArray(field) ? field : field?.val ?? [];

// Wraps a literal for a field that takes expressions. Defaults are written this
// way so the shape is uniform from the start; `normalizeRust`/`normalizeView`
// wrap the bare numbers that sessions written before it saved.
export const numExpr = (n: number): NumberExpr => ({
  inputText: String(n),
  val: n,
});

// Must match MAX_LOOP_ECHOES in src-tauri/src/constants.rs. Duplicated rather
// than plumbed across because it only guards the input here.
export const MAX_LOOP_ECHOES = 16;

// The rust-side fields that take expressions -- every numeric one that has a
// text input. The sliders and dropdowns keep plain numbers, having nowhere to
// type an expression.
export type RustExprKey =
  | "bpm"
  | "beatsToLoop"
  | "loopEchoes"
  | "loopEchoGain"
  | "clickVolume"
  | "audioInGain"
  | "bufferCompensation"
  | "analysisBandLow"
  | "analysisBandHigh"
  | "onsetThreshold"
  | "onsetMinGap"
  | "onsetOffset";

export const defaultRustConfig = {
	audioInGain: numExpr(1.0),
  audioMonitorOn: false,
  beatsToLoop: numExpr(4),
  // How many times a phrase comes back, one `beatsToLoop` apart each time.
  loopEchoes: numExpr(1),
  // Gain per echo, compounding: 1 keeps them all at full volume, below that the
  // run fades out. 0 silences everything after the first echo, so it is a gain,
  // not a "feedback amount" -- see the note in structs.rs on the rename.
  loopEchoGain: numExpr(1),
  bpm: numExpr(91),
  bufferCompensation: numExpr(4330),
  // Whether Rust runs the spectrogram FFTs at all. Off costs nothing on the
  // audio thread and sends nothing, so a session with no spectrogram pane can
  // switch it off. Not derived from the panes: that would mean writing rust
  // config from a render, which is a loop waiting to happen.
  analysisOn: true,
  // The band the spectral flux is summed over, in Hz. Wide by default -- it
  // spans everything the bin edges cover -- so the curve starts as the whole
  // picture and gets narrowed onto whatever you're listening for. Nothing in
  // the frontend reads these; they exist to reach the audio thread.
  analysisBandLow: numExpr(30),
  analysisBandHigh: numExpr(16000),
  // FFT window in frames, trading frequency resolution against time
  // resolution. A plain number, not an expression: it's a dropdown over
  // ANALYSIS_WINDOWS, with nowhere to type one. The hop -- and so the
  // spectrogram's column width and how precisely the flux places an attack --
  // is always a quarter of it.
  analysisWindow: 1024,
  // How far above its local median the flux has to peak to count as an attack.
  // Relative, not absolute, so one number holds across dynamics -- a hard
  // full-band onset measures around 2.3 and a sustaining note under 0.01.
  onsetThreshold: numExpr(0.05),
  // Milliseconds an onset suppresses further ones on the same channel. A single
  // attack spreads over a few hops and the peak test alone reports the
  // shoulders of a broad one.
  onsetMinGap: numExpr(40),
  // Milliseconds to nudge every onset, positive later. A trim on top of the
  // structural correction in analysis.rs, which is measured on an instant
  // attack; a slow-attack instrument sits differently. Calibrate against the
  // drums bus, whose trigger times the callback knows exactly.
  onsetOffset: numExpr(0),
  paused: false,
  // Which input channels get sent to the display, by device channel index.
  visibleChannels: [0] as number[],
  // Stereo position per input channel, -1 hard left to 1 hard right. Sparse:
  // a channel with no entry sits centred.
  channelPans: [] as number[],
  clickOn: true,
  clickToggle: false,
  clickVolume: numExpr(0.3),
  drumOn: true,
  loopingOn: false,
  playFile: true,
  audioSubdivisions: {
    inputText: "2:1",
    val: {
      notes: [{ time: 0, sounds: ["h"] }, { time: 0.5 }],
      start: 0,
      end: 1,
    },
    type: "parser2",
  } as Rhythm,
  visualMonitorOn: true,
  drums: [
    {
      path: "ride",
      on: true,
      volume: 1,
      offset: 0,
      shift: 0,
      gains: [1],
      rhythm: {
        inputText: "2:1",
        val: { notes: [{ time: 0 }, { time: 0.5 }], start: 0, end: 1 },
        type: "parser2",
      },
    },
  ] as DrumVoice[],
  testObject: {
    notes: [{ time: 0, sounds: ["h"] }, { time: 0.5 }],
    start: 0,
    end: 1,
  },
};

// A rhythm as it round-trips through the UI: the text the user typed, the
// parsed form the drawing code reads, and which parser produced it.
export type Rhythm = {
  inputText: string;
  val: {
    notes: { time: number; sounds?: string[] }[];
    start: number;
    end: number;
  };
  type: "parser1" | "parser2";
};

// One grid overlay on the waveform. Grids are drawn bottom-of-the-list first,
// so where two grids land on the same beat the one nearer the top of the list
// is what you see.
export type VisualGrid = {
  color: string;
  // 0..1. Optional because presets saved before opacity existed don't carry it;
  // read it through gridAlpha rather than directly.
  alpha?: number;
  subdivisions: Rhythm;
};

export const gridAlpha = (grid: VisualGrid) =>
  typeof grid.alpha === "number" ? grid.alpha : 1;

// Handed out in order to newly added grids so each one starts visually distinct
// without the user having to pick a color.
export const GRID_COLORS = [
  "#0088ff",
  "#ff5533",
  "#33cc66",
  "#ffcc00",
  "#cc66ff",
  "#00ddcc",
  "#ff66aa",
  "#aaff33",
];

// Offered in order when adding a row color, so consecutive swatches start out
// easy to tell apart.
export const ROW_COLORS = [
  "#33cc66",
  "#0088ff",
  "#ff5533",
  "#ffcc00",
  "#cc66ff",
  "#00ddcc",
  "#ff66aa",
  "#aaff33",
  "#ffffff",
  "#888888",
];

// A named number, so "switch to 16ths" is one edit rather than five. A list
// rather than a map because the panel needs a stable order to draw the rows in.
// One pane of the waveform display. Everything here is per-view, so two panes
// can show the same audio against different grids and row lengths -- looking
// back and forth between 16ths and triplets is the whole point of having more
// than one.
export type ViewConfig = {
  // What the y axis of the pane means: amplitude, or frequency. Everything
  // else -- rows, margins, grids, the sweep -- is shared between the two.
  kind: ViewKind;
  // Which *device* input channel the spectrogram shows. The analysis stream
  // carries the input channels in device order (up to Rust's cap), not the
  // `visibleChannels` subset, so this indexes it directly.
  spectrogramChannel: number;
  // Multiplies the normalised u8 magnitude, after the floor is subtracted.
  spectrogramGain: number;
  // 0..1 on the u8 scale: everything at or below it draws as background. The
  // dB range Rust sends is deliberately wide, so this is where the noise floor
  // actually gets chosen -- and changing it never pushes config across.
  spectrogramFloor: number;
  beatsPerRow: NumberListExpr;
  marginLeft: NumberExpr;
  marginRight: NumberExpr;
  grids: VisualGrid[];
  visualGain: NumberExpr;
  barColorMode: boolean;
  refreshAtCycleEnd: boolean;
  // Colors a row's waveform can take, in the order `rowColorPattern` indexes
  // them. Empty means rows keep the channel's own color, which is what every
  // pane did before this existed.
  rowColors: string[];
  // Which row takes which color, 1-based and cycled by row index, in the same
  // "1, 2x3" syntax as beatsPerRow. Only consulted when `rowColors` has more
  // than one entry; empty means every row takes the first color.
  rowColorPattern: number[];
  // Draw the spectral flux over the waveform, one bar per pixel column, in
  // each visible input channel's own colour. It arrives on the analysis stream
  // rather than the sample stream, so it is a second pass over the pane -- see
  // drawFlux in App.tsx.
  showFlux: boolean;
  // Mark each detected attack with a tick at the row's edge, in the channel's
  // colour. Discrete events rather than a curve, so unlike `showFlux` they
  // carry their own sub-hop beat and need no per-column accumulation.
  showOnsets: boolean;
  // Multiplies the flux before it is clamped to the row. A plain number, not an
  // expression: it's a slider, with nowhere to type one. Well below 1 by
  // default because a hard full-band attack measures around 2.3 -- the flux is
  // normalised so a threshold can be a single setting, not so it fills a row.
  fluxGain: number;
  // Draw the first visible channel above the centre line and the second below,
  // instead of overlaying them. With more than two, even slots go up and odd
  // slots go down.
  splitChannels: boolean;
};

// A factory rather than a constant: each view needs grid and row arrays of its
// own, or editing one pane's would edit every pane's.
// The color a row's waveform takes: the pane's row palette if it has one,
// otherwise null, meaning fall back to the channel's own color. The pattern is
// cycled by row index rather than stretched over the rows, so one shorter than
// the row list repeats down the pane -- with `0.25x16` rows and "1,2x3" that
// lands color 1 on exactly the rows that start a beat.
export const rowColorFor = (
  { rowColors, rowColorPattern }: ViewConfig,
  row: number
): string | null => {
  if (!rowColors.length) return null;
  if (!rowColorPattern.length) return rowColors[0];
  const pick = Math.round(rowColorPattern[row % rowColorPattern.length]);
  // 1-based, and wrapped rather than clamped -- the same way drum `gains`
  // cycles, so a number past the end of the list comes back round to the start
  // instead of erroring or silently sticking on the last color.
  const i =
    (((pick - 1) % rowColors.length) + rowColors.length) % rowColors.length;
  return rowColors[i];
};

// A pane with no rows would divide by zero on the way to a row height.
// `parseNumberList` rejects an empty list, so this only catches a hand-edited
// or half-migrated session.
export const viewRowBeats = (view: ViewConfig): number[] => {
  const rows = exprList(view.beatsPerRow);
  return rows.length ? rows : [1];
};

export type ViewKind = "waveform" | "spectrogram";

export const VIEW_KINDS: ViewKind[] = ["waveform", "spectrogram"];

// Must match MAX_ANALYSIS_CHANNELS in src-tauri/src/analysis.rs. Duplicated
// rather than plumbed across because it only bounds the channel picker here.
export const MAX_ANALYSIS_CHANNELS = 4;

// Half SAMPLE_RATE in src-tauri/src/constants.rs. Duplicated rather than
// plumbed across because it only bounds the band inputs here.
export const ANALYSIS_NYQUIST = 22050;

// How many bins Rust groups the spectrum into. Duplicated rather than plumbed
// across because the stream says its own `bins` -- this is only the fallback
// the draw code sizes a fresh accumulator from.
export const ANALYSIS_BINS = 64;

// Must match ANALYSIS_WINDOWS in src-tauri/src/analysis.rs. Duplicated rather
// than plumbed across because it only fills the dropdown here; Rust snaps
// anything else to the nearest of these anyway.
export const ANALYSIS_WINDOWS = [256, 512, 1024, 2048, 4096];

export const defaultViewConfig = (): ViewConfig => ({
  kind: "waveform",
  spectrogramChannel: 0,
  spectrogramGain: 1,
  spectrogramFloor: 0.15,
  beatsPerRow: { inputText: "2x2", val: [2, 2] },
  marginLeft: { inputText: "0.11", val: 0.11 },
  marginRight: { inputText: "0.11", val: 0.11 },
  grids: [
    {
      color: GRID_COLORS[0],
      alpha: 1,
      subdivisions: {
        inputText: "2:1",
        val: { notes: [{ time: 0 }, { time: 0.5 }], start: 0, end: 1 },
        type: "parser2",
      },
    },
  ],
  visualGain: { inputText: "10", val: 10 },
  barColorMode: false,
  refreshAtCycleEnd: false,
  rowColors: [],
  rowColorPattern: [],
  showFlux: false,
  fluxGain: 0.3,
  showOnsets: false,
  splitChannels: false,
});

// A pane grid past this is unreadable long before it's slow, and it keeps a
// stored 40x40 from building 1600 canvases on load.
export const MAX_VIEW_SIDE = 4;

// Views are copied rather than shared so two panes never end up pointing at one
// grid array, where editing either would edit both.
export const copyView = (view: ViewConfig): ViewConfig =>
  JSON.parse(JSON.stringify(view));

export const defaultJsConfig = {
  canvasHeight: 1000,
  canvasWidth: 2000,
  subdivisionOffset: numExpr(0),
  channelStyles: [] as ChannelStyle[],
  // Global rather than per-view: one set of names every pane's expressions can
  // reach, so `n` means the same thing wherever it's written.
  parameters: [] as Parameter[],
  views: [defaultViewConfig()] as ViewConfig[],
  // The pane arrangement. `views.length` is held equal to viewCols * viewRows,
  // so changing either resizes the list rather than letting the two disagree.
  viewCols: 1,
  viewRows: 1,
};

export type RustConfig = typeof defaultRustConfig;

export type RustConfigKey = keyof RustConfig;

export const isRustConfigKey = (k: string): k is RustConfigKey =>
  k in defaultRustConfig;

export type JsConfig = typeof defaultJsConfig;

export type JsConfigKey = keyof JsConfig;

export const isJsConfigKey = (k: string): k is JsConfigKey =>
  k in defaultJsConfig;

export type ViewConfigKey = keyof ViewConfig;

// Checked against a throwaway instance because defaultViewConfig is a factory.
const VIEW_CONFIG_TEMPLATE = defaultViewConfig();

export const isViewConfigKey = (k: string): k is ViewConfigKey =>
  k in VIEW_CONFIG_TEMPLATE;

// View keys are in here so `Input` can be typed against them, but they live in
// neither default object -- the plain get/set can't reach them, only the
// view-scoped pair App hands to the per-view panel.
export type Config = RustConfig & JsConfig & ViewConfig;

export type ConfigKey = keyof Config;

// Later duplicates would silently win, so the first binding of a name is the
// one that counts. The panel refuses to create a duplicate; this only decides
// what a hand-edited session does.
export const parameterValues = (parameters: Parameter[]): Params => {
  const out: Params = {};
  for (const p of parameters) if (!(p.name in out)) out[p.name] = p.value;
  return out;
};

// Failure keeps the last good `val` and leaves the text alone. Deleting a
// parameter shouldn't wipe every field that referred to it -- the field goes
// red and waits to be fixed, and meanwhile the pane still draws.
const resolveNumber = (
  field: NumberExpr,
  params: Params,
  validate?: (n: number) => boolean
): NumberExpr => {
  if (!field || typeof field.inputText !== "string") return field;
  try {
    const val = evaluate(field.inputText, params);
    // A validator failing is treated exactly like a parse failure: keep the last
    // good value. It matters most for bpm, where `n - n` would otherwise push a
    // 0 to Rust and `get_loop_spacing` would divide by it.
    if (validate && !validate(val)) return field;
    return { inputText: field.inputText, val };
  } catch (e) {
    return field;
  }
};

const resolveList = (
  field: NumberListExpr,
  params: Params
): NumberListExpr => {
  if (!field || typeof field.inputText !== "string") return field;
  try {
    return {
      inputText: field.inputText,
      val: parseNumberList(field.inputText, params),
    };
  } catch (e) {
    return field;
  }
};

const resolveRhythm = (rhythm: Rhythm, params: Params): Rhythm => {
  try {
    const text = resolveRhythmText(rhythm.inputText, params);
    // Nothing in it referred to a parameter, so the stored val can't have
    // moved -- and text the parsers no longer accept is never re-parsed.
    if (text === rhythm.inputText) return rhythm;
    const parser = rhythm.type === "parser1" ? parser1 : parser2;
    return { ...rhythm, val: parser.parse(text) };
  } catch (e) {
    return rhythm;
  }
};

const resolveView = (view: ViewConfig, params: Params): ViewConfig => ({
  ...view,
  beatsPerRow: resolveList(view.beatsPerRow, params),
  marginLeft: resolveNumber(view.marginLeft, params),
  marginRight: resolveNumber(view.marginRight, params),
  visualGain: resolveNumber(view.visualGain, params),
  grids: view.grids.map((g) => ({
    ...g,
    subdivisions: resolveRhythm(g.subdivisions, params),
  })),
});

// Re-evaluates every expression-backed field against the config's own
// parameters. Called from the parameter setter, inside the same update, rather
// than from an effect: an effect that writes config is a render loop waiting to
// happen, and the draw loop reads `val` directly, so it would also draw one
// frame from stale numbers.
// The rust-side expression fields, with the guards that keep a nonsense value
// from crossing. Nothing in the frontend reads these -- they exist only to be
// pushed to the audio thread -- so `unwrapValues` stripping them to `val` is the
// whole of the Rust-side story.
// A band edge past Nyquist describes no bin at all; Rust falls back to the full
// range rather than reporting nothing, which would read as the flux being
// broken. Rejecting here is the honest place to say so.
const inBand = (n: number) => Number.isFinite(n) && n > 0 && n < ANALYSIS_NYQUIST;

const RUST_EXPR_FIELDS: {
  key: RustExprKey;
  validate?: (n: number) => boolean;
}[] = [
  { key: "bpm", validate: (n) => n > 0 && n < 100000 },
  { key: "beatsToLoop", validate: (n) => n > 0 },
  { key: "loopEchoes", validate: (n) => n >= 1 && n <= MAX_LOOP_ECHOES },
  { key: "loopEchoGain", validate: (n) => n >= 0 && n <= 1 },
  { key: "onsetThreshold", validate: (n) => Number.isFinite(n) && n >= 0 },
  { key: "onsetMinGap", validate: (n) => Number.isFinite(n) && n >= 0 && n < 10000 },
  { key: "onsetOffset", validate: (n) => Number.isFinite(n) && Math.abs(n) < 10000 },
  { key: "clickVolume", validate: (n) => n >= 0 },
  { key: "audioInGain", validate: (n) => n >= 0 },
  { key: "bufferCompensation", validate: (n) => n >= 0 },
  { key: "analysisBandLow", validate: inBand },
  { key: "analysisBandHigh", validate: inBand },
];

export const resolveRustConfig = (
  rust: RustConfig,
  params: Params
): RustConfig => {
  const out = { ...rust } as Record<string, unknown>;
  for (const { key, validate } of RUST_EXPR_FIELDS) {
    out[key] = resolveNumber(rust[key], params, validate);
  }
  out.audioSubdivisions = resolveRhythm(rust.audioSubdivisions, params);
  out.drums = rust.drums.map((d) => ({
    ...d,
    rhythm: resolveRhythm(d.rhythm, params),
  }));
  return out as RustConfig;
};

export const resolveJsConfig = (js: JsConfig): JsConfig => {
  const params = parameterValues(js.parameters);
  return { ...js, views: js.views.map((v) => resolveView(v, params)) };
};
