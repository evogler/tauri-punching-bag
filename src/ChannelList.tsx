import { ChannelStyle, channelStyle } from "./config";

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

const ChannelRow = ({
  index,
  shown,
  style,
  onToggle,
  onStyle,
}: {
  index: number;
  shown: boolean;
  style: ChannelStyle;
  onToggle: () => void;
  onStyle: (next: ChannelStyle) => void;
}) => (
  <div style={{ ...rowStyle, opacity: shown ? 1 : 0.45 }}>
    <input
      type="checkbox"
      checked={shown}
      onChange={onToggle}
      title={shown ? `Hide input ${index + 1}` : `Show input ${index + 1}`}
    />
    <label style={{ width: "3.5em" }}>ch {index + 1}</label>
    <input
      type="color"
      value={style.color}
      onChange={(e) => onStyle({ ...style, color: e.target.value })}
      title={`Colour for input ${index + 1}`}
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
      title={`Opacity ${Math.round(style.alpha * 100)}%`}
      style={{ flex: 1, minWidth: 0 }}
    />
  </div>
);

export const ChannelList = ({
  count,
  visible,
  styles,
  setVisible,
  setStyles,
}: {
  count: number;
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
      {Array.from({ length: count }, (_, index) => (
        <ChannelRow
          key={index}
          index={index}
          shown={visible.includes(index)}
          style={channelStyle(styles, index)}
          onToggle={() => toggle(index)}
          onStyle={(next) => setStyles(withStyleAt(styles, index, next))}
        />
      ))}
      {count <= 1 && (
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          The input device only offers one channel.
        </div>
      )}
    </div>
  );
};
