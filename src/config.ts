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

export const defaultJsConfig = {
  barColorMode: false,
  beatsPerRow: [2, 2],
  canvasHeight: 1000,
  canvasWidth: 2000,
  margin: 0.11,
  visualSubdivisions: {
		inputText: "2:1",
    val: { notes: [{ time: 0 }, { time: 0.5 }], start: 0, end: 1 },
    type: "parser2",
  },
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
