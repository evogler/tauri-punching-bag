export const defaultRustConfig = {
	audioInGain: 1.0,
  audioMonitorOn: false,
  beatsToLoop: 4,
  bpm: 91,
  bufferCompensation: 4330,
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
