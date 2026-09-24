import { useEffect, useState } from "react";
import { EXAMPLES } from "./examples";
import { Preset, presetHash } from "./presets";
import { useHelp } from "./help";
import { ui } from "./theme";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

/// The "try this" line, and knowing when to stop showing it.
///
/// Held above both the picker and the header rather than inside the picker,
/// because the advice is about what to go and *do* -- you load an example and
/// then leave for the Play section, where the line has to still be there. Same
/// argument as the config error banner, which is the other transient notice
/// that outlives the section it came from.
export const useExampleHint = (getCurrent: () => Preset) => {
  const [loadedId, setLoadedId] = useState("");
  // The hash of the config as the example left it. Empty means nothing is
  // loaded, or something has been changed since.
  const [baseline, setBaseline] = useState("");
  const [capture, setCapture] = useState(false);

  // Runs after every render, which is the only place the config *as loaded* can
  // be read: `onLoad` sets state, so the settings are still the old ones for
  // the rest of the click that asked for them. Comparing hashes is what lets
  // the line go away by itself -- it describes the example, and the moment
  // anything moves it is describing something else. Clearing the baseline also
  // stops the hashing, so this costs nothing once it has fired.
  useEffect(() => {
    if (capture) {
      setCapture(false);
      setBaseline(presetHash(getCurrent()));
      return;
    }
    if (baseline && presetHash(getCurrent()) !== baseline) setBaseline("");
  });

  const example = EXAMPLES.find((e) => e.id === loadedId);
  return {
    showing: baseline && example?.tryThis ? example : null,
    loaded: (id: string) => {
      setLoadedId(id);
      setCapture(true);
    },
    dismiss: () => setBaseline(""),
  };
};

export const ExampleHint = ({
  example,
  onDismiss,
}: {
  example: { name: string; tryThis?: string };
  onDismiss: () => void;
}) => (
  <div
    style={{
      ...rowStyle,
      alignItems: "baseline",
      border: `1px solid ${ui.hintEdge}`,
      borderRadius: 8,
      margin: 4,
      padding: "5px 7px",
      backgroundColor: ui.hintFill,
    }}
  >
    <div style={{ flex: 1, minWidth: 0, color: ui.hintText, fontSize: "0.9em" }}>
      <b>Try this:</b> {example.tryThis}
    </div>
    <button onClick={onDismiss} title="Dismiss">
      ✕
    </button>
  </div>
);

/// The bundled examples. Read-only, in their own section rather than mixed into
/// the saved presets: these are not yours and cannot be deleted by accident.
/// Loading one goes through the same `loadPreset` everything else does, so it
/// inherits the merge-over-defaults rule and leaves a measured latency alone --
/// and saving afterwards makes an ordinary preset of your own.
export const ExampleBar = ({
  onLoad,
  onLoaded,
}: {
  onLoad: (preset: Preset) => void;
  /** Tells the hint above which example is now in effect. */
  onLoaded: (id: string) => void;
}) => {
  const [id, setId] = useState("");
  const help = useHelp();
  const chosen = EXAMPLES.find((e) => e.id === id);

  const load = () => {
    if (!chosen) return;
    onLoad(chosen.preset);
    onLoaded(chosen.id);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={rowStyle}>
        <select
          value={id}
          onChange={(e) => setId(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
          {...help("examples.list")}
        >
          <option value="">Choose an example…</option>
          {EXAMPLES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button
          onClick={load}
          disabled={!chosen}
          title={chosen ? `Load "${chosen.name}"` : "Choose an example first"}
          {...help("examples.load")}
        >
          Load
        </button>
      </div>
      <div style={{ color: ui.text.muted, fontSize: "0.85em" }}>
        {chosen
          ? chosen.description
          : "Each one is a working setup that shows off one idea. Loading one replaces your settings, so save them first if you want them back."}
      </div>
    </div>
  );
};
