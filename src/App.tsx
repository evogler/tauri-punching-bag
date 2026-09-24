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
  setKit,
  KitSound,
  rowColorFor,
  ViewConfig,
  defaultViewConfig,
  isViewConfigKey,
  MAX_VIEW_SIDE,
  Parameter,
  exprNumber,
  parameterValues,
  rollParameters,
  resolveConfigs,
  applyDrumGrids,
  removeGridVoice,
  viewRowBeats,
  numExpr,
  setSampleRateHz,
  ANALYSIS_BINS,
} from "./config";
import {
  Rect,
  addView,
  copySettings,
  fitViews,
  growView,
  paneOrder,
  removeView,
  resetView,
  selectionAfterRemove,
  swapViews,
  firstFreeRect,
} from "./paneLayout";
import {
  ActiveDevices,
  AudioDeviceInfo,
  AudioPrefs,
  DEVICES_CHANGED_EVENT,
  emptyPrefs,
  pairCompensation,
  withPairCompensation,
} from "./DevicePicker";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SlidingDivision } from "./SlidingDivision";
import {
  KEPT_RUST_KEYS,
  Preset,
  makePreset,
  readSession,
  writeSession,
} from "./presets";
import {
  Layout,
  Position,
  getCanvasPositions,
  rowColumnLayout,
} from "./layout";
import { SampleStatus, makeDrumVoice } from "./DrumList";
import { open as openFileDialog } from "@tauri-apps/api/dialog";
import { BROWSER_DEBUG_MODE } from "./env";
import { Panel } from "./panel/Panel";
import { SetupWizard, shouldOpenSetup } from "./SetupWizard";
import { PanelTab, tabForDigit, tabStep } from "./panel/chrome";
import { FileInfo, PanelProps } from "./panel/types";
import { ui } from "./theme";

// A pane's backing store, in device pixels, and the ratio it was measured at --
// the one number that converts a width in CSS pixels into surface pixels.
type PaneSize = { width: number; height: number; scale: number };

// Only ever used by the render that *creates* a pane's canvas: the layout
// effect measures the real box before the first paint. Not a layout constant --
// nothing is laid out to these numbers.
const UNMEASURED_PANE: PaneSize = { width: 300, height: 150, scale: 1 };

// How long the first config push will wait for the drum samples to decode
// before going ahead without them. Long enough for a local kit, short enough
// that a file on a volume that never answers costs a moment of silence rather
// than the whole session.
const FIRST_PUSH_WAIT_MS = 2000;

// A pane's own label: modest, in a corner, and no more. Both numbers are in CSS
// pixels and are multiplied by the pane's measured ratio at draw time, the way
// `gridWidth` is -- text sized in surface pixels would come out half-height on
// a Retina pane and full height on an external monitor, for the same setting.
// The inset puts it over the lead-in margin, which is the dimmed, duplicated
// part of the picture and so the least worth covering.
const PANE_NAME_SIZE = 11;
const PANE_NAME_INSET = 6;
// Drawn well below full opacity so it reads as a label on the surface rather
// than as something the app measured.
const PANE_NAME_ALPHA = 0.5;

// Black or white, whichever reads against the background, rather than a config
// key of its own: a label has one job, and a second colour picker for it is a
// setting nobody wants to be asked about. Rec. 601 luma, the usual rule for a
// light-or-dark decision; anything unparseable falls back to white, which is
// right for the dark backgrounds this app is used on.
const inkFor = (bg: string): string => {
  const hex = bg.trim().replace(/^#/, "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const n = Number.parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return "#ffffff";
  const luma =
    0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luma > 140 ? "#000000" : "#ffffff";
};

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

const App = () => {
  const [log, setLog] = useState("log");
  const [hideConfig, setHideConfig] = useState(false);
  // Plain state rather than a config key: which tab is open is transient UI,
  // and keeping it out of config keeps it out of presets and the session.
  const [panelTab, setPanelTab] = useState<PanelTab>("play");
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
        // No path is not a failure, and the zeroed FileInfo it answers with
        // would print as a 0-frame file.
        setFileInfo(filename ? info : null);
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
  // A fresh install, or setup part way through a device-change restart.
  const [setupOpen, setSetupOpen] = useState(() =>
    shouldOpenSetup(restoredSession !== null)
  );
  // Resolved on the way in: a session restored from an older build can carry
  // texts whose `val` predates the parameters saved alongside them. Both halves
  // together, because a drum grid lives in the js config and compiles into the
  // rust one -- resolving either alone would restore a stale rhythm.
  const [restored] = useState(() =>
    resolveConfigs(
      { ...defaultRustConfig, ...restoredSession?.rust },
      { ...defaultJsConfig, ...restoredSession?.js }
    )
  );
  const [rustConfig, setRustConfig] = useState<RustConfig>(restored.rust);
  const [jsConfig, setJsConfig] = useState<JsConfig>(restored.js);
  const get = <T extends ConfigKey>(k: T) => {
    if (isRustConfigKey(k)) return rustConfig[k] as RustConfig[typeof k];
    else if (isJsConfigKey(k)) return jsConfig[k] as JsConfig[typeof k];
    else return "never" as never;
  };
  // Every expression-backed field is re-resolved in the same update, so `val`
  // can never lag a parameter change. An effect doing it afterwards would risk
  // a render loop, and would leave one frame drawn from stale numbers.
  const setParameters = (parameters: Parameter[]) => {
    // The rust side has to be re-resolved *and* pushed -- unlike the js config
    // nothing here re-reads it on render, so a stale `val` would sit in the
    // audio thread until the next unrelated setting change. The drum grids are
    // the same hazard one level down: their pulse is expression-backed and what
    // they compile to is a rust-side rhythm.
    const next = resolveConfigs(rustConfig, { ...jsConfig, parameters });
    setJsConfig(next.js);
    updateRustConfig(next.rust);
  };

  // A reroll is an ordinary parameter change -- the new draws are written back
  // as the parameters' stored values and everything downstream re-resolves from
  // them, which is why nothing here knows what a random parameter feeds.
  const reroll = (pick?: (name: string) => boolean) =>
    setParameters(rollParameters(jsConfig.parameters, pick));

  // Rust holds decoded samples and not the path, so the path has to be pushed
  // across whenever it changes -- not once on mount, which is what this was.
  // Picking a file called `loadFile` itself, so the only path that ever changed
  // it without decoding was *loading a preset*: the new preset's `fileBeats`
  // and stretch then applied to whatever file was already in memory, which came
  // out as the old file playing back stretched wrong.
  //
  // A ref rather than a dependency because `loadFile` closes over the state
  // setters and is a new function every render; the path is the only thing that
  // should make this fire.
  const filePushed = useRef<string | null>(null);
  const filePath = get("filePath");
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) return;
    if (filePushed.current === filePath) return;
    filePushed.current = filePath;
    // The empty path is pushed too, and clears the buffer on the Rust side. A
    // preset with no file has to be able to stop the last one playing.
    loadFile(filePath);
  }, [filePath]);


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
    // The ratio this pane was measured at: what converts any other width
    // written in CSS pixels -- the name's size and inset -- into surface ones.
    scale: number;
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
  const paneInk = inkFor(background);
  const gridWidth = get("gridWidth");
  // What the panel's readout resolves a CSS width against: the ratio the panes
  // were measured at, not `window.devicePixelRatio` read again, so the number
  // shown is the one actually being drawn with.
  const paneScale = paneSizes[0]?.scale ?? 1;
  // How many *panes*, which is no longer how many cells: a pane places itself
  // explicitly and cells may be empty.
  const paneCount = get("views").length;

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
  // The chain runs in the order the panes *read* -- by top-left cell, left to
  // right and then down -- not in array order. Array order is the order panes
  // happened to be created in, which stops matching the screen the first time
  // one is swapped or added into a hole, and "the signal runs through pane 1's
  // rows, then pane 2's" has to mean what it looks like.
  const chainStarts: number[] = new Array(viewWindows.length).fill(0);
  let chainTotal = 0;
  for (const i of paneOrder(get("views"))) {
    chainStarts[i] = chainTotal;
    chainTotal += viewWindows[i];
  }

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
    // The rows wrapped into strips. `pixelsPerBeat` is then a *strip's* width
    // divided by the longest row, so asking for two columns halves it: twice
    // as many rows on screen, each drawn at half the resolution. That is the
    // whole trade, and it is arithmetic rather than a compromise.
    const { rowColumns, rowsPerColumn, columnWidth } = rowColumnLayout(
      beatsPerRow.length,
      cfg.rowColumns ?? 1,
      cellWidth
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
        cycleBeats: sequential ? chainTotal : viewWindows[index],
        chainStart: sequential ? chainStarts[index] : 0,
        pixelsPerBeat: columnWidth / maxBeatsInRow,
        marginLeft,
        marginRight,
        rowColumns,
        rowsPerColumn,
        columnWidth,
      },
      visualGain: exprNumber(cfg.visualGain),
      rowHeight: cellHeight / rowsPerColumn,
      gridLineWidth: gridWidth * scale,
      scale,
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

  // Several view fields at once, in one update. One at a time through
  // `viewSetGet` would work -- each is a functional update over the last -- but
  // a generated pane shape is one configuration rather than four independent
  // edits, and a half-applied one draws something nobody asked for.
  const patchView = (index: number, patch: Partial<ViewConfig>) =>
    setJsConfig((js) => ({
      ...js,
      views: js.views.map((v, i) => (i === index ? { ...v, ...patch } : v)),
    }));

  // The arrangement now says how many *cells* there are, not how many panes.
  // Growing it leaves empty cells for the add button to fill; shrinking it
  // re-fits every pane, which moves or shrinks the ones that no longer fit and
  // drops only those with nowhere left to go -- `fitViews` is the single place
  // that judgement is made.
  const setArrangement = (cols: number, rows: number) => {
    const c = Math.max(1, Math.min(MAX_VIEW_SIDE, cols));
    const r = Math.max(1, Math.min(MAX_VIEW_SIDE, rows));
    setJsConfig((js) => {
      const views = fitViews(
        js.views.length ? js.views : [defaultViewConfig()],
        c,
        r
      );
      return { ...js, viewCols: c, viewRows: r, views };
    });
    setSelectedView((i) => Math.min(i, c * r - 1));
  };

  // Every pane operation writes through here, so `views` is replaced wholesale
  // by a list `paneLayout` has already made legal rather than edited in place.
  const setViews = (next: (views: ViewConfig[]) => ViewConfig[] | null) =>
    setJsConfig((js) => {
      const views = next(js.views);
      return views ? { ...js, views } : js;
    });

  // Add into the first empty cell. There is deliberately no "grow the grid to
  // make room": the arrangement is a deliberate choice about how the space is
  // divided, and a button labelled "add a pane" must not silently resize every
  // other one. The button is disabled instead, and says why.
  const paneRoom = firstFreeRect(get("views"), viewCols, viewRows) !== null;
  const paneOps = {
    canAdd: paneRoom,
    // Computed here rather than inside the state updater: an updater has to be
    // a pure function of the state it is handed, and this one has to tell the
    // panel to select the pane it just made.
    add: (at?: Rect) => {
      const next = addView(get("views"), viewCols, viewRows, at);
      if (!next) return;
      setViews(() => next);
      setSelectedView(next.length - 1);
    },
    // Leaves a hole. What it must not do is leave the *selection* pointing at a
    // different pane than the one that was being edited: everything about a
    // pane is indexed by its position in `views`, so removing one shifts every
    // later pane down by one and a selection past the hole has to follow.
    remove: (index: number) => {
      setViews((views) => (views.length > 1 ? removeView(views, index) : views));
      setSelectedView((i) =>
        selectionAfterRemove(i, index, get("views").length)
      );
    },
    grow: (index: number, axis: "col" | "row", delta: 1 | -1) =>
      setViews((views) => growView(views, index, viewCols, viewRows, axis, delta)),
    canGrow: (index: number, axis: "col" | "row", delta: 1 | -1) =>
      growView(get("views"), index, viewCols, viewRows, axis, delta) !== null,
    swap: (a: number, b: number) => setViews((views) => swapViews(views, a, b)),
    copyFrom: (from: number, to: number) =>
      setViews((views) => copySettings(views, from, to)),
    reset: (index: number) => setViews((views) => resetView(views, index)),
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
  // Answers with a promise so the first config push can wait for the kit: a
  // voice whose file is still decoding has no sample in the map, and the
  // callback skips it entirely -- so its hit on beat 0 goes missing however
  // the trigger is seeded.
  const loadDrumSample = (path: string): Promise<void> => {
    // Nothing behind `yarn start` to ask. Kit sounds need no special case:
    // Rust answers for anything already loaded, built-ins included.
    if (BROWSER_DEBUG_MODE) return Promise.resolve();
    if (requestedSamples.current.has(path)) return Promise.resolve();
    requestedSamples.current.add(path);
    setSampleStatus((s) => ({ ...s, [path]: "loading" }));
    return invoke("load_drum_sample", { path })
      .then(() => setSampleStatus((s) => ({ ...s, [path]: "ok" })))
      .catch(() => setSampleStatus((s) => ({ ...s, [path]: "error" })));
  };

  // Answers with the new voice's index, so a grid row can be pointed at what it
  // just added. Null means the pick was cancelled.
  const addDrumSample = async (builtIn?: string): Promise<number | null> => {
    // A kit sound is already loaded under its name, so there is nothing to pick.
    if (builtIn) {
      const drums = get("drums");
      set("drums", [...drums, makeDrumVoice(builtIn)]);
      return drums.length;
    }
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
    if (!path) return null;
    const drums = get("drums");
    set("drums", [...drums, makeDrumVoice(path)]);
    return drums.length;
  };

  // Deleting a voice shifts every index after it, and a grid row names its
  // voice by index -- so the two edits are one operation. `sections[].drums`
  // has exactly the same problem and does *not* fix it up; left alone here
  // rather than changed on the way past.
  const removeDrumVoice = (index: number) => {
    set(
      "drums",
      rustConfig.drums.filter((_, i) => i !== index)
    );
    setJsConfig((js) => ({
      ...js,
      drumGrids: removeGridVoice(js.drumGrids, index),
    }));
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

  // The built-in kit, for the add menu and every drum label. Held module-level
  // (see `setKit`), since `drumLabel` has no way to reach state; this counter
  // only exists to render once more when it arrives.
  const [, setKitVersion] = useState(0);
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) return;
    invoke<KitSound[]>("get_kit")
      .then((next) => {
        setKit(next);
        setKitVersion((v) => v + 1);
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

  // A saved device that is present but cannot do the role it was saved for is
  // not a temporary problem: a microphone will never grow output channels. So
  // forget it and go back to the system default, which is what Rust has already
  // fallen back to for this run. Deliberately *not* done for a device that is
  // merely absent -- an interface that is unplugged today is the one you want
  // back tomorrow, which is the whole reason the choice is stored by UID.
  useEffect(() => {
    if (BROWSER_DEBUG_MODE || audioDevices.length === 0) return;
    const wrongRole = (uid: string, output: boolean) => {
      if (!uid) return false;
      const device = audioDevices.find((d) => d.uid === uid);
      if (!device) return false;
      return (output ? device.outputChannels : device.inputChannels) === 0;
    };
    const badInput = wrongRole(audioPrefs.inputUid, false);
    const badOutput = wrongRole(audioPrefs.outputUid, true);
    if (!badInput && !badOutput) return;
    writeAudioPrefs({
      ...audioPrefs,
      inputUid: badInput ? "" : audioPrefs.inputUid,
      outputUid: badOutput ? "" : audioPrefs.outputUid,
    });
  }, [audioDevices, audioPrefs]);

  // `audio-prefs.json` is the only home for this: it is excluded from presets
  // and from the session (see LOCAL_RUST_KEYS), so the config boots at the
  // default and the stored figure for whatever device actually opened is
  // applied over it, once. A ref rather than state because applying it must not
  // depend on having applied it.
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
  // Pushed on mount whether or not a session was restored, and that is load
  // bearing twice over. Rust boots from its own `default_config()` and stays
  // *silent* until this arrives, so a fresh install with nothing saved would
  // never become audible without it; and `default_config()` is a second
  // definition of the defaults that can drift from `defaultRustConfig`, so
  // pushing unconditionally keeps the frontend the one source of truth.
  const sentFirstConfig = useRef(false);
  useEffect(() => {
    if (sentFirstConfig.current) return;
    sentFirstConfig.current = true;
    // The kit first, because the push is what starts the sound: a voice whose
    // file has not decoded yet is skipped by the callback, so its hit on beat
    // 0 is lost even though the trigger is seeded to fire it. `allSettled`, so
    // one missing file delays nothing and still starts the rest -- and a race
    // against a timeout, so a file on a wedged network volume cannot leave the
    // app silent for ever, which is the one failure the gate could otherwise
    // turn permanent.
    const kit = Promise.allSettled(
      rustConfig.drums.map((voice) => loadDrumSample(voice.path))
    );
    const capped = new Promise((done) => setTimeout(done, FIRST_PUSH_WAIT_MS));
    Promise.race([kit, capped]).then(() =>
      invoke("set_config", { newConfig: snakeCaseKeys(unwrapValues(rustConfig)) })
    );
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

  // A drum grid is edited in the js config and sounds out of the rust one, so
  // the compile has to be re-run whenever either half moves. An effect rather
  // than a call at each of the sites -- a grid edit, a voice added or removed,
  // the arrangement of rows, a preset, the restored session -- because a missed
  // one leaves a rhythm playing that nothing on screen agrees with. It cannot
  // loop: `applyDrumGrids` is a pure function of the grids and the voices and
  // hands back the *same array* when nothing changed, so pushing its own output
  // is a fixed point. Same shape, and the same argument, as the channel union
  // above. The three resolve paths still compile explicitly, so this is the
  // backstop rather than the mechanism, and normally does nothing.
  const griddedDrums = applyDrumGrids(rustConfig.drums, jsConfig.drumGrids);
  useEffect(() => {
    if (griddedDrums === rustConfig.drums) return;
    updateRustConfig({ drums: griddedDrums });
  }, [griddedDrums, rustConfig.drums]);

  // Covers both adding a sample and coming back to one a restored session
  // referred to.
  useEffect(() => {
    if (BROWSER_DEBUG_MODE) return;
    for (const voice of rustConfig.drums) loadDrumSample(voice.path);
  }, [rustConfig.drums]);

  const getCurrentPreset = () => makePreset(rustConfig, jsConfig);

  // Merged over the *defaults*, not over what is loaded now, which is the same
  // rule session restore follows. Merging over the current config made a preset
  // mean "these settings, plus whatever you happen to have" -- so a preset
  // saved before a feature existed could not turn that feature off, and loading
  // A then B gave a hybrid that neither one describes. A practice cycle
  // outliving a preset that has none was this.
  //
  // The cost is that a key added since a preset was saved comes back at its
  // default rather than keeping the current value. That is the honest answer
  // and the one restore already gives.
  const loadPreset = (preset: Preset) => {
    // Last, so they win even over an older preset that still carries them:
    // whether you are paused is not something a preset gets to decide, and the
    // latency of the interface in front of you is not something it can know.
    const kept = Object.fromEntries(
      KEPT_RUST_KEYS.map((k) => [k, rustConfig[k]])
    );
    const next = resolveConfigs(
      { ...defaultRustConfig, ...preset.rust, ...kept },
      { ...defaultJsConfig, ...preset.js }
    );
    setJsConfig(next.js);
    updateRustConfig(next.rust);
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
  const rowBox = (v: ViewCtx, pos: Position) => ({
    y: pos.rowInColumn * v.rowHeight,
    height: v.rowHeight - 1,
  });

  // A row's *horizontal* extent, and the counterpart to `rowBox`. Wrapped into
  // columns a row owns one strip of the pane rather than the whole width, so
  // everything painted inside it is clipped here -- the eraser, the waveform,
  // the flux, the onset ticks, the grids and the spectrogram alike. They have
  // to agree exactly, for the reason the eraser and the waveform already share
  // `columnLeft`: the sweep only ever erases columns it visits, so a pixel
  // painted into the neighbouring strip is one nothing comes back to clear.
  //
  // With one column the strip is the pane, and the clip is the canvas edge the
  // browser was already applying -- so this changes not a pixel there.
  const clipToStrip = (
    v: ViewCtx,
    pos: Position,
    left: number,
    width: number
  ) => {
    const stripLeft = pos.column * v.layout.columnWidth;
    const l = Math.max(left, stripLeft);
    const r = Math.min(left + width, stripLeft + v.layout.columnWidth);
    return { left: l, width: r - l };
  };

  // The whole pixel columns a draw at `x` spanning `span` of them occupies,
  // clipped to its strip. `columnLeft` says which columns the sweep just
  // crossed; this says which of them belong to this row.
  const columnRect = (v: ViewCtx, pos: Position, span: number) =>
    clipToStrip(v, pos, columnLeft(pos.x, span), span);

  const eraseColumn = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    pos: Position,
    span: number
  ) => {
    const { y, height } = rowBox(v, pos);
    const { left, width } = columnRect(v, pos, span);
    if (width <= 0) return;
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
    ctx.fillRect(left, top, width, bottom - top);
  };

  // `half` splits the waveform about the row's centre line: "up" draws only the
  // top, "down" only the bottom, so two channels can share a row without either
  // losing vertical space.
  const drawChannel = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    pos: Position,
    span: number,
    value: number,
    style: ChannelStyle,
    half: "both" | "up" | "down"
  ) => {
    const { y, height } = rowBox(v, pos);
    const { left, width } = columnRect(v, pos, span);
    if (width <= 0) return;
    const val = Math.min(1, Math.max(value, 0));
    drawOps.current++;
    // Margin copies are repeats of another part of the loop, so they're dimmed
    // the way the single-channel version used a darker grey for them.
    ctx.globalAlpha = style.alpha * (pos.isMargin ? 0.55 : 1);
    // Whole columns across, fractional down: the horizontal edges have to land
    // on the pixel grid so the eraser can cover them, but the vertical extent
    // is the *signal*, and rounding it would drop a quiet passage to nothing
    // instead of drawing it faintly.
    if (v.cfg.barColorMode) {
      const shade = Math.floor(val * 255)
        .toString(16)
        .padStart(2, "0");
      ctx.fillStyle = `#${shade}${shade}${shade}`;
      ctx.fillRect(left, y, width, height);
    } else {
      // The row the colour pattern is indexed by is the pane's own row, not the
      // slot it wrapped into -- "every fourth row marks the beat" has to keep
      // meaning that when the rows are dealt into two strips.
      ctx.fillStyle = rowColorFor(v.cfg, pos.row, half) ?? style.color;
      const top = half === "down" ? 0.5 : 0.5 - 0.5 * val;
      const bottom = half === "up" ? 0.5 : 0.5 + 0.5 * val;
      ctx.fillRect(left, y + top * height, width, (bottom - top) * height);
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
    pos: Position,
    span: number,
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
        pos,
        span,
        Math.min(1, peaks[slot] * v.visualGain * channelGains[channel]),
        style,
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
    pos: Position,
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
        pos,
        1,
        Math.min(1, value * v.cfg.fluxGain),
        style,
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
        for (const pos of getCanvasPositions(v.layout, beat)) {
          drawFluxAt(ctx, v, pos, peaks);
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
    pos: Position,
    mark: OnsetMark
  ) => {
    const index = v.channels.indexOf(mark.channel);
    const style = channelStyles[mark.channel];
    if (index < 0 || !style) return;
    const { y, height } = rowBox(v, pos);
    const { left, width } = clipToStrip(v, pos, pos.x - 1, 2);
    if (width <= 0) return;
    const tick = Math.max(3, height * ONSET_TICK);
    // In split mode the tick sits on the edge its channel's waveform grows
    // from, so two channels' onsets stay told apart.
    const top = halfFor(v, index) === "down" ? y + height - tick : y;
    ctx.globalAlpha = style.alpha * (pos.isMargin ? 0.55 : 1);
    ctx.fillStyle = style.color;
    drawOps.current++;
    ctx.fillRect(left, top, width, tick);
    ctx.globalAlpha = 1;
  };

  // Onsets are discrete and already carry a sub-hop beat, so there is no column
  // accumulation here -- each one is simply drawn everywhere its beat lands.
  // Called after drawSweep and drawFlux, both of which would paint over it.
  const drawOnsets = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { onsets } = analysis.current;
    if (!(v.layout.beatsPerWindow > 0)) return;
    for (const mark of onsets) {
      for (const pos of getCanvasPositions(v.layout, mark.beat)) {
        drawOnsetMark(ctx, v, pos, mark);
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
          for (const pos of getCanvasPositions(v.layout, b)) {
            const top = Math.round(pos.rowInColumn * v.rowHeight);
            const bottom = Math.round((pos.rowInColumn + 1) * v.rowHeight);
            // Snapped to whole pixels, and filled rather than stroked. A stroke
            // at a fractional x spreads its width over one more column than it
            // asked for, at partial coverage -- and since the grids are
            // repainted every frame, alpha compositing drives every column it
            // touches to full opacity anyway. The line's width on screen was
            // therefore *how many columns it overlapped*, so 1 device pixel and
            // 2 came out as 2 columns and 3 rather than as 1 and 2, and the
            // setting looked like it did nothing.
            // Clipped to the row's own strip like everything else: a line at
            // the right edge of a row would otherwise land a pixel inside the
            // next column, where it belongs to nothing.
            const rect = clipToStrip(
              v,
              pos,
              Math.round(pos.x - width / 2),
              width
            );
            if (rect.width <= 0) continue;
            drawOps.current++;
            ctx.fillRect(rect.left, top, rect.width, bottom - top);
          }
        }
      }
    }
    // The samples drawn afterwards are always fully opaque.
    ctx.globalAlpha = 1;
  };

  // The pane's label. Painted on the *visible* canvas after the layer blit, for
  // the same reason the grids are: the layer is erased a column at a time by
  // the sweep, so anything put there is eaten within a pass, and anything
  // composited onto it repeatedly climbs to full opacity. Last of all, so a
  // grid line never crosses the text.
  const drawPaneName = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    // Empty is the default and means draw nothing -- what every pane did before
    // names existed.
    const name = v.cfg.name?.trim();
    if (!name) return;
    drawOps.current++;
    ctx.save();
    ctx.globalAlpha = PANE_NAME_ALPHA;
    ctx.fillStyle = paneInk;
    ctx.font = `${PANE_NAME_SIZE * v.scale}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(name, PANE_NAME_INSET * v.scale, PANE_NAME_INSET * v.scale);
    ctx.restore();
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
          for (const pos of getCanvasPositions(v.layout, v.state.pendingBeat)) {
            const right = Math.floor(pos.x);
            // Not finite on the first flush, negative when the loop wrapped;
            // both mean "just this column". A row is only ever as wide as its
            // own strip, so that -- not the pane -- bounds the rest. Columns
            // the span reaches outside the strip are ones this row never drew
            // into, and `columnRect` drops them.
            const left =
              advance > 0
                ? Math.max(
                    right - v.layout.columnWidth + 1,
                    Math.floor(pos.x - advance) + 1
                  )
                : right;
            const span = right - left + 1;
            eraseColumn(ctx, v, pos, span);
            drawChannelsAt(ctx, v, pos, span, peaks);
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
    pos: Position,
    hopWidth: number,
    peaks: number[],
    style: ChannelStyle
  ) => {
    const { y, height } = rowBox(v, pos);
    // The column is drawn backwards from `x`: the hops in it cover the span
    // ending at this beat, so anchoring them forward would put every one of
    // them a whole hop late. Clipped to the row's strip, which is what stops a
    // wide hop at a row's left edge reaching back into the column beside it --
    // the same rule the waveform's eraser follows, and for the same reason:
    // this pane repaints a strip at a time and never revisits its neighbour.
    const { left, width } = clipToStrip(v, pos, pos.x - hopWidth, hopWidth);
    if (width <= 0) return;
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
        Math.min(1, level) * style.alpha * (pos.isMargin ? 0.55 : 1);
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
          v.layout.columnWidth,
          Math.max(1, Math.ceil(spanBeats * pixelsPerBeat) || 1)
        );
        for (const pos of getCanvasPositions(v.layout, beat)) {
          drawSpectrumColumn(ctx, v, pos, width, peaks, style);
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
      for (const pos of getCanvasPositions(v.layout, beat)) {
        drawChannelsAt(ctx, v, pos, 1, peaks);
      }
    });
    if (showsFlux(v)) {
      v.state.fluxColumns.forEach((peaks, column) => {
        const beat = (column + 0.5) / v.layout.pixelsPerBeat;
        for (const pos of getCanvasPositions(v.layout, beat)) {
          drawFluxAt(ctx, v, pos, peaks);
        }
      });
    }
    // Last, so a tick is never painted over by the waveform or the flux.
    if (showsOnsets(v)) {
      for (const mark of v.state.cycleOnsets) {
        for (const pos of getCanvasPositions(v.layout, mark.beat)) {
          drawOnsetMark(ctx, v, pos, mark);
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
    drawPaneName(ctx, v);
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
        // The wrap is geometry too: with the rows dealt into a different number
        // of strips the old picture stands in whatever columns the new one
        // never reaches, which is exactly what a zoom change does.
        `${v.layout.rowColumns}x${v.layout.columnWidth}:` +
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
  // Opening a section also brings the panel back: a shortcut that silently
  // does nothing because the panel is hidden reads as a broken shortcut.
  const openTabRef = useRef((tab: PanelTab) => {});
  openTabRef.current = (tab) => {
    setPanelTab(tab);
    setHideConfig(false);
  };
  const stepTabRef = useRef((by: number) => {});
  stepTabRef.current = (by) => openTabRef.current(tabStep(panelTab, by));
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      // The section rail: ⌘1..⌘9 then ⌘0, counting down the rail, and ⌘[ / ⌘]
      // to step through the whole of it once the digits run out. Taken
      // unconditionally like ⌘P and ⌘L -- none of them is a text-editing key,
      // and ⌘0 only resets the zoom in a browser, which this is not.
      if (!e.shiftKey && key.length === 1 && key >= "0" && key <= "9") {
        const tab = tabForDigit(key);
        if (!tab) return;
        e.preventDefault();
        openTabRef.current(tab);
        return;
      }
      if (!e.shiftKey && (key === "[" || key === "]")) {
        e.preventDefault();
        stepTabRef.current(key === "]" ? 1 : -1);
        return;
      }
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
    <Panel
      panelTab={panelTab}
      setPanelTab={setPanelTab}
      // The same function; TS cannot prove its inferred generic return, which
      // routes by which half a key lives in, equals Config[K].
      get={get as unknown as PanelProps["get"]}
      set={set}
      params={params}
      resetBeat={resetBeat}
      configError={configError}
      setParameters={setParameters}
      reroll={reroll}
      getCurrentPreset={getCurrentPreset}
      loadPreset={loadPreset}
      rustConfig={rustConfig}
      addDrumSample={addDrumSample}
      removeDrumVoice={removeDrumVoice}
      sampleStatus={sampleStatus}
      chooseFile={chooseFile}
      fileInfo={fileInfo}
      fileError={fileError}
      setTempoFromFile={setTempoFromFile}
      stretching={stretching}
      audioDevices={audioDevices}
      activeDevices={activeDevices}
      audioPrefs={audioPrefs}
      writeAudioPrefs={writeAudioPrefs}
      refreshDevices={refreshDevices}
      inputChannelCount={inputChannelCount}
      channelLabels={channelLabels}
      sampleRate={sampleRate}
      gridWidth={gridWidth}
      paneScale={paneScale}
      viewCols={viewCols}
      viewRows={viewRows}
      setArrangement={setArrangement}
      activeView={activeView}
      setSelectedView={setSelectedView}
      viewIO={viewIO}
      patchView={patchView}
      paneOps={paneOps}
      views={get("views")}
      paneCount={viewCtxs.length}
      activeCfg={viewCtxs[activeView]?.cfg}
      openSetup={() => setSetupOpen(true)}
      togglePaused={() => toggleRef.current("paused")}
    />
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
          // actually is. Load-bearing a third time now that a pane can span
          // two cells: a spanning pane's backing store is twice as wide, so its
          // automatic minimum would be twice the floor as well, and a track
          // sized from it would push the panes it shares a row with off screen.
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            // Explicit placement: the pane's own rectangle of cells, rather
            // than wherever auto-flow would have dropped it. CSS grid lines
            // are 1-based and the config is 0-based, which is converted here
            // and nowhere else.
            gridColumn: `${v.cfg.col + 1} / span ${v.cfg.colSpan}`,
            gridRow: `${v.cfg.row + 1} / span ${v.cfg.rowSpan}`,
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
            color: ui.overlayInk,
            backgroundColor: "rgba(0, 0, 0, 0.55)",
            padding: "2px 6px",
            borderRadius: "3px",
            whiteSpace: "nowrap",
          }}
        >
          <span ref={frameStatsRef}>measuring...</span>
          <span style={{ opacity: 0.6 }}>
            {"  ·  "}
            {paneCount} in {viewCols}x{viewRows} {"·"}{" "}
            {get("visibleChannels").length} ch
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
        {setupOpen && (
          <SetupWizard
            devices={audioDevices}
            active={activeDevices}
            prefs={audioPrefs}
            setPrefs={writeAudioPrefs}
            refreshDevices={refreshDevices}
            inputCount={inputChannelCount}
            channelLabels={channelLabels}
            get={get}
            set={set}
            sampleRate={sampleRate}
            onClose={() => setSetupOpen(false)}
          />
        )}

        {/* <SlidingDivision panel={config} rest={waveform} /> */}
      </div>
    </>
  );
};

export default App;
