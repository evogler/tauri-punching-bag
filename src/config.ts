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

export const defaultRustConfig = {
	audioInGain: 1.0,
  audioMonitorOn: false,
  beatsToLoop: 4,
  bpm: 91,
  bufferCompensation: 4330,
  paused: false,
  // Which input channels get sent to the display, by device channel index.
  visibleChannels: [0] as number[],
  // Stereo position per input channel, -1 hard left to 1 hard right. Sparse:
  // a channel with no entry sits centred.
  channelPans: [] as number[],
  clickOn: true,
  clickToggle: false,
  clickVolume: 0.3,
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
  },
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

// One pane of the waveform display. Everything here is per-view, so two panes
// can show the same audio against different grids and row lengths -- looking
// back and forth between 16ths and triplets is the whole point of having more
// than one.
export type ViewConfig = {
  beatsPerRow: number[];
  marginLeft: number;
  marginRight: number;
  grids: VisualGrid[];
  visualGain: number;
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

export const defaultViewConfig = (): ViewConfig => ({
  beatsPerRow: [2, 2],
  marginLeft: 0.11,
  marginRight: 0.11,
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
  visualGain: 10,
  barColorMode: false,
  refreshAtCycleEnd: false,
  rowColors: [],
  rowColorPattern: [],
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
  subdivisionOffset: 0,
  channelStyles: [] as ChannelStyle[],
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
