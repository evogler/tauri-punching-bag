import { ViewConfig } from "./config";

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

const Slider = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  title,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  title: string;
}) => (
  <div style={rowStyle}>
    <label style={{ width: "9em" }}>{label}</label>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      title={title}
      style={{ flex: 1, minWidth: 0 }}
    />
    <span style={{ color: "#aaa", fontSize: "0.8em", width: "3em" }}>
      {value}
    </span>
  </div>
);

// The pane controls that only mean anything for a spectrogram. Plain numbers
// rather than expressions: a slider and a dropdown have nowhere to type one.
export const SpectrogramControls = ({
  cfg,
  labels,
  count,
  set,
}: {
  cfg: ViewConfig;
  // Channel names in device order; only the first `count` are analysed.
  labels: string[];
  count: number;
  set: (key: string, val: unknown) => void;
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
    <div style={rowStyle}>
      <label style={{ width: "9em" }}>spectrogram channel</label>
      <select
        value={cfg.spectrogramChannel}
        onChange={(e) => set("spectrogramChannel", Number(e.target.value))}
        title="Which input channel this pane shows the spectrum of"
      >
        {Array.from({ length: Math.max(1, count) }, (_, i) => (
          <option key={i} value={i}>
            {labels[i] ?? `ch ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
    <Slider
      label="spectrogram gain"
      value={cfg.spectrogramGain}
      min={0.5}
      max={4}
      step={0.1}
      onChange={(n) => set("spectrogramGain", n)}
      title="Brightness multiplier, applied after the floor is subtracted"
    />
    <Slider
      label="spectrogram floor"
      value={cfg.spectrogramFloor}
      min={0}
      max={0.9}
      step={0.01}
      onChange={(n) => set("spectrogramFloor", n)}
      // Rust sends a deliberately wide -100..0 dB range, so where the noise
      // actually stops is decided here rather than pushed to the audio thread.
      title="Everything at or below this fraction of full scale draws as background"
    />
  </div>
);
