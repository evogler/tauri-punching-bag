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
} from "./config";
import { Input } from "./Input";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { SlidingDivision } from "./SlidingDivision";
import { PresetBar } from "./PresetBar";
import { Preset, makePreset, readSession, writeSession } from "./presets";
import { GridList } from "./GridList";
import { Layout, getCanvasPositions } from "./layout";

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

const unwrapValues = (obj: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === "object" && v !== null && v.val !== undefined ? v.val : v,
    ])
  );

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
  const samples = useRef<[number, number][]>([]);
  // Whole-cycle mode: the loudest sample seen in each pixel column so far this
  // time round, so holding a cycle's worth of audio costs a few thousand
  // numbers instead of a few hundred thousand samples.
  const cycleColumns = useRef(new Map<number, number>());
  const lastCyclePos = useRef(0);
  const getArray = async () => {
    const result: [number, number][] = await invoke("get_samples");
    samples.current.push(...result);
  };

  const mockGetArrayPos = useRef(0);
  const beatsPerSample = 91 / 60 / 44100;
  const mockGetArray = async () => {
    for (let i = 0; i < 441; i++) {
      samples.current.push([
        mockGetArrayPos.current,
        (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1) *
          (Math.random() * 2 - 1),
      ]);
      mockGetArrayPos.current += beatsPerSample;
    }
  };

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

  const getCurrentPreset = () => makePreset(rustConfig, jsConfig);

  const loadPreset = (preset: Preset) => {
    setJsConfig((jsConfig) => ({ ...jsConfig, ...preset.js }));
    updateRustConfig(preset.rust);
  };

  const resetBeat = () => {
    invoke("reset_beat");
  };

  const drawSample = (
    ctx: CanvasRenderingContext2D,
    pos: [number, number],
    value: number,
    isMarginColor = false
  ) => {
    const x = pos[0];
    const row = pos[1];
    const y = row * canvasRowHeight;
    ctx.strokeStyle = WAVEFORM_BACKGROUND;
    ctx.lineWidth = 1;

    for (let x0 = 0; x0 < 1; x0++) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (canvasRowHeight - 1));
      ctx.stroke();
    }

    ctx.strokeStyle = "#999999";
    const color = Math.floor(Math.abs(Math.min(1, Math.max(value, 0))) * 255);
    const colorHex = color.toString(16).padStart(2, "0");
    ctx.beginPath();
    if (get("barColorMode")) {
      ctx.strokeStyle = `#${colorHex}${colorHex}${colorHex}`;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (canvasRowHeight - 1));
    } else {
      ctx.strokeStyle = isMarginColor ? "#888" : "#CCC";
      const ch = canvasRowHeight - 1;
      ctx.moveTo(x, y + (0.5 - 0.5 * value) * ch);
      ctx.lineTo(x, y + (0.5 + 0.5 * value) * ch);
    }
    ctx.stroke();
  };

  let maxSample = 0;

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
    const vals = samples.current;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vals.length; i++) {
      const [beat, val] = vals[i];
      maxSample = Math.max(maxSample, val);
      if (!(beatsPerWindow > 0)) continue;
      // Flush once per step along the loop, exactly as often as before -- the
      // beat's own progress, not any one copy's position on screen.
      const sweep = (beat % beatsPerWindow) * pixelsPerBeat;
      if (sweep !== canvasPos.current) {
        const peak = Math.min(1, maxSample * get("visualGain"));
        for (const { x, row, isMargin } of getCanvasPositions(layout, beat)) {
          drawSample(ctx, [x, row], peak, isMargin);
        }
        maxSample = 0;
        canvasPos.current = sweep;
      }
    }
  };

  // Repaints the window from the collected cycle. Clearing first means nothing
  // of the previous pass can survive underneath.
  const paintWholeCycle = (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = WAVEFORM_BACKGROUND;
    ctx.fillRect(0, 0, get("canvasWidth"), get("canvasHeight"));
    drawGrids(ctx);
    ctx.lineWidth = 0.5;
    const gain = get("visualGain");
    cycleColumns.current.forEach((sample, column) => {
      // Every beat inside a column lands on the same pixel, so the middle of it
      // stands in for all of them.
      const beat = (column + 0.5) / pixelsPerBeat;
      const peak = Math.min(1, sample * gain);
      for (const { x, row, isMargin } of getCanvasPositions(layout, beat)) {
        drawSample(ctx, [x, row], peak, isMargin);
      }
    });
  };

  // The alternative: hold the picture still and repaint the whole window at once
  // when the beat wraps, so a cycle is only ever shown complete.
  const drawWholeCycle = (ctx: CanvasRenderingContext2D) => {
    if (!(beatsPerWindow > 0)) return;
    const vals = samples.current;
    for (let i = 0; i < vals.length; i++) {
      const [beat, val] = vals[i];
      const b = ((beat % beatsPerWindow) + beatsPerWindow) % beatsPerWindow;
      // The beat only ever moves backwards by wrapping (or by RESET TIME),
      // which is exactly when the finished cycle should go up.
      if (b < lastCyclePos.current) {
        paintWholeCycle(ctx);
        cycleColumns.current.clear();
      }
      lastCyclePos.current = b;
      const column = Math.floor(b * pixelsPerBeat);
      const previous = cycleColumns.current.get(column);
      // Gain is applied at paint time, so changing it restyles the next repaint
      // rather than only affecting samples collected after the change.
      if (previous === undefined || val > previous) {
        cycleColumns.current.set(column, val);
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
    samples.current = [];
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
        // overflow: "scroll",
        width: "600px",
        height: "100%",
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

        <Section label="drum">
          <Input label="drum on" _key="drumOn" set={set} get={get} />
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
