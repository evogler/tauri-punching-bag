import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api";
import Canvas from "./Canvas";

const App = () => {
  useEffect(() => {
    // alert('about to try to get audio');
    // navigator.mediaDevices.getUserMedia({
    //   audio: true,
    // });
    // alert('just tried');
  })

  useEffect(() => {
    setInterval(getArray, 1000 / 100);
  });

  const [bpm, setBpm] = useState(240);
  const CANVAS_HEIGHT = 500;
  const CANVAS_WIDTH = 441;
  const CANVAS_ROWS = 4;
  const CANVAS_ROW_HEIGHT = CANVAS_HEIGHT / CANVAS_ROWS;
  const canvasPos = useRef(0);
  const samples = useRef<number[]>([]);
  const getArray = useCallback(async () => {
    const result: number[] = await invoke("get_samples");
    samples.current.push(...result);
  }, []);

  const drawSample = (
    ctx: CanvasRenderingContext2D,
    pos: number,
    value: number
  ) => {
    const _pos = pos % (CANVAS_WIDTH * CANVAS_ROWS);
    const x = (_pos % CANVAS_WIDTH) * 0.5;
    const row = Math.floor(_pos / CANVAS_WIDTH);
    const y = (0.5 + row) * CANVAS_ROW_HEIGHT * 0.5;
    ctx.strokeStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.moveTo(x, y - CANVAS_ROW_HEIGHT / 2 / 2);
    ctx.lineTo(x, y + CANVAS_ROW_HEIGHT / 2 / 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x + 0.5, y - CANVAS_ROW_HEIGHT / 2 / 2);
    ctx.lineTo(x + 0.5, y + CANVAS_ROW_HEIGHT / 2 / 2);
    ctx.stroke();

    ctx.strokeStyle = "#000000";
    ctx.beginPath();
    ctx.moveTo(x, y); //- value * CANVAS_ROW_HEIGHT / 2 / 2);
    ctx.lineTo(x, y - (value * CANVAS_ROW_HEIGHT) / 2 / 2);
    ctx.stroke();
  };

  const draw = (ctx: CanvasRenderingContext2D, frameCount: number) => {
    for (let i = 0; i < 4; i++) {
      let x = (CANVAS_WIDTH / 8) * i;
      ctx.strokeStyle = "#00880005";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_HEIGHT);
      ctx.stroke();
    }

    let max = 0;
    const vals = samples.current;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vals.length; i++) {
      const p = i + canvasPos.current;
      max += Math.max(max, vals[i]);
      if (p % 200 === 0) {
        drawSample(ctx, p / 200, max * bpm);
      }
      max = 0;
    }
    canvasPos.current += vals.length;
    samples.current = [];
  };

  return (
    <div>
      <input
        onChange={(e) => {
          const g = parseFloat(e.target.value);
          if (!g) return;
          setBpm(g);
        }}
        value={bpm}
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
