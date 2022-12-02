import React, { useRef, useEffect } from "react";

interface Props {
  draw: (...args: unknown[]) => void;
}

const Canvas = (props: Props) => {
  const { draw, ...rest } = props;
  const canvasRef = useRef<null | HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    // @ts-expect-error I'm not sure how canvas becomes non-null, TBH.
    const context = canvas.getContext("2d");
    let frameCount = 0;
    let animationFrameId: number;

    const render = () => {
      frameCount++;
      draw(context, frameCount);
      animationFrameId = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [draw]);

  return <canvas ref={canvasRef} {...rest} />;
};

export default Canvas;
