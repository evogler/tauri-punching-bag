import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import { invoke } from "@tauri-apps/api";
import {
  defaultRustConfig,
  RustConfig,
  isRustConfigKey,
  defaultJsConfig,
  JsConfig,
  isJsConfigKey,
  ConfigKey,
  gridAlpha,
  gridShift,
  ChannelStyle,
  channelStyle,
  channelGain,
  unionChannels,
  BUILT_IN_DRUMS,
  rowColorFor,
  ViewConfig,
  defaultViewConfig,
  isViewConfigKey,
  copyView,
  MAX_VIEW_SIDE,
  Parameter,
  exprNumber,
  parameterValues,
  rollParameters,
  resolveJsConfig,
  resolveRustConfig,
  viewRowBeats,
  analysisNyquist,
  numExpr,
  setSampleRateHz,
  ANALYSIS_BINS,
  ANALYSIS_WINDOWS,
  MAX_ANALYSIS_CHANNELS,
  VIEW_KINDS,
  ViewKind,
} from "./config";
import { Calibration } from "./Calibration";
import { ColorInput, Input } from "./Input";
import {
  ActiveDevices,
  AudioDeviceInfo,
  AudioPrefs,
  DEVICES_CHANGED_EVENT,
  DevicePicker,
  emptyPrefs,
  pairCompensation,
  withPairCompensation,
} from "./DevicePicker";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SlidingDivision } from "./SlidingDivision";
import { PresetBar } from "./PresetBar";
import { Preset, makePreset, readSession, writeSession } from "./presets";
import { GridList } from "./GridList";
import { SectionList } from "./SectionList";
import { RowColorList } from "./RowColorList";
import { SpectrogramControls } from "./SpectrogramControls";
import { Slider } from "./Slider";
import { ParameterList } from "./ParameterList";
import { Layout, getCanvasPositions } from "./layout";
import { ChannelList } from "./ChannelList";
import { ChannelPicker } from "./ChannelPicker";
import { DrumList, SampleStatus, makeDrumVoice } from "./DrumList";
import { open as openFileDialog } from "@tauri-apps/api/dialog";

// True only in a plain browser (`yarn start`), where there's no Rust backend to
// call, so samples are faked. Inside the Tauri app -- dev or release -- the IPC
// global is injected and we always use real samples.
const BROWSER_DEBUG_MODE = !("__TAURI_IPC__" in window);

// What `set_mp3_buffer` reports back about the file it just decoded. The
// buffer Rust keeps has already been converted to the device rate and to
// stereo, so `frames` and `seconds` are in the units the callback plays at;
// `sourceRate` and `sourceChannels` are what the file itself was.
type FileInfo = {
  frames: number;
  seconds: number;
  sourceRate: number;
  sourceChannels: number;
  deviceRate: number;
};

// Rate and channel count are only mentioned when the loader actually had to do
// something about them, so the usual case stays short. The beat figure is the
// point of the line: it's what tells you to type 8 into `file beats`.
const fileDescription = (info: FileInfo, bpm: number) => {
  const parts = [`${info.seconds.toFixed(3)} s`];
  if (info.sourceChannels !== 2) parts.push(`${info.sourceChannels} ch → 2`);
  if (Math.abs(info.sourceRate - info.deviceRate) > 0.5)
    parts.push(`${info.sourceRate} → ${info.deviceRate} Hz`);
  if (bpm > 0)
    parts.push(`${((info.seconds * bpm) / 60).toFixed(2)} beats at ${bpm} bpm`);
  return parts.join(" · ");
};

// Says what the segment will actually do, including the two ways it quietly
// won't: a length in beats is what makes a position in beats mean anything, and
// a backwards segment falls back to the whole file rather than being refused
// while you're still typing the other end.
const repeatDescription = (a: number, b: number, fileBeats: number) => {
  if (!(fileBeats > 0)) return "⚠ needs `file beats` — playing the whole file";
  if (!(b > a)) return "⚠ b must be past a — playing the whole file";
  const wraps = a < 0 || b > fileBeats;
  return `${b - a} beats of the file, repeating every ${b - a}${
    wraps ? ", wrapping past its end" : ""
  }`;
};

// The ratio is a plain consequence of two numbers you have already given, so
// it's derived here rather than reported back from Rust. Above 1 is slower.
const stretchRatio = (info: FileInfo | null, fileBeats: number, bpm: number) => {
  if (!info || !(info.seconds > 0) || !(fileBeats > 0) || !(bpm > 0)) return null;
  const naturalBpm = (fileBeats * 60) / info.seconds;
  return { ratio: naturalBpm / bpm, naturalBpm };
};

// WSOLA is honest up to about a third either way; past that a drum loop starts
// to flam and sustained material warbles. Better to say so than to let it be
// discovered as "the file sounds wrong".
const STRETCH_CLEAN_LOW = 0.75;
const STRETCH_CLEAN_HIGH = 1.33;

// A pane's backing store, in device pixels, and the ratio it was measured at --
// the one number that converts a width in CSS pixels into surface pixels.
type PaneSize = { width: number; height: number; scale: number };

// Only ever used by the render that *creates* a pane's canvas: the layout
// effect measures the real box before the first paint. Not a layout constant --
// nothing is laid out to these numbers.
const UNMEASURED_PANE: PaneSize = { width: 300, height: 150, scale: 1 };

// The pane arrangements the panel offers, as [across, down].
const ARRANGEMENTS: [number, number][] = [
  [1, 1],
  [2, 1],
  [1, 2],
  [3, 1],
  [2, 2],
  [4, 1],
];

// Per-pane mutable draw state. Every pane needs its own: the sweep flush
// boundary falls where a pixel column ends, and panes disagree about that
// because they each have their own pixelsPerBeat.
type ViewDrawState = {
  // The pixel column the sweep is currently filling, and the last beat that
  // landed in it -- the column is painted at that beat when the sweep leaves,
  // so a column's peak lands where it was measured rather than one column on.
  canvasPos: number;
  pendingBeat: number;
  // Where the last flush painted, in pixels along the loop. The gap to the next
  // one is what says which columns were crossed -- see drawSweep.
  lastFlushPixels: number;
  // Whole-cycle mode: the loudest sample seen in each pixel column so far this
  // time round, so holding a cycle's worth of audio costs a few thousand
  // numbers instead of a few hundred thousand samples.
  cycleColumns: Map<number, number[]>;
  lastCyclePos: number;
  // Peak per visible channel since this pane last flushed a column.
  channelPeaks: number[];
  // Spectrogram: peak per frequency bin since the last flush, and the beat of
  // the hop that flush painted. The gap between the two is how wide the next
  // column has to be -- at 172 hops/sec a hop can be dozens of pixels apart, so
  // a one-pixel line per hop would draw a picket fence rather than a picture.
  binPeaks: number[];
  lastHopBeat: number;
  // Flux: peak per *analysed input channel* since the last flush, and the pixel
  // column that flush went into. Its own column rather than `canvasPos`, which
  // the waveform sweep owns and compares as a float.
  fluxPeaks: number[];
  fluxColumn: number;
  // Whole-cycle mode's equivalent of `cycleColumns`, kept separate because the
  // two streams arrive at different rates and are indexed by different things
  // -- device channel here, stream slot there.
  fluxColumns: Map<number, number[]>;
  // Whole-cycle mode's onset list, cleared at the wrap alongside fluxColumns.
  // A list rather than a column map: onsets are discrete and carry a sub-hop
  // beat, and rounding them into columns would throw away the precision the
  // parabolic fit exists to recover.
  cycleOnsets: OnsetMark[];
};

// One detected attack, as Rust reports it. `channel` is a *device* input
// channel, like the flux and unlike the sample stream's slot order.
type OnsetMark = { beat: number; channel: number; strength: number };

const freshViewState = (): ViewDrawState => ({
  canvasPos: -1,
  pendingBeat: NaN,
  lastFlushPixels: NaN,
  cycleColumns: new Map(),
  lastCyclePos: 0,
  channelPeaks: [],
  binPeaks: [],
  lastHopBeat: NaN,
  fluxPeaks: [],
  fluxColumn: -1,
  fluxColumns: new Map(),
  cycleOnsets: [],
});

// const log = <T,>(label: string, x: T) => {
//   console.log(label, x);
//   return x;
// // };

const mapFuncOnObjectKeys = <T,>(
  obj: Record<string, T>,
  func: (key: string) => string
) => {
  const newObj: Record<string, T> = {};
  for (const key in obj) {
    newObj[func(key)] = obj[key];
  }
  return newObj;
};

// Rhythms are stored as {inputText, val, type} so the fields can keep what was
// typed, while Rust only wants the parsed `val`. Recursive because a drum voice
// carries a rhythm each, nested inside an array.
const unwrapValues = (value: any): any => {
  if (Array.isArray(value)) return value.map(unwrapValues);
  if (value !== null && typeof value === "object") {
    if (value.val !== undefined) return unwrapValues(value.val);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, unwrapValues(v)])
    );
  }
  return value;
};

const camelCaseToSnakeCase = (str: string) =>
  str.replace(/([A-Z])/g, (g) => `_${g[0].toLowerCase()}`);

const snakeCaseKeys = <T,>(obj: Record<string, T>) =>
  mapFuncOnObjectKeys(obj, camelCaseToSnakeCase);
const Section = ({
  children,
  label = undefined,
}: {
  children: React.ReactNode;
  label?: string;
}) => (
  <div
    style={{
      border: "1px solid #777",
      margin: "4px",
      padding: "4px",
      borderRadius: "8px",
      backgroundColor: "#444",
    }}
  >
    {label && <h4 style={{ color: "#ccc", margin: "1px " }}>{label}</h4>}
    {children}
  </div>
);

// The panel groups by what a setting acts on: the sound being made, the signal
// coming back in, how it is drawn, and the panes drawing it. Transport, the
// parameters every expression reads and the preset bar stay above the tabs --
// parameters especially, since you edit `n` while looking at a field that
// reads `bar/n x n`.
const PANEL_TABS = ["sound", "signal", "visual", "views"] as const;
type PanelTab = (typeof PANEL_TABS)[number];

const TabBar = ({
  active,
  onSelect,
}: {
  active: PanelTab;
  onSelect: (tab: PanelTab) => void;
}) => (
  <div style={{ display: "flex", flexDirection: "row", gap: "2px", margin: "4px 4px 0" }}>
    {PANEL_TABS.map((tab) => (
      <button
        key={tab}
        onClick={() => onSelect(tab)}
        style={{
          flex: 1,
          padding: "4px",
          border: "1px solid #777",
          borderRadius: "8px 8px 0 0",
          backgroundColor: tab === active ? "#444" : "#333",
          color: tab === active ? "#fff" : "#aaa",
          fontWeight: tab === active ? "bold" : undefined,
          cursor: "pointer",
        }}
      >
        {tab}
      </button>
    ))}
  </div>
);

// Hidden rather than unmounted: `Input` holds the text you are typing in local
// state, and an expression is invalid for most of the time it takes to type,
// so unmounting would throw a half-written field away on every tab switch.
// Every section rendered on every render before this existed, so nothing here
// costs more than it used to.
const TabPanel = ({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) => <div style={{ display: active ? "block" : "none" }}>{children}</div>;

// A labelled hairline between groups of settings inside one Section. The views
// pane holds four unrelated kinds of setting -- which pane, how it is ruled,
// how it draws, what is drawn over it -- and reads as a wall of inputs without
// something separating them.
const Divider = ({ label }: { label?: string }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: "6px",
      margin: "8px 0 4px",
    }}
  >
    {label && (
      <span
        style={{
          color: "#999",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {label}
      </span>
    )}
    <div style={{ flex: 1, height: "1px", backgroundColor: "#777" }} />
  </div>
);

const App = () => {
  const [log, setLog] = useState("log");
  const [hideConfig, setHideConfig] = useState(false);
  // Plain state rather than a config key: which tab is open is transient UI,
  // and keeping it out of config keeps it out of presets and the session.
  const [panelTab, setPanelTab] = useState<PanelTab>("sound");
  useEffect(() => {
    const setListener = async () => {
      const unlisten = await listen("log", (msg) => {
        // @ts-expect-error I don't feel like typing this
        setLog(JSON.stringify(msg.payload.message));
      });
      setLog("listening");
      return unlisten;
    };
    const unlisten = setListener();
    return () => {
      (async () => await unlisten)();
    };
  }, []);

  // useEffect(() => {
  //   alert("about to try to get audio");
  //   try {
  //     const mic =(async () => {return await navigator.mediaDevices.getUserMedia({
  //       audio: true,
  //     });})();
  // 		alert('it worked ' + JSON.stringify(mic));
  //   } catch (e) {
  // 		let message = 'Unknown Error';
  // 		if (e instanceof Error) message = e.message;
  //     alert("error: " + message);
  //   }
  //   alert("just tried and didn't error");
  // });

  const getArrayAdded = useRef(false);
  useEffect(() => {
    // check for new samples
    if (getArrayAdded.current) return;
    getArrayAdded.current = true;
    const interval = setInterval(
      BROWSER_DEBUG_MODE ? mockGetArray : getArray,
      // getArray,
      1000 / 100
    );
    return () => { clearInterval(interval); getArrayAdded.current = false;};
  }, []);

  // What the loader made of the current file. Kept so the panel can say what
  // was converted on the way in -- a 44.1k bounce on a 48k device used to be
  // resampled by nobody and simply play 8.8% fast -- and so `set tempo from
  // file` has a length to divide.
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const loadFile = (filename: string) => {
    if (BROWSER_DEBUG_MODE) return;
    invoke<FileInfo>("set_mp3_buffer", { filename })
      .then((info) => {
        setFileInfo(info);
        setFileError(null);
      })
      .catch((e) => {
        setFileInfo(null);
        setFileError(String(e));
      });
  };

  // The path lives in the js config so the session brings it back; Rust holds
  // only the decoded samples, so it has to be pushed across again on mount.
  const pickNewMp3 = (filename: string) => () => {
    set("filePath", filename);
    loadFile(filename);
  };

  // The file's own length is a tempo, once you say how many beats it is. Worth
  // a button because a Logic bounce of a known bar count is the case this whole
  // feature is for, and typing the quotient by hand is how you end up a few
  // thousandths out.
  //
  // Rounding the result is safe in a way it wouldn't be with an accumulated
  // read position: the file is locked to `beat` by construction, so a rounded
  // bpm shifts the playback *rate* by a millionth and cannot slide the file off
  // the grid however long it runs.
  const setTempoFromFile = () => {
    const beats = exprNumber(get("fileBeats"));
    if (!fileInfo || beats <= 0 || fileInfo.seconds <= 0) return;
    set("bpm", numExpr(Math.round(((beats * 60) / fileInfo.seconds) * 10000) / 10000));
  };

  const chooseFile = async () => {
    let path: string | null = null;
    if (BROWSER_DEBUG_MODE) {
      path = window.prompt("Path to an audio file");
    } else {
      const picked = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: "Audio",
            extensions: ["wav", "aif", "aiff", "mp3", "flac", "ogg", "m4a"],
          },
        ],
      });
      path = typeof picked === "string" ? picked : null;
    }
    if (path) pickNewMp3(path)();
  };

  // Rendering a long file takes a moment, and it happens on a worker thread, so
  // without this a tempo change would look like nothing happening.
  const [stretching, setStretching] = useState(false);
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) return;
    const p = listen<{ stretching: boolean }>("file-stretch", (e) =>
      setStretching(e.payload.stretching)
    );
    return () => {
      p.then((un) => un());
    };
  }, []);

  const fileRestored = useRef(false);
  useEffect(() => {
    if (fileRestored.current) return;
    fileRestored.current = true;
    const path = get("filePath");
    if (path) loadFile(path);
    // Once, on mount: Rust boots with no file, whatever the session says.
  }, []);

  useEffect(() => {
    const unsubscribe = appWindow.onFileDropEvent((event) => {
      if (event.payload.type === "hover") {
        setLog("User hovering " + JSON.stringify(event.payload.paths));
      } else if (event.payload.type === "drop") {
        setLog("User dropped " + JSON.stringify(event.payload.paths));
        pickNewMp3(event.payload.paths[0])();
      } else {
        setLog("File drop cancelled");
      }
    });
    return () => {
      (async () => await unsubscribe)();
    };
  });

  // Read once, on the first render only.
  const [restoredSession] = useState(readSession);
  const [rustConfig, setRustConfig] = useState<RustConfig>(() =>
    resolveRustConfig(
      { ...defaultRustConfig, ...restoredSession?.rust },
      parameterValues(restoredSession?.js?.parameters ?? [])
    )
  );
  // Resolved on the way in: a session restored from an older build can carry
  // texts whose `val` predates the parameters saved alongside them.
  const [jsConfig, setJsConfig] = useState<JsConfig>(() =>
    resolveJsConfig({ ...defaultJsConfig, ...restoredSession?.js })
  );
  const get = <T extends ConfigKey>(k: T) => {
    if (isRustConfigKey(k)) return rustConfig[k] as RustConfig[typeof k];
    else if (isJsConfigKey(k)) return jsConfig[k] as JsConfig[typeof k];
    else return "never" as never;
  };
  // Every expression-backed field is re-resolved in the same update, so `val`
  // can never lag a parameter change. An effect doing it afterwards would risk
  // a render loop, and would leave one frame drawn from stale numbers.
  const setParameters = (parameters: Parameter[]) => {
    setJsConfig((js) => resolveJsConfig({ ...js, parameters }));
    // The rust side has to be re-resolved *and* pushed -- unlike the js config
    // nothing here re-reads it on render, so a stale `val` would sit in the
    // audio thread until the next unrelated setting change.
    updateRustConfig(
      resolveRustConfig(rustConfig, parameterValues(parameters))
    );
  };

  // A reroll is an ordinary parameter change -- the new draws are written back
  // as the parameters' stored values and everything downstream re-resolves from
  // them, which is why nothing here knows what a random parameter feeds.
  const reroll = (pick?: (name: string) => boolean) =>
    setParameters(rollParameters(jsConfig.parameters, pick));


  const set = <T,>(k: string, v: T) => {
    if (isRustConfigKey(k)) {
      updateRustConfig({ [k]: v });
    } else if (isJsConfigKey(k)) {
      setJsConfig((jsConfig) => ({ ...jsConfig, [k]: v }));
    }
  };

  // Everything one pane needs to draw itself, resolved once per render. The
  // geometry is layout.ts's; `rowHeight` and the pixel size are the pane's own,
  // since panes divide the canvas area between them.
  type ViewCtx = {
    index: number;
    cfg: ViewConfig;
    // Device channel indices this pane draws. Looked up in `streamSlots` for
    // the sample stream and used directly for the analysis stream.
    channels: number[];
    layout: Layout;
    visualGain: number;
    rowHeight: number;
    // `gridWidth` converted from CSS pixels into this pane's surface pixels.
    gridLineWidth: number;
    width: number;
    height: number;
    state: ViewDrawState;
  };

  // Mutated by the draw loop every frame, so a ref rather than state -- none of
  // it should cause a render. This is also where `channelPeaks` now lives; it
  // used to be a plain `let` in the component body, which quietly threw away
  // the accumulated peaks every time React re-rendered.
  const viewStates = useRef<ViewDrawState[]>([]);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  // One offscreen canvas per pane, holding everything that is painted
  // *incrementally*: the sweep's waveform, the flux, the onsets, the
  // spectrogram's columns. The visible canvas is rebuilt from it every frame,
  // which is what lets the grids be painted onto a clean surface exactly once.
  const layers = useRef<HTMLCanvasElement[]>([]);
  const [selectedView, setSelectedView] = useState(0);

  // Each pane's backing store, in device pixels. Measured from the element
  // rather than derived from the window, which is what stops the picture being
  // scaled -- see the layout effect below.
  const [paneSizes, setPaneSizes] = useState<PaneSize[]>([]);

  // Resolved once per render and handed to every field that can hold an
  // expression, so each pane's inputs read the same bindings.
  const params = parameterValues(get("parameters"));

  const viewCols = get("viewCols");
  const viewRows = get("viewRows");
  // What the sweep paints over old samples with. The whole-cycle refresh clears
  // to the same thing, so both modes sit on the same background.
  const background = get("waveformBackground");
  const gridWidth = get("gridWidth");
  // What the panel's readout resolves a CSS width against: the ratio the panes
  // were measured at, not `window.devicePixelRatio` read again, so the number
  // shown is the one actually being drawn with.
  const paneScale = paneSizes[0]?.scale ?? 1;
  const paneCount = viewCols * viewRows;

  // The backing store is sized from the pane's own box, so one pixel of surface
  // is one pixel of screen. It used to be the *window's* size in physical
  // pixels less a hard-coded 500x250, divided by the arrangement -- numbers
  // that stopped describing the layout the moment the panel could be hidden or
  // a gutter put between the panes, and that were in a different unit than the
  // box besides.
  //
  // Nothing *moved* under that: the draw code places everything as a fraction
  // of the surface, so a beat sat on its grid line whatever the scale. What it
  // cost was resolution, and anisotropically -- at the sizes in use the surface
  // was about 1.4x the screen across and 0.87x down, so the picture was
  // oversampled horizontally and *upscaled*, i.e. blurred, vertically. The
  // parts counted in pixels rather than fractions -- the 1px erase column, the
  // grid hairlines, the onset ticks -- came out at different apparent weights
  // across and down for the same reason.
  //
  // This cannot feed back into layout, because the canvas carries
  // `minWidth/minHeight: 0`: without it a grid item's automatic minimum is its
  // own aspect ratio, and a bigger backing store would ask for a bigger box.
  useLayoutEffect(() => {
    const measure = () => {
      // CSS pixels times the device ratio, so a Retina pane is drawn at its
      // real resolution rather than at half of it.
      const dpr = window.devicePixelRatio || 1;
      const next: PaneSize[] = [];
      for (let i = 0; i < paneCount; i++) {
        const box = canvasRefs.current[i]?.getBoundingClientRect();
        next.push({
          width: Math.max(1, Math.round((box?.width ?? 0) * dpr)),
          height: Math.max(1, Math.round((box?.height ?? 0) * dpr)),
          scale: dpr,
        });
      }
      // Setting the width attribute blanks a canvas, so an unchanged size must
      // not reach the DOM -- and an unconditional setState here would loop.
      setPaneSizes((prev) =>
        prev.length === next.length &&
        prev.every(
          (p, i) =>
            p.width === next[i].width &&
            p.height === next[i].height &&
            p.scale === next[i].scale
        )
          ? prev
          : next
      );
    };

    const observer = new ResizeObserver(measure);
    for (let i = 0; i < paneCount; i++) {
      const el = canvasRefs.current[i];
      if (el) observer.observe(el);
    }

    // Moving the window to a display with a different pixel ratio leaves the
    // CSS box the same size, so the observer never fires -- the surface would
    // stay at the old resolution until something else resized. The query has to
    // be rebuilt around each new ratio, since it can only ask about one.
    let media: MediaQueryList | null = null;
    const onRatioChange = () => {
      measure();
      watchRatio();
    };
    const watchRatio = () => {
      media?.removeEventListener("change", onRatioChange);
      media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", onRatioChange);
    };
    watchRatio();

    measure();
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", onRatioChange);
    };
  }, [paneCount]);

  // Chained panes divide one timeline between them: pane 1 covers the beats
  // after every earlier pane's, so the signal runs through its rows, then the
  // next pane's. Simultaneous is the default -- every pane covering the same
  // beats is what makes two rulings of one performance comparable.
  const sequential = get("viewsSequential");
  const viewWindows = get("views").map((cfg) =>
    viewRowBeats(cfg).reduce((sum, n) => sum + n, 0)
  );
  const chainStarts = viewWindows.reduce(
    (acc, n) => [...acc, acc.slice(-1)[0] + n],
    [0]
  );

  const viewCtxs: ViewCtx[] = get("views").map((cfg, index) => {
    // Measured, not derived: the backing store is this pane's own box, so
    // nothing the draw code computes is stretched on its way to the screen.
    const {
      width: cellWidth,
      height: cellHeight,
      scale,
    } = paneSizes[index] ?? UNMEASURED_PANE;
    const beatsPerRow = viewRowBeats(cfg);
    const marginLeft = exprNumber(cfg.marginLeft);
    const marginRight = exprNumber(cfg.marginRight);
    const maxBeatsInRow = Math.max(...beatsPerRow) + marginLeft + marginRight;
    const rowStarts = beatsPerRow.reduce(
      (acc, n) => [...acc, acc.slice(-1)[0] + n],
      [0]
    );
    while (viewStates.current.length <= index)
      viewStates.current.push(freshViewState());
    return {
      index,
      cfg,
      channels: cfg.channels,
      layout: {
        beatsPerRow,
        rowStarts,
        beatsPerWindow: viewWindows[index],
        cycleBeats: sequential ? chainStarts.slice(-1)[0] : viewWindows[index],
        chainStart: sequential ? chainStarts[index] : 0,
        pixelsPerBeat: cellWidth / maxBeatsInRow,
        marginLeft,
        marginRight,
      },
      visualGain: exprNumber(cfg.visualGain),
      rowHeight: cellHeight / beatsPerRow.length,
      gridLineWidth: gridWidth * scale,
      width: cellWidth,
      height: cellHeight,
      state: viewStates.current[index],
    };
  });
  // Panes removed by a smaller arrangement shouldn't leave their state behind.
  viewStates.current.length = viewCtxs.length;

  // Clamped rather than trusted: shrinking the arrangement can leave the
  // selection pointing past the end until the next render settles.
  const activeView = Math.min(selectedView, viewCtxs.length - 1);

  // Per-view keys live in `views[i]` rather than in either default object, so
  // the plain get/set can't route them (a key in the wrong object silently does
  // nothing -- see CLAUDE.md). Anything else falls through unchanged, so the
  // panel can mix view and global inputs without caring which is which.
  const viewSetGet = (index: number) => ({
    get: (k: string): any =>
      isViewConfigKey(k)
        ? (get("views")[index] as Record<string, any>)?.[k]
        : (get as any)(k),
    set: (k: string, val: any) => {
      if (!isViewConfigKey(k)) return (set as any)(k, val);
      setJsConfig((js) => ({
        ...js,
        views: js.views.map((v, i) => (i === index ? { ...v, [k]: val } : v)),
      }));
    },
  });

  // The arrangement is what decides how many panes there are, so it resizes the
  // list itself -- a separate add/remove control would only be one more thing
  // to keep in agreement with it. A new pane starts as a copy of the first,
  // since adding one is nearly always "show me this again, against another grid".
  const setArrangement = (cols: number, rows: number) => {
    const c = Math.max(1, Math.min(MAX_VIEW_SIDE, cols));
    const r = Math.max(1, Math.min(MAX_VIEW_SIDE, rows));
    const wanted = c * r;
    setJsConfig((js) => {
      const views = js.views.slice(0, wanted);
      while (views.length < wanted)
        views.push(copyView(views[0] ?? defaultViewConfig()));
      return { ...js, viewCols: c, viewRows: r, views };
    });
    setSelectedView((i) => Math.min(i, wanted - 1));
  };

  // The pane the panel is currently editing.
  const viewIO = viewSetGet(activeView);
  // The visual stream as Rust sends it: one beat per frame, `channels` values
  // per beat, flattened so neither side allocates per frame.
  type VisualSamples = {
    cycle: number;
    channels: number;
    beats: number[];
    values: number[];
  };
  const samples = useRef<VisualSamples>({
    cycle: 0,
    channels: 1,
    beats: [],
    values: [],
  });
  const appendSamples = (batch: VisualSamples) => {
    // The audio thread restarts the cycle itself -- it has to, or the count-off
    // would begin a round trip late. What it cannot do is reroll, because the
    // parameters live here, so it counts the wraps and this notices one. Read
    // through a ref for the same reason the keyboard shortcuts are: the poll is
    // registered once and `reroll` is a new closure every render.
    if (batch.cycle !== lastCycle.current) {
      lastCycle.current = batch.cycle;
      onCycleWrap.current();
    }
    const held = samples.current;
    // A change of channel count changes the row width, so anything collected
    // under the old one can't be read alongside the new.
    if (held.channels !== batch.channels) {
      samples.current = batch;
      return;
    }
    // Appended one at a time: a spread of a long backlog can blow the stack.
    for (let i = 0; i < batch.beats.length; i++) held.beats.push(batch.beats[i]);
    for (let i = 0; i < batch.values.length; i++)
      held.values.push(batch.values[i]);
  };
  // The spectrogram stream: one entry in `beats` per hop, `channels * bins`
  // bytes after it. Separate from the sample stream because it arrives 256
  // times more slowly -- see AnalysisFrames in structs.rs.
  type AnalysisFrames = {
    channels: number;
    bins: number;
    beats: number[];
    mags: number[];
    // One value per hop per analysed channel: `flux[hop * channels + ch]`. It
    // rides here rather than in the sample stream precisely because these beats
    // are already stamped at the window centre.
    flux: number[];
    // Sparse, not one per hop, and each carries its own beat -- so unlike
    // `mags` and `flux` these are not indexed against `beats` at all.
    onsets: OnsetMark[];
  };
  const analysis = useRef<AnalysisFrames>({
    channels: 0,
    bins: 0,
    beats: [],
    mags: [],
    flux: [],
    onsets: [],
  });
  const appendAnalysis = (batch: AnalysisFrames) => {
    const held = analysis.current;
    // Either number changes the row width of the flattened mags, so what was
    // collected under the old shape can't be read as the new one.
    if (held.channels !== batch.channels || held.bins !== batch.bins) {
      analysis.current = batch;
      return;
    }
    // One at a time, for the same reason as appendSamples: a spread of a long
    // backlog can blow the stack.
    for (let i = 0; i < batch.beats.length; i++) held.beats.push(batch.beats[i]);
    for (let i = 0; i < batch.mags.length; i++) held.mags.push(batch.mags[i]);
    for (let i = 0; i < batch.flux.length; i++) held.flux.push(batch.flux[i]);
    for (let i = 0; i < batch.onsets.length; i++)
      held.onsets.push(batch.onsets[i]);
  };
  const lastCycle = useRef(0);
  const onCycleWrap = useRef(() => {});

  const getArray = async () => {
    appendSamples(await invoke("get_samples"));
    appendAnalysis(await invoke("get_analysis"));
  };

  const mockGetArrayPos = useRef(0);
  const mockHopBeat = useRef(0);
  // Fake data for the browser-only path; no Rust, so a nominal rate is fine.
  const beatsPerSample = 91 / 60 / 44100;
  const mockGetArray = async () => {
    const channels = Math.max(1, get("visibleChannels").length);
    const batch: VisualSamples = { cycle: 0, channels, beats: [], values: [] };
    const noise = () =>
      Math.abs(
        (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1)
      );
    for (let i = 0; i < 441; i++) {
      batch.beats.push(mockGetArrayPos.current);
      for (let c = 0; c < channels; c++) batch.values.push(noise());
      mockGetArrayPos.current += beatsPerSample;
    }
    appendSamples(batch);
    // A hop every 256 frames, matching HOP in analysis.rs, so the spectrogram
    // path can be looked at in the browser too. A drifting band, not noise --
    // a picture that's obviously wrong is easier to spot than static.
    const frames: AnalysisFrames = {
      channels: 2,
      bins: ANALYSIS_BINS,
      beats: [],
      mags: [],
      flux: [],
      onsets: [],
    };
    while (mockHopBeat.current < mockGetArrayPos.current) {
      const beat = mockHopBeat.current;
      mockHopBeat.current += 256 * beatsPerSample;
      frames.beats.push(beat);
      for (let c = 0; c < frames.channels; c++) {
        const centre = ANALYSIS_BINS * (0.5 + 0.4 * Math.sin(beat * 2 + c));
        for (let b = 0; b < ANALYSIS_BINS; b++)
          frames.mags.push(
            Math.round(255 * Math.exp(-Math.abs(b - centre) / 4))
          );
        // A spike on every half beat, offset per channel, and near-silence
        // between them -- the shape a real onset function has, so a flux drawn
        // in the wrong place or on the wrong channel is obvious at a glance.
        const phase = (beat + c * 0.25) % 0.5;
        const spike = phase < 0.03;
        frames.flux.push(spike ? 0.9 : 0.02 * Math.random());
        // One onset on the leading edge of each spike, so the marker can be
        // checked against the curve it is supposed to have come from.
        if (spike && phase - 256 * beatsPerSample < 0)
          frames.onsets.push({ beat, channel: c, strength: 0.9 });
      }
    }
    appendAnalysis(frames);
  };

  // Decoding happens in Rust and is keyed by path, so the frontend only has to
  // make sure every referenced file has been loaded once.
  const [sampleStatus, setSampleStatus] = useState<Record<string, SampleStatus>>(
    {}
  );
  const requestedSamples = useRef(new Set<string>());
  const loadDrumSample = (path: string) => {
    if (BUILT_IN_DRUMS.includes(path)) return;
    if (requestedSamples.current.has(path)) return;
    requestedSamples.current.add(path);
    setSampleStatus((s) => ({ ...s, [path]: "loading" }));
    invoke("load_drum_sample", { path })
      .then(() => setSampleStatus((s) => ({ ...s, [path]: "ok" })))
      .catch(() => setSampleStatus((s) => ({ ...s, [path]: "error" })));
  };

  const addDrumSample = async () => {
    let path: string | null = null;
    if (BROWSER_DEBUG_MODE) {
      path = window.prompt("Path to an audio file");
    } else {
      const picked = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: "Audio",
            extensions: ["wav", "aif", "aiff", "mp3", "flac", "ogg", "m4a"],
          },
        ],
      });
      path = typeof picked === "string" ? picked : null;
    }
    if (!path) return;
    set("drums", [...get("drums"), makeDrumVoice(path)]);
  };

  // How many channels the capture device gave us, which is what the channel
  // list is sized from.
  const [inputChannelCount, setInputChannelCount] = useState(1);
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) {
      setInputChannelCount(2);
      return;
    }
    invoke<number>("get_input_channel_count")
      .then((n) => setInputChannelCount(Math.max(1, n)))
      .catch(() => {});
  }, []);

  // The rate Rust took from the input device. The sample stream is stamped in
  // beats, so nothing in the draw path needs this -- it is only for the two
  // places the UI has to name a frequency or a duration.
  const [sampleRate, setSampleRate] = useState(44100);
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) return;
    invoke<number>("get_sample_rate")
      .then((hz) => {
        if (!(hz > 0)) return;
        setSampleRate(hz);
        // The validators are module-level and can't read state.
        setSampleRateHz(hz);
      })
      .catch(() => {});
  }, []);

  // Device choice and per-device latency live in a prefs file rather than the
  // config: Rust has to read the device before any window exists, and a preset
  // carrying a UID or someone else's measurement would be noise on another
  // machine.
  const [audioDevices, setAudioDevices] = useState<AudioDeviceInfo[]>([]);
  const [audioPrefs, setAudioPrefs] = useState<AudioPrefs>(emptyPrefs());
  const [activeDevices, setActiveDevices] = useState<ActiveDevices | null>(null);
  // Re-enumerated rather than cached: an interface plugged in after launch has
  // to appear without a relaunch, which is the whole point of a picker.
  const refreshDevices = useCallback(() => {
    if (BROWSER_DEBUG_MODE) return;
    invoke<AudioDeviceInfo[]>("list_audio_devices")
      .then(setAudioDevices)
      .catch(() => {});
    invoke<ActiveDevices>("get_active_devices")
      .then(setActiveDevices)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshDevices();
    if (BROWSER_DEBUG_MODE) return;
    invoke<AudioPrefs>("get_audio_prefs")
      .then((p) => setAudioPrefs({ ...emptyPrefs(), ...p }))
      .catch(() => {});
    // Core Audio tells us when a device appears or goes away, so the list is
    // current without polling. Focus is the belt-and-braces path: plugging
    // something in usually means clicking back into the app straight after,
    // and it also covers the listener failing to register.
    const unlisten = listen(DEVICES_CHANGED_EVENT, () => refreshDevices());
    window.addEventListener("focus", refreshDevices);
    return () => {
      unlisten.then((f) => f()).catch(() => {});
      window.removeEventListener("focus", refreshDevices);
    };
  }, [refreshDevices]);

  const writeAudioPrefs = (next: AudioPrefs) => {
    setAudioPrefs(next);
    if (BROWSER_DEBUG_MODE) return;
    invoke("set_audio_prefs", { prefs: next }).catch(() => {});
  };

  // The stored compensation for whatever device actually opened wins over the
  // restored session, once -- the session is the same on every machine, this
  // number is not. A ref rather than state because applying it must not depend
  // on having applied it.
  const appliedCompRef = useRef(false);
  useEffect(() => {
    if (appliedCompRef.current || !activeDevices) return;
    appliedCompRef.current = true;
    const stored = pairCompensation(audioPrefs, activeDevices);
    if (typeof stored !== "number" || !Number.isFinite(stored)) return;
    if (stored === exprNumber(get("bufferCompensation"))) return;
    set("bufferCompensation", numExpr(stored));
  }, [activeDevices, audioPrefs]);

  // ...and edits flow back, so the next launch on this device starts there.
  // Guarded on equality, and on having applied first, so it can neither loop
  // nor overwrite a saved value with the default before it has been read.
  const activeCompensation = exprNumber(get("bufferCompensation"));
  useEffect(() => {
    if (!appliedCompRef.current || !activeDevices) return;
    if (pairCompensation(audioPrefs, activeDevices) === activeCompensation) return;
    writeAudioPrefs(
      withPairCompensation(audioPrefs, activeDevices, activeCompensation)
    );
  }, [activeCompensation, activeDevices, audioPrefs]);

  // The synthetic buses ride along after the real inputs, so each can be shown,
  // coloured and split against them like any other channel. Order has to match
  // how Rust fills them.
  const channelLabels = [
    ...Array.from({ length: inputChannelCount }, (_, i) => `ch ${i + 1}`),
    "drums",
    "click",
    "file",
  ];

  // Set when the audio thread has refused the config, i.e. when what you see in
  // the panel is not what is playing.
  const [configError, setConfigError] = useState<string | null>(null);

  const updateRustConfig = (args: Partial<RustConfig>) => {
    // console.log("calling set_config");

    const newConfig = { ...rustConfig, ...args };
    setRustConfig(newConfig);
    const newConfigForRust = snakeCaseKeys(unwrapValues(newConfig));
    // console.log("calling set_config with " + newConfigForRust);
    // alert(JSON.stringify(newConfigForRust));
    // A rejected push used to vanish: Tauri deserializes the argument before the
    // command runs, so one bad field means the *whole* config is refused and
    // Rust keeps whatever it last accepted. Everything still looks fine -- the
    // panel updates, the checkbox ticks -- and nothing reaches the audio thread
    // ever again. That was a NaN note time arriving as JSON `null`, which serde
    // won't take; the grammar rejects those now, but the point is that a push
    // failing for any reason has to be visible rather than inferred from the
    // sound not changing.
    invoke("set_config", { newConfig: newConfigForRust })
      .then(() => setConfigError(null))
      .catch((e) => setConfigError(String(e)));
    // console.log("called set_config");
  };

  // Rust boots from its own default_config, so a restored session has to be
  // pushed across once at startup or the two sides silently disagree until the
  // first time a setting is touched.
  const sentRestoredConfig = useRef(false);
  useEffect(() => {
    if (sentRestoredConfig.current || !restoredSession) return;
    sentRestoredConfig.current = true;
    invoke("set_config", { newConfig: snakeCaseKeys(unwrapValues(rustConfig)) });
  });

  // Remember what's in use, so the next launch comes back to it.
  useEffect(() => {
    writeSession(makePreset(rustConfig, jsConfig));
  }, [rustConfig, jsConfig]);

  // The one pane setting that has to reach the audio thread: the callback packs
  // the union of what the panes ask for, so adding a channel to a pane has to
  // push. An effect rather than a call in every mutation site because the panes
  // change from five of them -- a per-pane edit, the arrangement, a preset, the
  // restored session -- and a missed one would leave Rust packing the wrong
  // set. It can't loop: the union is a pure function of `views`, and the
  // equality guard makes the push a fixed point.
  const wantedKey = unionChannels(jsConfig.views).join(",");
  const packedKey = rustConfig.visibleChannels.join(",");
  useEffect(() => {
    if (wantedKey === packedKey) return;
    updateRustConfig({
      visibleChannels: wantedKey ? wantedKey.split(",").map(Number) : [],
    });
  }, [wantedKey, packedKey]);

  // Covers both adding a sample and coming back to one a restored session
  // referred to.
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) return;
    for (const voice of rustConfig.drums) loadDrumSample(voice.path);
  }, [rustConfig.drums]);

  const getCurrentPreset = () => makePreset(rustConfig, jsConfig);

  const loadPreset = (preset: Preset) => {
    const next = resolveJsConfig({ ...jsConfig, ...preset.js });
    setJsConfig(next);
    updateRustConfig(
      resolveRustConfig(
        { ...rustConfig, ...preset.rust },
        parameterValues(next.parameters)
      )
    );
  };

  const resetBeat = () => {
    invoke("reset_beat");
  };

  // Whole columns, ending at the one `x` falls in. The sweep moves left to
  // right within a row, so a span greater than one covers the columns just
  // crossed -- the erase and the draw both start here so they line up exactly.
  const columnLeft = (x: number, span: number) => Math.floor(x) - (span - 1);

  // The eraser: `span` dark columns covering the row, painted before the
  // channels so the previous pass through this spot is gone.
  //
  // A *filled rect on whole columns*, not a stroke at a fractional x. A 1px
  // stroke centred on a fraction covers two columns at partial opacity, so it
  // only ever partly erased -- invisible while the sweep flushed once per
  // sample and several strokes piled up per column, and immediately visible as
  // the previous pass showing through once the flush became one per column.
  // The erase and the channels share this geometry exactly, so what is drawn is
  // what gets cleared next time round.
  // A row's drawn extent, in fractional surface pixels. The `-1` is the gap
  // between rows. Everything that paints inside a row derives its geometry from
  // here, and so does the eraser -- they were computed separately once, and
  // drifted.
  const rowBox = (v: ViewCtx, row: number) => ({
    y: row * v.rowHeight,
    height: v.rowHeight - 1,
  });

  const eraseColumn = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    span: number
  ) => {
    const { y, height } = rowBox(v, row);
    // Every pixel row a bar can *touch*, not the ones it fills. The vertical
    // extent is deliberately fractional -- rounding it would drop a quiet
    // passage to nothing -- so a full-amplitude bar antialiases into the pixel
    // row at each end. Rounding here instead of flooring and ceiling left those
    // two fringes behind, and only a loud sound reaches far enough to show it.
    const top = Math.floor(y);
    const bottom = Math.ceil(y + height);
    drawOps.current++;
    ctx.globalAlpha = 1;
    ctx.fillStyle = background;
    ctx.fillRect(columnLeft(x, span), top, span, bottom - top);
  };

  // `half` splits the waveform about the row's centre line: "up" draws only the
  // top, "down" only the bottom, so two channels can share a row without either
  // losing vertical space.
  const drawChannel = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    span: number,
    value: number,
    style: ChannelStyle,
    isMargin: boolean,
    half: "both" | "up" | "down"
  ) => {
    const { y, height } = rowBox(v, row);
    const val = Math.min(1, Math.max(value, 0));
    drawOps.current++;
    // Margin copies are repeats of another part of the loop, so they're dimmed
    // the way the single-channel version used a darker grey for them.
    ctx.globalAlpha = style.alpha * (isMargin ? 0.55 : 1);
    // Whole columns across, fractional down: the horizontal edges have to land
    // on the pixel grid so the eraser can cover them, but the vertical extent
    // is the *signal*, and rounding it would drop a quiet passage to nothing
    // instead of drawing it faintly.
    const left = columnLeft(x, span);
    if (v.cfg.barColorMode) {
      const shade = Math.floor(val * 255)
        .toString(16)
        .padStart(2, "0");
      ctx.fillStyle = `#${shade}${shade}${shade}`;
      ctx.fillRect(left, y, span, height);
    } else {
      ctx.fillStyle = rowColorFor(v.cfg, row, half) ?? style.color;
      const top = half === "down" ? 0.5 : 0.5 - 0.5 * val;
      const bottom = half === "up" ? 0.5 : 0.5 + 0.5 * val;
      ctx.fillRect(left, y + top * height, span, (bottom - top) * height);
    }
    ctx.globalAlpha = 1;
  };

  // Where each *device* channel sits in the sample stream. Rust packs the union
  // of what the panes ask for, in device order, so a pane finds its own
  // channels by looking them up here rather than by assuming stream order is
  // its own. A channel a pane wants but the stream hasn't caught up with yet
  // reads `undefined` and is skipped for a frame.
  const streamSlots: number[] = [];
  get("visibleChannels").forEach((channel, slot) => {
    streamSlots[channel] = slot;
  });

  // Styles are global and indexed by device channel, so a channel keeps its
  // colour in every pane. Resolved once per render rather than per column.
  const styleFor = (channel: number) =>
    channelStyle(get("channelStyles"), channel);
  const channelStyles = channelLabels.map((_, channel) => styleFor(channel));

  // The per-channel display trim, multiplied into the pane's own visual gain.
  // Waveform only: the flux and the spectrogram have their own gains, and the
  // flux is a normalised dB measure that a level trim would say nothing about.
  const channelGains = channelLabels.map((_, channel) =>
    channelGain(get("channelGains"), channel)
  );

  // The pane's own channels, so the split is by position *within this pane*.
  // Two panes showing different channels each split their own pair.
  const halfFor = (v: ViewCtx, index: number): "both" | "up" | "down" =>
    !v.cfg.splitChannels ? "both" : index % 2 === 0 ? "up" : "down";

  const drawChannelsAt = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    span: number,
    isMargin: boolean,
    peaks: number[]
  ) => {
    for (let i = 0; i < v.channels.length; i++) {
      const channel = v.channels[i];
      const slot = streamSlots[channel];
      const style = channelStyles[channel];
      if (slot === undefined || peaks[slot] === undefined || !style) continue;
      drawChannel(
        ctx,
        v,
        x,
        row,
        span,
        Math.min(1, peaks[slot] * v.visualGain * channelGains[channel]),
        style,
        isMargin,
        halfFor(v, i)
      );
    }
  };

  // The flux is per *device* input channel, which is how the pane's own channel
  // list reads too -- so unlike the sample stream there is no slot lookup here.
  // A channel pointing at a synthetic bus has no entry and is skipped: the
  // buses aren't captured, so there is no spectrum to difference.
  const drawFluxAt = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    isMargin: boolean,
    peaks: number[]
  ) => {
    for (let i = 0; i < v.channels.length; i++) {
      const channel = v.channels[i];
      const value = peaks[channel];
      const style = channelStyles[channel];
      if (value === undefined || !style) continue;
      drawChannel(
        ctx,
        v,
        x,
        row,
        1,
        Math.min(1, value * v.cfg.fluxGain),
        style,
        isMargin,
        halfFor(v, i)
      );
    }
  };

  // `barColorMode` paints the whole row height as a shade, so there is nowhere
  // to put a second signal -- the same reason a spectrogram pane ignores this.
  const showsFlux = (v: ViewCtx) => v.cfg.showFlux && !v.cfg.barColorMode;

  // Onsets survive barColorMode -- a tick at the row's edge sits on top of the
  // shading rather than competing with it for the row's height, which is what
  // rules the flux out there.
  const showsOnsets = (v: ViewCtx) => v.cfg.showOnsets;

  // A second pass over the pane, from the analysis stream. Called *after*
  // drawSweep, which erases each column before redrawing it and would otherwise
  // wipe this out. A hop is stamped at its window centre, half a window behind
  // the newest sample, so the flux lands a few pixels behind the sweep cursor --
  // that is the stamp being honest about when the value describes, not a lag.
  const drawFlux = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { channels, beats, flux } = analysis.current;
    const { beatsPerWindow, cycleBeats, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1 || !flux.length) return;
    const peaks = v.state.fluxPeaks;
    for (let i = 0; i < beats.length; i++) {
      for (let c = 0; c < channels; c++) {
        const value = flux[i * channels + c];
        if (peaks[c] === undefined || value > peaks[c]) peaks[c] = value;
      }
      const beat = beats[i];
      // A whole pixel column, like the spectrogram and unlike drawSweep's float
      // compare: at low zoom several hops share a column and the loudest has to
      // win rather than the last one overwriting the rest.
      const column = Math.floor((beat % cycleBeats) * pixelsPerBeat);
      if (column !== v.state.fluxColumn) {
        for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
          drawFluxAt(ctx, v, x, row, isMargin, peaks);
        }
        peaks.length = 0;
        v.state.fluxColumn = column;
      }
    }
  };

  // Whole-cycle mode's accumulator. Nothing is drawn here -- paintWholeCycle
  // puts it up when the cycle wraps.
  const collectFlux = (v: ViewCtx) => {
    const { channels, beats, flux } = analysis.current;
    const { beatsPerWindow, cycleBeats, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1 || !flux.length) return;
    for (let i = 0; i < beats.length; i++) {
      const b = ((beats[i] % cycleBeats) + cycleBeats) % cycleBeats;
      const column = Math.floor(b * pixelsPerBeat);
      let peaks = v.state.fluxColumns.get(column);
      if (!peaks || peaks.length !== channels) {
        peaks = new Array(channels).fill(0);
        v.state.fluxColumns.set(column, peaks);
      }
      for (let c = 0; c < channels; c++) {
        const value = flux[i * channels + c];
        if (value > peaks[c]) peaks[c] = value;
      }
    }
  };

  // Fraction of the row height an onset tick takes. Short and at the row's edge
  // rather than a full-height line, so it can't be mistaken for a grid line --
  // which is exactly what it has to be read *against*.
  const ONSET_TICK = 0.22;

  const drawOnsetMark = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    isMargin: boolean,
    mark: OnsetMark
  ) => {
    const index = v.channels.indexOf(mark.channel);
    const style = channelStyles[mark.channel];
    if (index < 0 || !style) return;
    const { y, height } = rowBox(v, row);
    const tick = Math.max(3, height * ONSET_TICK);
    // In split mode the tick sits on the edge its channel's waveform grows
    // from, so two channels' onsets stay told apart.
    const top = halfFor(v, index) === "down" ? y + height - tick : y;
    ctx.globalAlpha = style.alpha * (isMargin ? 0.55 : 1);
    ctx.fillStyle = style.color;
    drawOps.current++;
    ctx.fillRect(x - 1, top, 2, tick);
    ctx.globalAlpha = 1;
  };

  // Onsets are discrete and already carry a sub-hop beat, so there is no column
  // accumulation here -- each one is simply drawn everywhere its beat lands.
  // Called after drawSweep and drawFlux, both of which would paint over it.
  const drawOnsets = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { onsets } = analysis.current;
    if (!(v.layout.beatsPerWindow > 0)) return;
    for (const mark of onsets) {
      for (const { x, row, isMargin } of getCanvasPositions(v.layout, mark.beat)) {
        drawOnsetMark(ctx, v, x, row, isMargin, mark);
      }
    }
  };

  // Whole-cycle mode's accumulator, drained by paintWholeCycle at the wrap.
  const collectOnsets = (v: ViewCtx) => {
    for (const mark of analysis.current.onsets) v.state.cycleOnsets.push(mark);
  };

  // Tiles each grid's rhythm across the pane. Drawn last-to-first so the top of
  // the list ends up on top of the stack.
  const drawGrids = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const grids = v.cfg.grids;
    const { cycleBeats } = v.layout;
    // A fraction of a pixel cannot be drawn crisply, and a crisp hairline is the
    // whole point of the control, so the width lands on a whole device pixel.
    const width = Math.max(1, Math.round(v.gridLineWidth));
    for (let i = grids.length - 1; i >= 0; i--) {
      const grid = grids[i];
      const { notes, end } = grid.subdivisions.val;
      // A pattern of zero (or negative) length would never advance the tiling.
      if (!(end > 0) || !notes.length) continue;
      ctx.fillStyle = grid.color;
      ctx.globalAlpha = gridAlpha(grid);
      // Reduced into one pattern length: the pattern tiles every `end`, so a
      // whole pattern of shift is a no-op -- the property a drum voice's shift
      // has for the same reason. Tiling starts one pattern early so a shift
      // can't leave the first beats of the pane empty.
      const shift = (((gridShift(grid) % end) + end) % end) || 0;
      for (let startBeat = -end; startBeat < cycleBeats; startBeat += end) {
        for (const note of notes) {
          const b = startBeat + note.time + shift;
          if (b >= cycleBeats) break;
          if (b < 0) continue;
          for (const { x, row } of getCanvasPositions(v.layout, b)) {
            const top = Math.round(row * v.rowHeight);
            const bottom = Math.round((row + 1) * v.rowHeight);
            // Snapped to whole pixels, and filled rather than stroked. A stroke
            // at a fractional x spreads its width over one more column than it
            // asked for, at partial coverage -- and since the grids are
            // repainted every frame, alpha compositing drives every column it
            // touches to full opacity anyway. The line's width on screen was
            // therefore *how many columns it overlapped*, so 1 device pixel and
            // 2 came out as 2 columns and 3 rather than as 1 and 2, and the
            // setting looked like it did nothing.
            drawOps.current++;
            ctx.fillRect(Math.round(x - width / 2), top, width, bottom - top);
          }
        }
      }
    }
    // The samples drawn afterwards are always fully opaque.
    ctx.globalAlpha = 1;
  };

  // The default: each column is erased and redrawn as the cursor reaches it, so
  // the newest sample always sits right at the sweep.
  const drawSweep = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { channels, beats, values } = samples.current;
    const { beatsPerWindow, cycleBeats, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1) return;
    const peaks = v.state.channelPeaks;
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      // Flush once per *pixel column*. This used to compare the sweep position
      // as a float, which changes on every sample, so a column was erased and
      // redrawn once per sample in it -- several times over at any zoom, and
      // more the wider the pane -- for a picture a single stroke at the column's
      // peak draws more accurately. The peak accumulator was already here; only
      // the boundary was wrong. The spectrogram has always flushed this way.
      //
      // The step along the loop is the beat's own progress, not any one copy's
      // position on screen: a beat can appear several times in a pane.
      const column = Math.floor((beat % cycleBeats) * pixelsPerBeat);
      if (column !== v.state.canvasPos) {
        // Painted at the last beat that belonged to the column now closing, so
        // its peak lands in the column it was measured in.
        if (!Number.isNaN(v.state.pendingBeat)) {
          // How far the sweep moved since the last flush, in pixels. Each copy
          // of the beat on screen advances by exactly this, so the columns it
          // crossed are (floor(x - advance), floor(x)] -- computed per copy
          // rather than once from the loop's own column index, because a row's
          // x is the loop position minus a *fractional* offset and the two
          // therefore cross pixel boundaries at different moments. Taking one
          // span for every copy left a column unvisited at some zooms, and an
          // unvisited column is never erased: the leftover bar stays until the
          // geometry changes.
          const closing =
            (v.state.pendingBeat % cycleBeats) * pixelsPerBeat;
          const advance = closing - v.state.lastFlushPixels;
          for (const { x, row, isMargin } of getCanvasPositions(
            v.layout,
            v.state.pendingBeat
          )) {
            const right = Math.floor(x);
            // Not finite on the first flush, negative when the loop wrapped;
            // both mean "just this column". The pane's width bounds the rest.
            const left =
              advance > 0
                ? Math.max(right - v.width + 1, Math.floor(x - advance) + 1)
                : right;
            const span = right - left + 1;
            eraseColumn(ctx, v, x, row, span);
            drawChannelsAt(ctx, v, x, row, span, isMargin, peaks);
          }
          v.state.lastFlushPixels = closing;
        }
        peaks.length = 0;
        v.state.canvasPos = column;
      }
      for (let c = 0; c < channels; c++) {
        const value = values[i * channels + c];
        if (peaks[c] === undefined || value > peaks[c]) peaks[c] = value;
      }
      v.state.pendingBeat = beat;
    }
  };

  // One hop's worth of spectrum, painted as a stack of rects filling the row:
  // bin 0 (the low end) at the bottom, so the picture reads the way a
  // spectrogram is expected to. `width` covers the span the accumulated hops
  // describe, which at high zoom is far more than a pixel.
  const drawSpectrumColumn = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    width: number,
    row: number,
    peaks: number[],
    style: ChannelStyle,
    isMargin: boolean
  ) => {
    const { y, height } = rowBox(v, row);
    // The column is drawn backwards from `x`: the hops in it cover the span
    // ending at this beat, so anchoring them forward would put every one of
    // them a whole hop late.
    const left = x - width;
    ctx.globalAlpha = 1;
    drawOps.current++;
    ctx.fillStyle = background;
    ctx.fillRect(left, y, width, height);
    ctx.fillStyle = style.color;
    const floor = v.cfg.spectrogramFloor;
    const span = Math.max(1e-6, 1 - floor);
    const bins = peaks.length;
    for (let b = 0; b < bins; b++) {
      const level = ((peaks[b] / 255 - floor) / span) * v.cfg.spectrogramGain;
      if (!(level > 0)) continue;
      const top = y + height * (1 - (b + 1) / bins);
      const bottom = y + height * (1 - b / bins);
      // Ceil rather than round: fractional bin heights would otherwise leave
      // background-coloured seams between the rects.
      ctx.globalAlpha =
        Math.min(1, level) * style.alpha * (isMargin ? 0.55 : 1);
      drawOps.current++;
      ctx.fillRect(left, top, width, Math.ceil(bottom - top));
    }
    ctx.globalAlpha = 1;
  };

  // The spectrogram sweep. Same shape as drawSweep -- accumulate, flush when
  // the column moves on -- but the accumulator is one value per frequency bin
  // and the flush boundary is a whole pixel: hops arrive 172 times a second, so
  // at low zoom several land in one column and the loudest has to win rather
  // than the last one overwriting the rest.
  const drawSpectrogram = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { channels, bins, beats, mags } = analysis.current;
    const { beatsPerWindow, cycleBeats, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1 || bins < 1) return;
    // A device channel past what Rust analysed -- a synthetic bus, or beyond
    // the cap. Nothing to show rather than a misread of another channel.
    const channel = v.cfg.spectrogramChannel;
    if (channel < 0 || channel >= channels) return;
    const style = channelStyle(get("channelStyles"), channel);
    const peaks = v.state.binPeaks;
    if (peaks.length !== bins) peaks.length = 0;
    for (let i = 0; i < beats.length; i++) {
      const base = (i * channels + channel) * bins;
      for (let b = 0; b < bins; b++) {
        const value = mags[base + b];
        if (peaks[b] === undefined || value > peaks[b]) peaks[b] = value;
      }
      const beat = beats[i];
      const column = Math.floor((beat % cycleBeats) * pixelsPerBeat);
      if (column !== v.state.canvasPos) {
        // How much of the loop this column stands for. NaN on the first hop
        // after a reset, and negative where the beat wrapped past the end of
        // the window -- both mean "just this pixel".
        const spanBeats = beat - v.state.lastHopBeat;
        const width = Math.min(
          v.width,
          Math.max(1, Math.ceil(spanBeats * pixelsPerBeat) || 1)
        );
        for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
          drawSpectrumColumn(ctx, v, x, width, row, peaks, style, isMargin);
        }
        peaks.length = 0;
        v.state.canvasPos = column;
        v.state.lastHopBeat = beat;
      }
    }
  };

  // Repaints the pane from the collected cycle. Clearing first means nothing of
  // the previous pass can survive underneath -- and unlike the sweep, there's no
  // per-column erase, so grid lines stay visible behind quiet passages.
  const paintWholeCycle = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    ctx.globalAlpha = 1;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, v.width, v.height);
    v.state.cycleColumns.forEach((peaks, column) => {
      // Every beat inside a column lands on the same pixel, so the middle of it
      // stands in for all of them.
      const beat = (column + 0.5) / v.layout.pixelsPerBeat;
      for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
        drawChannelsAt(ctx, v, x, row, 1, isMargin, peaks);
      }
    });
    if (showsFlux(v)) {
      v.state.fluxColumns.forEach((peaks, column) => {
        const beat = (column + 0.5) / v.layout.pixelsPerBeat;
        for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
          drawFluxAt(ctx, v, x, row, isMargin, peaks);
        }
      });
    }
    // Last, so a tick is never painted over by the waveform or the flux.
    if (showsOnsets(v)) {
      for (const mark of v.state.cycleOnsets) {
        for (const { x, row, isMargin } of getCanvasPositions(v.layout, mark.beat)) {
          drawOnsetMark(ctx, v, x, row, isMargin, mark);
        }
      }
    }
  };

  // The alternative: hold the picture still and repaint the whole pane at once
  // when the beat wraps, so a cycle is only ever shown complete.
  const drawWholeCycle = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { channels, beats, values } = samples.current;
    const { beatsPerWindow, cycleBeats, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1) return;
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      // Chained, this is the position in the whole timeline rather than in the
      // pane's own slice, so every pane repaints together at one wrap.
      const b = ((beat % cycleBeats) + cycleBeats) % cycleBeats;
      // The modulo only ever goes backwards when the beat has wrapped past the
      // end of the window, which is exactly when the finished cycle should go up.
      if (b < v.state.lastCyclePos) {
        paintWholeCycle(ctx, v);
        v.state.cycleColumns.clear();
        v.state.fluxColumns.clear();
        v.state.cycleOnsets.length = 0;
      }
      v.state.lastCyclePos = b;
      const column = Math.floor(b * pixelsPerBeat);
      let peaks = v.state.cycleColumns.get(column);
      if (!peaks || peaks.length !== channels) {
        peaks = new Array(channels).fill(0);
        v.state.cycleColumns.set(column, peaks);
      }
      // Gain is applied at paint time, so changing it restyles the next repaint
      // rather than only affecting samples collected after the change.
      for (let c = 0; c < channels; c++) {
        const value = values[i * channels + c];
        if (value > peaks[c]) peaks[c] = value;
      }
    }
  };

  // The pane's accumulated picture, created and sized on demand. Sizing it
  // blanks it, which is what a resize wants anyway.
  const layerFor = (v: ViewCtx): CanvasRenderingContext2D | null => {
    let canvas = layers.current[v.index];
    if (!canvas) {
      canvas = document.createElement("canvas");
      layers.current[v.index] = canvas;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (canvas.width !== v.width || canvas.height !== v.height) {
      canvas.width = v.width;
      canvas.height = v.height;
      ctx.globalAlpha = 1;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, v.width, v.height);
    }
    return ctx;
  };

  const drawView = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const layer = layerFor(v);
    if (!layer) return;

    // Everything below paints into the layer, never the screen. Each of these
    // is incremental -- a column at a time, or a whole cycle at the wrap -- and
    // the layer is what carries that from frame to frame.
    if (v.cfg.kind === "spectrogram") {
      // `refreshAtCycleEnd` is a waveform mode and is ignored here.
      drawSpectrogram(layer, v);
    } else if (v.cfg.refreshAtCycleEnd) {
      // Collected before the wrap check inside drawWholeCycle: a hop is stamped
      // half a window behind the samples, so the tail of a cycle's flux arrives
      // after the samples have already wrapped, and it belongs to the picture
      // that is about to go up rather than the next one.
      if (showsFlux(v)) collectFlux(v);
      if (showsOnsets(v)) collectOnsets(v);
      drawWholeCycle(layer, v);
    } else {
      drawSweep(layer, v);
      // After the sweep: it erases each column just before redrawing it, so
      // anything drawn first is painted over.
      if (showsFlux(v)) drawFlux(layer, v);
      if (showsOnsets(v)) drawOnsets(layer, v);
    }

    // Rebuild the pane: the accumulated picture, then the grids over it. The
    // grids used to be painted straight onto the pane every frame, compositing
    // over their own previous pass -- which drove any alpha below 1 to opaque
    // within about a second, and left them *under* the waveform only in the
    // column the sweep was in. Onto a surface rebuilt every frame they land
    // once, at the alpha asked for, in the same order everywhere.
    drawOps.current++;
    ctx.globalAlpha = 1;
    ctx.drawImage(layer.canvas, 0, 0);
    drawGrids(ctx, v);
  };

  // One loop driving every pane, so the batch is drained once, after all of them
  // have read it. Each pane used to be a Canvas that ran its own
  // requestAnimationFrame and cleared the buffer itself; with more than one
  // that races, and whichever drew first would eat the samples.
  const drawAll = () => {
    for (const v of viewCtxs) {
      const ctx = canvasRefs.current[v.index]?.getContext("2d");
      if (ctx) drawView(ctx, v);
    }
    // Panes dropped by a smaller arrangement shouldn't keep a canvas alive.
    layers.current.length = viewCtxs.length;
    samples.current = {
      cycle: samples.current.cycle,
      channels: samples.current.channels,
      beats: [],
      values: [],
    };
    analysis.current = {
      channels: analysis.current.channels,
      bins: analysis.current.bins,
      beats: [],
      mags: [],
      flux: [],
      onsets: [],
    };
  };

  // The loop reaches the newest drawAll through a ref instead of depending on
  // it: the old `[draw]` dependency tore the animation loop down and rebuilt it
  // on every render, since that closure was new each time.
  const drawAllRef = useRef(drawAll);
  drawAllRef.current = drawAll;
  // Written to by the render loop with `textContent`, never through React: a
  // readout that caused a render 60 times a second would be measuring itself.
  // It exists only while the toggle is on, and the loop skips the write when
  // the node isn't there, so the measurement is always taken and never shown
  // unless asked for.
  const frameStatsRef = useRef<HTMLSpanElement>(null);
  // Canvas primitives issued this frame. Divided into the frame's draw time it
  // gives cost per operation, which is the number that separates "there is too
  // much to draw" from "each thing is drawn too expensively" -- and only the
  // second of those is fixable without changing the picture.
  const drawOps = useRef(0);
  useEffect(() => {
    let id: number;
    // Accumulated over a window and flushed a few times a second -- a number
    // changing every frame is unreadable, and the max is the interesting half
    // anyway. `draw` is the JS side of a frame; `frame` is the gap between
    // callbacks, which is what actually says whether the loop is keeping up.
    const FLUSH_MS = 250;
    let frames = 0;
    let drawTotal = 0;
    let drawMax = 0;
    let opsTotal = 0;
    let spanStart = performance.now();

    const render = () => {
      drawOps.current = 0;
      const before = performance.now();
      drawAllRef.current();
      const after = performance.now();

      const draw = after - before;
      frames++;
      drawTotal += draw;
      opsTotal += drawOps.current;
      if (draw > drawMax) drawMax = draw;

      if (after - spanStart >= FLUSH_MS) {
        const node = frameStatsRef.current;
        if (node) {
          const interval = (after - spanStart) / frames;
          const ops = opsTotal / frames;
          node.textContent =
            `draw ${(drawTotal / frames).toFixed(1)} avg / ` +
            `${drawMax.toFixed(1)} max ms  ·  ` +
            `${Math.round(ops).toLocaleString()} ops  ·  ` +
            `${((drawTotal / frames / Math.max(1, ops)) * 1000).toFixed(2)} us/op` +
            `  ·  frame ${interval.toFixed(1)} ms  ·  ` +
            `${Math.round(1000 / interval)} fps`;
        }
        frames = 0;
        drawTotal = 0;
        drawMax = 0;
        opsTotal = 0;
        spanStart = after;
      }
      id = window.requestAnimationFrame(render);
    };
    render();
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Everything a pane's geometry is derived from, as one comparable value. A
  // change to any of it invalidates every pixel already on screen *and* the
  // accumulated per-column peaks, which are keyed by a column index that only
  // means something at one zoom.
  const layoutKey = viewCtxs
    .map(
      (v) =>
        `${v.width}x${v.height}:${v.layout.pixelsPerBeat}:${v.layout.cycleBeats}:` +
        `${v.layout.chainStart}:${v.layout.marginLeft},${v.layout.marginRight}:` +
        v.layout.beatsPerRow.join(",")
    )
    .join("|");

  // The sweep never clears a pane -- it erases one column at a time, just ahead
  // of where it is about to draw -- so a new background would otherwise arrive
  // one column per frame and leave the pane in two colors for a whole cycle,
  // and a new *zoom* would leave the old picture's bars standing in whatever
  // columns the new one happens not to visit. Repainting here costs the
  // waveform already on screen, which is exactly what a resize already does.
  useEffect(() => {
    // The layers are what actually hold the stale picture; the panes are
    // rebuilt from them every frame. Both are cleared so nothing shows through
    // in the frame between this effect and the next draw.
    for (const canvas of [...layers.current, ...canvasRefs.current]) {
      const ctx = canvas?.getContext("2d");
      if (!ctx) continue;
      ctx.globalAlpha = 1;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas!.width, canvas!.height);
    }
    // The draw state describes the picture just thrown away: a sweep position,
    // a half-filled column, and peaks indexed by the old zoom's columns.
    // Reset *in place*: the ViewCtxs the draw loop is using hold references to
    // these objects, taken during the render before this effect ran, so
    // replacing the array would leave the sweep on the old state until some
    // unrelated render happened to rebuild them.
    for (const state of viewStates.current)
      Object.assign(state, freshViewState());
  }, [background, layoutKey]);

  // Transport shortcuts: cmd-P pauses, cmd-L toggles looping, cmd-R rerolls
  // every random parameter. The listener is
  // registered once and reaches the current config through a ref, for the same
  // reason the draw loop does -- `set` and `get` are new closures every render,
  // so depending on them would tear the listener down and rebuild it each time.
  onCycleWrap.current = () => reroll();
  const toggleRef = useRef((k: "paused" | "loopingOn") => {});
  toggleRef.current = (k) => set(k, !get(k));
  const rerollRef = useRef(() => {});
  rerollRef.current = () => reroll();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "r") {
        // cmd-shift-R is Restart, in the app menu. That arrives here too on the
        // way past, so it has to be let through rather than rerolling.
        if (e.shiftKey) return;
        e.preventDefault();
        rerollRef.current();
        return;
      }
      if (key !== "p" && key !== "l") return;
      // Both are the browser's (print, address bar) even inside a text field,
      // and neither means anything here, so they're taken unconditionally.
      e.preventDefault();
      toggleRef.current(key === "p" ? "paused" : "loopingOn");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // const Input = ({ label, _key }: { label: string; _key: string }) => (
  // <RealInput label={label} _key={_key} set={set} get={get} />
  // );
  const setGet = { set, get };

  const config = hideConfig ? null : (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "1px",
        gap: "2px",
        width: "600px",
        // Fixed width against the canvas next to it, and its own scrollbar --
        // the sections outgrew the window a while ago.
        flexShrink: 0,
        height: "100%",
        boxSizing: "border-box",
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      <>
        <div style={{ display: "flex", flexDirection: "row", gap: "2px" }}>
          <button
            onClick={() => set("paused", !get("paused"))}
            title="Freeze the beat, the click, the file and the display (⌘P)"
            style={{
              flex: 1,
              fontWeight: "bold",
              backgroundColor: get("paused") ? "#c44" : undefined,
              color: get("paused") ? "#fff" : undefined,
            }}
          >
            {get("paused") ? "▶ RESUME" : "⏸ PAUSE"}
          </button>
          <button onClick={resetBeat} style={{ flex: 1 }}>
            RESET TIME
          </button>
        </div>
        {/* <button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_3.wav")}>
				NEW MP3 1
			</button>
			<button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_4.wav")}>
				NEW MP3 2
			</button> */}

        {configError && (
          <div
            style={{
              border: "1px solid #e86",
              borderRadius: 8,
              margin: 4,
              padding: 8,
              backgroundColor: "#4a2a2a",
              color: "#fbb",
            }}
          >
            <b>the audio thread refused this config.</b> what you see here is not
            what is playing. usually a rhythm field: fix the red one and it will
            reconnect.
            <div style={{ opacity: 0.8, fontSize: "0.85em", marginTop: 4 }}>
              {configError}
            </div>
          </div>
        )}

        <Section label="parameters">
          <ParameterList
            parameters={get("parameters")}
            setParameters={setParameters}
            reroll={reroll}
          />
        </Section>

        <Section label="configs">
          <PresetBar getCurrent={getCurrentPreset} onLoad={loadPreset} />
        </Section>

        <TabBar active={panelTab} onSelect={setPanelTab} />

        <TabPanel active={panelTab === "sound"}>
          <Section label="bpm">
            <Input
              label="bpm"
              _key="bpm"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => n > 0}
            />
          </Section>
          <Section label="click">
            <Input label="click" _key="clickOn" set={set} get={get} />
            <Input
              label="click rhythm"
              _key="audioSubdivisions"
              params={params}
              set={set}
              get={get}
            />
            <Input label="click volume" _key="clickVolume" params={params} set={set} get={get} />
            {/* Beats, not milliseconds: the click is synthesised in the
                callback, so there is no file attack to align the way a drum
                voice's `offset` does. This is the musical half only. */}
            <Input
              label="click offset (beats)"
              _key="clickShift"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => Number.isFinite(n) && Math.abs(n) < 100000}
            />
          </Section>
          <Section label="drums">
            <Input label="drums on" _key="drumOn" set={set} get={get} />
            <DrumList
              params={params}
              drums={get("drums")}
              setDrums={(next) => set("drums", next)}
              onAdd={addDrumSample}
              status={sampleStatus}
            />
          </Section>
          <Section label="practice cycle">
            <Input
              label="run the cycle"
              _key="sectionsOn"
              set={set}
              get={get}
              title="Play the sections in order, then start again -- rerolling, resetting the beat and clearing the looper"
            />
            <SectionList
              sections={get("sections")}
              setSections={(next) => set("sections", next)}
              drums={rustConfig.drums}
              params={params}
            />
          </Section>
          <Section label="file">
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <button onClick={chooseFile}>choose file…</button>
              <span
                style={{
                  opacity: 0.7,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  direction: "rtl",
                }}
              >
                {get("filePath") || "none"}
              </span>
            </div>
            {fileError && <div style={{ color: "#e86" }}>{fileError}</div>}
            {fileInfo && (
              <div style={{ opacity: 0.7, fontSize: "0.9em" }}>
                {fileDescription(fileInfo, exprNumber(get("bpm")))}
              </div>
            )}
            <Input label="play file" _key="playFile" set={set} get={get} />
            <Input
              label="file volume"
              _key="fileVolume"
              params={params}
              set={set}
              get={get}
            />
            <Divider label="against the grid" />
            <Input
              label="file beats"
              _key="fileBeats"
              params={params}
              set={set}
              get={get}
            />
            <button
              onClick={setTempoFromFile}
              disabled={!fileInfo || exprNumber(get("fileBeats")) <= 0}
            >
              set tempo from file
            </button>
            <Input
              label="file offset (ms)"
              _key="fileOffsetMs"
              params={params}
              set={set}
              get={get}
            />
            <Input
              label="file shift (beats)"
              _key="fileShift"
              params={params}
              set={set}
              get={get}
            />
            <Divider label="follow tempo" />
            <Input
              label="time stretch"
              _key="fileStretch"
              set={set}
              get={get}
              title="fit the file to `file beats` at the current tempo without changing its pitch"
            />
            {get("fileStretch") &&
              (() => {
                const st = stretchRatio(
                  fileInfo,
                  exprNumber(get("fileBeats")),
                  exprNumber(get("bpm"))
                );
                if (!st)
                  return (
                    <div style={{ color: "#e86", fontSize: "0.9em" }}>
                      ⚠ needs `file beats` — playing at its own speed
                    </div>
                  );
                const rough =
                  st.ratio < STRETCH_CLEAN_LOW || st.ratio > STRETCH_CLEAN_HIGH;
                return (
                  <div
                    style={{
                      fontSize: "0.9em",
                      opacity: 0.8,
                      color: rough ? "#e86" : undefined,
                    }}
                  >
                    {st.ratio.toFixed(3)}× — {st.naturalBpm.toFixed(2)} bpm
                    material at {exprNumber(get("bpm"))}
                    {rough && " · past where this stays clean"}
                    {stretching && " · rendering…"}
                  </div>
                );
              })()}
            <Divider label="a–b repeat" />
            <Input label="repeat a–b" _key="fileRepeatOn" set={set} get={get} />
            <Input
              label="a (beats)"
              _key="fileRepeatStart"
              params={params}
              set={set}
              get={get}
            />
            <Input
              label="b (beats)"
              _key="fileRepeatEnd"
              params={params}
              set={set}
              get={get}
            />
            {get("fileRepeatOn") && (
              <div style={{ opacity: 0.8, fontSize: "0.9em" }}>
                {repeatDescription(
                  exprNumber(get("fileRepeatStart")),
                  exprNumber(get("fileRepeatEnd")),
                  exprNumber(get("fileBeats"))
                )}
              </div>
            )}
          </Section>
        </TabPanel>

        <TabPanel active={panelTab === "signal"}>
          <Section label="gain">
            <Input label="input gain" _key="audioInGain" params={params} set={set} get={get} />
          </Section>
          <Section label="high pass">
            <Input
              label="high pass"
              _key="highPassOn"
              set={set}
              get={get}
              title="Tilt the picture toward the high end, so note starts stand out of the fundamental"
            />
            <Input
              label="cutoff (Hz)"
              _key="highPassHz"
              params={params}
              set={set}
              get={get}
            />
            <Input
              label="filter the sound too"
              _key="highPassAudio"
              set={set}
              get={get}
              title="Also filter the monitor and what the looper records, so you can hear what the picture is showing"
            />
            <div style={{ color: "#aaa", fontSize: "0.8em" }}>
              {!get("highPassOn")
                ? "Off -- the picture is drawn from the input as it arrives."
                : get("highPassAudio")
                ? "12 dB/octave, on the picture and on the sound."
                : "12 dB/octave, on the picture only. The looper still records dry."}
            </div>
          </Section>
          <Section label="looping">
            <Input label="looping (⌘L)" _key="loopingOn" set={set} get={get} />
            <Input label="beatsToLoop" _key="beatsToLoop" params={params} set={set} get={get} />
            <Input
              label="loop echoes"
              _key="loopEchoes"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => n >= 1 && n <= 16}
            />
            <Input
              label="loop echo gain"
              _key="loopEchoGain"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => n >= 0 && n <= 1}
            />
            <Input
              label="audio monitor"
              _key="audioMonitorOn"
              set={set}
              get={get}
            />
          </Section>
          <Section label="device">
            <DevicePicker
              devices={audioDevices}
              active={activeDevices}
              prefs={audioPrefs}
              setPrefs={writeAudioPrefs}
              onOpen={refreshDevices}
              onRestart={() => invoke("restart_app").catch(() => {})}
            />
            <Divider label="latency" />
            <Calibration
              inputCount={inputChannelCount}
              onApply={(frames) => set("bufferCompensation", numExpr(frames))}
            />
          </Section>
          <Section label="input channels">
            <ChannelList
              labels={channelLabels}
              inputCount={inputChannelCount}
              styles={get("channelStyles")}
              pans={get("channelPans")}
              gains={get("channelGains")}
              setStyles={(next) => set("channelStyles", next)}
              setPans={(next) => set("channelPans", next)}
              setGains={(next) => set("channelGains", next)}
            />
          </Section>
          <Section label="latency">
            <Input
              label="bufferCompensation"
              _key="bufferCompensation"
              params={params}
              set={set}
              get={get}
            />
          </Section>
        </TabPanel>

        <TabPanel active={panelTab === "visual"}>
          {/* The frame rather than the signal: what a pane sits on, and what
              sits between the panes. Global on purpose -- a gutter belongs to no
              one pane, and a background that differed pane by pane would read as
              a difference in what is being drawn. The per-pane palette is `row
              colors`, over in the views tab. */}
          <Section label="layout">
            <ColorInput
              label="background"
              value={get("waveformBackground")}
              onChange={(c) => set("waveformBackground", c)}
              title="What a pane is erased to, in both draw modes"
            />
            {/* CSS pixels rather than surface pixels, so a line is the same
                weight on the laptop screen and an external monitor. The note
                below resolves it against the ratio the panes were actually
                measured at, because "one device pixel" is the interesting end
                of this slider and it isn't a round number in CSS pixels. */}
            <Slider
              label="grid width"
              value={gridWidth}
              min={0.5}
              max={4}
              step={0.25}
              onChange={(n) => set("gridWidth", n)}
              title="Grid line thickness in CSS pixels, scaled by the display's pixel ratio"
            />
            <div style={{ color: "#aaa", fontSize: "0.8em" }}>
              {Math.max(1, Math.round(gridWidth * paneScale)) === 1
                ? "1 device pixel -- as thin as this display draws"
                : `${Math.max(
                    1,
                    Math.round(gridWidth * paneScale)
                  )} device pixels`}
            </div>
            <Divider label="between panes" />
            <Slider
              label="pane gap"
              value={get("paneGap")}
              min={0}
              max={24}
              step={1}
              onChange={(n) => set("paneGap", n)}
              title="Gutter between panes, in pixels. 0 butts them together"
            />
            <ColorInput
              label="gap color"
              value={get("paneGapColor")}
              onChange={(c) => set("paneGapColor", c)}
              title="What shows through the gutter between panes"
            />
            {(viewCtxs.length < 2 || get("paneGap") === 0) && (
              <div style={{ color: "#aaa", fontSize: "0.8em" }}>
                No gutter to see -- needs more than one pane and a gap above 0.
              </div>
            )}
          </Section>
          <Section label="visual">
            <Input
              label="visual monitor"
              _key="visualMonitorOn"
              set={set}
              get={get}
            />
            <Input
              label="frame time"
              _key="showFrameTime"
              title="Overlay the draw loop's cost: JS time per frame, and the gap between frames"
              set={set}
              get={get}
            />
            <Input
              label="spectrum analysis"
              _key="analysisOn"
              set={set}
              get={get}
            />
            {/* Frequency resolution against time resolution, and the one knob
                for both: the hop is a quarter of the window, so a shorter one
                narrows the spectrogram's columns and places an attack more
                precisely at the cost of smearing the bass end further. Global
                rather than per-pane -- one FFT feeds every pane and the flux. */}
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>fft window</label>
              <select
                value={get("analysisWindow")}
                onChange={(e) => set("analysisWindow", Number(e.target.value))}
                title="FFT window in frames. Shorter is sharper in time, coarser in frequency"
              >
                {ANALYSIS_WINDOWS.map((n) => (
                  <option key={n} value={n}>
                    {n} ({Math.round((n / sampleRate) * 10000) / 10} ms)
                  </option>
                ))}
              </select>
            </div>
            {/* The band the flux is summed over. Global rather than per-pane:
                it's an audio-thread setting, and narrowing it onto what you're
                listening for is what stops a bass note reading as a snare hit. */}
            <Input
              label="flux band low (Hz)"
              _key="analysisBandLow"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => n > 0 && n < analysisNyquist()}
            />
            <Input
              label="flux band high (Hz)"
              _key="analysisBandHigh"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => n > 0 && n < analysisNyquist()}
            />
            {/* Peak picking. Relative to the flux's local median, so the
                threshold means the same thing loud or quiet; the gap is what
                stops one broad attack reporting its own shoulders. */}
            <Input
              label="onset threshold"
              _key="onsetThreshold"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => Number.isFinite(n) && n >= 0}
            />
            <Input
              label="onset min gap (ms)"
              _key="onsetMinGap"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => Number.isFinite(n) && n >= 0 && n < 10000}
            />
            <Input
              label="onset offset (ms)"
              _key="onsetOffset"
              params={params}
              set={set}
              get={get}
              validate={(n: number) => Number.isFinite(n) && Math.abs(n) < 10000}
            />
          </Section>
        </TabPanel>

        <TabPanel active={panelTab === "views"}>
          <Section label="views">
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>arrangement</label>
              <select
                value={`${viewCols}x${viewRows}`}
                onChange={(e) => {
                  const [cols, rows] = e.target.value.split("x").map(Number);
                  setArrangement(cols, rows);
                }}
              >
                {ARRANGEMENTS.map(([cols, rows]) => (
                  <option key={`${cols}x${rows}`} value={`${cols}x${rows}`}>
                    {cols} across x {rows} down
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="chain panes"
              _key="viewsSequential"
              set={set}
              get={get}
              title="Run the signal through each pane's rows in turn instead of drawing the same beats in all of them"
            />
            {viewCtxs.length > 1 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: "2px",
                  margin: "4px 0",
                }}
              >
                {viewCtxs.map((v) => (
                  <button
                    key={v.index}
                    onClick={() => setSelectedView(v.index)}
                    style={{
                      flex: 1,
                      fontWeight: v.index === activeView ? "bold" : "normal",
                      backgroundColor: v.index === activeView ? "#666" : undefined,
                    }}
                  >
                    view {v.index + 1}
                  </button>
                ))}
              </div>
            )}
            <Divider label="content" />
            <ChannelPicker
              labels={channelLabels}
              styles={get("channelStyles")}
              channels={viewCtxs[activeView]?.cfg.channels ?? []}
              setChannels={(next) => viewIO.set("channels", next)}
            />
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>kind</label>
              <select
                value={viewCtxs[activeView]?.cfg.kind ?? "waveform"}
                onChange={(e) => viewIO.set("kind", e.target.value as ViewKind)}
                title="What the pane's vertical axis means"
              >
                {VIEW_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </div>
            {viewCtxs[activeView]?.cfg.kind === "spectrogram" && (
              <SpectrogramControls
                cfg={viewCtxs[activeView].cfg}
                labels={channelLabels}
                // Only the real inputs are analysed, and only the first few of
                // them -- the buses aren't captured and have no spectrum.
                count={Math.min(inputChannelCount, MAX_ANALYSIS_CHANNELS)}
                set={viewIO.set}
              />
            )}
            <Divider label="layout" />
            <Input
              label="beats per row"
              _key="beatsPerRow"
              params={params}
              {...viewIO}
            />
            <Input
              label="left margin"
              _key="marginLeft"
              params={params}
              {...viewIO}
            />
            <Input
              label="right margin"
              _key="marginRight"
              params={params}
              {...viewIO}
            />
            <Divider label="drawing" />
            <Input
              label="visual gain"
              _key="visualGain"
              params={params}
              {...viewIO}
            />
            <Input label="split up/down" _key="splitChannels" {...viewIO} />
            <Input label="bar color mode" _key="barColorMode" {...viewIO} />
            <Input
              label="refresh at cycle end"
              _key="refreshAtCycleEnd"
              {...viewIO}
            />
            <Divider label="overlays" />
            {viewCtxs[activeView]?.cfg.kind === "waveform" && (
              <>
                <Input label="show flux" _key="showFlux" {...viewIO} />
                {viewCtxs[activeView]?.cfg.showFlux && (
                  <Slider
                    label="flux gain"
                    value={viewCtxs[activeView].cfg.fluxGain}
                    min={0.05}
                    max={4}
                    step={0.05}
                    onChange={(n) => viewIO.set("fluxGain", n)}
                    title="Multiplies the onset function before it is clamped to the row"
                  />
                )}
                <Input label="show onsets" _key="showOnsets" {...viewIO} />
              </>
            )}
            <Divider label="colors & grids" />
            <RowColorList
              colors={viewCtxs[activeView]?.cfg.rowColors ?? []}
              setColors={(colors) => viewIO.set("rowColors", colors)}
            />
            {(viewCtxs[activeView]?.cfg.rowColors.length ?? 0) > 1 && (
              <>
                <Input
                  label={
                    viewCtxs[activeView]?.cfg.splitChannels
                      ? "row color pattern (up)"
                      : "row color pattern"
                  }
                  _key="rowColorPattern"
                  params={params}
                  {...viewIO}
                />
                {/* The halves are different channels, so one palette read
                    through two patterns tells them apart without giving up the
                    row marking. Empty means the lower half reads the pattern
                    above it. */}
                {viewCtxs[activeView]?.cfg.splitChannels && (
                  <Input
                    label="row color pattern (down)"
                    _key="rowColorPatternDown"
                    params={params}
                    {...viewIO}
                  />
                )}
              </>
            )}
            <GridList
              grids={viewCtxs[activeView]?.cfg.grids ?? []}
              setGrids={(grids) => viewIO.set("grids", grids)}
              params={params}
            />
          </Section>
        </TabPanel>
      </>
      {/* <div>{log}</div> */}
    </div>
  );

  const waveform = (
    <div
      style={{
        width: "100%",
        height: "100%",
        // The frame-time overlay is positioned against this, so it sits over
        // the panes without being a grid item and taking a cell of its own.
        position: "relative",
        display: "grid",
        gridTemplateColumns: `repeat(${viewCols}, 1fr)`,
        gridTemplateRows: `repeat(${viewRows}, 1fr)`,
        // The gutter is the container showing through between the panes, so the
        // gap color is this background rather than anything the canvases draw.
        gap: `${get("paneGap")}px`,
        backgroundColor: get("paneGapColor"),
      }}
    >
      {viewCtxs.map((v) => (
        <canvas
          key={v.index}
          ref={(el) => {
            canvasRefs.current[v.index] = el;
          }}
          onClick={() => setHideConfig(!hideConfig)}
          // Setting either attribute blanks the canvas, which is what you want
          // anyway on the resize or rearrangement that changes them.
          width={v.width}
          height={v.height}
          // `min-width`/`min-height` are `auto` on a grid item, and for a
          // replaced element that means *its own aspect ratio* sets the floor:
          // a `1fr` row refuses to shrink below the cell's width divided by the
          // backing store's aspect. Wide enough and the row outgrows the
          // window, which is why hiding the 600px panel -- and nothing else --
          // cut the bottom off. Zero lets the tracks size from the space there
          // actually is.
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            minWidth: 0,
            minHeight: 0,
          }}
        />
      ))}
      {get("showFrameTime") && (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: 4,
            // Diagnostics sit *over* the picture, and must never eat a click
            // meant for the canvas underneath -- clicking a pane is what hides
            // the panel.
            pointerEvents: "none",
            font: "11px ui-monospace, Menlo, monospace",
            color: "#9c9",
            backgroundColor: "rgba(0, 0, 0, 0.55)",
            padding: "2px 6px",
            borderRadius: "3px",
            whiteSpace: "nowrap",
          }}
        >
          <span ref={frameStatsRef}>measuring...</span>
          <span style={{ opacity: 0.6 }}>
            {"  ·  "}
            {viewCols}x{viewRows} panes {"·"} {get("visibleChannels").length} ch
          </span>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {config}
        {waveform}

        {/* <SlidingDivision panel={config} rest={waveform} /> */}
      </div>
    </>
  );
};

export default App;
