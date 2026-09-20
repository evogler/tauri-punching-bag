import { useEffect, useState } from "react";
import { EXAMPLES } from "./examples";
import { Preset, presetHash } from "./presets";
import { useHelp } from "./help";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

/// The bundled examples, in their own picker rather than mixed into the saved
/// presets: these are read-only, they are not yours, and they cannot be deleted
/// by accident. Loading one goes through the same `loadPreset` everything else
/// does, so it inherits the merge-over-defaults rule and leaves a measured
/// latency alone -- and saving afterwards makes an ordinary preset of your own.
export const ExampleBar = ({
  getCurrent,
  onLoad,
}: {
  getCurrent: () => Preset;
  onLoad: (preset: Preset) => void;
}) => {
  const [id, setId] = useState("");
  const [loadedId, setLoadedId] = useState("");
  // The hash of the config as the example left it. Empty means nothing is
  // loaded, or something has been changed since.
  const [baseline, setBaseline] = useState("");
  const [capture, setCapture] = useState(false);
  const help = useHelp();

  const chosen = EXAMPLES.find((e) => e.id === id);
  const loaded = EXAMPLES.find((e) => e.id === loadedId);

  // Runs after every render, which is the only place the config *as loaded* can
  // be read: `onLoad` sets state, so the settings are still the old ones for
  // the rest of the click that asked for them. Comparing hashes is what lets
  // the try-this line go away by itself -- it describes the example, and the
  // moment anything moves it is describing something else. Clearing the
  // baseline also stops the hashing, so this costs nothing once it has fired.
  useEffect(() => {
    if (capture) {
      setCapture(false);
      setBaseline(presetHash(getCurrent()));
      return;
    }
    if (baseline && presetHash(getCurrent()) !== baseline) setBaseline("");
  });

  const load = () => {
    if (!chosen) return;
    onLoad(chosen.preset);
    setLoadedId(chosen.id);
    setCapture(true);
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
      {chosen && (
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          {chosen.description}
        </div>
      )}
      {loaded?.tryThis && baseline && (
        <div style={{ ...rowStyle, alignItems: "baseline" }}>
          <div style={{ flex: 1, minWidth: 0, color: "#cfc", fontSize: "0.8em" }}>
            <b>Try this:</b> {loaded.tryThis}
          </div>
          <button onClick={() => setBaseline("")} title="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
};
