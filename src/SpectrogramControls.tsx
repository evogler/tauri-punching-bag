import { ViewConfig } from "./config";
import { useHelp } from "./help";
import { Slider, sliderRowStyle as rowStyle } from "./Slider";

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
}) => {
  const help = useHelp();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <div style={rowStyle} {...help("spectrogramChannel")}>
        <label style={{ width: "9em" }}>Spectrum of</label>
        <select
          value={cfg.spectrogramChannel}
          onChange={(e) => set("spectrogramChannel", Number(e.target.value))}
        >
          {Array.from({ length: Math.max(1, count) }, (_, i) => (
            <option key={i} value={i}>
              {labels[i] ?? `ch ${i + 1}`}
            </option>
          ))}
        </select>
      </div>
      <Slider
        label="Brightness"
        value={cfg.spectrogramGain}
        min={0.5}
        max={4}
        step={0.1}
        onChange={(n) => set("spectrogramGain", n)}
        help="spectrogramGain"
      />
      {/* Rust sends a deliberately wide -100..0 dB range, so where the noise
          actually stops is decided here rather than pushed to the audio
          thread. */}
      <Slider
        label="Floor"
        value={cfg.spectrogramFloor}
        min={0}
        max={0.9}
        step={0.01}
        onChange={(n) => set("spectrogramFloor", n)}
        help="spectrogramFloor"
      />
    </div>
  );
};
