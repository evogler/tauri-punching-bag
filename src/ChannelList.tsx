import {
  ChannelGains,
  ChannelId,
  ChannelInfo,
  ChannelStyle,
  ChannelStyles,
  channelGain,
  channelPan,
  channelStyle,
  isInputId,
} from "./config";
import { useHelp } from "./help";
import { ui } from "./theme";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

// Styles and display levels are maps keyed by channel id, so setting one is
// one entry -- nothing to pad. Pans are still an array: they are inputs only,
// and an input's id is its index.
const withStyleAt = (styles: ChannelStyles, id: ChannelId, next: ChannelStyle) => ({
  ...styles,
  [id]: next,
});

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

const withGainAt = (gains: ChannelGains, id: ChannelId, next: number) => ({
  ...gains,
  [id]: next,
});

// Wide enough to lift a quiet mic into the same row as a hot line, and to pull
// a loud one back. 1 is neutral, and double-clicking returns to it.
const MAX_CHANNEL_GAIN = 4;

const ChannelRow = ({
  label,
  present,
  style,
  pan,
  gain,
  onStyle,
  onPan,
  onGain,
}: {
  label: string;
  // False for an input a pane asks for that this device doesn't have. Still
  // editable -- the settings wait for it -- but dimmed.
  present: boolean;
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
  <div
    style={{ ...rowStyle, opacity: present ? 1 : 0.45 }}
    title={present ? undefined : `${label} is not connected`}
  >
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
      className="ch-slider"
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
      className="ch-slider"
      style={{ width: "5em" }}
    />
    {pan === undefined ? (
      <span className="ch-slider" style={{ width: "5em" }} />
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
        className="ch-slider"
        style={{ width: "5em" }}
      />
    )}
  </div>
  );
};

// A channel's identity rather than its visibility: the colour it draws in
// everywhere and, for a real input, where it sits in the stereo field. Which
// pane shows it is chosen per pane -- see ChannelPicker.
const heading: React.CSSProperties = { fontSize: "10px", whiteSpace: "nowrap" };

export const ChannelList = ({
  channels,
  styles,
  pans,
  gains,
  setStyles,
  setPans,
  setGains,
}: {
  pans: number[];
  setPans: (next: number[]) => void;
  gains: ChannelGains;
  setGains: (next: ChannelGains) => void;
  // Every channel the panel can name, by id: the inputs, the synthetic buses,
  // and any input a pane asks for that isn't connected. Only inputs pan.
  channels: ChannelInfo[];
  styles: ChannelStyles;
  setStyles: (next: ChannelStyles) => void;
}) => {
  const help = useHelp();
  const missing = channels.filter((c) => !c.present).map((c) => c.label);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {/* The widths are the rows' own, in the rows' ems: the headings'
          smaller type is on the words only, or every column heading sits left
          of the column it names. */}
      <div
        style={{
          ...rowStyle,
          color: ui.text.dim,
          textTransform: "uppercase",
          letterSpacing: "0.3px",
        }}
      >
        <span style={{ width: "3.5em" }} />
        <span style={{ width: "2em" }} {...help("channels.color")}>
          <span style={heading}>color</span>
        </span>
        <span className="ch-slider" style={{ flex: 1, minWidth: 0, overflow: "hidden" }} {...help("channels.opacity")}>
          {/* Nudged clear of "color", which is wider than its 2em swatch. */}
          <span style={{ ...heading, paddingLeft: "6px" }}>opacity</span>
        </span>
        <span className="ch-slider" style={{ width: "5em", overflow: "hidden" }} {...help("channels.level")}>
          <span style={heading}>level</span>
        </span>
        <span className="ch-slider" style={{ width: "5em", overflow: "hidden" }} {...help("channels.pan")}>
          <span style={heading}>pan</span>
        </span>
      </div>
      {channels.map(({ id, label, present }) => (
        <ChannelRow
          key={id}
          label={label}
          present={present}
          style={channelStyle(styles, id)}
          pan={isInputId(id) ? channelPan(pans, id) : undefined}
          gain={channelGain(gains, id)}
          onStyle={(next) => setStyles(withStyleAt(styles, id, next))}
          onPan={(next) => setPans(withPanAt(pans, id, next))}
          onGain={(next) => setGains(withGainAt(gains, id, next))}
        />
      ))}
      {missing.length > 0 && (
        <div style={{ color: ui.text.muted, fontSize: "0.8em" }}>
          {missing.join(", ")}: not connected -- kept for the panes that show{" "}
          {missing.length > 1 ? "them" : "it"}.
        </div>
      )}

    </div>
  );
};
