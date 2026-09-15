import { Help } from "./help";
import { ViewConfig } from "./config";
import { PaneOps } from "./panel/types";
import { paneLabel } from "./paneLayout";

// The arrangement as a picture: one cell per cell of the real grid, each pane
// drawn over the cells it actually occupies. A row of numbered buttons said
// which panes existed and nothing about where they were, which stops being
// enough the moment a pane can be two cells wide or a cell can be empty.
//
// Buttons only, deliberately. Dragging a pane's edge is the obvious next step
// and is not built: every operation here is one click with a definite answer,
// which is also what makes the refusals visible -- a grow that would collide is
// a disabled button rather than a drag that snaps back.

const buttonStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
  fontSize: "11px",
  padding: 0,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  margin: "4px 0",
};

export const PaneMap = ({
  views,
  cols,
  rows,
  activeView,
  setSelectedView,
  ops,
}: {
  views: ViewConfig[];
  cols: number;
  rows: number;
  activeView: number;
  setSelectedView: (index: number) => void;
  ops: PaneOps;
}) => {
  // Which pane, if any, covers each cell -- so an uncovered cell can offer to
  // become one. Derived from the panes rather than stored, since the panes are
  // the only record of the layout and a second one could disagree with them.
  const owner: (number | null)[] = new Array(cols * rows).fill(null);
  views.forEach((v, i) => {
    for (let r = v.row; r < v.row + v.rowSpan; r++)
      for (let c = v.col; c < v.col + v.colSpan; c++)
        if (r < rows && c < cols) owner[r * cols + c] = i;
  });

  const holes: { col: number; row: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (owner[r * cols + c] === null) holes.push({ col: c, row: r });

  const grow = (axis: "col" | "row", delta: 1 | -1, label: string, title: string) => (
    <button
      style={{ flex: 1 }}
      title={title}
      disabled={!ops.canGrow(activeView, axis, delta)}
      onClick={() => ops.grow(activeView, axis, delta)}
    >
      {label}
    </button>
  );

  return (
    <>
      <Help
        id="paneMap"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 26px)`,
          gap: "2px",
          margin: "4px 0",
        }}
      >
        {views.map((v, i) => (
          <button
            key={`pane-${i}`}
            onClick={() => setSelectedView(i)}
            style={{
              ...buttonStyle,
              gridColumn: `${v.col + 1} / span ${v.colSpan}`,
              gridRow: `${v.row + 1} / span ${v.rowSpan}`,
              fontWeight: i === activeView ? "bold" : "normal",
              backgroundColor: i === activeView ? "#666" : undefined,
            }}
          >
            {paneLabel(views, i)}
          </button>
        ))}
        {holes.map((h) => (
          <button
            key={`hole-${h.col},${h.row}`}
            title="Add a pane here"
            onClick={() => ops.add({ ...h, colSpan: 1, rowSpan: 1 })}
            style={{
              ...buttonStyle,
              gridColumn: `${h.col + 1}`,
              gridRow: `${h.row + 1}`,
              color: "#999",
              backgroundColor: "#3a3a3a",
              border: "1px dashed #777",
            }}
          >
            +
          </button>
        ))}
      </Help>
      <Help id="paneSize" style={rowStyle}>
        {grow("col", 1, "Wider", "Take the cell to the right")}
        {grow("col", -1, "Narrower", "Give back the rightmost cell")}
        {grow("row", 1, "Taller", "Take the cell below")}
        {grow("row", -1, "Shorter", "Give back the bottom cell")}
      </Help>
      <div style={rowStyle}>
        <button
          style={{ flex: 1 }}
          disabled={!ops.canAdd}
          onClick={() => ops.add()}
          title={
            ops.canAdd
              ? "Add a pane in the first empty cell"
              : "No empty cell -- make the arrangement bigger first"
          }
        >
          Add pane
        </button>
        <button
          style={{ flex: 1 }}
          disabled={views.length < 2}
          onClick={() => ops.remove(activeView)}
          title="Remove this pane, leaving its cells empty"
        >
          Remove pane
        </button>
      </div>
      {views.length > 1 && (
        <Help id="paneSwap" style={{ ...rowStyle, alignItems: "center" }}>
          <label>Swap with</label>
          {/* Resets to its prompt after each pick, so it reads as an action
              rather than as a setting -- the same idiom as adding a drum. */}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value !== "") ops.swap(activeView, Number(e.target.value));
            }}
          >
            <option value="">Choose…</option>
            {views.map((_, i) =>
              i === activeView ? null : (
                <option key={i} value={i}>
                  {paneLabel(views, i)}
                </option>
              )
            )}
          </select>
        </Help>
      )}
    </>
  );
};
