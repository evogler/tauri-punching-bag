import { ChannelId, ChannelInfo, ChannelStyles, channelStyle } from "./config";
import { ui } from "./theme";

// Which channels one pane draws. Deliberately thinner than `ChannelList`: the
// colour and the pan belong to the channel itself and stay global, so all a
// pane chooses is the subset.
export const ChannelPicker = ({
  channels,
  styles,
  selected,
  setSelected,
}: {
  // Every channel the panel can name, by id: this device's inputs, the buses,
  // and any input some pane asks for that isn't connected.
  channels: ChannelInfo[];
  styles: ChannelStyles;
  selected: ChannelId[];
  setSelected: (next: ChannelId[]) => void;
}) => {
  const toggle = (id: ChannelId) =>
    setSelected(
      selected.includes(id)
        ? selected.filter((i) => i !== id)
        : // Id order -- inputs, then the buses -- which is the order they're
          // drawn in and the order the up/down split assigns from.
          [...selected, id].sort((a, b) => a - b)
    );

  // An input this device doesn't have is shown only to the pane that asks for
  // it: kept, named, and said to be missing, so the choice is visible and can
  // be undone, rather than hidden until the interface comes back.
  const shownHere = channels.filter((c) => c.present || selected.includes(c.id));

  return (
    <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "8px" }}>
      {shownHere.map(({ id, label, present }) => {
        const shown = selected.includes(id);
        const style = channelStyle(styles, id);
        return (
          <label
            key={id}
            style={{
              display: "flex",
              flexDirection: "row",
              alignItems: "center",
              gap: "3px",
              opacity: shown && present ? 1 : 0.45,
            }}
            title={
              present
                ? `${shown ? "Hide" : "Show"} ${label} in this pane`
                : `${label} isn't on this device. The pane keeps it and draws it again when a device with that input is chosen.`
            }
          >
            <input type="checkbox" checked={shown} onChange={() => toggle(id)} />
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
            {!present && (
              <span style={{ color: ui.text.muted }}> -- not connected</span>
            )}
          </label>
        );
      })}
    </div>
  );
};
