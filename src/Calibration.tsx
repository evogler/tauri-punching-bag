import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";

export type CalibrationResult = {
  phase: "idle" | "running" | "done" | "failed";
  progress: number;
  frames: number;
  ms: number;
  spreadMs: number;
  peakRatio: number;
  inputPeakDb: number;
  probesDetected: number;
  probesTotal: number;
  message: string;
  minInputPeakDb: number;
  minPeakRatio: number;
  maxSpreadMs: number;
};

const noteStyle: React.CSSProperties = { fontSize: "11px", opacity: 0.75 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: "6px",
  alignItems: "center",
};

/**
 * A meter rather than a pass/fail tick. The failure this exists to fix is a
 * user retrying blindly: "too quiet" and "loud but not locking" want opposite
 * responses, and seeing how far short a measurement fell tells you which way to
 * move the microphone.
 */
const Meter = ({
  label,
  value,
  threshold,
  fraction,
  suffix,
  higherIsBetter = true,
}: {
  label: string;
  value: number;
  threshold: number;
  fraction: number;
  suffix: string;
  higherIsBetter?: boolean;
}) => {
  const ok = higherIsBetter ? value >= threshold : value <= threshold;
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
      <div style={{ ...noteStyle, display: "flex", gap: "4px" }}>
        <span style={{ minWidth: "72px" }}>{label}</span>
        <span style={{ color: ok ? "#6c6" : "#e86" }}>
          {value.toFixed(1)}
          {suffix}
        </span>
        <span style={{ opacity: 0.6 }}>
          ({higherIsBetter ? "needs" : "under"} {threshold.toFixed(0)}
          {suffix})
        </span>
      </div>
      <div style={{ height: "3px", background: "#333", width: "180px" }}>
        <div
          style={{
            height: "100%",
            width: `${clamped * 100}%`,
            background: ok ? "#6c6" : "#e86",
          }}
        />
      </div>
    </div>
  );
};

/**
 * Round-trip latency measurement. Emits a sweep, finds it in the input with a
 * matched filter, and offers the frame difference. Never applies it on its own:
 * a calibration that is confidently wrong is worse than none, because you stop
 * suspecting it.
 */
export const Calibration = ({
  inputCount,
  onApply,
}: {
  inputCount: number;
  onApply: (frames: number) => void;
}) => {
  const [channel, setChannel] = useState(0);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = result?.phase === "running";

  useEffect(() => {
    if (!running) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return;
    }
    timer.current = setInterval(() => {
      invoke<CalibrationResult>("get_calibration_status")
        .then(setResult)
        .catch(() => {});
    }, 100);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [running]);

  const start = () => {
    invoke("start_calibration", { channel })
      .then(() =>
        setResult({
          phase: "running",
          progress: 0,
          frames: 0,
          ms: 0,
          spreadMs: 0,
          peakRatio: 0,
          inputPeakDb: -120,
          probesDetected: 0,
          probesTotal: 5,
          message: "",
          minInputPeakDb: -45,
          minPeakRatio: 8,
          maxSpreadMs: 5,
        })
      )
      .catch(() => {});
  };

  const cancel = () => {
    invoke("cancel_calibration").catch(() => {});
    setResult(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
      <div style={rowStyle}>
        <label>Channel</label>
        <select
          value={channel}
          disabled={running}
          onChange={(e) => setChannel(Number(e.target.value))}
        >
          {Array.from({ length: Math.max(1, inputCount) }, (_, i) => (
            <option key={i} value={i}>
              ch {i + 1}
            </option>
          ))}
        </select>
        {running ? (
          <>
            <span style={noteStyle}>
              Measuring… {Math.round((result?.progress ?? 0) * 100)}%
            </span>
            <button onClick={cancel}>Stop</button>
          </>
        ) : (
          <button onClick={start}>Measure latency</button>
        )}
      </div>

      <div style={noteStyle}>
        Plays a short sweep and listens for it. Put the microphone against a
        speaker — or right inside a headphone cup with the volume up, which
        works well. The measurement includes the air path, so keep it close.
      </div>

      {result && result.phase !== "running" && result.phase !== "idle" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
          <div
            style={{
              ...noteStyle,
              color: result.phase === "done" ? "#6c6" : "#e86",
            }}
          >
            {result.message}
          </div>

          {/* Shown for a failure as well as a success: the numbers are how you
              work out what to change. */}
          <Meter
            label="Input level"
            value={result.inputPeakDb}
            threshold={result.minInputPeakDb}
            suffix=" dB"
            fraction={(result.inputPeakDb + 90) / 90}
          />
          <Meter
            label="Match"
            value={result.peakRatio}
            threshold={result.minPeakRatio}
            suffix="x"
            fraction={result.peakRatio / (result.minPeakRatio * 3)}
          />
          <Meter
            label="Agreement"
            value={result.spreadMs}
            threshold={result.maxSpreadMs}
            suffix=" ms"
            higherIsBetter={false}
            fraction={1 - result.spreadMs / (result.maxSpreadMs * 3)}
          />
          <div style={noteStyle}>
            Probes found: {result.probesDetected} / {result.probesTotal}
          </div>

          {result.phase === "done" && (
            <div style={rowStyle}>
              <button onClick={() => onApply(Math.round(result.frames))}>
                Apply {Math.round(result.frames)} frames ({result.ms.toFixed(1)}{" "}
                ms)
              </button>
              <button onClick={() => setResult(null)}>Discard</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
