import { createContext, useContext, useEffect, useState } from "react";
import { HELP } from "./helpText";
import { ui } from "./theme";

// Pointing at anything that carries a help id shows its entry in the help area
// at the foot of the panel. A context rather than props, so a cell deep inside
// a list component can name its own entry without every layer above it passing
// a setter down.
const ShowHelp = createContext<(id: string | null) => void>(() => {});
export const HelpProvider = ShowHelp.Provider;

// Spread onto any element. `onFocusCapture` rather than `onFocus`, because the
// text fields already use `onFocus` to keep what is being typed -- spreading a
// second one over it would silently break editing. Capture fires for the
// element itself and for anything focused inside it, so a wrapper works too.
export const useHelp = () => {
  const show = useContext(ShowHelp);
  return (id: string) => ({
    onMouseEnter: () => show(id),
    onFocusCapture: () => show(id),
  });
};

export const Help = ({
  id,
  children,
  style,
}: {
  id: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) => {
  const help = useHelp();
  return (
    <div {...help(id)} style={style}>
      {children}
    </div>
  );
};

// Backticks mark something you would type, drawn in monospace so `bar/n x n`
// reads as syntax rather than as prose.
const renderBody = (text: string) =>
  text.split("`").map((part, i) =>
    i % 2 ? (
      <code
        key={i}
        style={{
          fontFamily: "ui-monospace, Menlo, monospace",
          backgroundColor: ui.surface.sunken,
          padding: "0 3px",
          borderRadius: 3,
        }}
      >
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    )
  );

// Holds which entry is showing itself, rather than in the panel: every hover
// would otherwise re-render every tab. `register` hands the setter up once.
export const HelpArea = ({
  register,
}: {
  register: (show: ((id: string | null) => void) | null) => void;
}) => {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    register(setId);
    return () => register(null);
  }, [register]);
  const entry = id ? HELP[id] : undefined;
  return (
    <div
      style={{
        flexShrink: 0,
        // A fixed height, so the panel above does not jump as entries of
        // different lengths come and go. A long one scrolls.
        height: "7.5em",
        overflowY: "auto",
        boxSizing: "border-box",
        borderTop: `1px solid ${ui.line.divider}`,
        backgroundColor: ui.surface.inset,
        padding: "6px 10px",
        fontSize: "0.9em",
        lineHeight: 1.4,
        color: ui.text.primary,
      }}
    >
      {entry ? (
        <>
          <div style={{ fontWeight: "bold", marginBottom: 2 }}>{entry.title}</div>
          <div>{renderBody(entry.body)}</div>
        </>
      ) : (
        <div style={{ color: ui.text.dim }}>
          Point at any setting to see what it does. Click a pane to hide this
          panel, and click again to bring it back.
        </div>
      )}
    </div>
  );
};
