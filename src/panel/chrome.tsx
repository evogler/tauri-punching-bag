import { useState } from "react";
import { useHelp } from "../help";
import { ui } from "../theme";

// A section's name, as a caption rather than a title. It used to be an
// unstyled `h4` -- bold, and at the same size as the labels underneath it, so
// the name of a group competed with the settings inside it. Smaller and
// quieter than its own contents is the right way round: the group tells you
// where you are, the controls are what you came for. Uppercase and
// letter-spaced so it still reads as a heading at that size, which is the same
// treatment the section rail's group names get.
const headingStyle: React.CSSProperties = {
  color: ui.text.caption,
  fontSize: "0.8em",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
  margin: "0 0 4px 1px",
};

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
        // A hairline barely above the fill it encloses. It used to be #777 on
        // #444, which put a bright outline around every group -- a dozen of
        // them stacked, and between them the loudest structure in the panel.
        // The fill is what groups; the line only says where the group ends.
        border: "1px solid #525252",
        margin: "4px",
        padding: "5px 7px",
        borderRadius: "8px",
        backgroundColor: ui.surface.panel,
      }}
    >
      {label &&
        (collapsible ? (
          <h4
            onClick={() => setCollapsed(!collapsed)}
            {...headingHelp}
            style={{ ...headingStyle, cursor: "pointer", userSelect: "none" }}
          >
            {collapsed ? "▸" : "▾"} {label}
          </h4>
        ) : (
          <h4 {...headingHelp} style={headingStyle}>
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

// The panel groups by what you are doing: the settings as a whole, what plays,
// a file to play along with, what comes back to you, how it is drawn and the
// frame it is drawn in, and what belongs to this machine. Only the transport,
// the tempo and the looper switch stay outside the rail -- those are reached
// for mid-phrase, and tempo belongs to no one section.
//
// Examples, presets and parameters were pinned above the tabs and are sections
// now: three boxes standing open over every tab, two of them collapsed to a
// heading and saying nothing, was clutter in the one place that is always on
// screen. Parameters loses something real by moving -- it was pinned so `n`
// could be edited while looking at a field that reads `bar/n x n` -- and that
// was weighed and taken.
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
  // First, because the first question is where to start from, and because a
  // newcomer who reads no further than the top of the rail has still found the
  // examples.
  { label: "settings", tabs: ["examples", "presets", "parameters"] },
  { label: "sound", tabs: ["play", "file", "loop"] },
  { label: "picture", tabs: ["display", "layout", "analysis"] },
  { label: "machine", tabs: ["setup"] },
] as const;

export type PanelTab = (typeof TAB_GROUPS)[number]["tabs"][number];

/// The rail read top to bottom, which is also the order the shortcuts count in.
export const RAIL_TABS: PanelTab[] = TAB_GROUPS.flatMap(
  (g) => g.tabs as readonly PanelTab[]
);

/// ⌘1..⌘9 then ⌘0, in rail order -- the browser-tab and Logic-screenset
/// convention, and the only one where the key you press is something you can
/// *see*: the digit is drawn in the rail button, so nobody has to be told.
///
/// **Positional, which is the one part of this rail that does not scale.**
/// Reordering the groups renumbers everything, and an eleventh section gets no
/// digit at all. Taken deliberately rather than by oversight: a mnemonic
/// scheme collides immediately (play, presets and parameters all start with p)
/// and would have to be remembered instead of read. ⌘[ and ⌘] step through the
/// whole rail, so nothing is ever unreachable however long it gets.
export const tabAccelerator = (tab: PanelTab): string | undefined => {
  const i = RAIL_TABS.indexOf(tab);
  if (i < 0 || i > 9) return undefined;
  return String((i + 1) % 10);
};

/// Which section a digit selects, or nothing if it names none. ⌘1 is the first
/// and ⌘0 the tenth, so the digit is shifted down one and wrapped; a rail with
/// fewer than ten sections simply has no answer for the digits past its end.
export const tabForDigit = (digit: string): PanelTab | undefined =>
  RAIL_TABS[(Number(digit) + 9) % 10];

/// One step through the rail, wrapping. What keeps an eleventh section
/// reachable once the digits have run out.
export const tabStep = (tab: PanelTab, by: number): PanelTab => {
  const i = RAIL_TABS.indexOf(tab);
  const n = RAIL_TABS.length;
  return RAIL_TABS[(((i < 0 ? 0 : i) + by) % n + n) % n];
};

const railButton = (active: boolean): React.CSSProperties => ({
  padding: "5px 8px",
  textAlign: "left",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  // Flat against the settings on its right and rounded away from them, so the
  // open section reads as one piece with what it opened. The row of tabs did
  // the same thing upwards.
  borderRadius: "8px 0 0 8px",
  border: "1px solid #777",
  borderRight: active ? "none" : "1px solid #777",
  paddingRight: active ? "9px" : "8px",
  backgroundColor: active ? ui.surface.panel : ui.surface.app,
  color: active ? ui.text.bright : ui.text.muted,
  fontWeight: active ? "bold" : undefined,
  cursor: "pointer",
});

/// The section list, down the left-hand edge of the panel.
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
            color: ui.text.dim,
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            padding: i ? "8px 0 2px 9px" : "0 0 2px 9px",
          }}
        >
          {group.label}
        </span>
        {group.tabs.map((tab) => {
          const key = tabAccelerator(tab);
          return (
            <button
              key={tab}
              onClick={() => onSelect(tab)}
              // Generated from the position rather than written down, so the
              // label and the key that works can never disagree.
              title={key ? `⌘${key}` : undefined}
              {...help(`tabs.${tab}`)}
              style={railButton(tab === active)}
            >
              <span>{tab[0].toUpperCase() + tab.slice(1)}</span>
              {/* Dim, because it is a reminder rather than part of the name --
                  but present, because a shortcut nobody can see is one nobody
                  uses. */}
              {key && (
                <span style={{ opacity: 0.45, paddingLeft: "6px" }}>{key}</span>
              )}
            </button>
          );
        })}
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
    {/* Not uppercase, unlike the section caption above it -- the two are one
        level apart and would otherwise read as the same thing twice. */}
    {label && (
      <span style={{ color: ui.text.faint, fontSize: "0.78em" }}>{label}</span>
    )}
    <div style={{ flex: 1, height: "1px", backgroundColor: ui.line.divider }} />
  </div>
);
