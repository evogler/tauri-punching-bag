import { useState } from "react";
import { useHelp } from "../help";

// Passing `startCollapsed` makes the heading a toggle. Collapsed is hidden, not
// unmounted, for the same reason as `TabPanel`: a half-typed field inside
// would otherwise be thrown away. `help` names the entry the heading shows.
export const Section = ({
  children,
  label = undefined,
  startCollapsed,
  help,
}: {
  children: React.ReactNode;
  label?: string;
  startCollapsed?: boolean;
  help?: string;
}) => {
  const [collapsed, setCollapsed] = useState(startCollapsed ?? false);
  const collapsible = startCollapsed !== undefined;
  const showHelp = useHelp();
  const headingHelp = help ? showHelp(help) : {};
  return (
    <div
      style={{
        border: "1px solid #777",
        margin: "4px",
        padding: "4px",
        borderRadius: "8px",
        backgroundColor: "#444",
      }}
    >
      {label &&
        (collapsible ? (
          <h4
            onClick={() => setCollapsed(!collapsed)}
            {...headingHelp}
            style={{
              color: "#ccc",
              margin: "1px ",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            {collapsed ? "▸" : "▾"} {label}
          </h4>
        ) : (
          <h4 {...headingHelp} style={{ color: "#ccc", margin: "1px " }}>
            {label}
          </h4>
        ))}
      {collapsible ? (
        <div style={{ display: collapsed ? "none" : "block" }}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
};

// The panel groups by what you are doing: what plays, a file to play along
// with, what comes back to you, how it is drawn and the frame it is drawn in,
// what belongs to this machine, and the expert knobs. Transport, tempo, the
// looper switch, presets and parameters stay above the tabs -- parameters
// especially, since you edit `n` while looking at a field that reads
// `bar/n x n`.
export const PANEL_TABS = [
  "play",
  "file",
  "loop",
  "display",
  "layout",
  "setup",
  "analysis",
] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const TabBar = ({
  active,
  onSelect,
}: {
  active: PanelTab;
  onSelect: (tab: PanelTab) => void;
}) => (
  <div style={{ display: "flex", flexDirection: "row", gap: "2px", margin: "4px 4px 0" }}>
    {PANEL_TABS.map((tab) => (
      <button
        key={tab}
        onClick={() => onSelect(tab)}
        style={{
          flex: 1,
          padding: "4px",
          border: "1px solid #777",
          borderRadius: "8px 8px 0 0",
          backgroundColor: tab === active ? "#444" : "#333",
          color: tab === active ? "#fff" : "#aaa",
          fontWeight: tab === active ? "bold" : undefined,
          cursor: "pointer",
        }}
      >
        {tab[0].toUpperCase() + tab.slice(1)}
      </button>
    ))}
  </div>
);

// Hidden rather than unmounted: `Input` holds the text you are typing in local
// state, and an expression is invalid for most of the time it takes to type,
// so unmounting would throw a half-written field away on every tab switch.
// Every section rendered on every render before this existed, so nothing here
// costs more than it used to.
export const TabPanel = ({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) => <div style={{ display: active ? "block" : "none" }}>{children}</div>;

// A labelled hairline between groups of settings inside one Section. The views
// pane holds four unrelated kinds of setting -- which pane, how it is ruled,
// how it draws, what is drawn over it -- and reads as a wall of inputs without
// something separating them.
export const Divider = ({ label }: { label?: string }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: "6px",
      margin: "8px 0 4px",
    }}
  >
    {label && (
      <span
        style={{
          color: "#999",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {label}
      </span>
    )}
    <div style={{ flex: 1, height: "1px", backgroundColor: "#777" }} />
  </div>
);
