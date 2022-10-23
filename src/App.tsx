import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import Canvas from "./Canvas";

interface RustConfig {
	bpm: number,
	beatsToLoop: number,
	clickOn: boolean,
	loopingOn: boolean,
	monitorOn: boolean,
	bufferCompensation: number,
}

const defaultRustConfig: RustConfig = {
	bpm: 180,
	beatsToLoop: 4,
	clickOn: true,
	loopingOn: true,
	monitorOn: true,
	bufferCompensation: 1024
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

  // const [log, setLog] = useState('');
  const [log] = useState("");
  const CANVAS_HEIGHT = 500;
  const CANVAS_WIDTH = 800;
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
		const newRustConfig = {...rustConfig, ...args};
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
    const x = pos[0] / 2;
    const row = pos[1];
    const y = (1 + row) * CANVAS_ROW_HEIGHT * 0.5;
    ctx.strokeStyle = "#FFFFFF";

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - (CANVAS_ROW_HEIGHT - 1) / 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + 0.5, y);
    ctx.lineTo(x + 0.5, y - (CANVAS_ROW_HEIGHT - 1) / 2);
    ctx.stroke();

    ctx.strokeStyle = "#000000";
    ctx.beginPath();
    ctx.moveTo(x, y); //- value * CANVAS_ROW_HEIGHT / 2 / 2);
    ctx.lineTo(x, y - (value * (CANVAS_ROW_HEIGHT - 1)) / 2);
    ctx.stroke();
  };

  let max = 0;

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    for (let i = 0; i < 4; i++) {
      let x = (CANVAS_WIDTH / 8) * i;
      ctx.strokeStyle = "#00880005";
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
    <div>
      <div>{log}</div>

      <label>bpm</label>
      <input
        onChange={(e) => {
          const bpm = parseFloat(e.target.value);
          if (!bpm) return;
          updateRustConfig({ bpm });
        }}
        value={rustConfig.bpm}
      ></input>

      <label>loop size</label>
      <input
        onChange={(e) => {
          const beatsToLoop = parseFloat(e.target.value);
          if (!beatsToLoop) return;
          updateRustConfig({ beatsToLoop });
        }}
        value={rustConfig.beatsToLoop}
      ></input>

      <label>visual gain</label>
      <input
        onChange={(e) => {
          const g = parseFloat(e.target.value);
          if (!g) return;
          setVisualGain(g);
        }}
        value={visualGain}
      ></input>

      <label>click</label>
      <input
        onChange={(e) => {
					const clickOn = !rustConfig.clickOn;
					updateRustConfig({ clickOn })
        }}
        type="checkbox"
        checked={rustConfig.clickOn}
      />

      <label>loop</label>
      <input
        onChange={(e) => {
					const loopingOn = !rustConfig.loopingOn;
					updateRustConfig({ loopingOn })
        }}
        type="checkbox"
        checked={rustConfig.loopingOn}
      />

			<label>monitor</label>
      <input
        onChange={(e) => {
					const monitorOn = !rustConfig.monitorOn;
					updateRustConfig({ monitorOn })
        }}
        type="checkbox"
        checked={rustConfig.monitorOn}
      />

		  <label>buf comp</label>
      <input
        onChange={(e) => {
          const bufferCompensation = parseFloat(e.target.value);
          if (!bufferCompensation) return;
          updateRustConfig({ bufferCompensation });
        }}
        value={rustConfig.bufferCompensation}
      ></input>


      <div id="output"></div>
      <Canvas
        // @ts-expect-error TODO figure out canvas draw type
        draw={draw}
        style={{
          border: "1px solid black",
          height: CANVAS_HEIGHT + "px",
          width: CANVAS_WIDTH + "px",
        }}
        width={CANVAS_WIDTH / 2}
        height={CANVAS_HEIGHT / 2}
      />
    </div>
  );
};

export default App;
