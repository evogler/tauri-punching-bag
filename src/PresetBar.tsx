import { useState } from "react";
import {
  Preset,
  defaultPreset,
  readPresets,
  writePresets,
} from "./presets";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

export const PresetBar = ({
  getCurrent,
  onLoad,
}: {
  getCurrent: () => Preset;
  onLoad: (preset: Preset) => void;
}) => {
  const [presets, setPresets] = useState(readPresets);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");

  const names = Object.keys(presets).sort();

  const update = (next: Record<string, Preset>) => {
    setPresets(next);
    writePresets(next);
  };

  // So SAVE always does something, even before anything has been typed.
  const nextDefaultName = () => {
    let i = 1;
    while (`config ${i}` in presets) i++;
    return `config ${i}`;
  };

  const save = () => {
    const trimmed = name.trim() || nextDefaultName();
    if (trimmed in presets && !window.confirm(`Overwrite "${trimmed}"?`)) return;
    update({ ...presets, [trimmed]: getCurrent() });
    setSelected(trimmed);
    setName(trimmed);
  };

  const load = () => {
    const preset = presets[selected];
    if (preset) onLoad(preset);
  };

  const remove = () => {
    if (!selected || !(selected in presets)) return;
    if (!window.confirm(`Delete "${selected}"?`)) return;
    const next = { ...presets };
    delete next[selected];
    update(next);
    setSelected("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={rowStyle}>
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setName(e.target.value);
          }}
          style={{ flex: 1, minWidth: 0 }}
        >
          <option value="">
            {names.length ? "-- pick a config --" : "-- no saved configs --"}
          </option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          onClick={load}
          disabled={!presets[selected]}
          title={presets[selected] ? `Load "${selected}"` : "Pick a config first"}
        >
          LOAD
        </button>
        <button
          onClick={remove}
          disabled={!presets[selected]}
          title={
            presets[selected] ? `Delete "${selected}"` : "Pick a config first"
          }
        >
          DELETE
        </button>
      </div>
      <div style={rowStyle}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          placeholder={nextDefaultName()}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button onClick={save} title="Save the current settings">
          SAVE
        </button>
        <button
          onClick={() => onLoad(defaultPreset())}
          title="Reset every setting to its default"
        >
          DEFAULTS
        </button>
      </div>
      {!names.length && (
        <div style={{ color: "#aaa", fontSize: "0.8em" }}>
          Name the current settings and hit SAVE.
        </div>
      )}
    </div>
  );
};
