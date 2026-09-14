import { ActiveDevices, AudioDeviceInfo, AudioPrefs } from "../DevicePicker";
import { Config, ConfigKey, Parameter, RustConfig, ViewConfig } from "../config";
import { SampleStatus } from "../DrumList";
import { Params } from "../expression";
import { Preset } from "../presets";

// What `set_mp3_buffer` reports back about the file it just decoded. The
// buffer Rust keeps has already been converted to the device rate and to
// stereo, so `frames` and `seconds` are in the units the callback plays at;
// `sourceRate` and `sourceChannels` are what the file itself was.
export type FileInfo = {
  frames: number;
  seconds: number;
  sourceRate: number;
  sourceChannels: number;
  deviceRate: number;
};

// Everything the panel reads from App. One bundle rather than per-tab props:
// the tabs are about to be rearranged, and a control moving between them
// should not mean rewiring what it can reach.
export type PanelProps = {
  get: <K extends ConfigKey>(k: K) => Config[K];
  set: <T>(k: string, v: T) => void;
  params: Params;

  resetBeat: () => void;
  configError: string | null;
  setParameters: (parameters: Parameter[]) => void;
  reroll: (pick?: (name: string) => boolean) => void;
  getCurrentPreset: () => Preset;
  loadPreset: (preset: Preset) => void;

  rustConfig: RustConfig;
  addDrumSample: (builtIn?: string) => void;
  sampleStatus: Record<string, SampleStatus>;
  chooseFile: () => void;
  fileInfo: FileInfo | null;
  fileError: string | null;
  setTempoFromFile: () => void;
  stretching: boolean;

  audioDevices: AudioDeviceInfo[];
  activeDevices: ActiveDevices | null;
  audioPrefs: AudioPrefs;
  writeAudioPrefs: (next: AudioPrefs) => void;
  refreshDevices: () => void;
  inputChannelCount: number;
  channelLabels: string[];
  sampleRate: number;

  gridWidth: number;
  paneScale: number;
  viewCols: number;
  viewRows: number;
  setArrangement: (cols: number, rows: number) => void;
  paneCount: number;
  activeView: number;
  setSelectedView: (index: number) => void;
  // The pane the panel is editing, and the view-scoped get/set for it.
  activeCfg: ViewConfig | undefined;
  viewIO: { get: (k: string) => any; set: (k: string, val: any) => void };
  patchView: (index: number, patch: Partial<ViewConfig>) => void;

  openSetup: () => void;
  // The same thing ⌘P does. Handed over as an action rather than left to a
  // `set("paused", !get("paused"))` at the call site, because the global
  // shortcut's handler is captured once and must not close over a stale `get`.
  togglePaused: () => void;
};
