import { useHelp } from "../help";
import { PanelProps } from "./types";
import { ui } from "../theme";

export const PanelHeader = (
  p: PanelProps & { helpVisible: boolean; toggleHelp: () => void }
) => {
  const { configError, helpVisible, toggleHelp } = p;
  const help = useHelp();
  return (
    <>
      {/* All that is left up here. The transport, the tempo and the looper
          moved to the window's top bar, where hiding the panel cannot take
          them with it; the help toggle stayed, because what it toggles is a
          part of this panel and goes when the panel does.

          Keeps a tooltip: once the help area is hidden, it cannot explain the
          button that brings it back. */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={toggleHelp}
          {...help("helpToggle")}
          title={helpVisible ? "Hide help" : "Show help"}
          style={{
            width: "2.2em",
            fontWeight: "bold",
            backgroundColor: helpVisible ? ui.surface.selected : undefined,
          }}
        >
          ?
        </button>
      </div>

      {configError && (
        <div
          style={{
            border: `1px solid ${ui.bad}`,
            borderRadius: 8,
            margin: 4,
            padding: 8,
            backgroundColor: ui.dangerFill,
            color: ui.error,
          }}
        >
          <b>A setting couldn't be applied, so what's playing doesn't match the
          panel.</b>{" "}
          Fix the field outlined in red and it will catch up.
          <div style={{ opacity: 0.8, fontSize: "0.85em", marginTop: 4 }}>
            {configError}
          </div>
        </div>
      )}
    </>
  );
};
