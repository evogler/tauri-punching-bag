import { MutableRefObject, useEffect, useRef } from "react";

type Props = {
  panel: React.ReactNode;
  rest: React.ReactNode;
};

export const PanelAndRest = ({ panel, rest }: Props): React.ReactNode => {
  const panelRef = useRef() as MutableRefObject<HTMLDivElement>;
  const edge = useRef() as MutableRefObject<HTMLDivElement>;
  const restRef = useRef() as MutableRefObject<HTMLDivElement>;

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
    <div id="container">
      <div id="panel" ref={panelRef}>
        {panel}
      </div>
      <div id="edge" ref={edge}></div>
      <div id="rest" ref={restRef}>
        {rest}
      </div>
    </div>
  );
};
