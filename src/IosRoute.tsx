import { ActiveDevices } from "./DevicePicker";
import { ui } from "./theme";

const noteStyle: React.CSSProperties = { fontSize: "11px", opacity: 0.7 };
const warnStyle: React.CSSProperties = { fontSize: "0.85em", color: ui.warn };

/**
 * What iOS shows where the Mac has the device picker. There is nothing to
 * pick: the system routes -- plug headphones in and the audio goes there --
 * and the app follows (`platform/ios/mod.rs`). So this says what the route
 * is, what the session reports about it, and what is wrong with it: Bluetooth
 * output, whose latency drifts, and a refused microphone, which is otherwise
 * indistinguishable from a quiet room.
 */
export const IosRoute = ({
  active,
  sampleRate,
  error,
}: {
  active: ActiveDevices | null;
  sampleRate: number;
  error?: string | null;
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
    {active ? (
      <>
        <div>
          {active.inputName} → {active.outputName}
        </div>
        <div style={noteStyle}>
          {sampleRate} Hz · buffer {active.ioBufferFrames ?? "?"} frames · the
          system reports {(active.inputLatencyMs ?? 0).toFixed(1)} ms in,{" "}
          {(active.outputLatencyMs ?? 0).toFixed(1)} ms out
          {active.suggestedCompensation
            ? ` -- a starting latency of ${active.suggestedCompensation} frames. Measure it below; only that hears the air.`
            : ""}
        </div>
        {active.outputWarning && <div style={warnStyle}>{active.outputWarning}</div>}
        {active.inputWarning && (
          <div style={{ ...warnStyle, color: ui.error }}>{active.inputWarning}</div>
        )}
      </>
    ) : (
      <div style={noteStyle}>Starting the audio…</div>
    )}
    {error && <div style={{ ...noteStyle, color: ui.error, opacity: 1 }}>{error}</div>}
  </div>
);
