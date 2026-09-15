import { ActiveDevices, AudioDeviceInfo, AudioPrefs } from "../DevicePicker";
import { Config, ConfigKey, Parameter, RustConfig, ViewConfig } from "../config";
import { SampleStatus } from "../DrumList";
import { Params } from "../expression";
import { Rect } from "../paneLayout";
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

// The pane layout operations, all of them going through `paneLayout.ts` so the
// no-overlap invariant is enforced in one place.
export type PaneOps = {
  canAdd: boolean;
  add: (at?: Rect) => void;
  remove: (index: number) => void;
  grow: (index: number, axis: "col" | "row", delta: 1 | -1) => void;
  canGrow: (index: number, axis: "col" | "row", delta: 1 | -1) => boolean;
  swap: (a: number, b: number) => void;
  copyFrom: (from: number, to: number) => void;
  reset: (index: number) => void;
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
  /** Answers with the new voice's index, so a grid row can point at it. */
  addDrumSample: (builtIn?: string) => Promise<number | null>;
  // One operation rather than a plain `set("drums", …)`: a grid row names its
  // voice by index, so deleting one has to fix those up in the same breath.
  removeDrumVoice: (index: number) => void;
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
  // Every pane, so the layout controls can draw the grid as it actually is --
  // which cells are taken, and by which pane. Read-only here: the operations
  // below are the only way a placement changes.
  views: ViewConfig[];
  // Grouped rather than spread flat across the bundle, because these are one
  // mechanism: each answers a list `paneLayout` has already made legal, or
  // refuses. `canAdd` and `canGrow` exist so a button can be disabled rather
  // than clicked into a refusal.
  paneOps: PaneOps;
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
