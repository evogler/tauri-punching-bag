import { ChannelStyle, channelGain, channelPan, channelStyle } from "./config";
import { useHelp } from "./help";

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

// The same again for the display trim, padded with 1 rather than 0 -- the
// neutral value here is "unchanged", not "silent".
const withGainAt = (gains: number[], index: number, next: number) => {
  const out = gains.slice();
  while (out.length <= index) out.push(1);
  out[index] = next;
  return out;
};

// Wide enough to lift a quiet mic into the same row as a hot line, and to pull
// a loud one back. 1 is neutral, and double-clicking returns to it.
const MAX_CHANNEL_GAIN = 4;

const ChannelRow = ({
  label,
  style,
  pan,
  gain,
  onStyle,
  onPan,
  onGain,
}: {
  label: string;
  style: ChannelStyle;
  // Absent for anything that isn't a real input -- the drum bus isn't routed.
  pan?: number;
  // Present for every channel, buses included: it only affects the picture.
  gain: number;
  onStyle: (next: ChannelStyle) => void;
  onPan: (next: number) => void;
  onGain: (next: number) => void;
}) => {
  const help = useHelp();
  return (
  <div style={rowStyle}>
    <label style={{ width: "3.5em" }}>{label}</label>
    <input
      type="color"
      value={style.color}
      onChange={(e) => onStyle({ ...style, color: e.target.value })}
      title={`Color for ${label}`}
      {...help("channels.color")}
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
      {...help("channels.opacity")}
      style={{ flex: 1, minWidth: 0 }}
    />
    <input
      type="range"
      min={0}
      max={MAX_CHANNEL_GAIN}
      step={0.05}
      value={gain}
      onChange={(e) => onGain(parseFloat(e.target.value))}
      onDoubleClick={() => onGain(1)}
      title={`${label} display level: x${gain} (double-click to reset)`}
      {...help("channels.level")}
      style={{ width: "5em" }}
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
        {...help("channels.pan")}
        style={{ width: "5em" }}
      />
    )}
  </div>
  );
};

// A channel's identity rather than its visibility: the colour it draws in
// everywhere and, for a real input, where it sits in the stereo field. Which
// pane shows it is chosen per pane -- see ChannelPicker.
export const ChannelList = ({
  labels,
  inputCount,
  styles,
  pans,
  gains,
  setStyles,
  setPans,
  setGains,
}: {
  // How many of `labels` are real inputs. Only those can be panned.
  inputCount: number;
  pans: number[];
  setPans: (next: number[]) => void;
  gains: number[];
  setGains: (next: number[]) => void;
  // One per selectable channel, in device order. Anything past the device's
  // input channels is a synthetic bus -- the drums, then the click.
  labels: string[];
  styles: ChannelStyle[];
  setStyles: (next: ChannelStyle[]) => void;
}) => {
  const help = useHelp();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <div
        style={{
          ...rowStyle,
          fontSize: "10px",
          color: "#999",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        <span style={{ width: "3.5em" }} />
        <span style={{ width: "2em" }} {...help("channels.color")}>color</span>
        <span style={{ flex: 1, minWidth: 0 }} {...help("channels.opacity")}>opacity</span>
        <span style={{ width: "5em" }} {...help("channels.level")}>level</span>
        <span style={{ width: "5em" }} {...help("channels.pan")}>pan</span>
      </div>
      {labels.map((label, index) => (
        <ChannelRow
          key={index}
          label={label}
          style={channelStyle(styles, index)}
          pan={index < inputCount ? channelPan(pans, index) : undefined}
          gain={channelGain(gains, index)}
          onStyle={(next) => setStyles(withStyleAt(styles, index, next))}
          onPan={(next) => setPans(withPanAt(pans, index, next))}
          onGain={(next) => setGains(withGainAt(gains, index, next))}
        />
      ))}

    </div>
  );
};
