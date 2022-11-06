export const defaultRustConfig = {
  audioMonitorOn: true,
  beatsToLoop: 4,
  bpm: 140,
  bufferCompensation: 1250,
  clickOn: true,
  clickToggle: false,
  loopingOn: true,
  playFile: true,
  subdivision: 1,
  visualMonitorOn: true,
};

export type RustConfig = typeof defaultRustConfig;

export type RustConfigKey = keyof RustConfig;

export const isRustConfigKey = (k: string): k is RustConfigKey =>
  k in defaultRustConfig;

export const defaultJsConfig = {
  barColorMode: false,
  beatsPerRow: 4,
	canvasHeight: 500,
	canvasWidth: 1000,
  canvasRows: 4,
  subDivisions: [0, 0.6],
  visualGain: 10,
  visualSubdivision: 3,
};

export type JsConfig = typeof defaultJsConfig;

export type JsConfigKey = keyof JsConfig;

export const isJsConfigKey = (k: string): k is JsConfigKey =>
  k in defaultJsConfig;

export type Config = RustConfig & JsConfig;

export type ConfigKey = keyof Config;
