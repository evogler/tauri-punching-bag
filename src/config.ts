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
  rhythm: Rhythm;
};

export const BUILT_IN_DRUMS = ["ride"];

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

export const defaultJsConfig = {
  barColorMode: false,
  beatsPerRow: [2, 2],
  canvasHeight: 1000,
  canvasWidth: 2000,
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
  ] as VisualGrid[],
  subdivisionOffset: 0,
  refreshAtCycleEnd: false,
  channelStyles: [] as ChannelStyle[],
  // Draw the first visible channel above the centre line and the second below,
  // instead of overlaying them. With more than two, even slots go up and odd
  // slots go down.
  splitChannels: false,
  visualGain: 10,
};

export type RustConfig = typeof defaultRustConfig;

export type RustConfigKey = keyof RustConfig;

export const isRustConfigKey = (k: string): k is RustConfigKey =>
  k in defaultRustConfig;

export type JsConfig = typeof defaultJsConfig;

export type JsConfigKey = keyof JsConfig;

export const isJsConfigKey = (k: string): k is JsConfigKey =>
  k in defaultJsConfig;

export type Config = RustConfig & JsConfig;

export type ConfigKey = keyof Config;
