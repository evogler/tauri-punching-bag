import {
  DrumGrid,
  DrumGridRow,
  DrumVoice,
  GridCell,
  compileGrid,
  drumLabel,
  gridPulseText,
  getKit,
  gridOwners,
  gridRestart,
} from "./config";
import { MAX_LIST_LENGTH, Params, parseNumberList } from "./expression";
import { useHelp } from "./help";
import { accepts, invalidBorder, useFocusedValue } from "./Input";

// Not a possible sample id or voice index, so they can share one menu.
const FROM_FILE = "\0file";
const KIT = "kit:";
const VOICE = "voice:";

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

// A new row sounds on every column. The matrix is about turning cells *off*,
// and a row that arrives silent would have nothing to say it had been added.
const makeGridRow = (voice: number, columns: number): DrumGridRow => ({
  voice,
  cells: Array.from({ length: columns }, () => ({ chance: 1 })),
});

// A column added later arrives sounding, for the same reason a new row does.
const resizeCells = (cells: GridCell[], columns: number): GridCell[] =>
  Array.from({ length: columns }, (_, i) => cells[i] ?? { chance: 1 });

const GridRow = ({
  row,
  drums,
  onRemove,
}: {
  row: DrumGridRow;
  drums: DrumVoice[];
  onRemove: () => void;
}) => {
  const voice = drums[row.voice];
  const help = useHelp();
  return (
    <div style={{ ...rowStyle, paddingLeft: "1em" }} {...help("drumGrids.row")}>
      <span
        style={{
          width: "8em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: voice ? undefined : "#f88",
        }}
      >
        {voice ? drumLabel(voice.path) : `voice ${row.voice + 1} is gone`}
      </span>
      <span style={{ color: "#aaa", fontSize: "0.8em", flex: 1 }}>
        {row.cells.filter((c) => c.chance > 0).length} of {row.cells.length}{" "}
        sounding
      </span>
      <button onClick={onRemove} title="Take this part out of the grid">
        ✕
      </button>
    </div>
  );
};

const Grid = ({
  grid,
  index,
  drums,
  params,
  taken,
  onChange,
  onRemove,
  addVoice,
}: {
  grid: DrumGrid;
  index: number;
  drums: DrumVoice[];
  params: Params;
  /** Voices some grid already owns, which cannot be added to another. */
  taken: Set<number>;
  onChange: (next: DrumGrid) => void;
  onRemove: () => void;
  addVoice: (builtIn?: string) => Promise<number | null>;
}) => {
  const help = useHelp();
  const [columnsProps, setColumnsText] = useFocusedValue(grid.columns);
  const [pulseProps, setPulseText] = useFocusedValue(gridPulseText(grid), {
    toString: (x) => x as string,
  });
  const pulseInvalid = !accepts(() => parseNumberList(pulseProps.value, params));

  const setColumns = (columns: number) =>
    onChange({
      ...grid,
      columns,
      rows: grid.rows.map((r) => ({ ...r, cells: resizeCells(r.cells, columns) })),
    });

  const addRow = async (choice: string) => {
    if (choice.startsWith(VOICE)) {
      onChange({
        ...grid,
        rows: [
          ...grid.rows,
          makeGridRow(Number(choice.slice(VOICE.length)), grid.columns),
        ],
      });
      return;
    }
    const added = await addVoice(
      choice.startsWith(KIT) ? choice.slice(KIT.length) : undefined
    );
    if (added === null) return;
    // Adding the voice only touches the rust config, so this render's `grid` is
    // still the current one when the dialog comes back.
    onChange({ ...grid, rows: [...grid.rows, makeGridRow(added, grid.columns)] });
  };

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

  return (
    <div
      style={{
        border: "1px solid #666",
        borderRadius: "6px",
        padding: "3px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
      }}
    >
      <div style={rowStyle}>
        <span style={{ width: "2em", color: "#aaa", fontSize: "0.8em" }}>
          {index + 1}
        </span>
        <label style={{ fontSize: "0.85em" }} {...help("drumGrids.columns")}>
          Columns
        </label>
        <input
          {...columnsProps}
          onChange={(e) => {
            setColumnsText(e.target.value);
            const n = Math.round(parseFloat(e.target.value));
            if (!(n >= 1) || n > MAX_LIST_LENGTH) return;
            setColumns(n);
          }}
          {...help("drumGrids.columns")}
          style={{ width: "3.5em" }}
        />
        <label style={{ fontSize: "0.85em" }} {...help("drumGrids.pulse")}>
          Pulse
        </label>
        <input
          {...pulseProps}
          onChange={(e) => {
            const text = e.target.value;
            setPulseText(text);
            try {
              onChange({
                ...grid,
                pulse: { inputText: text, val: parseNumberList(text, params) },
              });
            } catch (e) {}
          }}
          {...help("drumGrids.pulse")}
          style={{ flex: 1, minWidth: 0, ...invalidBorder(pulseInvalid) }}
        />
        <label
          style={{ display: "flex", alignItems: "center", gap: "2px" }}
          {...help("drumGrids.restart")}
        >
          <input
            type="checkbox"
            checked={gridRestart(grid)}
            onChange={() => onChange({ ...grid, restart: !gridRestart(grid) })}
          />
          <span style={{ fontSize: "0.85em" }}>Restart</span>
        </label>
        <button onClick={onRemove} title="Delete this grid">
          ✕
        </button>
      </div>
      {grid.rows.map((row, i) => (
        <GridRow
          key={i}
          row={row}
          drums={drums}
          onRemove={() =>
            onChange({ ...grid, rows: grid.rows.filter((_, j) => j !== i) })
          }
        />
      ))}
      <div style={{ ...rowStyle, paddingLeft: "1em" }}>
        {/* Resets to its prompt after each pick, so it reads as an action
            rather than as a setting with a current value. */}
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) addRow(e.target.value);
          }}
          {...help("drumGrids.addRow")}
        >
          <option value="">Add part…</option>
          {getKit().map((sound) => (
            <option key={sound.id} value={KIT + sound.id}>
              {sound.name}
            </option>
          ))}
          <option value={FROM_FILE}>From a file…</option>
          {drums.map((voice, i) =>
            taken.has(i) ? null : (
              <option key={i} value={VOICE + i}>
                {drumLabel(voice.path)} (part {i + 1})
              </option>
            )
          )}
        </select>
        <span
          style={{ color: error ? "#f88" : "#aaa", fontSize: "0.8em" }}
          {...help("drumGrids.cycle")}
        >
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
 * The matrix itself is not here yet -- a row says how many of its columns sound
 * and nothing more.
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
  const taken = new Set(Array.from(gridOwners(grids).keys()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
      {grids.map((grid, i) => (
        <Grid
          key={i}
          grid={grid}
          index={i}
          drums={drums}
          params={params}
          taken={taken}
          addVoice={addVoice}
          onChange={(next) => setGrids(grids.map((g, j) => (j === i ? next : g)))}
          onRemove={() => setGrids(grids.filter((_, j) => j !== i))}
        />
      ))}
      <div style={rowStyle}>
        <button
          onClick={() => setGrids([...grids, makeDrumGrid()])}
          {...help("drumGrids.add")}
        >
          New grid
        </button>
        {!grids.length && (
          <span style={{ color: "#aaa", fontSize: "0.8em" }}>
            None -- every part above is written as a rhythm.
          </span>
        )}
      </div>
    </div>
  );
};
