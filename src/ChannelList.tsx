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
  index,
  label,
  shown,
  style,
  pan,
  onToggle,
  onStyle,
  onPan,
}: {
  index: number;
  label: string;
  shown: boolean;
  style: ChannelStyle;
  // Absent for anything that isn't a real input -- the drum bus isn't routed.
  pan?: number;
  onToggle: () => void;
  onStyle: (next: ChannelStyle) => void;
  onPan: (next: number) => void;
}) => (
  <div style={{ ...rowStyle, opacity: shown ? 1 : 0.45 }}>
    <input
      type="checkbox"
      checked={shown}
      onChange={onToggle}
      title={shown ? `Hide ${label}` : `Show ${label}`}
    />
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

export const ChannelList = ({
  labels,
  inputCount,
  visible,
  styles,
  pans,
  setVisible,
  setStyles,
  setPans,
}: {
  // How many of `labels` are real inputs. Only those can be panned.
  inputCount: number;
  pans: number[];
  setPans: (next: number[]) => void;
  // One per selectable channel, in stream order. Anything past the device's
  // input channels is a synthetic bus -- the drums.
  labels: string[];
  visible: number[];
  styles: ChannelStyle[];
  setVisible: (next: number[]) => void;
  setStyles: (next: ChannelStyle[]) => void;
}) => {
  const toggle = (index: number) =>
    setVisible(
      visible.includes(index)
        ? visible.filter((i) => i !== index)
        : // Kept in device order, since that's the order they're drawn in and
          // the order the up/down split assigns from.
          [...visible, index].sort((a, b) => a - b)
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {labels.map((label, index) => (
        <ChannelRow
          key={index}
          index={index}
          label={label}
          shown={visible.includes(index)}
          style={channelStyle(styles, index)}
          pan={index < inputCount ? channelPan(pans, index) : undefined}
          onToggle={() => toggle(index)}
          onStyle={(next) => setStyles(withStyleAt(styles, index, next))}
          onPan={(next) => setPans(withPanAt(pans, index, next))}
        />
      ))}

    </div>
  );
};
