import { useRef, useState } from "react";
import { GRID_COLORS, Rhythm, VisualGrid, gridAlpha, gridShift } from "./config";
import { useHelp } from "./help";
import { accepts, invalidBorder, useFocusedValue } from "./Input";
import { Params, evaluate, resolveRhythmText } from "./expression";
import parser1 from "./parser1";
import parser2 from "./parser2";
import { ui } from "./theme";

const parserFor = (rhythm: Rhythm) =>
  rhythm.type === "parser1" ? parser1 : parser2;

// One line per beat -- the least surprising thing for a grid you just added.
const NEW_GRID_TEXT = "1:1";

const DROP_LINE = ui.dropLine;

// Picks the first palette color not already on screen so a new grid doesn't
// land invisibly on top of an existing one.
const nextColor = (grids: VisualGrid[]) =>
  GRID_COLORS.find((c) => !grids.some((g) => g.color === c)) ??
  GRID_COLORS[grids.length % GRID_COLORS.length];

const makeGrid = (grids: VisualGrid[]): VisualGrid => ({
  color: nextColor(grids),
  alpha: 1,
  subdivisions: {
    inputText: NEW_GRID_TEXT,
    val: parser2.parse(NEW_GRID_TEXT),
    type: "parser2",
  },
});

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

const GridRow = ({
  grid,
  index,
  params,
  dragging,
  onChange,
  onRemove,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  grid: VisualGrid;
  index: number;
  params: Params;
  dragging: boolean;
  onChange: (grid: VisualGrid) => void;
  onRemove: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (e: React.PointerEvent) => void;
  onDragEnd: () => void;
}) => {
  const [props, setFocusedVal] = useFocusedValue(grid.subdivisions.inputText, {
    toString: (x) => x as string,
  });
  const alpha = gridAlpha(grid);
  const parse = (text: string) =>
    parserFor(grid.subdivisions).parse(resolveRhythmText(text, params));
  const invalid = !accepts(() => parse(props.value));
  // Absent rather than 0 on a grid saved before this existed, so the field
  // shows what `gridShift` answers for it rather than inventing a value.
  const [shiftProps, setShiftVal] = useFocusedValue(
    grid.shift?.inputText ?? String(gridShift(grid)),
    { toString: (x) => x as string }
  );
  const shiftInvalid = !accepts(() => evaluate(shiftProps.value, params));
  const help = useHelp();

  return (
    <div style={{ ...rowStyle, opacity: dragging ? 0.4 : 1 }}>
      <span
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        title="Drag to reorder -- the top of the list draws on top"
        {...help("grids.drag")}
        style={{
          cursor: "grab",
          color: ui.text.muted,
          // Keep the gesture from turning into text selection or a pan.
          userSelect: "none",
          touchAction: "none",
        }}
      >
        ⠿
      </span>
      <input
        type="color"
        value={grid.color}
        onChange={(e) => onChange({ ...grid, color: e.target.value })}
        {...help("grids.color")}
        style={{
          width: "2em",
          height: "1.6em",
          padding: 0,
          border: "none",
          background: "none",
        }}
      />
      <input
        {...props}
        onChange={(e) => {
          const v = e.target.value;
          setFocusedVal(v);
          try {
            onChange({
              ...grid,
              subdivisions: {
                ...grid.subdivisions,
                val: parse(v),
                inputText: v,
              },
            });
          } catch (e) {}
        }}
        {...help("grids.rhythm")}
        style={{ flex: 1, minWidth: 0, ...invalidBorder(invalid) }}
      />
      <input
        {...shiftProps}
        onChange={(e) => {
          const v = e.target.value;
          setShiftVal(v);
          try {
            onChange({ ...grid, shift: { inputText: v, val: evaluate(v, params) } });
          } catch (e) {}
        }}
        {...help("grids.shift")}
        style={{ width: "4em", ...invalidBorder(shiftInvalid) }}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={alpha}
        onChange={(e) =>
          onChange({ ...grid, alpha: parseFloat(e.target.value) })
        }
        title={`Opacity ${Math.round(alpha * 100)}%`}
        {...help("grids.opacity")}
        style={{ width: "5em" }}
      />
      <button onClick={onRemove} title={`Remove grid ${index + 1}`}>
        ✕
      </button>
    </div>
  );
};

export const GridList = ({
  grids,
  setGrids,
  params,
}: {
  grids: VisualGrid[];
  setGrids: (grids: VisualGrid[]) => void;
  params: Params;
}) => {
  const rowsRef = useRef<HTMLDivElement>(null);
  // `to` is where the dragged grid lands in the reordered list.
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const help = useHelp();

  // Rows hold still during a drag, so the landing spot is just a count of how
  // many of the *other* rows sit above the pointer.
  const insertionIndex = (clientY: number, from: number) => {
    const rows = Array.from(rowsRef.current?.children ?? []);
    let to = 0;
    rows.forEach((row, i) => {
      if (i === from) return;
      const r = row.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) to++;
    });
    return to;
  };

  const startDrag = (i: number) => (e: React.PointerEvent) => {
    // Routes the rest of the gesture to the handle even as the pointer leaves
    // it, which is what makes a plain span usable as a drag handle.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: i, to: i });
  };

  const moveDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    const to = insertionIndex(e.clientY, drag.from);
    if (to !== drag.to) setDrag({ from: drag.from, to });
  };

  const endDrag = () => {
    if (!drag) return;
    if (drag.to !== drag.from) {
      const next = [...grids];
      const [moved] = next.splice(drag.from, 1);
      next.splice(drag.to, 0, moved);
      setGrids(next);
    }
    setDrag(null);
  };

  // The rows haven't moved yet, so translate the landing index back into a gap
  // between the rows as they're currently drawn.
  const dropGap = !drag
    ? -1
    : drag.to <= drag.from
    ? drag.to
    : drag.to + 1;

  const gapStyle = (gap: number): React.CSSProperties => ({
    borderTop: `2px solid ${dropGap === gap ? DROP_LINE : "transparent"}`,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div ref={rowsRef} style={{ display: "flex", flexDirection: "column" }}>
        {grids.map((grid, i) => (
          <div key={i} style={gapStyle(i)}>
            <GridRow
              grid={grid}
              index={i}
              params={params}
              dragging={drag?.from === i}
              onChange={(next) =>
                setGrids(grids.map((g, j) => (j === i ? next : g)))
              }
              onRemove={() => setGrids(grids.filter((_, j) => j !== i))}
              onDragStart={startDrag(i)}
              onDragMove={moveDrag}
              onDragEnd={endDrag}
            />
          </div>
        ))}
      </div>
      {/* The landing spot below the last row. Kept outside rowsRef so it doesn't
          throw off the row indexing above. */}
      <div style={gapStyle(grids.length)} />
      <div style={rowStyle}>
        <button
          onClick={() => setGrids([...grids, makeGrid(grids)])}
          {...help("grids.add")}
        >
          Add grid
        </button>
        {!grids.length && (
          <span style={{ color: ui.text.muted, fontSize: "0.8em" }}>
            No grids -- the waveform draws with no overlay.
          </span>
        )}
      </div>
    </div>
  );
};
