import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import Canvas from "./Canvas";


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

  const [bpm, setBpm] = useState(240);
  const [visualGain, setVisualGain] = useState(10);
  // const [log, setLog] = useState('');
  const [log] = useState('');
  const CANVAS_HEIGHT = 500;
  const CANVAS_WIDTH = 441;
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

	const setRustBpm = (bpm: number) => {
		invoke("set_bpm", { bpm });
	}

  const getCanvasPos = (beat: number): [number, number] => {
    const b = beat % BEATS_PER_WINDOW;
    const y = Math.floor(b / BEATS_PER_ROW);
    const x = b % BEATS_PER_ROW * PIXELS_PER_BEAT;
    return [x, y];
  }

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
    ctx.lineTo(x, y - (CANVAS_ROW_HEIGHT - 1) / 2 );
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
      <div>Is this thing on???</div>
      <div>{log}</div>
      <label>bpm</label>
      <input
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!n) return;
          setBpm(n);
					setRustBpm(n);
        }}
        value={bpm}
      >
      </input>
      <label>visual gain</label>
      <input
        onChange={(e) => {
          const g = parseFloat(e.target.value);
          if (!g) return;
          setVisualGain(g);
        }}
        value={visualGain}
      >
      </input>


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
