import { ChannelStyle, channelStyle } from "./config";

// Which channels one pane draws. Deliberately thinner than `ChannelList`: the
// colour and the pan belong to the channel itself and stay global, so all a
// pane chooses is the subset.
export const ChannelPicker = ({
  labels,
  styles,
  channels,
  setChannels,
}: {
  // One per selectable channel, in device order: the inputs, then the
  // synthetic drum and click buses.
  labels: string[];
  styles: ChannelStyle[];
  channels: number[];
  setChannels: (next: number[]) => void;
}) => {
  const toggle = (index: number) =>
    setChannels(
      channels.includes(index)
        ? channels.filter((i) => i !== index)
        : // Device order, which is the order they're drawn in and the order the
          // up/down split assigns from.
          [...channels, index].sort((a, b) => a - b)
    );

  return (
    <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
      {labels.map((label, index) => {
        const shown = channels.includes(index);
        const style = channelStyle(styles, index);
        return (
          <label
            key={index}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "3px",
              opacity: shown ? 1 : 0.45,
            }}
            title={`${shown ? "Hide" : "Show"} ${label} in this pane`}
          >
            <input type="checkbox" checked={shown} onChange={() => toggle(index)} />
            {/* The channel's own colour, so the pane's list reads the way the
                pane does. Not editable here -- colour is global. */}
            <span
              style={{
                width: "0.7em",
                height: "0.7em",
                borderRadius: "50%",
                backgroundColor: style.color,
                opacity: style.alpha,
              }}
            />
            {label}
          </label>
        );
      })}
    </div>
  );
};
