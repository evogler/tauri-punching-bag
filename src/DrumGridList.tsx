import { useState } from "react";
import {
  DrumGrid,
  DrumVoice,
  compileGrid,
  drumLabel,
  gridOwners,
  gridPulseText,
  gridRestart,
} from "./config";
import { DrumGridMatrix } from "./DrumGridMatrix";
import { Params } from "./expression";
import { useHelp } from "./help";
import { ui } from "./theme";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

// Eighth notes over a bar: a grid you can hear the moment a sound is added to
// it, which is what the pulse and the column count are easiest to read against.
export const makeDrumGrid = (): DrumGrid => ({
  columns: 8,
  pulse: { inputText: "0.5", val: [0.5] },
  restart: true,
  rows: [],
});

// The row in the panel is a summary and two buttons: a grid owns several parts
// and a matrix of cells, which is more than a settings row has room for, so the
// editing lives in the pop-up and this says only what is in there.
const GridRow = ({
  grid,
  index,
  drums,
  onEdit,
  onRemove,
}: {
  grid: DrumGrid;
  index: number;
  drums: DrumVoice[];
  onEdit: () => void;
  onRemove: () => void;
}) => {
  const help = useHelp();
  let readout = "";
  let error = "";
  try {
    const c = compileGrid(grid);
    readout =
      `${c.columns} column${c.columns === 1 ? "" : "s"}` +
      (c.passes > 1 ? ` x ${c.passes} passes = ${c.emitted}` : "") +
      ` -- ${Number(c.beats.toPrecision(6))} beats`;
  } catch (e) {
    error = (e as Error).message;
  }
  const parts = grid.rows
    .map((r) => (drums[r.voice] ? drumLabel(drums[r.voice].path) : "?"))
    .join(", ");
  return (
    <div
      style={{
        border: `1px solid ${ui.line.field}`,
        borderRadius: "6px",
        padding: "3px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      }}
    >
      <div style={rowStyle}>
        <span style={{ width: "2em", color: ui.text.muted, fontSize: "0.8em" }}>
          {index + 1}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {parts || "no parts yet"}
        </span>
        <span style={{ color: ui.text.muted, fontSize: "0.8em" }}>
          {gridPulseText(grid)} x {grid.columns}
          {gridRestart(grid) ? "" : " (carried over)"}
        </span>
        <button onClick={onEdit} {...help("drumGrids.edit")}>
          Edit…
        </button>
        <button onClick={onRemove} title="Delete this grid">
          ✕
        </button>
      </div>
      <div
        style={{ ...rowStyle, paddingLeft: "2em" }}
        {...help("drumGrids.cycle")}
      >
        <span style={{ color: error ? ui.error : ui.text.muted, fontSize: "0.8em" }}>
          {error || readout}
        </span>
      </div>
    </div>
  );
};

/**
 * The list of drum grids. A grid is an editing surface for the parts it names:
 * every column becomes a note and an unchecked column is a chance of 0, so what
 * it produces is an ordinary rhythm and an ordinary chances list.
 *
 * The cells are in `DrumGridMatrix`, which this opens over the panel.
 */
export const DrumGridList = ({
  grids,
  setGrids,
  drums,
  params,
  addVoice,
}: {
  grids: DrumGrid[];
  setGrids: (next: DrumGrid[]) => void;
  drums: DrumVoice[];
  params: Params;
  addVoice: (builtIn?: string) => Promise<number | null>;
}) => {
  const help = useHelp();
  // Which grid the matrix is showing. An index rather than the grid itself, so
  // what is on screen follows the config -- a preset load or a parameter change
  // re-renders the matrix from the new grid rather than from a stale copy.
  const [editing, setEditing] = useState<number | null>(null);
  const taken = new Set(Array.from(gridOwners(grids).keys()));
  const open = editing !== null ? grids[editing] : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
      {grids.map((grid, i) => (
        <GridRow
          key={i}
          grid={grid}
          index={i}
          drums={drums}
          onEdit={() => setEditing(i)}
          onRemove={() => {
            setEditing(null);
            setGrids(grids.filter((_, j) => j !== i));
          }}
        />
      ))}
      <div style={rowStyle}>
        <button
          onClick={() => {
            setGrids([...grids, makeDrumGrid()]);
            // Straight into the matrix: a grid with no parts and no cells has
            // nothing to say for itself in the list.
            setEditing(grids.length);
          }}
          {...help("drumGrids.add")}
        >
          New grid
        </button>
        {!grids.length && (
          <span style={{ color: ui.text.muted, fontSize: "0.8em" }}>
            None -- every part above is written as a rhythm.
          </span>
        )}
      </div>
      {open && editing !== null && (
        <DrumGridMatrix
          grid={open}
          index={editing}
          drums={drums}
          params={params}
          taken={taken}
          addVoice={addVoice}
          onChange={(next) =>
            setGrids(grids.map((g, j) => (j === editing ? next : g)))
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
};
