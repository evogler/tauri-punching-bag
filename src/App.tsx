import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import Canvas from "./Canvas";

interface RustConfig {
  bpm: number;
  beatsToLoop: number;
  clickOn: boolean;
	clickToggle: boolean;
  loopingOn: boolean;
  visualMonitorOn: boolean;
  audioMonitorOn: boolean;
  bufferCompensation: number;
  subdivision: number;
}

const defaultRustConfig: RustConfig = {
  bpm: 180,
  beatsToLoop: 4,
  clickOn: true,
	clickToggle: false,
  loopingOn: true,
  visualMonitorOn: true,
  audioMonitorOn: true,
  bufferCompensation: 1250,
  subdivision: 3,
};

const lowercaseKeys = <T,>(obj: T extends {} ? T : never) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));

const App = () => {
  // useEffect(() => {
  //   alert('about to try to get audio');
  //   navigator.mediaDevices.getUserMedia({
  //     audio: true,
  //   });
  //   alert('just tried');
  // })

  useEffect(() => {
    setInterval(getArray, 1000 / 100);
  });

  const [rustConfig, setRustConfig] = useState(defaultRustConfig);
  const [visualGain, setVisualGain] = useState(10);
	const [visualSubdivision, setVisualSubdivision] = useState(3);
  // const [log, setLog] = useState('');
  const [log] = useState("");
  const CANVAS_HEIGHT = 1000;
  const CANVAS_WIDTH = 2000;
  const BEATS_PER_ROW = 4;
  const PIXELS_PER_BEAT = CANVAS_WIDTH / BEATS_PER_ROW;
  const CANVAS_ROWS = 4;
  const CANVAS_ROW_HEIGHT = CANVAS_HEIGHT / CANVAS_ROWS;
  const BEATS_PER_WINDOW = BEATS_PER_ROW * CANVAS_ROWS;
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
    const y = Math.floor(b / BEATS_PER_ROW);
    const x = (b % BEATS_PER_ROW) * PIXELS_PER_BEAT;
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
    ctx.strokeStyle = "#FFFFFF";

    for (let x0 = 0; x0 < 2; x0++) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (CANVAS_ROW_HEIGHT - 1));
      ctx.stroke();
    }

    ctx.strokeStyle = "#000000";
    ctx.beginPath();
    const ch = CANVAS_ROW_HEIGHT - 1;

    ctx.moveTo(x, y + (0.5 - 0.5 * value) * ch);
    ctx.lineTo(x, y + (0.5 + 0.5 * value) * ch);
    ctx.stroke();
  };

  let max = 0;

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    const totalLines = BEATS_PER_ROW * visualSubdivision;
    for (let i = 0; i < totalLines; i++) {
      let x = (CANVAS_WIDTH / totalLines) * i;
      ctx.strokeStyle = "#00880020";
      ctx.lineWidth = i % visualSubdivision === 0 ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_HEIGHT);
      ctx.stroke();
    }

    const vals = samples.current;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vals.length; i++) {
      const [beat, val] = vals[i];
      const [x, y] = getCanvasPos(beat);
      max = Math.max(max, val);
      if (x !== canvasPos.current) {
        drawSample(ctx, [x, y], Math.min(1, max * visualGain));
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
          <div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
            <label>visual gain</label>
            <input
              onChange={(e) => {
                const g = parseFloat(e.target.value);
                if (!g) return;
                setVisualGain(g);
              }}
              value={visualGain}
              style={{ width: "4em" }}
            ></input>
          </div>
					<div style={{ display: "flex", flexDirection: "row", gap: "4px" }}>
            <label>visual subdivision</label>
            <input
              onChange={(e) => {
                const g = parseFloat(e.target.value);
                if (!g) return;
                setVisualSubdivision(g);
              }}
              value={visualSubdivision}
              style={{ width: "4em" }}
            ></input>
          </div>
        </div>
        {/* <div id="output"></div> */}
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
