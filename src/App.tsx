import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import Canvas from "./Canvas";
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
} from "./config";
import { Input } from "./Input";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SlidingDivision } from "./SlidingDivision";
import { PresetBar } from "./PresetBar";
import { Preset, makePreset, readSession, writeSession } from "./presets";
import { GridList } from "./GridList";
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
  const [rustConfig, setRustConfig] = useState<RustConfig>(() => ({
    ...defaultRustConfig,
    ...restoredSession?.rust,
  }));
  const [jsConfig, setJsConfig] = useState<JsConfig>(() => ({
    ...defaultJsConfig,
    ...restoredSession?.js,
  }));
  const get = <T extends ConfigKey>(k: T) => {
    if (isRustConfigKey(k)) return rustConfig[k] as RustConfig[typeof k];
    else if (isJsConfigKey(k)) return jsConfig[k] as JsConfig[typeof k];
    else return "never" as never;
  };
  const set = <T,>(k: string, v: T) => {
    if (isRustConfigKey(k)) {
      updateRustConfig({ [k]: v });
    } else if (isJsConfigKey(k)) {
      setJsConfig((jsConfig) => ({ ...jsConfig, [k]: v }));
    }
  };

  const maxBeatsInRow =
    Math.max(...get("beatsPerRow")) + get("marginLeft") + get("marginRight");
  const rowBeatsCumulative = get("beatsPerRow").reduce(
    (acc, n) => [...acc, acc.slice(-1)[0] + n],
    [0]
  );
  const pixelsPerBeat = get("canvasWidth") / maxBeatsInRow;
  const canvasRowHeight = get("canvasHeight") / get("beatsPerRow").length;
  const beatsPerWindow = get("beatsPerRow").reduce((sum, n) => sum + n);
  const layout: Layout = {
    beatsPerRow: get("beatsPerRow"),
    rowStarts: rowBeatsCumulative,
    beatsPerWindow,
    pixelsPerBeat,
    marginLeft: get("marginLeft"),
    marginRight: get("marginRight"),
  };

  const canvasPos = useRef(0);
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
  // Whole-cycle mode: the loudest sample seen in each pixel column so far this
  // time round, so holding a cycle's worth of audio costs a few thousand
  // numbers instead of a few hundred thousand samples.
  const cycleColumns = useRef(new Map<number, number[]>());
  const lastCyclePos = useRef(0);
  const getArray = async () => {
    appendSamples(await invoke("get_samples"));
  };

  const mockGetArrayPos = useRef(0);
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

  // The drum bus rides along after the real inputs, so it can be shown, coloured
  // and split against them like any other channel.
  const channelLabels = [
    ...Array.from({ length: inputChannelCount }, (_, i) => `ch ${i + 1}`),
    "drums",
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
    setJsConfig((jsConfig) => ({ ...jsConfig, ...preset.js }));
    updateRustConfig(preset.rust);
  };

  const resetBeat = () => {
    invoke("reset_beat");
  };

  // The eraser: one dark column covering the row, painted before the channels so
  // the previous pass through this spot is gone.
  const eraseColumn = (ctx: CanvasRenderingContext2D, x: number, row: number) => {
    const y = row * canvasRowHeight;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = WAVEFORM_BACKGROUND;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + (canvasRowHeight - 1));
    ctx.stroke();
  };

  // `half` splits the waveform about the row's centre line: "up" draws only the
  // top, "down" only the bottom, so two channels can share a row without either
  // losing vertical space.
  const drawChannel = (
    ctx: CanvasRenderingContext2D,
    x: number,
    row: number,
    value: number,
    style: ChannelStyle,
    isMargin: boolean,
    half: "both" | "up" | "down"
  ) => {
    const y = row * canvasRowHeight;
    const height = canvasRowHeight - 1;
    const v = Math.min(1, Math.max(value, 0));
    ctx.lineWidth = 1;
    // Margin copies are repeats of another part of the loop, so they're dimmed
    // the way the single-channel version used a darker grey for them.
    ctx.globalAlpha = style.alpha * (isMargin ? 0.55 : 1);
    ctx.beginPath();
    if (get("barColorMode")) {
      const shade = Math.floor(v * 255)
        .toString(16)
        .padStart(2, "0");
      ctx.strokeStyle = `#${shade}${shade}${shade}`;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + height);
    } else {
      ctx.strokeStyle = style.color;
      const top = half === "down" ? 0.5 : 0.5 - 0.5 * v;
      const bottom = half === "up" ? 0.5 : 0.5 + 0.5 * v;
      ctx.moveTo(x, y + top * height);
      ctx.lineTo(x, y + bottom * height);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  // Resolved once per frame: the style for each *visible* channel, in the order
  // Rust packs them into the stream.
  const visibleStyles = get("visibleChannels").map((channel) =>
    channelStyle(get("channelStyles"), channel)
  );
  const halfFor = (slot: number): "both" | "up" | "down" =>
    !get("splitChannels") ? "both" : slot % 2 === 0 ? "up" : "down";

  const drawChannelsAt = (
    ctx: CanvasRenderingContext2D,
    x: number,
    row: number,
    isMargin: boolean,
    peaks: number[],
    gain: number
  ) => {
    for (let slot = 0; slot < peaks.length; slot++) {
      const style = visibleStyles[slot];
      if (!style) continue;
      drawChannel(
        ctx,
        x,
        row,
        Math.min(1, peaks[slot] * gain),
        style,
        isMargin,
        halfFor(slot)
      );
    }
  };

  // Peak per visible channel since the last column was drawn.
  let channelPeaks: number[] = [];

  // Tiles each grid's rhythm across the window. Drawn last-to-first so the top
  // of the list ends up on top of the stack.
  const drawGrids = (ctx: CanvasRenderingContext2D) => {
    const grids = get("grids");
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
          for (const { x, row } of getCanvasPositions(layout, b)) {
            const y = row * canvasRowHeight;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + canvasRowHeight);
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
  const drawSweep = (ctx: CanvasRenderingContext2D) => {
    const { channels, beats, values } = samples.current;
    if (!(beatsPerWindow > 0) || channels < 1) return;
    const gain = get("visualGain");
    for (let i = 0; i < beats.length; i++) {
      for (let c = 0; c < channels; c++) {
        const value = values[i * channels + c];
        if (channelPeaks[c] === undefined || value > channelPeaks[c]) {
          channelPeaks[c] = value;
        }
      }
      const beat = beats[i];
      // Flush once per step along the loop -- the beat's own progress, not any
      // one copy's position on screen.
      const sweep = (beat % beatsPerWindow) * pixelsPerBeat;
      if (sweep !== canvasPos.current) {
        for (const { x, row, isMargin } of getCanvasPositions(layout, beat)) {
          eraseColumn(ctx, x, row);
          drawChannelsAt(ctx, x, row, isMargin, channelPeaks, gain);
        }
        channelPeaks.length = 0;
        canvasPos.current = sweep;
      }
    }
  };

  // Repaints the window from the collected cycle. Clearing first means nothing
  // of the previous pass can survive underneath -- and unlike the sweep, there's
  // no per-column erase, so grid lines stay visible behind quiet passages.
  const paintWholeCycle = (ctx: CanvasRenderingContext2D) => {
    ctx.globalAlpha = 1;
    ctx.fillStyle = WAVEFORM_BACKGROUND;
    ctx.fillRect(0, 0, get("canvasWidth"), get("canvasHeight"));
    drawGrids(ctx);
    const gain = get("visualGain");
    cycleColumns.current.forEach((peaks, column) => {
      // Every beat inside a column lands on the same pixel, so the middle of it
      // stands in for all of them.
      const beat = (column + 0.5) / pixelsPerBeat;
      for (const { x, row, isMargin } of getCanvasPositions(layout, beat)) {
        drawChannelsAt(ctx, x, row, isMargin, peaks, gain);
      }
    });
  };

  // The alternative: hold the picture still and repaint the whole window at once
  // when the beat wraps, so a cycle is only ever shown complete.
  const drawWholeCycle = (ctx: CanvasRenderingContext2D) => {
    const { channels, beats, values } = samples.current;
    if (!(beatsPerWindow > 0) || channels < 1) return;
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const b = ((beat % beatsPerWindow) + beatsPerWindow) % beatsPerWindow;
      // The beat only ever moves backwards by wrapping (or by RESET TIME),
      // which is exactly when the finished cycle should go up.
      if (b < lastCyclePos.current) {
        paintWholeCycle(ctx);
        cycleColumns.current.clear();
      }
      lastCyclePos.current = b;
      const column = Math.floor(b * pixelsPerBeat);
      let peaks = cycleColumns.current.get(column);
      if (!peaks || peaks.length !== channels) {
        peaks = new Array(channels).fill(0);
        cycleColumns.current.set(column, peaks);
      }
      // Gain is applied at paint time, so changing it restyles the next repaint
      // rather than only affecting samples collected after the change.
      for (let c = 0; c < channels; c++) {
        const value = values[i * channels + c];
        if (value > peaks[c]) peaks[c] = value;
      }
    }
  };

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    if (get("refreshAtCycleEnd")) {
      drawWholeCycle(ctx);
    } else {
      drawGrids(ctx);
      drawSweep(ctx);
    }
    samples.current = { channels: samples.current.channels, beats: [], values: [] };
  };

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
            set={set}
            get={get}
          />
          <Input label="click toggle" _key="clickToggle" set={set} get={get} />
          <Input label="click volume" _key="clickVolume" set={set} get={get} />
        </Section>

        <Section label="drums">
          <Input label="drums on" _key="drumOn" set={set} get={get} />
          <DrumList
            drums={get("drums")}
            setDrums={(next) => set("drums", next)}
            onAdd={addDrumSample}
            status={sampleStatus}
          />
        </Section>

        <Section label="gain">
          <Input label="input gain" _key="audioInGain" set={set} get={get} />
          <Input label="visual gain" _key="visualGain" set={set} get={get} />
        </Section>

        <Section label="looping">
          <Input label="looping" _key="loopingOn" set={set} get={get} />
          <Input label="beatsToLoop" _key="beatsToLoop" set={set} get={get} />
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
            set={set}
            get={get}
          />
          <Input label="beats per row" _key="beatsPerRow" set={set} get={get} />
          <Input label="left margin" _key="marginLeft" set={set} get={get} />
          <Input label="right margin" _key="marginRight" set={set} get={get} />
          <Input
            label="bar color mode"
            _key="barColorMode"
            set={set}
            get={get}
          />
          <Input
            label="refresh at cycle end"
            _key="refreshAtCycleEnd"
            set={set}
            get={get}
          />
        </Section>

        <Section label="input channels">
          <ChannelList
            labels={channelLabels}
            visible={get("visibleChannels")}
            styles={get("channelStyles")}
            setVisible={(next) => set("visibleChannels", next)}
            setStyles={(next) => set("channelStyles", next)}
          />
          <Input
            label="split up/down"
            _key="splitChannels"
            set={set}
            get={get}
          />
        </Section>

        <Section label="grids">
          <GridList
            grids={get("grids")}
            setGrids={(grids) => set("grids", grids)}
          />
        </Section>

        <Section label="misc">
          <Input
            label="bufferCompensation"
            _key="bufferCompensation"
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
    <div style={{ width: "100%", height: "100%" }}>
      <Canvas
        // @ts-expect-error TODO figure out canvas draw type
        draw={draw}
        onClick={() => setHideConfig(!hideConfig)}
        style={{
          // border: "1px solid black",
          // height: get("canvasHeight") / 2 + "px",
          height: "100%",
          margin: "1px",
          // width: get("canvasWidth") / 2 + "px",
          width: "100%",
        }}
        width={get("canvasWidth")}
        height={get("canvasHeight")}
      />
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
