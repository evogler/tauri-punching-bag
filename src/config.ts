export const defaultRustConfig = {
  audioMonitorOn: false,
  beatsToLoop: 4,
  bpm: 91,
  bufferCompensation: 4330,
  clickOn: true,
  clickToggle: false,
	clickVolume: 0.3,
  loopingOn: false,
  playFile: true,
  subdivision: 1,
  visualMonitorOn: true,
};

export const defaultJsConfig = {
  barColorMode: false,
  beatsPerRow: [2, 2],
	canvasHeight: 1000,
	canvasWidth: 2000,
	margin: 0.11,
  subDivisions: [0, 0.6],
	subdivisionLoop: 1,
	subdivisionOffset: 0,
  visualGain: 10,
  visualSubdivision: 3,
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
