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
// looper switch, examples, presets and parameters stay outside the rail --
// parameters especially, since you edit `n` while looking at a field that
// reads `bar/n x n`.
//
// **The groups are the source of truth, and `PanelTab` is derived from them.**
// A separate flat list of sections would let a new one be added without being
// put in a group, and an ungrouped section is one the rail never draws -- a
// tab you cannot reach, with nothing saying so. Deriving the type makes that
// unrepresentable rather than guarded against.
//
// The headings are what keeps a column legible past about eight entries --
// which is the length the row of tabs stopped working at, and the length this
// is built to grow through. Analysis sits under the picture rather than on its
// own: the high pass is explicitly for the picture, and the spectrum and the
// onsets are drawn.
export const TAB_GROUPS = [
  { label: "sound", tabs: ["play", "file", "loop"] },
  { label: "picture", tabs: ["display", "layout", "analysis"] },
  { label: "machine", tabs: ["setup"] },
] as const;

export type PanelTab = (typeof TAB_GROUPS)[number]["tabs"][number];

const railButton = (active: boolean): React.CSSProperties => ({
  padding: "5px 8px",
  textAlign: "left",
  // Flat against the content on its left and rounded away from it, so the
  // open section reads as one piece with what it opened. The row of tabs did
  // the same thing upwards.
  borderRadius: "0 8px 8px 0",
  border: "1px solid #777",
  borderLeft: active ? "none" : "1px solid #777",
  paddingLeft: active ? "9px" : "8px",
  backgroundColor: active ? "#444" : "#333",
  color: active ? "#fff" : "#aaa",
  fontWeight: active ? "bold" : undefined,
  cursor: "pointer",
});

/// The section list, down the right-hand edge of the panel.
///
/// A column rather than a row because a row divides one panel width between
/// however many sections there are -- at seven each tab was already 85px, and
/// the next few would have truncated their own labels. A column costs a fixed
/// strip of width and then grows for free, and it stays put while the settings
/// beside it scroll.
export const TabRail = ({
  active,
  onSelect,
}: {
  active: PanelTab;
  onSelect: (tab: PanelTab) => void;
}) => {
  // Read here rather than taken as a prop: `Panel` *provides* the help context,
  // so a `useHelp()` call up there would read the no-op default above it.
  const help = useHelp();
  return (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: "2px",
      padding: "4px 0 4px 0",
      flexShrink: 0,
      // Its own scroll, so a rail longer than the window can still be reached
      // without the settings beside it moving.
      minHeight: 0,
      overflowY: "auto",
      overflowX: "hidden",
    }}
  >
    {TAB_GROUPS.map((group, i) => (
      <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <span
          style={{
            color: "#999",
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            padding: i ? "8px 0 2px 9px" : "0 0 2px 9px",
          }}
        >
          {group.label}
        </span>
        {group.tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => onSelect(tab)}
            {...help(`tabs.${tab}`)}
            style={railButton(tab === active)}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
    ))}
  </div>
  );
};

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
