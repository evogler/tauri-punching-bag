import { useEffect, useState, useRef } from "react";
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
  ChannelStyle,
  channelStyle,
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
  resolveJsConfig,
  resolveRustConfig,
  viewRowBeats,
  ANALYSIS_BINS,
  ANALYSIS_NYQUIST,
  ANALYSIS_WINDOWS,
  MAX_ANALYSIS_CHANNELS,
  VIEW_KINDS,
  ViewKind,
} from "./config";
import { Input } from "./Input";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SlidingDivision } from "./SlidingDivision";
import { PresetBar } from "./PresetBar";
import { Preset, makePreset, readSession, writeSession } from "./presets";
import { GridList } from "./GridList";
import { RowColorList } from "./RowColorList";
import { SpectrogramControls } from "./SpectrogramControls";
import { Slider } from "./Slider";
import { ParameterList } from "./ParameterList";
import { Layout, getCanvasPositions } from "./layout";
import { ChannelList } from "./ChannelList";
import { DrumList, SampleStatus, makeDrumVoice } from "./DrumList";
import { open as openFileDialog } from "@tauri-apps/api/dialog";

// True only in a plain browser (`yarn start`), where there's no Rust backend to
// call, so samples are faked. Inside the Tauri app -- dev or release -- the IPC
// global is injected and we always use real samples.
const BROWSER_DEBUG_MODE = !("__TAURI_IPC__" in window);

// What the sweep paints over old samples with. The whole-cycle refresh clears to
// the same thing, so both modes sit on the same background.
const WAVEFORM_BACKGROUND = "#222222";

// The pane arrangements the panel offers, as [across, down].
const ARRANGEMENTS: [number, number][] = [
  [1, 1],
  [2, 1],
  [1, 2],
  [3, 1],
  [2, 2],
];

// Per-pane mutable draw state. Every pane needs its own: the sweep flush
// boundary falls where a pixel column ends, and panes disagree about that
// because they each have their own pixelsPerBeat.
type ViewDrawState = {
  // Where the sweep last flushed, in pixels along the loop.
  canvasPos: number;
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
};

const freshViewState = (): ViewDrawState => ({
  canvasPos: 0,
  cycleColumns: new Map(),
  lastCyclePos: 0,
  channelPeaks: [],
  binPeaks: [],
  lastHopBeat: NaN,
  fluxPeaks: [],
  fluxColumn: -1,
  fluxColumns: new Map(),
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

const App = () => {
  const [log, setLog] = useState("log");
  const [hideConfig, setHideConfig] = useState(false);
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

  useEffect(() => {
    // console log the new window size whenever the window is resized
    const unlisten = appWindow.onResized(() => {
      appWindow.innerSize().then(({ width, height }) => {
        // setLog(`${width}x${height}`);
        setJsConfig((jsConfig) => ({
          ...jsConfig,
          canvasHeight: height - 250,
          canvasWidth: width - 500,
        }));
      });
    });
    return () => {
      (async () => await unlisten)();
    };
  });

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

  const pickNewMp3 = (filename: string) => () => {
    invoke("set_mp3_buffer", { filename });
  };

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
    layout: Layout;
    visualGain: number;
    rowHeight: number;
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
  const [selectedView, setSelectedView] = useState(0);

  // Resolved once per render and handed to every field that can hold an
  // expression, so each pane's inputs read the same bindings.
  const params = parameterValues(get("parameters"));

  const viewCols = get("viewCols");
  const viewRows = get("viewRows");
  // Floored once here rather than at the canvas element, so the backing store
  // and the pixelsPerBeat derived from it can't disagree by a fraction.
  const cellWidth = Math.max(1, Math.floor(get("canvasWidth") / viewCols));
  const cellHeight = Math.max(1, Math.floor(get("canvasHeight") / viewRows));

  const viewCtxs: ViewCtx[] = get("views").map((cfg, index) => {
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
      layout: {
        beatsPerRow,
        rowStarts,
        beatsPerWindow: beatsPerRow.reduce((sum, n) => sum + n, 0),
        pixelsPerBeat: cellWidth / maxBeatsInRow,
        marginLeft,
        marginRight,
      },
      visualGain: exprNumber(cfg.visualGain),
      rowHeight: cellHeight / beatsPerRow.length,
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
  type VisualSamples = { channels: number; beats: number[]; values: number[] };
  const samples = useRef<VisualSamples>({ channels: 1, beats: [], values: [] });
  const appendSamples = (batch: VisualSamples) => {
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
  };
  const analysis = useRef<AnalysisFrames>({
    channels: 0,
    bins: 0,
    beats: [],
    mags: [],
    flux: [],
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
  };
  const getArray = async () => {
    appendSamples(await invoke("get_samples"));
    appendAnalysis(await invoke("get_analysis"));
  };

  const mockGetArrayPos = useRef(0);
  const mockHopBeat = useRef(0);
  const beatsPerSample = 91 / 60 / 44100;
  const mockGetArray = async () => {
    const channels = Math.max(1, get("visibleChannels").length);
    const batch: VisualSamples = { channels, beats: [], values: [] };
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
        frames.flux.push(phase < 0.03 ? 0.9 : 0.02 * Math.random());
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

  // The synthetic buses ride along after the real inputs, so each can be shown,
  // coloured and split against them like any other channel. Order has to match
  // how Rust fills them.
  const channelLabels = [
    ...Array.from({ length: inputChannelCount }, (_, i) => `ch ${i + 1}`),
    "drums",
    "click",
  ];

  const updateRustConfig = (args: Partial<RustConfig>) => {
    // console.log("calling set_config");

    const newConfig = { ...rustConfig, ...args };
    setRustConfig(newConfig);
    const newConfigForRust = snakeCaseKeys(unwrapValues(newConfig));
    // console.log("calling set_config with " + newConfigForRust);
    // alert(JSON.stringify(newConfigForRust));
    invoke("set_config", { newConfig: newConfigForRust });
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

  // The eraser: one dark column covering the row, painted before the channels so
  // the previous pass through this spot is gone.
  const eraseColumn = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number
  ) => {
    const y = row * v.rowHeight;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = WAVEFORM_BACKGROUND;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + (v.rowHeight - 1));
    ctx.stroke();
  };

  // `half` splits the waveform about the row's centre line: "up" draws only the
  // top, "down" only the bottom, so two channels can share a row without either
  // losing vertical space.
  const drawChannel = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    value: number,
    style: ChannelStyle,
    isMargin: boolean,
    half: "both" | "up" | "down"
  ) => {
    const y = row * v.rowHeight;
    const height = v.rowHeight - 1;
    const val = Math.min(1, Math.max(value, 0));
    ctx.lineWidth = 1;
    // Margin copies are repeats of another part of the loop, so they're dimmed
    // the way the single-channel version used a darker grey for them.
    ctx.globalAlpha = style.alpha * (isMargin ? 0.55 : 1);
    ctx.beginPath();
    if (v.cfg.barColorMode) {
      const shade = Math.floor(val * 255)
        .toString(16)
        .padStart(2, "0");
      ctx.strokeStyle = `#${shade}${shade}${shade}`;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + height);
    } else {
      ctx.strokeStyle = rowColorFor(v.cfg, row) ?? style.color;
      const top = half === "down" ? 0.5 : 0.5 - 0.5 * val;
      const bottom = half === "up" ? 0.5 : 0.5 + 0.5 * val;
      ctx.moveTo(x, y + top * height);
      ctx.lineTo(x, y + bottom * height);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  // Resolved once per render: the style for each *visible* channel, in the order
  // Rust packs them into the stream. Shared by every pane, so a channel keeps
  // its colour wherever you happen to be looking at it.
  const visibleStyles = get("visibleChannels").map((channel) =>
    channelStyle(get("channelStyles"), channel)
  );

  const halfFor = (v: ViewCtx, slot: number): "both" | "up" | "down" =>
    !v.cfg.splitChannels ? "both" : slot % 2 === 0 ? "up" : "down";

  const drawChannelsAt = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    isMargin: boolean,
    peaks: number[]
  ) => {
    for (let slot = 0; slot < peaks.length; slot++) {
      const style = visibleStyles[slot];
      if (!style) continue;
      drawChannel(
        ctx,
        v,
        x,
        row,
        Math.min(1, peaks[slot] * v.visualGain),
        style,
        isMargin,
        halfFor(v, slot)
      );
    }
  };

  // The flux is per *device* input channel, in device order, so it is indexed by
  // what's in `visibleChannels` rather than by the slot -- unlike the sample
  // stream, which Rust packs in `visibleChannels` order. A slot pointing at a
  // synthetic bus has no entry and is skipped: the buses aren't captured, so
  // there is no spectrum to difference.
  const drawFluxAt = (
    ctx: CanvasRenderingContext2D,
    v: ViewCtx,
    x: number,
    row: number,
    isMargin: boolean,
    peaks: number[]
  ) => {
    const visible = get("visibleChannels");
    for (let slot = 0; slot < visible.length; slot++) {
      const value = peaks[visible[slot]];
      const style = visibleStyles[slot];
      if (value === undefined || !style) continue;
      drawChannel(
        ctx,
        v,
        x,
        row,
        Math.min(1, value * v.cfg.fluxGain),
        style,
        isMargin,
        halfFor(v, slot)
      );
    }
  };

  // `barColorMode` paints the whole row height as a shade, so there is nowhere
  // to put a second signal -- the same reason a spectrogram pane ignores this.
  const showsFlux = (v: ViewCtx) => v.cfg.showFlux && !v.cfg.barColorMode;

  // A second pass over the pane, from the analysis stream. Called *after*
  // drawSweep, which erases each column before redrawing it and would otherwise
  // wipe this out. A hop is stamped at its window centre, half a window behind
  // the newest sample, so the flux lands a few pixels behind the sweep cursor --
  // that is the stamp being honest about when the value describes, not a lag.
  const drawFlux = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { channels, beats, flux } = analysis.current;
    const { beatsPerWindow, pixelsPerBeat } = v.layout;
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
      const column = Math.floor((beat % beatsPerWindow) * pixelsPerBeat);
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
    const { beatsPerWindow, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1 || !flux.length) return;
    for (let i = 0; i < beats.length; i++) {
      const b = ((beats[i] % beatsPerWindow) + beatsPerWindow) % beatsPerWindow;
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

  // Tiles each grid's rhythm across the pane. Drawn last-to-first so the top of
  // the list ends up on top of the stack.
  const drawGrids = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const grids = v.cfg.grids;
    const { beatsPerWindow } = v.layout;
    for (let i = grids.length - 1; i >= 0; i--) {
      const grid = grids[i];
      const { notes, end } = grid.subdivisions.val;
      // A pattern of zero (or negative) length would never advance the tiling.
      if (!(end > 0) || !notes.length) continue;
      ctx.strokeStyle = grid.color;
      ctx.globalAlpha = gridAlpha(grid);
      ctx.lineWidth = 2;
      for (let startBeat = 0; startBeat < beatsPerWindow; startBeat += end) {
        for (const note of notes) {
          const b = startBeat + note.time;
          if (b >= beatsPerWindow) break;
          for (const { x, row } of getCanvasPositions(v.layout, b)) {
            const y = row * v.rowHeight;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + v.rowHeight);
            ctx.stroke();
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
    const { beatsPerWindow, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1) return;
    const peaks = v.state.channelPeaks;
    for (let i = 0; i < beats.length; i++) {
      for (let c = 0; c < channels; c++) {
        const value = values[i * channels + c];
        if (peaks[c] === undefined || value > peaks[c]) peaks[c] = value;
      }
      const beat = beats[i];
      // Flush once per step along the loop -- the beat's own progress, not any
      // one copy's position on screen.
      const sweep = (beat % beatsPerWindow) * pixelsPerBeat;
      if (sweep !== v.state.canvasPos) {
        for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
          eraseColumn(ctx, v, x, row);
          drawChannelsAt(ctx, v, x, row, isMargin, peaks);
        }
        peaks.length = 0;
        v.state.canvasPos = sweep;
      }
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
    const y = row * v.rowHeight;
    const height = v.rowHeight - 1;
    // The column is drawn backwards from `x`: the hops in it cover the span
    // ending at this beat, so anchoring them forward would put every one of
    // them a whole hop late.
    const left = x - width;
    ctx.globalAlpha = 1;
    ctx.fillStyle = WAVEFORM_BACKGROUND;
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
    const { beatsPerWindow, pixelsPerBeat } = v.layout;
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
      const column = Math.floor((beat % beatsPerWindow) * pixelsPerBeat);
      if (column !== v.state.canvasPos) {
        // How much of the loop this column stands for. NaN on the first hop
        // after a reset, and negative where the beat wrapped past the end of
        // the window -- both mean "just this pixel".
        const spanBeats = beat - v.state.lastHopBeat;
        const width = Math.min(
          v.width,
          Math.max(1, Math.ceil(spanBeats * pixelsPerBeat) || 1)
        );
        const positions = getCanvasPositions(v.layout, beat);
        for (const { x, row, isMargin } of positions) {
          drawSpectrumColumn(ctx, v, x, width, row, peaks, style, isMargin);
        }
        // Grids over the spectrum rather than under it -- a column fills the
        // whole row height, so anything beneath it is gone, and seeing the
        // grid across the picture is most of the point. Clipped to the columns
        // just painted so each line is composited exactly once: repainting the
        // whole pane's grids every frame would drive any alpha below 1 to
        // opaque within a few frames.
        if (positions.length) {
          ctx.save();
          ctx.beginPath();
          for (const { x, row } of positions)
            ctx.rect(x - width, row * v.rowHeight, width, v.rowHeight);
          ctx.clip();
          drawGrids(ctx, v);
          ctx.restore();
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
    ctx.fillStyle = WAVEFORM_BACKGROUND;
    ctx.fillRect(0, 0, v.width, v.height);
    drawGrids(ctx, v);
    v.state.cycleColumns.forEach((peaks, column) => {
      // Every beat inside a column lands on the same pixel, so the middle of it
      // stands in for all of them.
      const beat = (column + 0.5) / v.layout.pixelsPerBeat;
      for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
        drawChannelsAt(ctx, v, x, row, isMargin, peaks);
      }
    });
    if (!showsFlux(v)) return;
    v.state.fluxColumns.forEach((peaks, column) => {
      const beat = (column + 0.5) / v.layout.pixelsPerBeat;
      for (const { x, row, isMargin } of getCanvasPositions(v.layout, beat)) {
        drawFluxAt(ctx, v, x, row, isMargin, peaks);
      }
    });
  };

  // The alternative: hold the picture still and repaint the whole pane at once
  // when the beat wraps, so a cycle is only ever shown complete.
  const drawWholeCycle = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    const { channels, beats, values } = samples.current;
    const { beatsPerWindow, pixelsPerBeat } = v.layout;
    if (!(beatsPerWindow > 0) || channels < 1) return;
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const b = ((beat % beatsPerWindow) + beatsPerWindow) % beatsPerWindow;
      // The modulo only ever goes backwards when the beat has wrapped past the
      // end of the window, which is exactly when the finished cycle should go up.
      if (b < v.state.lastCyclePos) {
        paintWholeCycle(ctx, v);
        v.state.cycleColumns.clear();
        v.state.fluxColumns.clear();
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

  const drawView = (ctx: CanvasRenderingContext2D, v: ViewCtx) => {
    if (v.cfg.kind === "spectrogram") {
      // Draws its own grids, per column and on top -- see drawSpectrogram.
      // `refreshAtCycleEnd` is a waveform mode and is ignored here.
      drawSpectrogram(ctx, v);
    } else if (v.cfg.refreshAtCycleEnd) {
      // Collected before the wrap check inside drawWholeCycle: a hop is stamped
      // half a window behind the samples, so the tail of a cycle's flux arrives
      // after the samples have already wrapped, and it belongs to the picture
      // that is about to go up rather than the next one.
      if (showsFlux(v)) collectFlux(v);
      drawWholeCycle(ctx, v);
    } else {
      drawGrids(ctx, v);
      drawSweep(ctx, v);
      // After the sweep: it erases each column just before redrawing it, so
      // anything drawn first is painted over.
      if (showsFlux(v)) drawFlux(ctx, v);
    }
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
    samples.current = {
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
    };
  };

  // The loop reaches the newest drawAll through a ref instead of depending on
  // it: the old `[draw]` dependency tore the animation loop down and rebuilt it
  // on every render, since that closure was new each time.
  const drawAllRef = useRef(drawAll);
  drawAllRef.current = drawAll;
  useEffect(() => {
    let id: number;
    const render = () => {
      drawAllRef.current();
      id = window.requestAnimationFrame(render);
    };
    render();
    return () => window.cancelAnimationFrame(id);
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
            title="Freeze the beat, the click, the file and the display"
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

        <Section label="configs">
          <PresetBar getCurrent={getCurrentPreset} onLoad={loadPreset} />
        </Section>

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
          <Input label="click toggle" _key="clickToggle" set={set} get={get} />
          <Input label="click volume" _key="clickVolume" params={params} set={set} get={get} />
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

        <Section label="gain">
          <Input label="input gain" _key="audioInGain" params={params} set={set} get={get} />
        </Section>

        <Section label="looping">
          <Input label="looping" _key="loopingOn" set={set} get={get} />
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

        <Section label="file">
          <Input label="play file" _key="playFile" set={set} get={get} />
        </Section>

        <Section label="visual">
          <Input
            label="visual monitor"
            _key="visualMonitorOn"
            set={set}
            get={get}
          />
          <Input
            label="visual subdivision offset"
            _key="subdivisionOffset"
            params={params}
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
                  {n} ({Math.round((n / 44100) * 10000) / 10} ms)
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
            validate={(n: number) => n > 0 && n < ANALYSIS_NYQUIST}
          />
          <Input
            label="flux band high (Hz)"
            _key="analysisBandHigh"
            params={params}
            set={set}
            get={get}
            validate={(n: number) => n > 0 && n < ANALYSIS_NYQUIST}
          />
        </Section>

        <Section label="parameters">
          <ParameterList
            parameters={get("parameters")}
            setParameters={setParameters}
          />
        </Section>

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
          <Input
            label="visual gain"
            _key="visualGain"
            params={params}
            {...viewIO}
          />
          <Input label="split up/down" _key="splitChannels" {...viewIO} />
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
            </>
          )}
          <Input label="bar color mode" _key="barColorMode" {...viewIO} />
          <Input
            label="refresh at cycle end"
            _key="refreshAtCycleEnd"
            {...viewIO}
          />
          <RowColorList
            colors={viewCtxs[activeView]?.cfg.rowColors ?? []}
            setColors={(colors) => viewIO.set("rowColors", colors)}
          />
          {(viewCtxs[activeView]?.cfg.rowColors.length ?? 0) > 1 && (
            <Input
              label="row color pattern"
              _key="rowColorPattern"
              {...viewIO}
            />
          )}
          <GridList
            grids={viewCtxs[activeView]?.cfg.grids ?? []}
            setGrids={(grids) => viewIO.set("grids", grids)}
            params={params}
          />
        </Section>

        <Section label="input channels">
          <ChannelList
            labels={channelLabels}
            inputCount={inputChannelCount}
            visible={get("visibleChannels")}
            styles={get("channelStyles")}
            pans={get("channelPans")}
            setVisible={(next) => set("visibleChannels", next)}
            setStyles={(next) => set("channelStyles", next)}
            setPans={(next) => set("channelPans", next)}
          />
        </Section>

        <Section label="misc">
          <Input
            label="bufferCompensation"
            _key="bufferCompensation"
            params={params}
            set={set}
            get={get}
          />
        </Section>
        {/* <Input label="canvas height" _key= "canvasHeight" /> */}
        {/* <Input label="canvas width" _key= "canvasWidth" /> */}
      </>
      {/* <div>{log}</div> */}
    </div>
  );

  const waveform = (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "grid",
        gridTemplateColumns: `repeat(${viewCols}, 1fr)`,
        gridTemplateRows: `repeat(${viewRows}, 1fr)`,
        gap: "2px",
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
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      ))}
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
