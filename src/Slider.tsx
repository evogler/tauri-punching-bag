import { useHelp } from "./help";
import { ui } from "./theme";

// A labelled range input, with the current value beside it. Shared by the
// per-view controls that are plain numbers rather than expressions -- a slider
// has nowhere to type one, which is the whole reason those keys aren't
// expression-backed.
export const sliderRowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "4px",
  alignItems: "center",
};

export const Slider = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  help,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  help: string;
}) => {
  const showHelp = useHelp();
  return (
    <div style={sliderRowStyle} {...showHelp(help)}>
      <label style={{ width: "9em" }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span style={{ color: ui.text.muted, fontSize: "0.8em", width: "3em" }}>
        {value}
      </span>
    </div>
  );
};
