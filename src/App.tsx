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

// const log = <T,>(label: string, x: T) => {
//   console.log(label, x);
//   return x;
// // };

const lowercaseKeys = <T,>(obj: T extends {} ? T : never) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));

// const getIntervals = (nums: number[]): number[] => {
//   const res: number[] = [];
//   for (let i = 1; i < res.length; i++) {
//     res.push(res[i] - res[i - 1]);
//   }
//   return res;
// };

const App = () => {
  const [log, setLog] = useState("");
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
    appWindow.onResized(() => {
      appWindow.innerSize().then(({ width, height }) => {
        // setLog(`${width}x${height}`);
        setJsConfig((jsConfig) => ({
          ...jsConfig,
          canvasHeight: height - 250,
          canvasWidth: width - 500,
        }));
      });
    });
  });

  useEffect(() => {
    setInterval(getArray, 1000 / 100);
  });

  const pickNewMp3 = (filename: string) => () => {
    invoke("set_mp3_buffer", { filename });
  };

  useEffect(() => {
    appWindow.onFileDropEvent((event) => {
      if (event.payload.type === "hover") {
        setLog("User hovering " + JSON.stringify(event.payload.paths));
      } else if (event.payload.type === "drop") {
        setLog("User dropped " + JSON.stringify(event.payload.paths));
        pickNewMp3(event.payload.paths[0])();
      } else {
        setLog("File drop cancelled");
      }
    });
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
  const marginPixels = get("margin") * pixelsPerBeat;
  const canvasPos = useRef(0);
  const samples = useRef<[number, number][]>([]);
  const getArray = async () => {
    const result: [number, number][] = await invoke("get_samples");
    samples.current.push(...result);
  };

  const updateRustConfig = (args: Partial<RustConfig>) => {
    console.log("calling set_config");
    const newRustConfig = { ...rustConfig, ...args };
    setRustConfig(newRustConfig);
    invoke("set_config", lowercaseKeys(newRustConfig));
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
      for (const d of get("subDivisions")) {
        b = startBeat + d + get("subdivisionOffset");
        if (b >= beatsPerWindow) break;
        const [x, row] = getCanvasPos(b);
        const y = row * canvasRowHeight;
        ctx.strokeStyle = "#0088ff";
        ctx.lineWidth = d === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + canvasRowHeight);
        ctx.stroke();
      }
      startBeat += get("subdivisionLoop");
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
      <div>{log}</div>
      <button onClick={resetBeat}>RESET TIME</button>
      <button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_3.wav")}>
        NEW MP3 1
      </button>
      <button onClick={pickNewMp3("/Users/eric/Music/Logic/Logic_4.wav")}>
        NEW MP3 2
      </button>
      <div style={{ display: "flex", flexDirection: "row" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "8px",
            gap: "8px",
            overflowY: "auto",
          }}
        >
          {(
            [
              ["click", "clickOn"],
              ["click toggle", "clickToggle"],
              ["click volume", "clickVolume"],
              ["looping", "loopingOn"],
              ["play file", "playFile"],
              ["visual monitor", "visualMonitorOn"],
              ["audio monitor", "audioMonitorOn"],
              ["bar color mode", "barColorMode"],
              ["bpm", "bpm"],
              ["beatsToLoop", "beatsToLoop"],
              ["subdivision", "subdivision"],
              ["bufferCompensation", "bufferCompensation"],
              ["visual gain", "visualGain"],
              ["visual subdivision loop", "subdivisionLoop"],
              ["beats per row", "beatsPerRow"],
              ["margin", "margin"],
              ["subdivisions", "subDivisions"],
              ["subdivision offset", "subdivisionOffset"],
              ["canvas height", "canvasHeight"],
              ["canvas width", "canvasWidth"],
            ] as [string, ConfigKey][]
          ).map(
            ([label, key]): JSX.Element => (
              <Input label={label} _key={key} get={get} set={set} />
            )
          )}
        </div>
        <Canvas
          // @ts-expect-error TODO figure out canvas draw type
          draw={draw}
          style={{
            border: "1px solid black",
            height: get("canvasHeight") / 2 + "px",
            margin: "8px",
            width: get("canvasWidth") / 2 + "px",
          }}
          width={get("canvasWidth")}
          height={get("canvasHeight")}
        />
      </div>
    </>
  );
};

export default App;
