import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import Canvas from "./Canvas";

// interface RustConfig {
//   bpm: number;
//   beatsToLoop: number;
//   clickOn: boolean;
//   clickToggle: boolean;
//   playFile: boolean;
//   loopingOn: boolean;
//   visualMonitorOn: boolean;
//   audioMonitorOn: boolean;
//   bufferCompensation: number;
//   subdivision: number;
// }

const defaultRustConfig = {
  audioMonitorOn: true,
  beatsToLoop: 4,
  bpm: 140,
  bufferCompensation: 1250,
  clickOn: true,
  clickToggle: false,
  loopingOn: true,
  playFile: true,
  subdivision: 1,
  visualMonitorOn: true,
};
type RustConfig = typeof defaultRustConfig;
type RustConfigKey = keyof RustConfig;
const isRustConfigKey = (k: string): k is RustConfigKey =>
  k in defaultRustConfig;

const defaultJsConfig = {
  barColorMode: false,
  beatsPerRow: 4,
  canvasRows: 4,
  subDivisions: [0, 0.6],
  visualGain: 10,
  visualSubdivision: 3,
};
type JsConfig = typeof defaultJsConfig;
type JsConfigKey = keyof JsConfig;
const isJsConfigKey = (k: string): k is JsConfigKey => k in defaultJsConfig;

type ConfigKey = (RustConfigKey | JsConfigKey);

const ArrayInput = ({
  value,
  set,
  label,
}: {
  value: number[];
  set: any;
  label: string;
}) => {
  const [isFocused, setIsFocused] = useState(false);
  const [focusedVal, setFocusedVal] = useState(value.join(","));
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
      <label>{label}</label>
      <input
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            const g = v.split(",").map(parseFloat);
            set(g);
          } catch (e) {}
        }}
        value={isFocused ? focusedVal : value.join(", ")}
        style={{ width: "8em" }}
      ></input>
    </div>
  );
};

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
  const CANVAS_HEIGHT = 800;
  const CANVAS_WIDTH = 2000;
  const PIXELS_PER_BEAT = CANVAS_WIDTH / get("beatsPerRow");
  const CANVAS_ROW_HEIGHT = CANVAS_HEIGHT / get("canvasRows");
  const BEATS_PER_WINDOW = get("beatsPerRow") * get("canvasRows");
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
    const b = beat % BEATS_PER_WINDOW;
    const y = Math.floor(b / get("beatsPerRow"));
    const x = (b % get("beatsPerRow")) * PIXELS_PER_BEAT;
    return [x, y];
  };

  const drawSample = (
    ctx: CanvasRenderingContext2D,
    pos: [number, number],
    value: number
  ) => {
    const x = pos[0];
    const row = pos[1];
    const y = row * CANVAS_ROW_HEIGHT;
    // ctx.strokeStyle = "#FFFFFF";
    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;

    for (let x0 = 0; x0 < 1; x0++) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (CANVAS_ROW_HEIGHT - 1));
      ctx.stroke();
    }

    ctx.strokeStyle = "#999999";
    const color = Math.floor(Math.abs(Math.min(1, Math.max(value, 0))) * 255);
    const colorHex = color.toString(16).padStart(2, "0");
    ctx.beginPath();
    if (get("barColorMode")) {
      ctx.strokeStyle = `#${colorHex}${colorHex}${colorHex}`;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (CANVAS_ROW_HEIGHT - 1));
    } else {
      ctx.strokeStyle = "#CCC";
      const ch = CANVAS_ROW_HEIGHT - 1;
      ctx.moveTo(x, y + (0.5 - 0.5 * value) * ch);
      ctx.lineTo(x, y + (0.5 + 0.5 * value) * ch);
    }
    ctx.stroke();
  };

  let max = 0;

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    for (let b = 0; b < get("beatsPerRow"); b++) {
      for (const d of get("subDivisions")) {
        const n = b + d;
        const x = (CANVAS_WIDTH / get("beatsPerRow")) * n;
        ctx.strokeStyle = "#0088ff";
        ctx.lineWidth = d === 0 ? 3 : 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, CANVAS_HEIGHT);
        ctx.stroke();
      }
    }

    const vals = samples.current;
    // const vals = [...new Array(50)].map(() => [Math.random() * 10000, Math.random() * 2 - 1]);
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vals.length; i++) {
      const [beat, val] = vals[i];
      const [x, y] = getCanvasPos(beat);
      max = Math.max(max, val);
      if (x !== canvasPos.current) {
        drawSample(ctx, [x, y], Math.min(1, max * get("visualGain")));
        max = 0;
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
              "clickOn",
              "clickToggle",
              "loopingOn",
              "playFile",
              "visualMonitorOn",
              "audioMonitorOn",
            ] as (keyof RustConfig)[]
          ).map((s) => (
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>{s}</label>
              <input
                onChange={(e) => updateRustConfig({ [s]: !rustConfig[s] })}
                type="checkbox"
                checked={Boolean(rustConfig[s])}
              />
            </div>
          ))}
          {(
            [
              "bpm",
              "beatsToLoop",
              "subdivision",
              "bufferCompensation",
            ] as (keyof RustConfig)[]
          ).map((s) => (
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>{s}</label>
              <input
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!val) return;
                  updateRustConfig({ [s]: val });
                }}
                value={Number(rustConfig[s])}
                style={{ width: "4em" }}
              />
            </div>
          ))}
          {(
            [
              ["visual gain", "visualGain"],
              ["visual subdivision", "visualSubdivision"],
              ["beats per row", "beatsPerRow"],
              ["canvas rows", "canvasRows"],
            ] as [string, ConfigKey][]
          ).map(([label, key]) => (
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>{label}</label>
              <input
                onChange={(e) => {
                  const g = parseFloat(e.target.value);
                  if (!g) return;
                  set(key, g);
                }}
                value={JSON.stringify(get(key))}
                style={{ width: "4em" }}
              ></input>
            </div>
          ))}
          {(
            [["bar color mode", 'barColorMode']] as [
              string,
              ConfigKey,
            ][]
          ).map(([label, key]) => (
            <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
              <label>{label}</label>
              <input
                onChange={(e) => set(key, !get(key))}
                type="checkbox"
                checked={get(key) as boolean}
              ></input>
            </div>
          ))}
          <ArrayInput
            value={get('subDivisions')}
            set={((v: any) => set('subDivisions', v))}
            label="subdivisions"
          />
        </div>
        <Canvas
          // @ts-expect-error TODO figure out canvas draw type
          draw={draw}
          style={{
            border: "1px solid black",
            height: CANVAS_HEIGHT / 2 + "px",
            margin: "8px",
            width: CANVAS_WIDTH / 2 + "px",
          }}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
        />
      </div>
    </>
  );
};

export default App;
