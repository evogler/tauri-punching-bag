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

// const log = <T,>(label: string, x: T) => {
//   console.log(label, x);
//   return x;
// };

const lowercaseKeys = <T,>(obj: T extends {} ? T : never) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));

const App = () => {
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
    setInterval(getArray, 1000 / 100);
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

  const [log] = useState("");
  const pixelsPerBeat = get("canvasWidth") / get("beatsPerRow");
  const canvasRowHeight = get("canvasHeight") / get("canvasRows");
  const beatsPerWindow = get("beatsPerRow") * get("canvasRows");
  const canvasPos = useRef(0);
  const samples = useRef<[number, number][]>([]);
  // const getArray = useCallback(async () => {
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

  const getCanvasPos = (beat: number): [number, number] => {
    const b = beat % beatsPerWindow;
    const y = Math.floor(b / get("beatsPerRow"));
    const x = (b % get("beatsPerRow")) * pixelsPerBeat;
    return [x, y];
  };

  const drawSample = (
    ctx: CanvasRenderingContext2D,
    pos: [number, number],
    value: number
  ) => {
    const x = pos[0];
    const row = pos[1];
    const y = row * canvasRowHeight;
    // ctx.strokeStyle = "#FFFFFF";
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
      ctx.strokeStyle = "#CCC";
      const ch = canvasRowHeight - 1;
      ctx.moveTo(x, y + (0.5 - 0.5 * value) * ch);
      ctx.lineTo(x, y + (0.5 + 0.5 * value) * ch);
    }
    ctx.stroke();
  };

  let maxSample = 0;

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    for (let b = 0; b < get("beatsPerRow"); b++) {
      for (const d of get("subDivisions")) {
        const n = b + d;
        const x = (get("canvasWidth") / get("beatsPerRow")) * n;
        ctx.strokeStyle = "#0088ff";
        ctx.lineWidth = d === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, get("canvasHeight"));
        ctx.stroke();
      }
    }

    const vals = samples.current;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vals.length; i++) {
      const [beat, val] = vals[i];
      const [x, y] = getCanvasPos(beat);
      maxSample = Math.max(maxSample, val);
      if (x !== canvasPos.current) {
        drawSample(ctx, [x, y], Math.min(1, maxSample * get("visualGain")));
        maxSample = 0;
        canvasPos.current = x;
      }
    }
    samples.current = [];
  };

  return (
    <>
      <div>{log}</div>
      <div style={{ display: "flex", flexDirection: "row" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "8px",
            gap: "8px",
          }}
        >
          {(
            [
              ["click", "clickOn"],
              ["click toggle", "clickToggle"],
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
              ["visual subdivision", "visualSubdivision"],
              ["beats per row", "beatsPerRow"],
              ["canvas rows", "canvasRows"],
              ["subdivisions", "subDivisions"],
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
