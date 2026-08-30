import { ROW_COLORS } from "./config";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
  flexWrap: "wrap",
};

// Picks the first palette color not already in the list, so consecutive
// swatches start out easy to tell apart.
const nextColor = (colors: string[]) =>
  ROW_COLORS.find((c) => !colors.includes(c)) ??
  ROW_COLORS[colors.length % ROW_COLORS.length];

// The colors a row's waveform can take. Order is what `rowColorPattern` indexes,
// so each swatch is labelled with its 1-based number.
export const RowColorList = ({
  colors,
  setColors,
}: {
  colors: string[];
  setColors: (colors: string[]) => void;
}) => (
  <div style={rowStyle}>
    <label>row colors</label>
    {colors.map((color, i) => (
      <span key={i} style={{ ...rowStyle, gap: "1px" }}>
        <span style={{ color: "#aaa", fontSize: "0.8em" }}>{i + 1}</span>
        <input
          type="color"
          value={color}
          onChange={(e) =>
            setColors(colors.map((c, j) => (j === i ? e.target.value : c)))
          }
          title={`Row color ${i + 1}`}
          style={{
            width: "2em",
            height: "1.6em",
            padding: 0,
            border: "none",
            background: "none",
          }}
        />
        <button
          onClick={() => setColors(colors.filter((_, j) => j !== i))}
          title={`Remove row color ${i + 1}`}
          style={{ padding: "0 3px" }}
        >
          ✕
        </button>
      </span>
    ))}
    <button
      onClick={() => setColors([...colors, nextColor(colors)])}
      title="Add a row color"
    >
      + COLOR
    </button>
    {!colors.length && (
      <span style={{ color: "#aaa", fontSize: "0.8em" }}>
        None -- rows use the channel's own color.
      </span>
    )}
  </div>
);
