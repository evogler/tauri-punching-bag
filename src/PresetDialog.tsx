import { ui } from "./theme";
// A modal list of presets with checkboxes, a note column and whatever action
// buttons the caller wants. Import and manage both use it, and loading only
// *part* of a preset is meant to be the third -- which is the whole reason it
// takes its rows and its actions rather than knowing what it is listing.

export type DialogRow = {
  key: string;
  name: string;
  /** Why this row is interesting: a collision, a duplicate, an unreadable entry. */
  note?: string;
  noteColor?: string;
  /** Present and unusable: shown, never selectable. */
  disabled?: boolean;
};

export type DialogAction = {
  label: string;
  primary?: boolean;
  /** Hidden entirely rather than disabled, for actions that only make sense sometimes. */
  hidden?: boolean;
  run: (keys: string[]) => void;
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const panel: React.CSSProperties = {
  backgroundColor: ui.surface.panel,
  border: `1px solid ${ui.line.divider}`,
  borderRadius: "8px",
  padding: "8px",
  minWidth: "26em",
  maxWidth: "40em",
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

export const PresetDialog = ({
  title,
  hint,
  rows,
  selected,
  setSelected,
  actions,
  onClose,
}: {
  title: string;
  hint?: string;
  rows: DialogRow[];
  selected: string[];
  setSelected: (keys: string[]) => void;
  actions: DialogAction[];
  onClose: () => void;
}) => {
  const usable = rows.filter((r) => !r.disabled);
  const allOn = usable.length > 0 && usable.every((r) => selected.includes(r.key));

  const toggle = (key: string) =>
    setSelected(
      selected.includes(key)
        ? selected.filter((k) => k !== key)
        : [...selected, key]
    );

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <h4 style={{ color: ui.text.body, margin: 0 }}>{title}</h4>
        {hint && (
          <div style={{ color: ui.text.muted, fontSize: "0.8em" }}>{hint}</div>
        )}

        <label
          style={{
            display: "flex",
            gap: "6px",
            alignItems: "center",
            color: ui.text.muted,
            fontSize: "0.8em",
            borderBottom: `1px solid ${ui.line.field}`,
            paddingBottom: "4px",
          }}
        >
          <input
            type="checkbox"
            checked={allOn}
            disabled={!usable.length}
            onChange={() => setSelected(allOn ? [] : usable.map((r) => r.key))}
          />
          {allOn ? "none" : "all"}
        </label>

        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {rows.map((row) => (
            <label
              key={row.key}
              style={{
                display: "flex",
                gap: "6px",
                alignItems: "baseline",
                padding: "2px 0",
                opacity: row.disabled ? 0.5 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={selected.includes(row.key)}
                disabled={row.disabled}
                onChange={() => toggle(row.key)}
              />
              <span style={{ flex: 1, minWidth: 0 }}>{row.name}</span>
              {row.note && (
                <span
                  style={{
                    color: row.noteColor ?? ui.text.muted,
                    fontSize: "0.8em",
                    textAlign: "right",
                  }}
                >
                  {row.note}
                </span>
              )}
            </label>
          ))}
          {!rows.length && (
            <div style={{ color: ui.text.muted, fontSize: "0.8em" }}>nothing here</div>
          )}
        </div>

        <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }}>
          <button onClick={onClose}>cancel</button>
          {actions
            .filter((a) => !a.hidden)
            .map((action) => (
              <button
                key={action.label}
                disabled={!selected.length}
                onClick={() => action.run(selected)}
                style={
                  action.primary ? { fontWeight: "bold" } : undefined
                }
              >
                {action.label}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
};
