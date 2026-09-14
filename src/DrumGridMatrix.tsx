import { useEffect, useRef, useState } from "react";
import {
  DrumGrid,
  DrumGridRow,
  DrumVoice,
  GridCell,
  cellOn,
  compileGrid,
  drumLabel,
  getKit,
  gridPulseText,
  gridRestart,
} from "./config";
import { MAX_LIST_LENGTH, Params, parseNumberList } from "./expression";
import { useHelp } from "./help";
import { accepts, invalidBorder, useFocusedValue } from "./Input";
import { Slider } from "./Slider";

// Not a possible sample id or voice index, so they can share one menu.
const FROM_FILE = "\0file";
const KIT = "kit:";
const VOICE = "voice:";

// The label column, in pixels rather than ems: the beat markers are positioned
// against it from a container that has to agree with it exactly.
const LABEL_W = 116;
const CELL_H = 22;

// Numbers in the cells stop being readable long before the columns stop being
// clickable, so they are drawn only while there is room for two characters.
const NUMBERS_UP_TO = 16;

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

/**
 * A new row arrives silent.
 *
 * The first pass made it sound on every column, because with no matrix a silent
 * row would have had nothing to say it had been added. The matrix is that
 * something, and it inverts the argument: you add a part in order to program
 * it, and a row that arrives on every column has to be cleared cell by cell
 * before it is a pattern rather than a machine gun.
 */
export const makeGridRow = (voice: number, columns: number): DrumGridRow => ({
  voice,
  cells: Array.from({ length: columns }, () => ({ chance: 0 })),
});

// A column added later arrives silent for the same reason: lengthening a
// pattern must not add hits nobody asked for.
export const resizeCells = (cells: GridCell[], columns: number): GridCell[] =>
  Array.from({ length: columns }, (_, i) => cells[i] ?? { chance: 0 });

// What each lens paints with, and what it reads back off a cell. Gains and
// chances only ever touch a cell that already sounds -- a cell with no hit in
// it has nothing to accent, and placing hits is what the hits lens is for.
type Lens = "hits" | "gains" | "chances";

const LENS_HELP: Record<Lens, string> = {
  hits: "drumGrids.lensHits",
  gains: "drumGrids.lensGains",
  chances: "drumGrids.lensChances",
};

// One hue per lens, so which one is showing is legible from the matrix itself
// rather than only from the switch.
const LENS_RGB: Record<Lens, string> = {
  hits: "120,200,140",
  gains: "230,180,110",
  chances: "110,170,230",
};

const OFF = "#2b2b2b";

const short = (n: number) =>
  String(Number(n.toPrecision(2))).replace(/^0\./, ".").replace(/^-0\./, "-.");

// Where a whole beat falls, as a percentage across an evenly drawn matrix.
// Only ever asked under restart: the spans are then one pass long and every
// pass is identical, so the answer is exact. Under carry-over the same beat
// lands in a different column on each pass and there is nothing honest to draw.
export const beatMarkers = (spans: number[]) => {
  const out: { beat: number; x: number }[] = [];
  let start = 0;
  spans.forEach((span, i) => {
    for (let b = Math.ceil(start - 1e-9); b < start + span - 1e-9; b++) {
      if (b > 0) out.push({ beat: b, x: ((i + (b - start) / span) / spans.length) * 100 });
    }
    start += span;
  });
  return out;
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const panelStyle: React.CSSProperties = {
  backgroundColor: "#444",
  border: "1px solid #777",
  borderRadius: "8px",
  padding: "8px",
  minWidth: "30em",
  maxWidth: "min(60em, 92vw)",
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

/**
 * The matrix: sounds down the y axis, columns across, and the grid's own
 * settings above them.
 *
 * **Columns are drawn evenly whatever the pulse.** The panes are where you look
 * at where a note actually landed; this is where you say what the notes are, and
 * a swung pulse drawn to scale would make the short columns the hard ones to
 * hit. The pulse is written above each column so the unevenness stays legible,
 * and under restart the beats are marked where they really fall -- which with an
 * uneven pulse is between columns, at irregular places.
 */
export const DrumGridMatrix = ({
  grid,
  index,
  drums,
  params,
  taken,
  onChange,
  onClose,
  addVoice,
}: {
  grid: DrumGrid;
  index: number;
  drums: DrumVoice[];
  params: Params;
  /** Voices some grid already owns, which cannot be added to another. */
  taken: Set<number>;
  onChange: (next: DrumGrid) => void;
  onClose: () => void;
  addVoice: (builtIn?: string) => Promise<number | null>;
}) => {
  const help = useHelp();
  const [lens, setLens] = useState<Lens>("hits");
  // Half, rather than 1: painting a gain of 1 would write a gains list that
  // says nothing, and the point of opening this lens is to make a cell differ.
  const [paintValue, setPaintValue] = useState(0.5);
  const [columnsProps, setColumnsText] = useFocusedValue(grid.columns);
  const [pulseProps, setPulseText] = useFocusedValue(gridPulseText(grid), {
    toString: (x) => x as string,
  });
  const pulseInvalid = !accepts(() => parseNumberList(pulseProps.value, params));

  // The value the drag is painting, held in a ref because the cells read it
  // from an event handler rather than drawing it.
  const painting = useRef<number | null>(null);
  // A drag that ends over the backdrop would otherwise dispatch its click on
  // the backdrop -- their common ancestor -- and close the editor.
  const dragging = useRef(false);

  useEffect(() => {
    const stop = () => {
      painting.current = null;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

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

  const paintCell = (r: number, c: number, value: number) => {
    const row = grid.rows[r];
    if (!row) return;
    const cell = row.cells[c] ?? { chance: 0 };
    let next: GridCell;
    if (lens === "hits") next = { ...cell, chance: value };
    else if (!cellOn(cell)) return;
    else if (lens === "gains") next = { ...cell, gain: value };
    else next = { ...cell, chance: value };
    if (next.chance === cell.chance && next.gain === cell.gain) return;
    onChange({
      ...grid,
      rows: grid.rows.map((rr, i) =>
        i !== r
          ? rr
          : {
              ...rr,
              // Rebuilt to the column count rather than mapped, so a
              // hand-edited config with a short list heals rather than
              // silently dropping the edit.
              cells: Array.from({ length: grid.columns }, (_, j) =>
                j === c ? next : rr.cells[j] ?? { chance: 0 }
              ),
            }
      ),
    });
  };

  const hasGains = grid.rows.some((r) =>
    r.cells.some((c) => typeof c?.gain === "number")
  );

  let compiled = null;
  let error = "";
  try {
    compiled = compileGrid(grid);
  } catch (e) {
    error = (e as Error).message;
  }
  const restart = gridRestart(grid);
  // One pass's worth: the matrix draws what you edit, and the rest of the
  // period is the compiler tiling it.
  const spans = compiled ? compiled.spans.slice(0, compiled.columns) : [];
  const markers = compiled && restart ? beatMarkers(spans) : [];
  const readout = !compiled
    ? ""
    : `${compiled.columns} column${compiled.columns === 1 ? "" : "s"}` +
      (compiled.passes > 1
        ? ` x ${compiled.passes} passes = ${compiled.emitted}`
        : "") +
      ` -- ${Number(compiled.beats.toPrecision(6))} beats`;

  const numbers = grid.columns <= NUMBERS_UP_TO;

  const cellStyle = (cell: GridCell | undefined, on: boolean): React.CSSProperties => {
    const rgb = LENS_RGB[lens];
    let alpha = 0;
    if (on) {
      if (lens === "hits") alpha = 1;
      else if (lens === "gains") alpha = 0.2 + 0.8 * Math.min(1, (cell?.gain ?? 1) / 2);
      else alpha = 0.2 + 0.8 * Math.min(1, cell?.chance ?? 0);
    }
    return {
      flex: "1 1 0",
      minWidth: 0,
      height: CELL_H,
      boxSizing: "border-box",
      borderRight: "1px solid #555",
      borderBottom: "1px solid #555",
      backgroundColor: on ? `rgba(${rgb},${alpha})` : OFF,
      color: "#111",
      fontSize: "0.65em",
      lineHeight: `${CELL_H}px`,
      textAlign: "center",
      overflow: "hidden",
      cursor: lens === "hits" || on ? "pointer" : "default",
      // Or a trackpad drag scrolls the dialog instead of painting.
      touchAction: "none",
      userSelect: "none",
    };
  };

  const cellTitle = (cell: GridCell | undefined, c: number) => {
    const chance = cell?.chance ?? 0;
    const where = `Column ${c + 1}`;
    if (!chance) return `${where}: silent`;
    if (lens === "gains") return `${where}: gain ${cell?.gain ?? 1}`;
    return `${where}: chance ${chance}`;
  };

  return (
    <div
      style={overlayStyle}
      onClick={() => {
        if (dragging.current) {
          dragging.current = false;
          return;
        }
        onClose();
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dragging.current = false;
      }}
    >
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={rowStyle}>
          <h4 style={{ color: "#ccc", margin: 0, flex: 1 }}>Grid {index + 1}</h4>
          <button onClick={onClose}>done</button>
        </div>

        <div style={rowStyle}>
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
              checked={restart}
              onChange={() => onChange({ ...grid, restart: !restart })}
            />
            <span style={{ fontSize: "0.85em" }}>Restart</span>
          </label>
        </div>

        <div style={rowStyle}>
          {(["hits", "gains", "chances"] as Lens[]).map((l) => (
            <button
              key={l}
              onClick={() => {
                setLens(l);
                // A gain may be 2 and a chance may not, so the shared paint
                // value comes down rather than showing a slider past its end.
                if (l === "chances") setPaintValue((v) => Math.min(v, 1));
              }}
              style={{ fontWeight: lens === l ? "bold" : undefined }}
              {...help(LENS_HELP[l])}
            >
              {l}
            </button>
          ))}
          <span style={{ color: "#aaa", fontSize: "0.8em", flex: 1 }}>
            {lens === "hits"
              ? "Click or drag across the cells."
              : "Only cells that already sound."}
          </span>
          {lens === "gains" && hasGains && (
            <button
              onClick={() =>
                onChange({
                  ...grid,
                  rows: grid.rows.map((r) => ({
                    ...r,
                    cells: r.cells.map(({ chance }) => ({ chance })),
                  })),
                })
              }
              {...help("drumGrids.clearGains")}
            >
              clear gains
            </button>
          )}
        </div>
        {lens !== "hits" && (
          <Slider
            label={lens === "gains" ? "Paint gain" : "Paint chance"}
            value={paintValue}
            min={0}
            max={lens === "gains" ? 2 : 1}
            step={0.05}
            onChange={setPaintValue}
            help="drumGrids.paint"
          />
        )}

        <div style={{ overflow: "auto" }}>
          <div style={{ position: "relative", minWidth: "20em" }}>
            {/* Where the whole beats fall, or why there is nothing to mark. */}
            <div style={{ display: "flex" }} {...help("drumGrids.beats")}>
              <div
                style={{
                  width: LABEL_W,
                  flex: `0 0 ${LABEL_W}px`,
                  color: "#aaa",
                  fontSize: "0.75em",
                }}
              >
                {restart ? "beats" : "pulse carries over"}
              </div>
              <div style={{ flex: 1, minWidth: 0, position: "relative", height: "1.2em" }}>
                {markers.map((m) => (
                  <span
                    key={m.beat}
                    style={{
                      position: "absolute",
                      left: `${m.x}%`,
                      transform: "translateX(-50%)",
                      color: "#ddd",
                      fontSize: "0.75em",
                    }}
                  >
                    {m.beat}
                  </span>
                ))}
                {!restart && (
                  <span style={{ color: "#aaa", fontSize: "0.75em" }}>
                    a beat lands in a different column on every pass -- the
                    period is below
                  </span>
                )}
              </div>
            </div>

            {/* The pulse, column by column, since the columns are drawn evenly
                and the numbers are the only place the unevenness shows. */}
            <div style={{ display: "flex" }} {...help("drumGrids.spans")}>
              <div
                style={{
                  width: LABEL_W,
                  flex: `0 0 ${LABEL_W}px`,
                  color: "#aaa",
                  fontSize: "0.75em",
                }}
              >
                pulse
              </div>
              <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
                {spans.map((span, c) => (
                  <div
                    key={c}
                    style={{
                      flex: "1 1 0",
                      minWidth: 0,
                      textAlign: "center",
                      color: "#aaa",
                      fontSize: "0.7em",
                      overflow: "hidden",
                    }}
                    title={`Column ${c + 1}: ${span} beats`}
                  >
                    {numbers ? short(span) : ""}
                  </div>
                ))}
              </div>
            </div>

            {!grid.rows.length && (
              <div style={{ color: "#aaa", fontSize: "0.8em", padding: "4px 0" }}>
                No parts yet -- add one below, then click the cells it should
                sound on.
              </div>
            )}

            {grid.rows.map((row, r) => {
              const voice = drums[row.voice];
              return (
                <div key={r} style={{ display: "flex" }} {...help("drumGrids.row")}>
                  <div
                    style={{
                      width: LABEL_W,
                      flex: `0 0 ${LABEL_W}px`,
                      display: "flex",
                      alignItems: "center",
                      gap: "2px",
                      height: CELL_H,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: "0.85em",
                        color: voice ? undefined : "#f88",
                      }}
                      title={voice ? drumLabel(voice.path) : undefined}
                    >
                      {voice ? drumLabel(voice.path) : `voice ${row.voice + 1} is gone`}
                    </span>
                    <button
                      onClick={() =>
                        onChange({
                          ...grid,
                          rows: grid.rows.filter((_, j) => j !== r),
                        })
                      }
                      title="Take this part out of the grid"
                      style={{ padding: "0 3px", fontSize: "0.75em" }}
                    >
                      ✕
                    </button>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
                    {Array.from({ length: grid.columns }, (_, c) => {
                      const cell = row.cells[c];
                      const on = cellOn(cell);
                      return (
                        <div
                          key={c}
                          role="button"
                          aria-label={`part ${r + 1} column ${c + 1}`}
                          title={cellTitle(cell, c)}
                          style={cellStyle(cell, on)}
                          onPointerDown={() => {
                            dragging.current = true;
                            const value =
                              lens === "hits" ? (on ? 0 : 1) : paintValue;
                            painting.current = value;
                            paintCell(r, c, value);
                          }}
                          onPointerEnter={() => {
                            if (painting.current !== null)
                              paintCell(r, c, painting.current);
                          }}
                        >
                          {numbers && on && lens !== "hits"
                            ? short(lens === "gains" ? cell?.gain ?? 1 : cell?.chance ?? 0)
                            : ""}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Drawn over the rows rather than between them: a beat lands
                inside a column as often as on its edge. */}
            <div
              style={{
                position: "absolute",
                left: LABEL_W,
                right: 0,
                top: "1.2em",
                bottom: 0,
                pointerEvents: "none",
              }}
            >
              {markers.map((m) => (
                <div
                  key={m.beat}
                  style={{
                    position: "absolute",
                    left: `${m.x}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    marginLeft: -1,
                    backgroundColor: "rgba(255,255,255,0.45)",
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div style={rowStyle}>
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
            style={{ color: error ? "#f88" : "#aaa", fontSize: "0.8em", flex: 1 }}
            {...help("drumGrids.cycle")}
          >
            {error || readout}
          </span>
        </div>
      </div>
    </div>
  );
};
