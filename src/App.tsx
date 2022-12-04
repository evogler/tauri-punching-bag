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
} from "./config";
import { Input } from "./Input";
import { appWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

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

  useEffect(() => {
    const interval = setInterval(getArray, 1000 / 100);
    return () => clearInterval(interval);
  });

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

  const [rustConfig, setRustConfig] = useState(defaultRustConfig);
  const [jsConfig, setJsConfig] = useState(defaultJsConfig);
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

  const maxBeatsInRow = Math.max(...get("beatsPerRow")) + 2 * get("margin");
  const rowBeatsCumulative = get("beatsPerRow").reduce(
    (acc, n) => [...acc, acc.slice(-1)[0] + n],
    [0]
  );
  const pixelsPerBeat = get("canvasWidth") / maxBeatsInRow;
  const canvasRowHeight = get("canvasHeight") / get("beatsPerRow").length;
  const beatsPerWindow = get("beatsPerRow").reduce((sum, n) => sum + n);
  // const marginPixels = get("margin") * pixelsPerBeat;
  const canvasPos = useRef(0);
  const samples = useRef<[number, number][]>([]);
  const getArray = async () => {
    const result: [number, number][] = await invoke("get_samples");
    samples.current.push(...result);
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

  const resetBeat = () => {
    invoke("reset_beat");
  };

  const getCanvasPos = (beat: number, rowOffset = 0): [number, number] => {
    const rows = rowBeatsCumulative;
    const b = beat % beatsPerWindow;
    let y = 0;
    for (let i = 1; i < rows.length; i++) {
      if (b >= rows[i]) {
        y = i;
      } else {
        break;
      }
    }
    y = (y + rowOffset + (rows.length - 1)) % (rows.length - 1);
    let x = (b - rows[y]) * pixelsPerBeat + get("margin") * pixelsPerBeat;
    if (x > beatsPerWindow * pixelsPerBeat) {
      x -= beatsPerWindow * pixelsPerBeat;
    } else if (x < 0) {
      x += beatsPerWindow * pixelsPerBeat;
    }

    return [x, y];
    // y = (y + rowOffset + rows.length) % rows.length;
    // let x = (b - rows[y]) * pixelsPerBeat + get("margin") * pixelsPerBeat;
    // if (x > beatsPerWindow * pixelsPerBeat) x -= beatsPerWindow * pixelsPerBeat;
    // return [x, y];
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
    ctx.strokeStyle = "#222222";
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

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    let startBeat = 0;
    let b = 0;
    while (b < beatsPerWindow) {
      for (const note of get("visualSubdivisions").val.notes) {
        const t = note.time;
        b = startBeat + t;
        if (b >= beatsPerWindow) break;
        const [x, row] = getCanvasPos(b);
        const y = row * canvasRowHeight;
        ctx.strokeStyle = "#0088ff";
        // ctx.lineWidth = d === 0 ? 3 : 1;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + canvasRowHeight);
        ctx.stroke();
      }
      startBeat += get("visualSubdivisions").val.end;
    }

    const vals = samples.current;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vals.length; i++) {
      const [beat, val] = vals[i];
      const [x, y] = getCanvasPos(beat);
      maxSample = Math.max(maxSample, val);
      if (x !== canvasPos.current) {
        const val = Math.min(1, maxSample * get("visualGain"));
        drawSample(ctx, [x, y], val);
        drawSample(ctx, getCanvasPos(beat, 1), val, true);
        drawSample(ctx, getCanvasPos(beat, -1), val, true);
        maxSample = 0;
        canvasPos.current = x;
      }
    }
    samples.current = [];
  };

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
        {!hideConfig && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "1px",
              gap: "2px",
              overflow: "scroll",
              width: "400px",
              height: "100%",
            }}
          >
            <>
              <button onClick={resetBeat}>RESET TIME</button>
              {/* <button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_3.wav")}>
              NEW MP3 1
            </button>
            <button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_4.wav")}>
              NEW MP3 2
            </button> */}

              {(
                [
                  ["click", "clickOn"],
                  ["click toggle", "clickToggle"],
                  ["click volume", "clickVolume"],
                  ["drum on", "drumOn"],
                  ["looping", "loopingOn"],
                  ["play file", "playFile"],
                  ["visual monitor", "visualMonitorOn"],
                  ["audio monitor", "audioMonitorOn"],
                  ["bar color mode", "barColorMode"],
                  ["bpm", "bpm"],
                  ["beatsToLoop", "beatsToLoop"],
                  ["click rhythm", "audioSubdivisions"],
                  ["bufferCompensation", "bufferCompensation"],
                  ["visual gain", "visualGain"],
                  ["visual subdivision loop", "subdivisionLoop"],
                  ["beats per row", "beatsPerRow"],
                  ["margin", "margin"],
                  ["visual subdivisions", "visualSubdivisions"],
                  ["subdivision offset", "subdivisionOffset"],
                  ["canvas height", "canvasHeight"],
                  ["canvas width", "canvasWidth"],
                ] as [string, ConfigKey][]
              ).map(
                ([label, key]): JSX.Element => (
                  <Input label={label} _key={key} get={get} set={set} />
                )
              )}
            </>
            <div>{log}</div>
          </div>
        )}

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
      </div>
    </>
  );
};

export default App;
