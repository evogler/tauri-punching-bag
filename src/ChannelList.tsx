import { ChannelStyle, channelPan, channelStyle } from "./config";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

// Styles are sparse, so setting one has to pad the gaps before it rather than
// leave holes an index lookup would trip over.
const withStyleAt = (
  styles: ChannelStyle[],
  index: number,
  next: ChannelStyle
) => {
  const out = styles.slice();
  while (out.length <= index) out.push(channelStyle(styles, out.length));
  out[index] = next;
  return out;
};

const panLabel = (pan: number) =>
  pan === 0 ? "centre" : `${Math.round(Math.abs(pan) * 100)}% ${pan < 0 ? "left" : "right"}`;

// Same padding rule as the styles: setting a later channel must not leave holes
// an index lookup would read as undefined.
const withPanAt = (pans: number[], index: number, next: number) => {
  const out = pans.slice();
  while (out.length <= index) out.push(0);
  out[index] = next;
  return out;
};

const ChannelRow = ({
  label,
  style,
  pan,
  onStyle,
  onPan,
}: {
  label: string;
  style: ChannelStyle;
  // Absent for anything that isn't a real input -- the drum bus isn't routed.
  pan?: number;
  onStyle: (next: ChannelStyle) => void;
  onPan: (next: number) => void;
}) => (
  <div style={rowStyle}>
    <label style={{ width: "3.5em" }}>{label}</label>
    <input
      type="color"
      value={style.color}
      onChange={(e) => onStyle({ ...style, color: e.target.value })}
      title={`Colour for ${label}`}
      style={{
        width: "2em",
        height: "1.6em",
        padding: 0,
        border: "none",
        background: "none",
      }}
    />
    <input
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={style.alpha}
      onChange={(e) => onStyle({ ...style, alpha: parseFloat(e.target.value) })}
      title={`${label} opacity ${Math.round(style.alpha * 100)}%`}
      style={{ flex: 1, minWidth: 0 }}
    />
    {pan === undefined ? (
      <span style={{ width: "5em" }} />
    ) : (
      <input
        type="range"
        min={-1}
        max={1}
        step={0.05}
        value={pan}
        onChange={(e) => onPan(parseFloat(e.target.value))}
        onDoubleClick={() => onPan(0)}
        title={`${label} pan: ${panLabel(pan)} (double-click to centre)`}
        style={{ width: "5em" }}
      />
    )}
  </div>
);

// A channel's identity rather than its visibility: the colour it draws in
// everywhere and, for a real input, where it sits in the stereo field. Which
// pane shows it is chosen per pane -- see ChannelPicker.
export const ChannelList = ({
  labels,
  inputCount,
  styles,
  pans,
  setStyles,
  setPans,
}: {
  // How many of `labels` are real inputs. Only those can be panned.
  inputCount: number;
  pans: number[];
  setPans: (next: number[]) => void;
  // One per selectable channel, in device order. Anything past the device's
  // input channels is a synthetic bus -- the drums, then the click.
  labels: string[];
  styles: ChannelStyle[];
  setStyles: (next: ChannelStyle[]) => void;
}) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {labels.map((label, index) => (
        <ChannelRow
          key={index}
          label={label}
          style={channelStyle(styles, index)}
          pan={index < inputCount ? channelPan(pans, index) : undefined}
          onStyle={(next) => setStyles(withStyleAt(styles, index, next))}
          onPan={(next) => setPans(withPanAt(pans, index, next))}
        />
      ))}

    </div>
  );
};
