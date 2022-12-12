import { useEffect, useRef } from "react";

type Props = {
  panel: React.ReactNode;
  rest: React.ReactNode;
};

export const SlidingDivision = ({ panel, rest }: Props): JSX.Element => {
  const panelRef = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const restRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: MouseEvent) => {
    const x = e.clientX;
    const overallWidth = document.body.clientWidth;
    if (
      panelRef.current === null ||
      restRef.current === null ||
      edge.current === null
    )
      return;
    panelRef.current.style.width = x - edge.current.clientWidth / 2 + "px";
    restRef.current.style.width =
      overallWidth - x - edge.current.clientWidth / 2 + "px";
  };

  useEffect(() => {
    if (edge.current === null) return;
    const handleMouseDown = () =>
      document.body.addEventListener("mousemove", handleMouseMove);
    edge.current.addEventListener("mousedown", handleMouseDown);
    const edgeCopy = edge.current;
    return () => {
      edgeCopy.removeEventListener("mousedown", handleMouseDown);
      document.body.removeEventListener("mousemove", handleMouseMove);
    };
  });

  useEffect(() => {
    if (edge.current === null) return;
    const handleMouseUp = () => {
      document.body.removeEventListener("mousemove", handleMouseMove);
    };
    document.body.addEventListener("mouseup", handleMouseUp);
    const edgeCopy = edge.current;
    return () => edgeCopy.removeEventListener("mouseup", handleMouseUp);
  });

  return (
    <div className="container">
      <div className="panel" ref={panelRef}>
        {panel}
      </div>
      <div className="edge" ref={edge}></div>
      <div className="rest" ref={restRef}>
        {rest}
      </div>
    </div>
  );
};
